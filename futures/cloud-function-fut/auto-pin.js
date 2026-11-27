'use strict';

/**
 * 合约只读自动盯：U 本位永续 24h 涨幅前 N → 观察池 → 边沿新进写入 fut-auto-pins.json。
 * 不读不写仓库根目录任何 watch-*.json；不调用现货模块。
 */

const { loadJson, saveJson } = require('./github');
const {
  fetchUsdtPerpTradingSet,
  fetchFutTickers,
} = require('./binance-fapi');

const CONFIG = {
  PINS_PATH: process.env.FUT_PINS_PATH || 'futures/fut-auto-pins.json',
  POOL_PATH: process.env.FUT_POOL_PATH || 'futures/fut-watch-pool.json',
  STATE_PATH: process.env.FUT_STATE_PATH || 'futures/fut-notify-state.json',
  BLACKLIST_PATH:
    process.env.FUT_BLACKLIST_PATH || 'futures/fut-blacklist.json',
  PREFS_PATH: process.env.FUT_PREFS_PATH || 'futures/fut-prefs.json',
  WATCH_POOL_RANK_DEFAULT: 35,
  WATCH_POOL_RANK_MIN: 10,
  WATCH_POOL_RANK_MAX: 100,
  WATCH_POOL_RANK: Number(process.env.FUT_WATCH_POOL_RANK || 35),
  AUTO_PIN_EVENTS_MAX: Number(process.env.FUT_AUTO_PIN_EVENTS_MAX || 40),
  ENABLED:
    String(
      process.env.FUT_AUTO_PIN_ENABLED === undefined
        ? '1'
        : process.env.FUT_AUTO_PIN_ENABLED,
    ) !== '0',
};

/** 内置过滤：稳定币 / 法币计价伪合约基名 */
const BUILTIN_BLOCK_BASES = new Set([
  'USDC',
  'BUSD',
  'FDUSD',
  'TUSD',
  'USDP',
  'DAI',
  'EUR',
  'GBP',
  'TRY',
  'BRL',
  'RUB',
]);

function normalizeWatchPoolRank(raw) {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n)) return CONFIG.WATCH_POOL_RANK_DEFAULT;
  return Math.min(
    CONFIG.WATCH_POOL_RANK_MAX,
    Math.max(CONFIG.WATCH_POOL_RANK_MIN, n),
  );
}

function baseOf(symbol) {
  const key = String(symbol || '')
    .trim()
    .toUpperCase();
  if (!key.endsWith('USDT')) return '';
  return key.slice(0, -4);
}

function isBlockedSymbol(symbol, blacklist) {
  const key = String(symbol || '')
    .trim()
    .toUpperCase();
  if (!key.endsWith('USDT')) return true;
  if (blacklist && blacklist.has(key)) return true;
  const base = baseOf(key);
  if (!base || BUILTIN_BLOCK_BASES.has(base)) return true;
  return false;
}

function normalizePinList(raw) {
  if (!Array.isArray(raw)) return [];
  const map = new Map();
  raw.forEach((item) => {
    if (!item || !item.symbol) return;
    const symbol = String(item.symbol).trim().toUpperCase();
    if (!symbol.endsWith('USDT')) return;
    const pinnedAt = Number(item.pinnedAt) || 0;
    const pinPrice = Number(item.pinPrice);
    const source = item.source ? String(item.source) : 'auto-fut';
    const change24h = Number(item.change24h);
    const prev = map.get(symbol);
    if (!prev || pinnedAt >= prev.pinnedAt) {
      map.set(symbol, {
        symbol,
        pinnedAt,
        pinPrice: Number.isFinite(pinPrice) ? pinPrice : null,
        change24h: Number.isFinite(change24h) ? change24h : null,
        source,
        market: 'usdt-perp',
      });
    }
  });
  return [...map.values()].sort((a, b) => {
    if (b.pinnedAt !== a.pinnedAt) return b.pinnedAt - a.pinnedAt;
    return a.symbol.localeCompare(b.symbol);
  });
}

function hasPin(list, symbol) {
  const key = String(symbol || '')
    .trim()
    .toUpperCase();
  return normalizePinList(list).some((item) => item.symbol === key);
}

function addPin(list, symbol, price, change24h, source, now) {
  const key = String(symbol || '')
    .trim()
    .toUpperCase();
  if (!key.endsWith('USDT')) return normalizePinList(list);
  const ts = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const next = normalizePinList(list).filter((item) => item.symbol !== key);
  next.unshift({
    symbol: key,
    pinnedAt: ts,
    pinPrice: Number.isFinite(Number(price)) ? Number(price) : null,
    change24h: Number.isFinite(Number(change24h)) ? Number(change24h) : null,
    source: source || 'auto-fut',
    market: 'usdt-perp',
  });
  return next;
}

function ranking(marketMap, blacklist) {
  return Object.entries(marketMap || {})
    .filter(([symbol]) => !isBlockedSymbol(symbol, blacklist))
    .sort((a, b) => (b[1].change24h || 0) - (a[1].change24h || 0))
    .map(([symbol]) => symbol);
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
    console.warn(
      'fut blacklist load failed',
      error && error.message ? error.message : error,
    );
    return new Set();
  }
}

async function loadWatchPoolRankFromPrefs() {
  try {
    const file = await loadJson(CONFIG.PREFS_PATH);
    if (file && file.data && file.data.watchPoolRank != null) {
      return normalizeWatchPoolRank(file.data.watchPoolRank);
    }
  } catch (error) {
    console.warn(
      'fut prefs load failed',
      error && error.message ? error.message : error,
    );
  }
  return normalizeWatchPoolRank(CONFIG.WATCH_POOL_RANK);
}

async function withConflictRetry(path, mutate, message) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const file = await loadJson(path);
      const result = mutate(file.data, file.sha);
      if (result && result.skipWrite) {
        return { data: result.data, skipped: true };
      }
      await saveJson(
        path,
        result.data,
        file.sha,
        message || `Update ${path}`,
      );
      return { data: result.data, skipped: false };
    } catch (error) {
      lastError = error;
      if (!error || error.code !== 'conflict') throw error;
    }
  }
  throw lastError || new Error(`save ${path} failed`);
}

/**
 * 一轮合约自动盯。
 */
async function runFutAutoPin(options) {
  const now = Number(options && options.now) || Date.now();

  if (!CONFIG.ENABLED) {
    return { skipped: true, reason: 'disabled' };
  }

  const [tradingSet, blacklist, prefRank] = await Promise.all([
    fetchUsdtPerpTradingSet(),
    loadBlacklistSet(),
    loadWatchPoolRankFromPrefs(),
  ]);
  const rank = normalizeWatchPoolRank(
    (options && options.watchPoolRank) || prefRank || CONFIG.WATCH_POOL_RANK,
  );
  CONFIG.WATCH_POOL_RANK = rank;
  const marketMap = await fetchFutTickers(tradingSet);
  const ranked = ranking(marketMap, blacklist);
  const pool = ranked.slice(0, rank);
  const poolSet = new Set(pool);

  console.log(
    'fut-auto-pin pool',
    JSON.stringify({
      rank,
      pool: pool.length,
      universe: Object.keys(marketMap).length,
      trading: tradingSet.size,
    }),
  );

  const pinsFile = await loadJson(CONFIG.PINS_PATH);
  let pins = normalizePinList(pinsFile.data && pinsFile.data.pins);
  const stateFile = await loadJson(CONFIG.STATE_PATH);
  const prevState =
    stateFile.data && typeof stateFile.data === 'object' ? stateFile.data : {};
  const prevSnap = Array.isArray(prevState.risingZoneSnap)
    ? prevState.risingZoneSnap.map(String)
    : [];
  let seeded = !!prevState.risingZoneSnapSeeded;
  let events = Array.isArray(prevState.autoPinEvents)
    ? prevState.autoPinEvents.slice()
    : [];

  // 首次部署只播种快照，避免把整池一次性钉满。
  if (!seeded) {
    const seedState = {
      risingZoneSnap: pool.slice(),
      risingZoneSnapSeeded: true,
      autoPinEvents: [],
      updatedAt: now,
    };
    await saveJson(
      CONFIG.STATE_PATH,
      seedState,
      stateFile.sha,
      `Fut seed zone snap ${pool.length}`,
    );
    await saveJson(
      CONFIG.POOL_PATH,
      {
        watchPool: pool.slice(),
        rank,
        updatedAt: now,
        market: 'usdt-perp',
      },
      (await loadJson(CONFIG.POOL_PATH)).sha,
      `Fut watch pool ${pool.length}`,
    );
    return {
      skipped: false,
      seeded: true,
      pool: pool.length,
      newcomers: [],
      pins: pins.length,
    };
  }

  const prevSet = new Set(prevSnap);
  const newcomers = pool.filter((symbol) => !hasPin(pins, symbol));
  const edgeNew = newcomers.filter((symbol) => !prevSet.has(symbol));
  const catchUp = newcomers.filter((symbol) => prevSet.has(symbol));
  const dropped = prevSnap.filter(
    (symbol) => symbol && !poolSet.has(symbol) && hasPin(pins, symbol),
  );

  let pinsChanged = false;
  if (newcomers.length) {
    for (const symbol of newcomers) {
      const row = marketMap[symbol] || {};
      pins = addPin(
        pins,
        symbol,
        row.price,
        row.change24h,
        'auto-fut',
        now,
      );
    }
    pinsChanged = true;
  }

  if (newcomers.length || dropped.length) {
    const nextEvents = [];
    if (edgeNew.length) {
      nextEvents.push({
        at: now,
        symbols: edgeNew.slice(),
        source: 'auto-fut',
        kind: 'new',
      });
    }
    if (catchUp.length) {
      nextEvents.push({
        at: now,
        symbols: catchUp.slice(),
        source: 'auto-fut',
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
      'fut-auto-pin edges',
      JSON.stringify({
        newcomers: newcomers.length,
        edgeNew: edgeNew.length,
        catchUp: catchUp.length,
        dropped: dropped.length,
        newSymbols: newcomers,
      }),
    );
  }

  if (pinsChanged) {
    await withConflictRetry(
      CONFIG.PINS_PATH,
      () => ({
        data: {
          pins: normalizePinList(pins),
          pinsUpdatedAt: now,
          market: 'usdt-perp',
          updatedAt: now,
        },
      }),
      `Fut auto-pin ${pins.length} (+${newcomers.length})`,
    );
  }

  await withConflictRetry(
    CONFIG.POOL_PATH,
    () => ({
      data: {
        watchPool: pool.slice(),
        rank,
        updatedAt: now,
        market: 'usdt-perp',
      },
    }),
    `Fut watch pool ${pool.length}`,
  );

  await withConflictRetry(
    CONFIG.STATE_PATH,
    () => ({
      data: {
        risingZoneSnap: pool.slice(),
        risingZoneSnapSeeded: true,
        autoPinEvents: events,
        updatedAt: now,
      },
    }),
    `Fut notify state zone=${pool.length}`,
  );

  return {
    skipped: false,
    seeded: false,
    pool: pool.length,
    rank,
    newcomers: newcomers.length,
    edgeNew: edgeNew.length,
    catchUp: catchUp.length,
    dropped: dropped.length,
    pins: normalizePinList(pins).length,
    pinsChanged,
  };
}

module.exports = {
  runFutAutoPin,
  normalizePinList,
  CONFIG,
};
