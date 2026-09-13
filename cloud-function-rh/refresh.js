'use strict';

const { loadJson, saveJson, requestRaw } = require('./github');

const CONFIG = {
  BASE: String(process.env.DEXPAPRIKA_BASE || 'https://api.dexpaprika.com').replace(
    /\/$/,
    '',
  ),
  API_KEY: String(process.env.DEXPAPRIKA_API_KEY || '').trim(),
  NETWORK: 'robinhood',
  CACHE_PATH: process.env.RH_CACHE_PATH || 'RH/cache.json',
  FDV_MIN: Number(process.env.RH_FDV_MIN || 5_000_000),
  FDV_MAX: Number(process.env.RH_FDV_MAX || 30_000_000),
  LIMIT: Number(process.env.RH_LIMIT || 60),
  DAYS: Number(process.env.RH_DAYS || 90),
  // Free DexPaprika rate-limits hard; default serial + gap.
  CONCURRENCY: Number(process.env.RH_CONCURRENCY || 1),
  REQUEST_GAP_MS: Number(process.env.RH_REQUEST_GAP_MS || 900),
  RETRIES: Number(process.env.RH_RETRIES || 4),
  ORDER_BY: process.env.RH_ORDER_BY || 'volume_usd_24h',
};

const QUOTE_BLOCKLIST = new Set(
  [
    '0x5fc5360d0400a0fd4f2af552add042d716f1d168',
    '0x0bd7d308f8e1639fab988df18a8011f41eacad73',
    '0x0000000000000000000000000000000000000000',
  ].map((s) => s.toLowerCase()),
);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function paprikaHeaders() {
  const headers = {
    Accept: 'application/json',
    'User-Agent': 'rh-cache-cf',
  };
  if (CONFIG.API_KEY) {
    headers.Authorization = `Bearer ${CONFIG.API_KEY}`;
    headers['X-API-Key'] = CONFIG.API_KEY;
  }
  return headers;
}

async function getJson(url) {
  const retries = Math.max(1, CONFIG.RETRIES || 4);
  let lastError = null;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    if (CONFIG.REQUEST_GAP_MS > 0) {
      await sleep(CONFIG.REQUEST_GAP_MS);
    }
    try {
      const response = await requestRaw(url, {
        method: 'GET',
        headers: paprikaHeaders(),
        timeout: 30000,
      });
      if (response.status === 429 || response.status === 503) {
        const wait = Math.min(20000, 1200 * attempt * attempt);
        console.warn(`rate limited ${response.status}, wait ${wait}ms`, url);
        await sleep(wait);
        lastError = new Error(`DexPaprika ${response.status}: ${url}`);
        continue;
      }
      if (!response.ok) {
        throw new Error(`DexPaprika ${response.status}: ${url}`);
      }
      return JSON.parse(response.text());
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        await sleep(800 * attempt);
      }
    }
  }
  throw lastError || new Error(`DexPaprika failed: ${url}`);
}

function startDateIso(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - Math.max(7, Math.min(365, days || 90)));
  return d.toISOString().slice(0, 10);
}

function normalizeBars(raw) {
  const list = Array.isArray(raw) ? raw : [];
  return list
    .map((row) => {
      const t = Math.floor(new Date(row.time_open || row.time).getTime() / 1000);
      const open = Number(row.open);
      const high = Number(row.high);
      const low = Number(row.low);
      const close = Number(row.close);
      if (
        !Number.isFinite(t) ||
        !Number.isFinite(open) ||
        !Number.isFinite(high) ||
        !Number.isFinite(low) ||
        !Number.isFinite(close)
      ) {
        return null;
      }
      return { time: t, open, high, low, close };
    })
    .filter(Boolean)
    .sort((a, b) => a.time - b.time);
}

async function mapPool(items, concurrency, worker) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return [];
  const limit = Math.max(1, Math.min(concurrency || 4, list.length));
  const results = new Array(list.length);
  let cursor = 0;
  async function run() {
    while (cursor < list.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(list[index], index);
    }
  }
  await Promise.all(Array.from({ length: limit }, () => run()));
  return results;
}

async function fetchTokens() {
  const want = Math.max(1, Math.min(120, CONFIG.LIMIT || 60));
  const pageSize = 100;
  const collected = [];
  let cursor = '';
  let guard = 0;

  while (collected.length < want && guard < 5) {
    guard += 1;
    const params = new URLSearchParams({
      fdv_usd_min: String(CONFIG.FDV_MIN),
      fdv_usd_max: String(CONFIG.FDV_MAX),
      order_by: CONFIG.ORDER_BY,
      sort: 'desc',
      limit: String(pageSize),
      detailed: 'true',
    });
    if (cursor) params.set('cursor', cursor);
    const url = `${CONFIG.BASE}/networks/${CONFIG.NETWORK}/tokens/search?${params}`;
    const data = await getJson(url);
    const batch = (data.results || []).filter(
      (t) =>
        t &&
        t.address &&
        !QUOTE_BLOCKLIST.has(String(t.address).toLowerCase()),
    );
    collected.push(...batch);
    if (!data.has_next_page || !data.next_cursor) break;
    cursor = data.next_cursor;
  }

  return collected
    .filter((t) => {
      const fdv = Number(t.fdv_usd);
      return (
        Number.isFinite(fdv) &&
        fdv >= CONFIG.FDV_MIN &&
        fdv <= CONFIG.FDV_MAX
      );
    })
    .slice(0, want);
}

async function enrichToken(token, days, prevByAddress) {
  const address = String(token.address || '').toLowerCase();
  const prev = (prevByAddress && prevByAddress.get(address)) || null;
  try {
    const poolParams = new URLSearchParams({
      token_address: token.address,
      order_by: 'liquidity_usd',
      sort: 'desc',
      limit: '3',
    });
    const pools = await getJson(
      `${CONFIG.BASE}/networks/${CONFIG.NETWORK}/pools/search?${poolParams}`,
    );
    const pool = (pools.results || [])[0];
    if (!pool || !pool.id) {
      return {
        address: token.address,
        symbol: token.symbol,
        name: token.name,
        fdv_usd: token.fdv_usd,
        price_usd: token.price_usd,
        price_change_percentage_24h: token.price_change_percentage_24h,
        volume_usd_24h: token.volume_usd_24h,
        liquidity_usd: token.liquidity_usd,
        poolId: (prev && prev.poolId) || null,
        bars: (prev && prev.bars) || [],
        error: 'no pool',
      };
    }

    const end = new Date().toISOString().slice(0, 10);
    const ohlcvParams = new URLSearchParams({
      start: startDateIso(days),
      end,
      interval: '24h',
      limit: String(days),
    });
    const ohlcv = await getJson(
      `${CONFIG.BASE}/networks/${CONFIG.NETWORK}/pools/${pool.id}/ohlcv?${ohlcvParams}`,
    );
    const bars = normalizeBars(ohlcv);

    return {
      address: token.address,
      symbol: token.symbol,
      name: token.name,
      fdv_usd: Number(token.fdv_usd),
      price_usd: Number(token.price_usd),
      price_change_percentage_24h: Number(token.price_change_percentage_24h),
      volume_usd_24h: Number(token.volume_usd_24h),
      liquidity_usd: Number(pool.liquidity_usd ?? token.liquidity_usd),
      poolId: pool.id,
      bars: bars.length ? bars : (prev && prev.bars) || [],
    };
  } catch (error) {
    console.warn(
      `enrich failed ${token.symbol || token.address}`,
      error && error.message ? error.message : error,
    );
    return {
      address: token.address,
      symbol: token.symbol,
      name: token.name,
      fdv_usd: Number(token.fdv_usd),
      price_usd: Number(token.price_usd),
      price_change_percentage_24h: Number(token.price_change_percentage_24h),
      volume_usd_24h: Number(token.volume_usd_24h),
      liquidity_usd: Number(token.liquidity_usd),
      poolId: (prev && prev.poolId) || null,
      bars: (prev && prev.bars) || [],
      error: error && error.message ? error.message : String(error),
    };
  }
}

async function main() {
  const days = Math.max(14, Math.min(180, CONFIG.DAYS || 90));
  const existing = await loadJson(CONFIG.CACHE_PATH);
  const prevByAddress = new Map();
  ((existing.data && existing.data.items) || []).forEach((item) => {
    if (item && item.address) {
      prevByAddress.set(String(item.address).toLowerCase(), item);
    }
  });

  const tokens = await fetchTokens();
  console.log(
    `tokens ${tokens.length}; concurrency=${CONFIG.CONCURRENCY}; gap=${CONFIG.REQUEST_GAP_MS}ms`,
  );

  const items = await mapPool(tokens, CONFIG.CONCURRENCY, (token) =>
    enrichToken(token, days, prevByAddress),
  );

  const payload = {
    updatedAt: Date.now(),
    network: CONFIG.NETWORK,
    params: {
      fdvMin: CONFIG.FDV_MIN,
      fdvMax: CONFIG.FDV_MAX,
      limit: CONFIG.LIMIT,
      days,
      orderBy: CONFIG.ORDER_BY,
    },
    items,
  };

  await saveJson(
    CONFIG.CACHE_PATH,
    payload,
    existing.sha,
    `Refresh RH daily candle cache (${items.length})`,
  );

  const withBars = items.filter((item) => item.bars && item.bars.length).length;
  const errors = items.filter((item) => item.error).length;
  console.log(
    'rh-cache done',
    JSON.stringify({
      items: items.length,
      withBars,
      errors,
      path: CONFIG.CACHE_PATH,
    }),
  );

  return {
    ok: true,
    items: items.length,
    withBars,
    errors,
    path: CONFIG.CACHE_PATH,
  };
}

module.exports = { main };
