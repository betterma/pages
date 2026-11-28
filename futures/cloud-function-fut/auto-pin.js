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
  NAILS_PATH: process.env.FUT_NAILS_PATH || 'futures/fut-nails.json',
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
  /** 自动盯 → 未置顶钉子（其余段）；对齐现货 notify.saveAutoPinNails */
  NAILS_WRITE_ENABLED:
    String(
      process.env.FUT_AUTO_PIN_NAILS_ENABLED === undefined
        ? '1'
        : process.env.FUT_AUTO_PIN_NAILS_ENABLED,
    ) !== '0',
};

const AUTO_PIN_NAIL_SOURCES = new Set(['auto-fut']);

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

function isAutoPinSource(source) {
  return AUTO_PIN_NAIL_SOURCES.has(String(source || '').trim());
}

function labelOf(symbol) {
  return String(symbol || '').replace(/USDT$/i, '');
}

function formatNailNotePrice(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || !(n > 0)) return '';
  if (n >= 1000) return n.toFixed(2);
  if (n >= 1) return n.toFixed(4);
  if (n >= 0.01) return n.toFixed(5);
  return n.toPrecision(4);
}

function pinPriceOf(pins, symbol) {
  const key = String(symbol || '')
    .trim()
    .toUpperCase();
  const row = normalizePinList(pins).find((item) => item.symbol === key);
  const price = row && Number(row.pinPrice);
  return Number.isFinite(price) && price > 0 ? price : null;
}

/**
 * 本轮新自动盯 → 写/刷新 fut-nails（pinned:false，进置顶分栏「其余」）；
 * 并补齐「已自动盯、钉子页却没有」的旧漏钉。
 * 补漏尊重 dismissedNails；新自动盯会清掉 dismissed 再钉入。
 * 对齐现货 cloud-function-notify/notify.js#saveAutoPinNails。
 */
async function saveFutAutoPinNails(now, newcomers, pins, priceBySymbol) {
  if (!CONFIG.NAILS_WRITE_ENABLED) {
    return { skipped: true, reason: 'disabled', added: 0, updated: 0 };
  }
  const forceSet = new Set(
    (newcomers || [])
      .map((symbol) => String(symbol || '').trim().toUpperCase())
      .filter(Boolean),
  );
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const file = await loadJson(CONFIG.NAILS_PATH);
    const prev = Array.isArray(file.data && file.data.nails)
      ? file.data.nails
      : [];
    const bySymbol = new Map();
    prev.forEach((item) => {
      const key = String((item && item.symbol) || '')
        .trim()
        .toUpperCase();
      if (key) bySymbol.set(key, item);
    });
    const dismissed = new Set(
      (Array.isArray(file.data && file.data.dismissedNails)
        ? file.data.dismissedNails
        : []
      )
        .map((symbol) => String(symbol || '').trim().toUpperCase())
        .filter(Boolean),
    );
    const backfillSet = new Set();
    (pins || []).forEach((row) => {
      if (!row || !isAutoPinSource(row.source)) return;
      const key = String(row.symbol || '')
        .trim()
        .toUpperCase();
      if (!key || bySymbol.has(key) || dismissed.has(key)) return;
      backfillSet.add(key);
    });
    const symbols = [...new Set([...forceSet, ...backfillSet])];
    if (!symbols.length) {
      return { skipped: false, added: 0, updated: 0, backfill: 0 };
    }

    const prices =
      priceBySymbol && typeof priceBySymbol === 'object' ? priceBySymbol : {};
    const added = [];
    const updated = [];
    for (const symbol of symbols) {
      const force = forceSet.has(symbol);
      if (force) {
        dismissed.delete(symbol);
      } else if (dismissed.has(symbol) || bySymbol.has(symbol)) {
        continue;
      }
      const live = prices[symbol] && Number(prices[symbol].price);
      const price =
        Number.isFinite(live) && live > 0 ? live : pinPriceOf(pins, symbol);
      const note = formatNailNotePrice(price);
      const existing = bySymbol.get(symbol) || null;
      if (existing) {
        if (!force) continue;
        // 已在钉子里：只刷新便签，不改 pinned / alwaysWatch。
        updated.push({
          ...existing,
          symbol,
          label: existing.label || labelOf(symbol),
          note,
          noteAt: note ? now : Number(existing.noteAt) || 0,
          at: now,
        });
      } else {
        added.push({
          id: `${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
          at: now,
          symbol,
          label: labelOf(symbol),
          note,
          noteAt: note ? now : 0,
          pinned: false,
          pinnedAt: 0,
          order: 0,
        });
      }
    }
    if (!added.length && !updated.length) {
      return { skipped: false, added: 0, updated: 0, backfill: 0 };
    }
    const updatedMap = new Map(updated.map((item) => [item.symbol, item]));
    const rest = prev.map((item) => {
      const key = String((item && item.symbol) || '')
        .trim()
        .toUpperCase();
      return updatedMap.get(key) || item;
    });
    const addedKeys = new Set(added.map((row) => row.symbol));
    const restWithoutDup = rest.filter((item) => {
      const key = String((item && item.symbol) || '')
        .trim()
        .toUpperCase();
      return !addedKeys.has(key);
    });
    const nails = [...added, ...restWithoutDup].map((item, order) => ({
      ...item,
      order,
    }));
    const backfillCount = added.filter((row) => !forceSet.has(row.symbol))
      .length;
    const alwaysWatch = Array.isArray(file.data && file.data.alwaysWatch)
      ? file.data.alwaysWatch
      : [];
    try {
      await saveJson(
        CONFIG.NAILS_PATH,
        {
          nails,
          alwaysWatch,
          alwaysWatchAt: Number(file.data && file.data.alwaysWatchAt) || 0,
          dismissedNails: [...dismissed],
          updatedAt: Date.now(),
          market: 'usdt-perp',
        },
        file.sha,
        `Fut auto-pin nails +${added.length} ~${updated.length}` +
          (backfillCount ? ` backfill ${backfillCount}` : ''),
      );
      return {
        skipped: false,
        added: added.length,
        updated: updated.length,
        backfill: backfillCount,
      };
    } catch (error) {
      lastError = error;
      const message = error && error.message ? error.message : String(error);
      if (!/409|conflict|sha/i.test(message)) break;
    }
  }
  console.warn(
    'save fut auto-pin nails failed',
    lastError && lastError.message ? lastError.message : lastError,
  );
  return {
    skipped: true,
    reason: 'save-failed',
    added: 0,
    updated: 0,
    error: lastError && lastError.message,
  };
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

  // 并行：币安 exchangeInfo / 黑名单 / prefs / pins / state；行情另拉（依赖 tradingSet）
  const [tradingSet, blacklist, prefRank, pinsFile, stateFile] =
    await Promise.all([
      fetchUsdtPerpTradingSet(),
      loadBlacklistSet(),
      loadWatchPoolRankFromPrefs(),
      loadJson(CONFIG.PINS_PATH),
      loadJson(CONFIG.STATE_PATH),
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

  let pins = normalizePinList(pinsFile.data && pinsFile.data.pins);
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
    const poolFile = await loadJson(CONFIG.POOL_PATH);
    await Promise.all([
      saveJson(
        CONFIG.STATE_PATH,
        seedState,
        stateFile.sha,
        `Fut seed zone snap ${pool.length}`,
      ),
      saveJson(
        CONFIG.POOL_PATH,
        {
          watchPool: pool.slice(),
          rank,
          updatedAt: now,
          market: 'usdt-perp',
        },
        poolFile.sha,
        `Fut watch pool ${pool.length}`,
      ),
    ]);
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

  // 对齐现货：自动盯 → fut-nails（pinned:false → 置顶分栏「其余」）。
  // 无 newcomers 时默认跳过（省一次 GitHub GET）；补漏开 FUT_NAILS_IDLE_BACKFILL=1。
  const idleBackfill = /^(1|true|yes)$/i.test(
    String(process.env.FUT_NAILS_IDLE_BACKFILL || ''),
  );
  let nailsWrite = { skipped: true, reason: 'not-run', added: 0, updated: 0 };
  if (newcomers.length || idleBackfill) {
    try {
      nailsWrite = await saveFutAutoPinNails(
        now,
        newcomers,
        normalizePinList(pins),
        marketMap,
      );
      console.log('fut-auto-pin nails', JSON.stringify(nailsWrite));
    } catch (error) {
      console.warn(
        'fut-auto-pin nails failed',
        error && error.message ? error.message : error,
      );
      nailsWrite = {
        skipped: true,
        reason: 'exception',
        added: 0,
        updated: 0,
        error: error && error.message,
      };
    }
  } else {
    nailsWrite = {
      skipped: true,
      reason: 'no-newcomers',
      added: 0,
      updated: 0,
      backfill: 0,
    };
    console.log('fut-auto-pin nails', JSON.stringify(nailsWrite));
  }

  // 池 + 状态并行写，避免串行 GitHub 在 3s 超时配额里叠爆
  console.log('fut-auto-pin write pool+state');
  await Promise.all([
    withConflictRetry(
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
    ),
    withConflictRetry(
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
    ),
  ]);

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
    nailsAdded: nailsWrite.added || 0,
    nailsUpdated: nailsWrite.updated || 0,
    nailsBackfill: nailsWrite.backfill || 0,
    nailsWrite,
  };
}

module.exports = {
  runFutAutoPin,
  saveFutAutoPinNails,
  normalizePinList,
  CONFIG,
};
