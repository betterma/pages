'use strict';

/**
 * Server-side auto-pin / rewarm / zone-drop: edges of 窗口上涨
 * (watch-pool ∩ window-up), including already-pinned coins.
 * Snapshot lives in watch-notify-state.json as risingZoneSnap.
 */

const {
  loadJson,
  saveJson,
  fetchBinanceTickers,
  requestRaw,
} = require('./github-wecom');

const CONFIG = {
  DATA_PATH: process.env.DATA_PATH || 'watch-data.json',
  OBS_DATA_URL:
    process.env.OBS_DATA_URL ||
    'https://mpctest.obs.cn-north-4.myhuaweicloud.com/watch-data.json',
  BLACKLIST_PATH: process.env.BLACKLIST_PATH || 'watch-blacklist.json',
  PINS_PATH: process.env.PINS_PATH || 'watch-pins.json',
  WATCH_POOL_RANK: Number(process.env.WATCH_POOL_RANK || 30),
  WINDOW_INTERVAL: process.env.PIN_WINDOW_INTERVAL || '4h',
  WINDOW_TOLERANCE_MS: Number(process.env.WINDOW_TOLERANCE_MS || 2 * 60 * 1000),
  PIN_TTL_MS: Number(process.env.PIN_TTL_MS || 12 * 60 * 60 * 1000),
  // 与页面一致：暂时不设盯一下过期。改 true / 环境变量 PIN_EXPIRY_ENABLED=1 可恢复。
  PIN_EXPIRY_ENABLED: /^(1|true|yes)$/i.test(
    String(process.env.PIN_EXPIRY_ENABLED || ''),
  ),
  AUTO_PIN_EVENTS_MAX: Number(process.env.AUTO_PIN_EVENTS_MAX || 40),
  // Same-symbol edge cooldown: skip rewarm / re-pin while recent.
  // Default 24h — kills flicker re-pins within a full day.
  EDGE_COOLDOWN_MS: Number(
    process.env.AUTO_PIN_EDGE_COOLDOWN_MS || 24 * 60 * 60 * 1000,
  ),
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
    expiresAt: CONFIG.PIN_EXPIRY_ENABLED ? ts + CONFIG.PIN_TTL_MS : 0,
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

function findPin(list, symbol) {
  const key = String(symbol || '')
    .trim()
    .toUpperCase();
  return normalizePinList(list).find((item) => item.symbol === key) || null;
}

/** True if this pin was written too recently to accept another edge update. */
function isEdgeCooling(pin, now) {
  if (!pin) return false;
  const cooldown = Number(CONFIG.EDGE_COOLDOWN_MS) || 0;
  if (cooldown <= 0) return false;
  const at = Number(pin.pinnedAt) || 0;
  if (at <= 0) return false;
  const ts = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  return ts - at < cooldown;
}

function watchDataStampMs(data) {
  const saved = Number(data && data.savedAt) || 0;
  let last = 0;
  const hist = Array.isArray(data && data.history) ? data.history : [];
  for (const snap of hist) {
    const t = Number(snap && snap.timestamp) || 0;
    if (t > last) last = t;
  }
  return Math.max(saved, last);
}

/** Reject GitHub files that are too old / prune to empty (same rule as kline). */
function isWatchDataUsable(data) {
  if (!data) return false;
  const hasShape =
    Array.isArray(data.history) || Array.isArray(data.watchPool);
  if (!hasShape) return false;
  const stamp = watchDataStampMs(data);
  if (!stamp) return false;
  const staleMs = Number(process.env.WATCH_DATA_STALE_MS) || 2 * 60 * 60 * 1000;
  if (Date.now() - stamp > staleMs) return false;
  const historyMs = 3 * 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - historyMs;
  const hist = Array.isArray(data.history) ? data.history : [];
  return hist.some((snap) => Number(snap && snap.timestamp) >= cutoff);
}

async function fetchWatchData() {
  // 优先 GitHub 瘦身版；失败/过旧再回落 OBS 完整版。
  try {
    const file = await loadJson(CONFIG.DATA_PATH);
    if (file && file.data && isWatchDataUsable(file.data)) {
      return file.data;
    }
    if (file && file.data) {
      console.warn(
        'GitHub watch-data stale/unusable, fallback OBS',
        JSON.stringify({ stamp: watchDataStampMs(file.data) }),
      );
    }
  } catch (error) {
    console.warn(
      'GitHub watch-data load failed, fallback OBS',
      error && error.message ? error.message : error,
    );
  }
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

/** UI list: zone ∩ not pinned. */
function listRisingSymbols(history, marketMap, watchPool, pinnedSet, blacklist) {
  return listRisingZone(history, marketMap, watchPool, blacklist).filter(
    (symbol) => !pinnedSet.has(symbol),
  );
}

/** Edge universe: watch-pool ∩ window-up (includes pinned). */
function listRisingZone(history, marketMap, watchPool, blacklist) {
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
      hasWindowGain(history, marketMap, symbol, interval),
  );
}

function emptyResult(pins, snap, seeded, events) {
  return {
    pins,
    pinsChanged: false,
    newcomers: [],
    rewarmed: [],
    dropped: [],
    risingSnap: snap,
    risingSnapSeeded: seeded,
    autoPinEvents: events,
  };
}

/**
 * @returns {{
 *   pins: object[],
 *   pinsChanged: boolean,
 *   newcomers: string[],
 *   rewarmed: string[],
 *   dropped: string[],
 *   risingSnap: string[],
 *   risingSnapSeeded: boolean,
 *   autoPinEvents: object[],
 * }}
 */
async function runAutoPin(options) {
  const opts = options || {};
  const now = Number(opts.now) || Date.now();
  let pins = normalizePinList(opts.pins);
  // Zone snap (v2) includes pinned; first deploy re-seeds without mass rewarm.
  const prevSnap = Array.isArray(opts.risingZoneSnap)
    ? opts.risingZoneSnap.map(String)
    : [];
  let seeded = !!opts.risingZoneSnapSeeded;
  let events = Array.isArray(opts.autoPinEvents) ? opts.autoPinEvents.slice() : [];

  if (!CONFIG.ENABLED) {
    return emptyResult(pins, prevSnap, seeded, events);
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

  const probe = ranking(
    Object.fromEntries(
      seedPool.map((symbol) => [String(symbol).toUpperCase(), { change24h: 0 }]),
    ),
    blacklist,
  );
  const lastSnap = history.length ? history[history.length - 1] : null;
  const lastSymbols = lastSnap && lastSnap.prices ? Object.keys(lastSnap.prices) : [];
  const want = [
    ...new Set([
      ...seedPool.map((s) => String(s).toUpperCase()),
      ...lastSymbols.map((s) => String(s).toUpperCase()),
      ...probe,
    ]),
  ].filter(Boolean);
  const symbolList = want.slice(0, Math.max(80, CONFIG.WATCH_POOL_RANK * 3));
  const tickers = await fetchBinanceTickers(symbolList);
  const marketMap = tickers;

  const watchPool = buildWatchPool(history, marketMap, seedPool, blacklist);
  const zone = listRisingZone(history, marketMap, watchPool, blacklist);

  if (!seeded) {
    console.log(
      'auto-pin seed rising zone snap',
      JSON.stringify({ zone: zone.length, pool: watchPool.size }),
    );
    return emptyResult(pins, zone, true, events);
  }

  const prevSet = new Set(prevSnap);
  const zoneSet = new Set(zone);
  const edges = zone.filter((symbol) => !prevSet.has(symbol));
  // Always advance zone snap (even when cooldown skips writes), so flicker
  // does not keep re-firing the same edge every cycle.
  const newcomers = edges.filter((symbol) => !hasPin(pins, symbol));
  const rewarmCandidates = edges.filter((symbol) => hasPin(pins, symbol));
  const rewarmSkipped = rewarmCandidates.filter((symbol) =>
    isEdgeCooling(findPin(pins, symbol), now),
  );
  const rewarmed = rewarmCandidates.filter(
    (symbol) => !isEdgeCooling(findPin(pins, symbol), now),
  );
  const dropped = prevSnap.filter(
    (symbol) => symbol && !zoneSet.has(symbol) && hasPin(pins, symbol),
  );

  let pinsChanged = false;
  if (newcomers.length || rewarmed.length) {
    for (const symbol of newcomers) {
      const price = marketMap[symbol] && marketMap[symbol].price;
      pins = addPin(pins, symbol, price, 'auto-cloud', now);
    }
    for (const symbol of rewarmed) {
      const price = marketMap[symbol] && marketMap[symbol].price;
      pins = addPin(pins, symbol, price, 'auto-rewarm', now);
    }
    pinsChanged = true;
  }
  if (newcomers.length || rewarmed.length || dropped.length) {
    const nextEvents = [];
    if (newcomers.length) {
      nextEvents.push({
        at: now,
        symbols: newcomers.slice(),
        source: 'auto-cloud',
        kind: 'new',
      });
    }
    if (rewarmed.length) {
      nextEvents.push({
        at: now,
        symbols: rewarmed.slice(),
        source: 'auto-rewarm',
        kind: 'rewarm',
      });
    }
    if (dropped.length) {
      nextEvents.push({
        at: now,
        symbols: dropped.slice(),
        source: 'zone-drop',
        kind: 'zone-drop',
      });
    }
    events = [...nextEvents, ...events].slice(0, CONFIG.AUTO_PIN_EVENTS_MAX);
    console.log(
      'auto-pin zone edges',
      JSON.stringify({
        newcomers: newcomers.length,
        rewarmed: rewarmed.length,
        dropped: dropped.length,
        skippedCooling: rewarmSkipped.length,
        newSymbols: newcomers,
        rewarmSymbols: rewarmed,
        droppedSymbols: dropped,
        skippedSymbols: rewarmSkipped,
      }),
    );
  } else if (rewarmSkipped.length) {
    console.log(
      'auto-pin zone edges cooled',
      JSON.stringify({ skippedCooling: rewarmSkipped.length, skippedSymbols: rewarmSkipped }),
    );
  }

  return {
    pins,
    pinsChanged,
    newcomers,
    rewarmed,
    dropped,
    risingSnap: zone,
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
  listRisingZone,
  listRisingSymbols,
  CONFIG,
};
