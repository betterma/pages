'use strict';

/**
 * Server-side auto-pin / zone-drop: 24h 前 N / 观察池
 * （默认前 30，不要求当前 4h 窗涨、不依赖窗起点价）。
 * 钉：边沿新进 ∪ 在池且未盯（补漏）；已盯不续温。
 * Snapshot lives in watch-notify-state.json as risingZoneSnap（语义=池区快照）。
 */

const {
  loadJson,
  saveJson,
  fetchBinanceTickers,
  requestRaw,
} = require('./github-wecom');

const CONFIG = {
  DATA_PATH: process.env.DATA_PATH || 'watch-data.json',
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
    // 只保留真 USDT 现货；丢掉非 USDT / 假双报价（ADAGBPUSDT）。
    if (!symbol || !symbol.endsWith('USDT')) return;
    const base = symbol.slice(0, -4);
    const badQuotes = [
      'USDC',
      'BUSD',
      'FDUSD',
      'TUSD',
      'BTC',
      'ETH',
      'BNB',
      'EUR',
      'GBP',
      'TRY',
      'BRL',
      'RUB',
    ];
    if (
      badQuotes.some((q) => base.endsWith(q) && base.length > q.length + 1)
    ) {
      return;
    }
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
  if (!key || !key.endsWith('USDT')) return normalizePinList(list);
  const base = key.slice(0, -4);
  if (
    ['USDC', 'BUSD', 'FDUSD', 'TUSD', 'BTC', 'ETH', 'BNB', 'EUR', 'GBP', 'TRY', 'BRL', 'RUB'].some(
      (q) => base.endsWith(q) && base.length > q.length + 1,
    )
  ) {
    return normalizePinList(list);
  }
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

function hydrateWatchDataLocal(data) {
  if (!data || typeof data !== 'object') return data;
  const history = Array.isArray(data.history) ? data.history : [];
  return {
    ...data,
    history: history.map((snap) => {
      if (!snap || typeof snap !== 'object') return snap;
      if (
        snap.ranks &&
        typeof snap.ranks === 'object' &&
        Object.keys(snap.ranks).length
      ) {
        return snap;
      }
      const list = Array.isArray(snap.r) ? snap.r : null;
      if (!list || !list.length) return snap;
      const ranks = {};
      list.forEach((symbol, index) => {
        const key = String(symbol || '')
          .trim()
          .toUpperCase();
        if (key) ranks[key] = index + 1;
      });
      return { ...snap, ranks };
    }),
  };
}

async function fetchWatchData() {
  // 只读 GitHub 热库（含紧凑名次 r[]）；不再回落 OBS。
  const file = await loadJson(CONFIG.DATA_PATH);
  if (file && file.data && isWatchDataUsable(file.data)) {
    return hydrateWatchDataLocal(file.data);
  }
  if (file && file.data) {
    throw new Error(
      `GitHub watch-data stale/unusable stamp=${watchDataStampMs(file.data)}`,
    );
  }
  throw new Error('GitHub watch-data missing');
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
    .filter(
      (symbol) =>
        /USDT$/i.test(String(symbol || '')) && !blacklist.has(symbol),
    );
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

/** 观察池 = 现货 24h 涨幅前 N（默认 30），跌出前 N / 拉黑则出池。不要求 4h 窗涨。 */
function buildWatchPool(history, marketMap, seedPool, blacklist) {
  const list = ranking(marketMap, blacklist);
  const next = new Set(
    (seedPool || [])
      .map((s) => String(s || '').toUpperCase())
      .filter((s) => s.endsWith('USDT')),
  );
  for (const symbol of [...next]) {
    const rank = list.indexOf(symbol) + 1;
    if (blacklist.has(symbol) || !rank || rank > CONFIG.WATCH_POOL_RANK) {
      next.delete(symbol);
    }
  }
  for (const symbol of list.slice(0, CONFIG.WATCH_POOL_RANK)) {
    if (blacklist.has(symbol)) continue;
    next.add(symbol);
  }
  return next;
}

/** UI list: zone ∩ not pinned. */
function listRisingSymbols(history, marketMap, watchPool, pinnedSet, blacklist) {
  return listRisingZone(history, marketMap, watchPool, blacklist).filter(
    (symbol) => !pinnedSet.has(symbol),
  );
}

/**
 * 自动盯边沿宇宙 = 观察池（≈24h 前 N），含已盯。
 * 不再过滤 hasWindowGain（榜高即可钉）。
 */
function listRisingZone(history, marketMap, watchPool, blacklist) {
  const list = ranking(marketMap, blacklist);
  const ranked = list.filter((symbol) => watchPool.has(symbol));
  const unranked = [...watchPool].filter(
    (symbol) =>
      String(symbol).endsWith('USDT') &&
      marketMap[symbol] &&
      !list.includes(symbol) &&
      !blacklist.has(symbol),
  );
  return [...ranked, ...unranked].filter(
    (symbol) =>
      String(symbol).endsWith('USDT') && !blacklist.has(symbol),
  );
}

function emptyResult(pins, snap, seeded, events) {
  return {
    pins,
    pinsChanged: false,
    newcomers: [],
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
  // Zone snap (v2) includes pinned; first deploy re-seeds without mass pin.
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
  const seedPool = (Array.isArray(watchData && watchData.watchPool)
    ? watchData.watchPool
    : []
  )
    .map((s) => String(s || '').trim().toUpperCase())
    .filter((s) => s.endsWith('USDT'));

  // 全市场 USDT 24hr，才能得到真实前 N（不能只拉池内子集再排名）。
  const marketMap = await fetchBinanceTickers(null);

  const watchPool = buildWatchPool(history, marketMap, seedPool, blacklist);
  const zone = listRisingZone(history, marketMap, watchPool, blacklist);

  if (!seeded) {
    console.log(
      'auto-pin seed pool-zone snap',
      JSON.stringify({ zone: zone.length, pool: watchPool.size }),
    );
    return emptyResult(pins, zone, true, events);
  }

  const prevSet = new Set(prevSnap);
  const zoneSet = new Set(zone);
  // 边沿新进 + 在池却未盯（snap 已含但漏钉）一律补钉；已盯不续温。
  // 始终推进 zone snap，避免闪烁重复边沿。
  const newcomers = zone.filter((symbol) => !hasPin(pins, symbol));
  const edgeNew = newcomers.filter((symbol) => !prevSet.has(symbol));
  const catchUp = newcomers.filter((symbol) => prevSet.has(symbol));
  const dropped = prevSnap.filter(
    (symbol) => symbol && !zoneSet.has(symbol) && hasPin(pins, symbol),
  );

  let pinsChanged = false;
  if (newcomers.length) {
    for (const symbol of newcomers) {
      const price = marketMap[symbol] && marketMap[symbol].price;
      pins = addPin(pins, symbol, price, 'auto-cloud', now);
    }
    pinsChanged = true;
  }
  if (newcomers.length || dropped.length) {
    const nextEvents = [];
    if (edgeNew.length) {
      nextEvents.push({
        at: now,
        symbols: edgeNew.slice(),
        source: 'auto-cloud',
        kind: 'new',
      });
    }
    if (catchUp.length) {
      nextEvents.push({
        at: now,
        symbols: catchUp.slice(),
        source: 'auto-cloud',
        kind: 'catch-up',
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
        edgeNew: edgeNew.length,
        catchUp: catchUp.length,
        dropped: dropped.length,
        newSymbols: newcomers,
        edgeSymbols: edgeNew,
        catchUpSymbols: catchUp,
        droppedSymbols: dropped,
      }),
    );
  }

  return {
    pins,
    pinsChanged,
    newcomers,
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
  loadBlacklistSet,
  listRisingZone,
  listRisingSymbols,
  CONFIG,
};
