'use strict';

/**
 * 事件函数入口（定时拉 OKX K 线缓存）
 * Handler: index.handler
 * 触发器：定时触发器（建议 5～15 分钟）
 * 不需要 HTTP 触发器
 *
 * 流程：
 *   读 GitHub okx/favorites.json
 *   拉 OKX market/candles（Basic，多周期）+ token basic-info + price-info（市值）
 *   写 GitHub okx/candles-cache.json（紧凑 K 线数组，含 marketCap / tokenLogoUrl）
 *   若补全了名字则回写 favorites.json
 */
const {
  fetchCandles,
  fetchTokenBasicInfo,
  fetchTokenPriceInfo,
  isPlaceholderSymbol,
  isRateLimitError,
  isQuotaExhaustedError,
} = require('./okx-client');
const {
  FAVORITES_PATH,
  CANDLES_PATH,
  loadJson,
  saveJson,
} = require('./github');

const BARS = String(process.env.OKX_CANDLE_BARS || '15m,2H,4H,1D,3D,1W')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);

const BAR_LIMITS = {
  '15m': 192, // ~2 天
  '2H': 84, // ~7 天
  '4H': 72, // ~12 天
  '1D': 90,
  '3D': 60,
  '1W': 52,
};

const BAR_GAP_MS = Math.max(
  200,
  Number(process.env.OKX_BAR_GAP_MS) || 450,
);
const TOKEN_GAP_MS = Math.max(
  200,
  Number(process.env.OKX_TOKEN_GAP_MS) || 600,
);
const GH_MAX_BYTES = Number(process.env.GH_MAX_BYTES || 900 * 1024);
const ALLOWED_CHAINS = new Set(
  String(process.env.OKX_CHAINS || '501,4663')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean),
);

function limitForBar(bar) {
  const fromEnv = Number(process.env[`OKX_LIMIT_${bar}`]);
  if (Number.isFinite(fromEnv) && fromEnv > 0) {
    return Math.min(299, fromEnv);
  }
  return Math.min(299, BAR_LIMITS[bar] || 72);
}

function normalizeFavorites(data) {
  const list = Array.isArray(data)
    ? data
    : Array.isArray(data && data.items)
      ? data.items
      : [];
  const map = new Map();
  list.forEach((item) => {
    if (!item || typeof item !== 'object') return;
    const chainIndex = String(item.chainIndex || '').trim();
    if (!ALLOWED_CHAINS.has(chainIndex)) return;
    const tokenContractAddress = String(
      item.tokenContractAddress || item.address || '',
    ).trim();
    if (!tokenContractAddress) return;
    const address =
      chainIndex === '501'
        ? tokenContractAddress
        : tokenContractAddress.toLowerCase();
    const key = `${chainIndex}:${address}`;
    map.set(key, {
      chainIndex,
      tokenContractAddress: address,
      symbol: String(item.symbol || '').trim(),
      addedAt: Number.isFinite(Number(item.addedAt))
        ? Number(item.addedAt)
        : Date.now(),
      source: item.source ? String(item.source) : 'manual',
    });
  });
  return [...map.values()];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function compactNum(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Number(Number(n).toPrecision(8));
}

/** 蜡烛 → [time, open, high, low, close, volume] */
function compactCandle(candle) {
  if (Array.isArray(candle) && candle.length >= 5) {
    return [
      Number(candle[0]) || 0,
      compactNum(candle[1]),
      compactNum(candle[2]),
      compactNum(candle[3]),
      compactNum(candle[4]),
      compactNum(candle[5] || 0),
    ];
  }
  if (!candle || typeof candle !== 'object') return null;
  const time = Number(candle.time) || 0;
  const close = Number(candle.close);
  if (!time || !Number.isFinite(close)) return null;
  return [
    time,
    compactNum(candle.open),
    compactNum(candle.high),
    compactNum(candle.low),
    compactNum(close),
    compactNum(candle.volume),
  ];
}

function hydrateCandle(candle) {
  if (Array.isArray(candle) && candle.length >= 5) {
    return {
      time: Number(candle[0]) || 0,
      open: Number(candle[1]),
      high: Number(candle[2]),
      low: Number(candle[3]),
      close: Number(candle[4]),
      volume: Number(candle[5]) || 0,
    };
  }
  if (candle && typeof candle === 'object' && Number.isFinite(Number(candle.close))) {
    return candle;
  }
  return null;
}

function hydrateCandleList(list) {
  return (Array.isArray(list) ? list : [])
    .map(hydrateCandle)
    .filter((item) => item && Number.isFinite(item.close));
}

function hydrateTokenRow(row) {
  if (!row || typeof row !== 'object') return row;
  const byBar = {};
  const src =
    row.candlesByBar && typeof row.candlesByBar === 'object'
      ? row.candlesByBar
      : {};
  Object.keys(src).forEach((bar) => {
    byBar[bar] = hydrateCandleList(src[bar]);
  });
  if (
    !Object.keys(byBar).length &&
    Array.isArray(row.candles) &&
    row.candles.length
  ) {
    byBar['4H'] = hydrateCandleList(row.candles);
  }
  return {
    ...row,
    candlesByBar: byBar,
  };
}

function compactTokenRow(row) {
  const byBar = {};
  const src =
    row && row.candlesByBar && typeof row.candlesByBar === 'object'
      ? row.candlesByBar
      : {};
  Object.keys(src).forEach((bar) => {
    byBar[bar] = (Array.isArray(src[bar]) ? src[bar] : [])
      .map(compactCandle)
      .filter(Boolean);
  });
  return {
    ok: !!(row && row.ok),
    chainIndex: row.chainIndex,
    tokenContractAddress: row.tokenContractAddress,
    symbol: (row && row.symbol) || '',
    tokenName: (row && row.tokenName) || '',
    tokenLogoUrl: (row && row.tokenLogoUrl) || '',
    marketCap: Number.isFinite(Number(row && row.marketCap))
      ? Number(row.marketCap)
      : null,
    candlesByBar: byBar,
    errors: row && row.errors ? row.errors : undefined,
    error: row && row.error ? row.error : undefined,
  };
}

function buildSlimPayload(raw) {
  const tokens = {};
  Object.keys((raw && raw.tokens) || {}).forEach((key) => {
    tokens[key] = compactTokenRow(raw.tokens[key]);
  });
  return {
    updatedAt: Number(raw && raw.updatedAt) || Date.now(),
    source: 'github-slim',
    bars: Array.isArray(raw && raw.bars) ? raw.bars.slice() : BARS.slice(),
    barLimits:
      raw && raw.barLimits && typeof raw.barLimits === 'object'
        ? raw.barLimits
        : Object.fromEntries(BARS.map((bar) => [bar, limitForBar(bar)])),
    tokenCount: Number(raw && raw.tokenCount) || Object.keys(tokens).length,
    okCount: Number(raw && raw.okCount) || 0,
    failCount: Number(raw && raw.failCount) || 0,
    tokens,
    quotaExhausted: raw && raw.quotaExhausted ? true : undefined,
    quotaAt: raw && raw.quotaAt ? Number(raw.quotaAt) : undefined,
  };
}

/** 超限时先丢掉长周期，再截短 15m。 */
function shrinkSlimPayload(payload) {
  const next = JSON.parse(JSON.stringify(payload));
  const dropOrder = ['1W', '3D', '2H'];
  for (const bar of dropOrder) {
    const bytes = Buffer.byteLength(JSON.stringify(next), 'utf8');
    if (bytes <= GH_MAX_BYTES) break;
    let touched = false;
    Object.values(next.tokens || {}).forEach((row) => {
      if (row.candlesByBar && row.candlesByBar[bar]) {
        delete row.candlesByBar[bar];
        touched = true;
      }
    });
    if (touched) {
      next.bars = (next.bars || []).filter((item) => item !== bar);
      console.warn(`candles slim dropped bar ${bar} to fit GitHub limit`);
    }
  }
  let guard = 0;
  while (
    Buffer.byteLength(JSON.stringify(next), 'utf8') > GH_MAX_BYTES &&
    guard < 8
  ) {
    guard += 1;
    Object.values(next.tokens || {}).forEach((row) => {
      const list = row.candlesByBar && row.candlesByBar['15m'];
      if (Array.isArray(list) && list.length > 48) {
        row.candlesByBar['15m'] = list.slice(-Math.ceil(list.length * 0.75));
      }
    });
    console.warn('candles slim trimmed 15m length');
  }
  const bytes = Buffer.byteLength(JSON.stringify(next), 'utf8');
  if (bytes > GH_MAX_BYTES) {
    throw new Error(
      `okx candles-cache still too large: ${(bytes / 1024).toFixed(1)}KB ` +
        `(limit ~${(GH_MAX_BYTES / 1024).toFixed(0)}KB)`,
    );
  }
  next.slim = { bytes, maxBytes: GH_MAX_BYTES };
  return next;
}

async function saveCandlesCache(rawPayload, message) {
  let slim = shrinkSlimPayload(buildSlimPayload(rawPayload));
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const current = await loadJson(CANDLES_PATH);
      await saveJson(
        CANDLES_PATH,
        slim,
        current.sha,
        message ||
          `Update OKX candles-cache (${((slim.slim && slim.slim.bytes) / 1024).toFixed(0)}KB)`,
      );
      return {
        path: CANDLES_PATH,
        bytes: slim.slim && slim.slim.bytes,
        bars: slim.bars,
      };
    } catch (error) {
      lastError = error;
      const text = error && error.message ? error.message : String(error);
      if (!/409|conflict|sha/i.test(text)) break;
      console.warn(`candles-cache write conflict, retry ${attempt + 1}`);
    }
  }
  throw lastError || new Error('candles-cache write failed');
}

async function fetchBarsForToken(token, previous) {
  const hydrated = hydrateTokenRow(previous || {});
  const prevBars =
    hydrated.candlesByBar && typeof hydrated.candlesByBar === 'object'
      ? hydrated.candlesByBar
      : {};
  const byBar = {};
  const errors = {};
  let okBars = 0;
  let reused = 0;

  for (let index = 0; index < BARS.length; index += 1) {
    const bar = BARS[index];
    try {
      const row = await fetchCandles({
        chainIndex: token.chainIndex,
        tokenContractAddress: token.tokenContractAddress,
        bar,
        limit: limitForBar(bar),
      });
      byBar[bar] = row.candles;
      if (row.candles && row.candles.length) okBars += 1;
    } catch (error) {
      if (isQuotaExhaustedError(error)) throw error;
      const prev =
        Array.isArray(prevBars[bar]) && prevBars[bar].length
          ? prevBars[bar]
          : [];
      byBar[bar] = prev;
      if (prev.length) {
        reused += 1;
        okBars += 1;
        errors[bar] = `reused previous · ${error.message || error}`;
      } else {
        errors[bar] = error.message || String(error);
      }
      if (isRateLimitError(error)) {
        await sleep(1200);
      }
    }
    if (index + 1 < BARS.length) await sleep(BAR_GAP_MS);
  }

  return { byBar, errors, okBars, reused };
}

async function syncCandlesCache() {
  const favoritesFile = await loadJson(FAVORITES_PATH);
  const tokens = normalizeFavorites(favoritesFile.data);
  console.log(
    `okx-candles favorites=${tokens.length} bars=${BARS.join(',')}`,
  );

  let previous = null;
  let previousTokens = {};
  let candlesSha = null;
  try {
    const file = await loadJson(CANDLES_PATH);
    candlesSha = file.sha;
    previous = file.data;
    if (previous && previous.tokens && typeof previous.tokens === 'object') {
      previousTokens = previous.tokens;
    }
  } catch (error) {
    console.warn(`load previous GitHub candles failed: ${error.message}`);
  }

  let metaMap = new Map();
  try {
    metaMap = await fetchTokenBasicInfo(tokens);
    console.log(`okx-candles basic-info hit=${metaMap.size}`);
  } catch (error) {
    console.warn(`basic-info failed: ${error.message}`);
    if (isQuotaExhaustedError(error) && previous && previous.tokens) {
      console.warn(
        'OKX quota exhausted on basic-info; keep previous GitHub cache',
      );
      const kept = {
        ...previous,
        quotaExhausted: true,
        quotaAt: Date.now(),
      };
      const written = await saveCandlesCache(
        kept,
        'Keep OKX candles (quota basic-info)',
      );
      return {
        storage: 'github-slim',
        path: written.path,
        bytes: written.bytes,
        skipped: true,
        reason: 'quota-exhausted',
        tokenCount: tokens.length,
        okCount: previous.okCount || 0,
        failCount: previous.failCount || 0,
        updatedAt: previous.updatedAt,
      };
    }
  }

  let priceMap = new Map();
  try {
    priceMap = await fetchTokenPriceInfo(tokens);
    console.log(`okx-candles price-info hit=${priceMap.size}`);
  } catch (error) {
    console.warn(`price-info failed: ${error.message}`);
    if (isQuotaExhaustedError(error) && previous && previous.tokens) {
      console.warn(
        'OKX quota exhausted on price-info; keep previous GitHub cache',
      );
      const kept = {
        ...previous,
        quotaExhausted: true,
        quotaAt: Date.now(),
      };
      const written = await saveCandlesCache(
        kept,
        'Keep OKX candles (quota price-info)',
      );
      return {
        storage: 'github-slim',
        path: written.path,
        bytes: written.bytes,
        skipped: true,
        reason: 'quota-exhausted',
        tokenCount: tokens.length,
        okCount: previous.okCount || 0,
        failCount: previous.failCount || 0,
        updatedAt: previous.updatedAt,
      };
    }
  }

  const results = {};
  let okCount = 0;
  let failCount = 0;
  let renamed = 0;
  let quotaExhausted = false;
  const nextFavorites = [];

  for (let index = 0; index < tokens.length; index += 1) {
    if (quotaExhausted) break;
    const token = tokens[index];
    const key = `${token.chainIndex}:${token.tokenContractAddress}`;
    const meta = metaMap.get(key);
    let symbol = token.symbol;
    if (
      meta &&
      meta.tokenSymbol &&
      isPlaceholderSymbol(symbol, token.tokenContractAddress)
    ) {
      symbol = String(meta.tokenSymbol).slice(0, 32);
      renamed += 1;
    }

    nextFavorites.push({
      chainIndex: token.chainIndex,
      tokenContractAddress: token.tokenContractAddress,
      symbol:
        symbol ||
        (meta && meta.tokenSymbol) ||
        token.symbol ||
        '',
      addedAt: token.addedAt,
      source: token.source,
    });

    try {
      const { byBar, errors, okBars, reused } = await fetchBarsForToken(
        token,
        previousTokens[key],
      );
      const ok = okBars > 0;
      if (ok) okCount += 1;
      else failCount += 1;
      const prevRow = hydrateTokenRow(
        previousTokens[key] && typeof previousTokens[key] === 'object'
          ? previousTokens[key]
          : {},
      );
      const priceRow = priceMap.get(key);
      const marketCap =
        priceRow && Number.isFinite(priceRow.marketCap)
          ? priceRow.marketCap
          : Number.isFinite(Number(prevRow.marketCap))
            ? Number(prevRow.marketCap)
            : null;
      results[key] = {
        ok,
        chainIndex: token.chainIndex,
        tokenContractAddress: token.tokenContractAddress,
        symbol: nextFavorites[nextFavorites.length - 1].symbol,
        tokenName: (meta && meta.tokenName) || prevRow.tokenName || '',
        tokenLogoUrl:
          (meta && meta.tokenLogoUrl) || prevRow.tokenLogoUrl || '',
        marketCap,
        candlesByBar: byBar,
        errors: Object.keys(errors).length ? errors : undefined,
      };
      if (!ok) {
        console.warn(
          `candle fail ${key}: no bars`,
          JSON.stringify(errors).slice(0, 200),
        );
      } else if (reused) {
        console.warn(`candle reused ${reused} bars for ${key}`);
      }
    } catch (error) {
      if (isQuotaExhaustedError(error)) {
        quotaExhausted = true;
        console.warn(`OKX quota exhausted at ${key}; stop remaining calls`);
        break;
      }
      failCount += 1;
      const prevRow = hydrateTokenRow(
        previousTokens[key] && typeof previousTokens[key] === 'object'
          ? previousTokens[key]
          : {},
      );
      const priceRow = priceMap.get(key);
      results[key] = {
        ok: false,
        chainIndex: token.chainIndex,
        tokenContractAddress: token.tokenContractAddress,
        symbol: nextFavorites[nextFavorites.length - 1].symbol,
        tokenName: (meta && meta.tokenName) || prevRow.tokenName || '',
        tokenLogoUrl:
          (meta && meta.tokenLogoUrl) || prevRow.tokenLogoUrl || '',
        marketCap:
          priceRow && Number.isFinite(priceRow.marketCap)
            ? priceRow.marketCap
            : Number.isFinite(Number(prevRow.marketCap))
              ? Number(prevRow.marketCap)
              : null,
        candlesByBar: {},
        error: error.message || String(error),
      };
      console.warn(`candle fail ${key}: ${error.message}`);
    }
    if (index + 1 < tokens.length) await sleep(TOKEN_GAP_MS);
  }

  const pulledCount = Object.keys(results).length;
  if (quotaExhausted && pulledCount === 0 && previous && previous.tokens) {
    const kept = {
      ...previous,
      quotaExhausted: true,
      quotaAt: Date.now(),
    };
    const written = await saveCandlesCache(
      kept,
      'Keep OKX candles (quota exhausted)',
    );
    return {
      storage: 'github-slim',
      path: written.path,
      bytes: written.bytes,
      skipped: true,
      reason: 'quota-exhausted',
      tokenCount: tokens.length,
      okCount: previous.okCount || 0,
      failCount: previous.failCount || 0,
      updatedAt: previous.updatedAt,
    };
  }

  if (quotaExhausted) {
    tokens.forEach((token) => {
      const key = `${token.chainIndex}:${token.tokenContractAddress}`;
      if (results[key] || !previousTokens[key]) return;
      results[key] = hydrateTokenRow(previousTokens[key]);
      if (previousTokens[key].ok) okCount += 1;
    });
  }

  const payload = {
    updatedAt: Date.now(),
    bars: BARS,
    barLimits: Object.fromEntries(BARS.map((bar) => [bar, limitForBar(bar)])),
    tokenCount: tokens.length,
    okCount,
    failCount,
    tokens: results,
    quotaExhausted: quotaExhausted || undefined,
    quotaAt: quotaExhausted ? Date.now() : undefined,
  };

  const written = await saveCandlesCache(payload);
  console.log(
    `Updated GitHub ${written.path} · ${(written.bytes / 1024).toFixed(1)}KB · ok=${okCount}`,
  );

  let favoritesUpdated = false;
  if (renamed > 0 && !quotaExhausted) {
    try {
      await saveJson(
        FAVORITES_PATH,
        { updatedAt: Date.now(), items: nextFavorites },
        favoritesFile.sha,
        `Fill OKX token symbols · ${renamed}`,
      );
      favoritesUpdated = true;
    } catch (error) {
      console.warn(`favorites symbol write failed: ${error.message}`);
    }
  }

  return {
    storage: 'github-slim',
    path: written.path,
    bytes: written.bytes,
    bars: written.bars || BARS,
    tokenCount: tokens.length,
    okCount,
    failCount,
    renamed,
    favoritesUpdated,
    quotaExhausted: Boolean(quotaExhausted),
    updatedAt: payload.updatedAt,
    previousSha: candlesSha,
  };
}

exports.handler = async (event, context) => {
  console.log(
    'okx-candles-timer invoke',
    JSON.stringify({
      keys: event && typeof event === 'object' ? Object.keys(event) : [],
      requestId: context && context.requestId,
    }),
  );
  const result = await syncCandlesCache();
  console.log('okx-candles-timer done', JSON.stringify(result));
  return result;
};

exports.syncCandlesCache = syncCandlesCache;
