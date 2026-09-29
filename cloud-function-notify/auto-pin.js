'use strict';

/**
 * Server-side auto-pin: same idea as kline.html Strategy A.
 * Newcomers into 窗口上涨 (watch-pool ∩ window-up) get pinned even if the
 * browser page is closed. Snapshot lives in watch-notify-state.json.
 */

const {
  loadJson,
  saveJson,
  fetchBinanceTickers,
  requestRaw,
} = require('./github-wecom');

const CONFIG = {
  OBS_DATA_URL:
    process.env.OBS_DATA_URL ||
    'https://mpctest.obs.cn-north-4.myhuaweicloud.com/watch-data.json',
  BLACKLIST_PATH: process.env.BLACKLIST_PATH || 'watch-blacklist.json',
  PINS_PATH: process.env.PINS_PATH || 'watch-pins.json',
  WATCH_POOL_RANK: Number(process.env.WATCH_POOL_RANK || 30),
  WINDOW_INTERVAL: process.env.PIN_WINDOW_INTERVAL || '4h',
  WINDOW_TOLERANCE_MS: Number(process.env.WINDOW_TOLERANCE_MS || 2 * 60 * 1000),
  PIN_TTL_MS: Number(process.env.PIN_TTL_MS || 12 * 60 * 60 * 1000),
  AUTO_PIN_EVENTS_MAX: Number(process.env.AUTO_PIN_EVENTS_MAX || 40),
  ENABLED:
    String(process.env.AUTO_PIN_ENABLED === undefined ? '1' : process.env.AUTO_PIN_ENABLED) !==
    '0',
};

const DURATION_MS = {
  '15m': 15 * 60 * 1000,
  '30m': 30 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '2h': 2 * 60 * 60 * 1000,
  '4h': 4 * 60 * 60 * 1000,
};

function normalizePinList(raw) {
  if (!Array.isArray(raw)) return [];
  const map = new Map();
  raw.forEach((item) => {
    if (!item || !item.symbol) return;
    const symbol = String(item.symbol).trim().toUpperCase();
    if (!symbol) return;
    const pinnedAt = Number(item.pinnedAt) || 0;
    const pinPrice = Number(item.pinPrice);
    const expiresAt = Number(item.expiresAt) || 0;
    const source = item.source ? String(item.source) : 'legacy';
    const prev = map.get(symbol);
    if (!prev || pinnedAt >= prev.pinnedAt) {
      map.set(symbol, {
        symbol,
        pinnedAt,
        expiresAt,
        pinPrice: Number.isFinite(pinPrice) ? pinPrice : null,
        source,
      });
    }
  });
  return [...map.values()].sort((a, b) => {
    if (b.pinnedAt !== a.pinnedAt) return b.pinnedAt - a.pinnedAt;
    return a.symbol.localeCompare(b.symbol);
  });
}

function addPin(list, symbol, pinPrice, source, now) {
  const key = String(symbol || '')
    .trim()
    .toUpperCase();
  if (!key) return normalizePinList(list);
  const ts = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const price = Number(pinPrice);
  const next = normalizePinList(list).filter((item) => item.symbol !== key);
  next.unshift({
    symbol: key,
    pinnedAt: ts,
    expiresAt: ts + CONFIG.PIN_TTL_MS,
    pinPrice: Number.isFinite(price) ? price : null,
    source: source || 'auto-cloud',
  });
  return next;
}

function hasPin(list, symbol) {
  const key = String(symbol || '')
    .trim()
    .toUpperCase();
  return normalizePinList(list).some((item) => item.symbol === key);
}

async function fetchWatchData() {
  const response = await requestRaw(CONFIG.OBS_DATA_URL, {
    method: 'GET',
    timeout: 20000,
  });
  if (!response.ok) {
    throw new Error(`OBS watch-data ${response.status}`);
  }
  return JSON.parse(response.text());
}

async function loadBlacklistSet() {
  try {
    const file = await loadJson(CONFIG.BLACKLIST_PATH);
    const raw =
      (file.data && file.data.blacklist) ||
      (Array.isArray(file.data) ? file.data : []);
    const set = new Set();
    (raw || []).forEach((item) => {
      const symbol =
        typeof item === 'string'
          ? item.trim().toUpperCase()
          : String((item && item.symbol) || '')
              .trim()
              .toUpperCase();
      if (symbol) set.add(symbol);
    });
    return set;
  } catch (error) {
    console.warn('auto-pin blacklist load failed', error.message || error);
    return new Set();
  }
}

function ranking(marketMap, blacklist) {
  return Object.entries(marketMap || {})
    .sort((a, b) => (b[1].change24h || 0) - (a[1].change24h || 0))
    .map(([symbol]) => symbol)
    .filter((symbol) => !blacklist.has(symbol));
}

function getWindowStart(timestamp, duration) {
  return Math.floor(timestamp / duration) * duration;
}

function selectEarliestWindowSnapshot(history, windowStart, duration) {
  const windowEnd = windowStart + duration;
  const strict = (history || []).filter(
    (snapshot) =>
      snapshot &&
      snapshot.timestamp >= windowStart &&
      snapshot.timestamp < windowEnd,
  );
  const candidates = strict.length
    ? strict
    : (history || []).filter(
        (snapshot) =>
          snapshot &&
          snapshot.timestamp >= windowStart &&
          snapshot.timestamp < windowEnd + CONFIG.WINDOW_TOLERANCE_MS,
      );
  if (!candidates.length) return null;
  return candidates.reduce((earliest, item) =>
    item.timestamp < earliest.timestamp ? item : earliest,
  );
}

function windowPriceChange(history, marketMap, symbol, interval) {
  const duration = DURATION_MS[interval];
  if (!duration) return null;
  const old = selectEarliestWindowSnapshot(
    history,
    getWindowStart(Date.now(), duration),
    duration,
  );
  const oldPrice = old && old.prices ? Number(old.prices[symbol]) : null;
  const currentPrice = marketMap[symbol] && marketMap[symbol].price;
  if (
    !Number.isFinite(oldPrice) ||
    !Number.isFinite(currentPrice) ||
    oldPrice === 0
  ) {
    return null;
  }
  return ((currentPrice - oldPrice) / oldPrice) * 100;
}

function hasWindowGain(history, marketMap, symbol, interval) {
  const change = windowPriceChange(history, marketMap, symbol, interval);
  return Number.isFinite(change) && change > 0;
}

function buildWatchPool(history, marketMap, seedPool, blacklist) {
  const list = ranking(marketMap, blacklist);
  const next = new Set(
    (seedPool || [])
      .map((s) => String(s || '').toUpperCase())
      .filter(Boolean),
  );
  for (const symbol of [...next]) {
    const rank = list.indexOf(symbol) + 1;
    if (blacklist.has(symbol) || !rank || rank > CONFIG.WATCH_POOL_RANK) {
      next.delete(symbol);
    }
  }
  for (const symbol of list.slice(0, CONFIG.WATCH_POOL_RANK)) {
    if (blacklist.has(symbol)) continue;
    if (hasWindowGain(history, marketMap, symbol, '4h')) next.add(symbol);
  }
  return next;
}

function listRisingSymbols(history, marketMap, watchPool, pinnedSet, blacklist) {
  const interval = CONFIG.WINDOW_INTERVAL;
  const list = ranking(marketMap, blacklist);
  const ranked = list.filter((symbol) => watchPool.has(symbol));
  const unranked = [...watchPool].filter(
    (symbol) =>
      marketMap[symbol] &&
      !list.includes(symbol) &&
      !blacklist.has(symbol),
  );
  return [...ranked, ...unranked].filter(
    (symbol) =>
      !blacklist.has(symbol) &&
      !pinnedSet.has(symbol) &&
      hasWindowGain(history, marketMap, symbol, interval),
  );
}

/**
 * @returns {{
 *   pins: object[],
 *   pinsChanged: boolean,
 *   newcomers: string[],
 *   risingSnap: string[],
 *   risingSnapSeeded: boolean,
 *   autoPinEvents: object[],
 * }}
 */
async function runAutoPin(options) {
  const opts = options || {};
  const now = Number(opts.now) || Date.now();
  let pins = normalizePinList(opts.pins);
  const prevSnap = Array.isArray(opts.risingSnap)
    ? opts.risingSnap.map(String)
    : [];
  let seeded = !!opts.risingSnapSeeded;
  let events = Array.isArray(opts.autoPinEvents) ? opts.autoPinEvents.slice() : [];

  if (!CONFIG.ENABLED) {
    return {
      pins,
      pinsChanged: false,
      newcomers: [],
      risingSnap: prevSnap,
      risingSnapSeeded: seeded,
      autoPinEvents: events,
    };
  }

  const [watchData, blacklist] = await Promise.all([
    fetchWatchData(),
    loadBlacklistSet(),
  ]);
  const history = Array.isArray(watchData && watchData.history)
    ? watchData.history
    : [];
  const seedPool = Array.isArray(watchData && watchData.watchPool)
    ? watchData.watchPool
    : [];

  // Need broad ticker map for pool ranking + window checks.
  const probe = ranking(
    Object.fromEntries(
      seedPool.map((symbol) => [String(symbol).toUpperCase(), { change24h: 0 }]),
    ),
    blacklist,
  );
  // Fetch all USDT via empty-set workaround: pass union of pool + ranked probe from last snapshot.
  const lastSnap = history.length ? history[history.length - 1] : null;
  const lastSymbols = lastSnap && lastSnap.prices ? Object.keys(lastSnap.prices) : [];
  const want = [
    ...new Set([
      ...seedPool.map((s) => String(s).toUpperCase()),
      ...lastSymbols.map((s) => String(s).toUpperCase()),
      ...probe,
    ]),
  ].filter(Boolean);
  // Cap fan-out: top ranks by last snapshot order if huge.
  const symbolList = want.slice(0, Math.max(80, CONFIG.WATCH_POOL_RANK * 3));
  const tickers = await fetchBinanceTickers(symbolList);
  const marketMap = tickers;

  const watchPool = buildWatchPool(history, marketMap, seedPool, blacklist);
  const pinnedSet = new Set(pins.map((item) => item.symbol));
  const rising = listRisingSymbols(
    history,
    marketMap,
    watchPool,
    pinnedSet,
    blacklist,
  );

  if (!seeded) {
    console.log(
      'auto-pin seed rising snap',
      JSON.stringify({ rising: rising.length, pool: watchPool.size }),
    );
    return {
      pins,
      pinsChanged: false,
      newcomers: [],
      risingSnap: rising,
      risingSnapSeeded: true,
      autoPinEvents: events,
    };
  }

  const prevSet = new Set(prevSnap);
  const newcomers = rising.filter(
    (symbol) => !prevSet.has(symbol) && !hasPin(pins, symbol),
  );

  let pinsChanged = false;
  if (newcomers.length) {
    for (const symbol of newcomers) {
      const price = marketMap[symbol] && marketMap[symbol].price;
      pins = addPin(pins, symbol, price, 'auto-cloud', now);
    }
    pinsChanged = true;
    events = [
      {
        at: now,
        symbols: newcomers.slice(),
        source: 'auto-cloud',
      },
      ...events,
    ].slice(0, CONFIG.AUTO_PIN_EVENTS_MAX);
    console.log(
      'auto-pin newcomers',
      JSON.stringify({ count: newcomers.length, symbols: newcomers }),
    );
  }

  // After pinning, refresh rising list without newly pinned names for snap.
  const pinnedAfter = new Set(pins.map((item) => item.symbol));
  const risingAfter = listRisingSymbols(
    history,
    marketMap,
    watchPool,
    pinnedAfter,
    blacklist,
  );

  return {
    pins,
    pinsChanged,
    newcomers,
    risingSnap: risingAfter,
    risingSnapSeeded: true,
    autoPinEvents: events,
  };
}

async function savePinsFile(pinsFile, pins, message) {
  const payload = {
    pins: normalizePinList(pins),
    pinsUpdatedAt: Date.now(),
  };
  await saveJson(
    CONFIG.PINS_PATH,
    payload,
    pinsFile && pinsFile.sha,
    message || `Auto-pin ${payload.pins.length}`,
  );
  return payload;
}

module.exports = {
  runAutoPin,
  savePinsFile,
  normalizePinList,
  CONFIG,
};
