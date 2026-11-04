'use strict';

/**
 * 模拟盘固定止损：读 watch-sim-holdings + watch-sim-sell-tasks，
 * 用币安公开买一价判断触发，市价模拟成交（不写币安订单）。
 */

const { loadJson, saveJson } = require('./github');
const { getBookTicker } = require('./ticker');

const HOLDINGS_PATH =
  process.env.SIM_HOLDINGS_PATH || 'watch-sim-holdings.json';
const SELL_TASKS_PATH =
  process.env.SIM_SELL_TASKS_PATH || 'watch-sim-sell-tasks.json';
const FEE_RATE = Number(process.env.SIM_FEE_RATE);
const FEE = Number.isFinite(FEE_RATE) && FEE_RATE >= 0 ? FEE_RATE : 0.001;
const DUST_USDT = 0.01;

function normalizeSymbol(raw) {
  let key = String(raw || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '');
  if (!key || key === 'USDT') return '';
  if (!key.endsWith('USDT')) key += 'USDT';
  return key;
}

function baseAssetOf(symbol) {
  const key = normalizeSymbol(symbol);
  if (!key) return '';
  return key.endsWith('USDT') ? key.slice(0, -4) : key;
}

function cloneBalances(balances) {
  const out = {};
  const src = balances && typeof balances === 'object' ? balances : {};
  Object.keys(src).forEach((asset) => {
    const row = src[asset];
    out[asset] = {
      free: Number(row && row.free) || 0,
      locked: Number(row && row.locked) || 0,
      at: Number(row && row.at) || 0,
    };
  });
  return out;
}

function applyPaperSell(holdings, symbol, sellPercent, spot, now) {
  const key = normalizeSymbol(symbol);
  const pct = Number(sellPercent);
  const price = Number(spot);
  if (!key || !(price > 0) || !(pct > 0)) {
    return { ok: false, reason: 'bad-args' };
  }
  const balances = cloneBalances(holdings.balances);
  const asset = baseAssetOf(key);
  const free = Number(balances[asset] && balances[asset].free) || 0;
  const qty = free * (Math.min(100, pct) / 100);
  if (!(qty > 0)) return { ok: false, reason: 'no-qty' };
  const gross = qty * price;
  const fee = gross * FEE;
  const proceeds = gross - fee;
  balances[asset] = {
    free: Math.max(0, free - qty),
    locked: Number(balances[asset] && balances[asset].locked) || 0,
    at: now,
  };
  const usdtPrev = balances.USDT || { free: 0, locked: 0, at: 0 };
  balances.USDT = {
    free: (Number(usdtPrev.free) || 0) + proceeds,
    locked: Number(usdtPrev.locked) || 0,
    at: now,
  };
  const entryPrices =
    holdings.entryPrices && typeof holdings.entryPrices === 'object'
      ? { ...holdings.entryPrices }
      : {};
  const stopCancel =
    holdings.stopCancel && typeof holdings.stopCancel === 'object'
      ? { ...holdings.stopCancel }
      : {};
  const remain = Number(balances[asset].free) || 0;
  if (remain * price < DUST_USDT) {
    balances[asset] = { free: 0, locked: 0, at: now };
    delete entryPrices[key];
    delete stopCancel[key];
  }
  return {
    ok: true,
    fill: { symbol: key, price, qty, proceeds, fee, sellPercent: pct, at: now },
    holdings: {
      ...holdings,
      balances,
      entryPrices,
      stopCancel,
      updatedAt: now,
    },
  };
}

async function runSimStops(options) {
  const opts = options || {};
  const now = Number(opts.now) || Date.now();
  const retry = Number(opts._retry) || 0;
  const result = {
    checked: 0,
    filled: 0,
    skipped: 0,
    symbols: [],
    reason: null,
  };

  let holdingsFile;
  let sellFile;
  try {
    holdingsFile = await loadJson(HOLDINGS_PATH);
    sellFile = await loadJson(SELL_TASKS_PATH);
  } catch (error) {
    result.reason = `load:${error.message || error}`;
    return result;
  }

  let holdings =
    holdingsFile.data && typeof holdingsFile.data === 'object'
      ? { ...holdingsFile.data }
      : null;
  if (!holdings) {
    result.reason = 'no-holdings';
    return result;
  }
  const sellData =
    sellFile.data && typeof sellFile.data === 'object' ? sellFile.data : {};
  let tasks = Array.isArray(sellData.tasks) ? sellData.tasks.slice() : [];
  if (!tasks.length) {
    result.reason = 'no-tasks';
    return result;
  }

  const armed = tasks.filter((task) => {
    if (!task || String(task.kind || '').toLowerCase() !== 'stop') return false;
    if (task.enabled === false) return false;
    const st = String(task.status || '').toLowerCase();
    if (st === 'filled' || st === 'done' || st === 'paused') return false;
    return true;
  });
  // stop3 before stop5 so half-out happens first in same tick if both trigger.
  armed.sort((a, b) => {
    const as = a.stopKey === 'stop3' ? 0 : a.stopKey === 'stop5' ? 1 : 2;
    const bs = b.stopKey === 'stop3' ? 0 : b.stopKey === 'stop5' ? 1 : 2;
    return as - bs;
  });

  let dirtyHoldings = false;
  const filledIds = new Set();

  for (const task of armed) {
    result.checked += 1;
    const symbol = normalizeSymbol(task.symbol);
    const trigger = Number(task.triggerPrice);
    if (!symbol || !(trigger > 0)) {
      result.skipped += 1;
      continue;
    }
    let book;
    try {
      book = await getBookTicker(symbol);
    } catch (error) {
      // 常规未触发不写盘，避免每轮刷 GitHub。
      result.skipped += 1;
      continue;
    }
    const bid = Number(book.bidPrice);
    if (!(bid > 0) || bid > trigger) {
      result.skipped += 1;
      continue;
    }

    const sold = applyPaperSell(
      holdings,
      symbol,
      Number(task.sellPercent) || (task.stopKey === 'stop5' ? 100 : 50),
      bid,
      now,
    );
    if (!sold.ok) {
      result.skipped += 1;
      continue;
    }

    holdings = sold.holdings;
    dirtyHoldings = true;
    const stopCancel =
      holdings.stopCancel && typeof holdings.stopCancel === 'object'
        ? { ...holdings.stopCancel }
        : {};
    const row = { ...(stopCancel[symbol] || {}) };
    if (task.stopKey === 'stop3' || task.stopKey === 'stop5') {
      row[task.stopKey] = true;
      stopCancel[symbol] = row;
      holdings.stopCancel = stopCancel;
    }

    if (task.id != null) filledIds.add(String(task.id));
    result.filled += 1;
    result.symbols.push(`${symbol}:${task.stopKey || 'stop'}`);
  }

  if (!dirtyHoldings && !filledIds.size) {
    result.reason = 'ok';
    return result;
  }

  if (dirtyHoldings) {
    try {
      await saveJson(
        HOLDINGS_PATH,
        {
          ...holdings,
          updatedAt: now,
        },
        holdingsFile.sha,
        `Sim stop fill x${result.filled}`,
      );
    } catch (error) {
      if (error.code === 'conflict' && retry < 2) {
        return runSimStops({ now, _retry: retry + 1 });
      }
      result.reason = `holdings-save:${error.message || error}`;
      return result;
    }
  }

  if (filledIds.size) {
    const nextTasks = tasks.filter(
      (t) => t && !filledIds.has(String(t.id)),
    );
    try {
      await saveJson(
        SELL_TASKS_PATH,
        {
          updatedAt: now,
          live: false,
          tasks: nextTasks,
        },
        sellFile.sha,
        `Sim stop tasks x${result.filled}`,
      );
    } catch (error) {
      if (error.code === 'conflict' && retry < 2) {
        return runSimStops({ now, _retry: retry + 1 });
      }
      result.reason = `tasks-save:${error.message || error}`;
      return result;
    }
  }

  result.reason = 'ok';
  return result;
}

module.exports = {
  runSimStops,
  applyPaperSell,
};
