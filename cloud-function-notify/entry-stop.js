'use strict';

/**
 * 持仓买入价 P → 固定止损任务（-3% 卖一半 / -5% 卖剩余，市价）。
 * 与限价「设置卖出」并存；取消记在 holdings.stopCancel。
 * 买入成交：加一笔 open lot，entryPrices 写剩余 VWAP 供止损；页面手填 P 仍为覆盖成单笔。
 * 成交 / 保存 P 都会清 stopCancel 并按新 P 重挂两档。
 */

const { loadJson, saveJson } = require('./github-wecom');
const {
  addBuyLot,
  replaceLotsWithSingle,
  lotsVwap,
  migrateEntryLotsFromPrices,
} = require('./trade-pnl');

const HOLDINGS_PATH = process.env.HOLDINGS_PATH || 'watch-holdings.json';
const SELL_TASKS_PATH = process.env.SELL_TASKS_PATH || 'watch-sell-tasks.json';
const STOP3_PCT = 0.03;
const STOP5_PCT = 0.05;

function normalizeSymbol(raw) {
  let key = String(raw || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '');
  if (!key || key === 'USDT') return '';
  if (!key.endsWith('USDT')) key += 'USDT';
  return key;
}

function stopId(symbol, stopKey) {
  return `${symbol}-${stopKey}`;
}

function buildStopTask(symbol, stopKey, entryPrice, now) {
  const pct = stopKey === 'stop5' ? STOP5_PCT : STOP3_PCT;
  const sellPercent = stopKey === 'stop5' ? 100 : 50;
  const trigger = Number(entryPrice) * (1 - pct);
  return {
    id: stopId(symbol, stopKey),
    symbol,
    kind: 'stop',
    stopKey,
    orderType: 'MARKET',
    sellPercent,
    minSell: 0,
    triggerPrice: trigger,
    entryPrice: Number(entryPrice),
    enabled: true,
    status: 'armed',
    openOrderId: null,
    lastPrice: null,
    lastQty: null,
    wouldSell: null,
    skipReason: null,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * 写入/刷新固定止损（仍尊重传入的 stopCancel；调用方若要重挂应先清 cancel）。
 * @returns {object[]} next tasks
 */
function upsertFixedStopTasks(tasks, symbol, entryPrice, stopCancel, now) {
  const key = normalizeSymbol(symbol);
  const price = Number(entryPrice);
  if (!key || !(price > 0)) return Array.isArray(tasks) ? tasks.slice() : [];
  const list = Array.isArray(tasks) ? tasks.slice() : [];
  const cancel =
    stopCancel && typeof stopCancel === 'object' ? stopCancel[key] || {} : {};
  const ts = Number.isFinite(Number(now)) ? Number(now) : Date.now();

  ['stop3', 'stop5'].forEach((stopKey) => {
    if (cancel[stopKey]) return;
    const id = stopId(key, stopKey);
    const next = buildStopTask(key, stopKey, price, ts);
    const idx = list.findIndex((t) => t && String(t.id) === id);
    if (idx >= 0) {
      const prev = list[idx];
      // 已挂单/撤单中的不打断
      if (
        prev.openOrderId ||
        prev.status === 'order_open' ||
        prev.status === 'partial' ||
        prev.status === 'cancel_requested'
      ) {
        return;
      }
      list[idx] = {
        ...prev,
        ...next,
        createdAt: prev.createdAt || ts,
        updatedAt: ts,
      };
    } else {
      list.unshift(next);
    }
  });
  return list;
}

function dropFixedStopTasks(tasks, symbol) {
  const key = normalizeSymbol(symbol);
  if (!key) return Array.isArray(tasks) ? tasks.slice() : [];
  return (Array.isArray(tasks) ? tasks : []).filter((t) => {
    if (!t || String(t.symbol).toUpperCase() !== key) return true;
    if (String(t.kind || '').toLowerCase() !== 'stop') return true;
    return false;
  });
}

/**
 * 卖光 / 灰尘：清掉该币全部监控任务；已挂单标 cancel_requested，其余删除。
 * @param {object[]} tasks
 * @param {string|string[]} symbols
 * @param {number} [now]
 */
function dropAllSymbolTradeTasks(tasks, symbols, now) {
  const list = Array.isArray(symbols) ? symbols : [symbols];
  const drop = new Set(
    list.map((s) => normalizeSymbol(s)).filter(Boolean),
  );
  if (!drop.size) return Array.isArray(tasks) ? tasks.slice() : [];
  const ts = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const next = [];
  (Array.isArray(tasks) ? tasks : []).forEach((task) => {
    if (!task) return;
    const sym = String(task.symbol || '')
      .trim()
      .toUpperCase();
    if (!drop.has(sym)) {
      next.push(task);
      return;
    }
    if (task.openOrderId) {
      next.push({
        ...task,
        status: 'cancel_requested',
        enabled: true,
        updatedAt: ts,
      });
    }
  });
  return next;
}

/**
 * 加仓加权均价：P' = (prevQty×prevP + fillQty×fillP) / (prevQty+fillQty)。
 * 缺旧仓/旧 P 时退回 fillP。
 */
function computeWeightedEntryPrice(prevPrice, prevQty, fillPrice, fillQty) {
  const p0 = Number(prevPrice);
  const q0 = Number(prevQty);
  const p1 = Number(fillPrice);
  const q1 = Number(fillQty);
  if (!(p1 > 0) || !(q1 > 0)) return null;
  if (!(p0 > 0) || !(q0 > 0)) return p1;
  const total = q0 + q1;
  if (!(total > 0)) return p1;
  return (q0 * p0 + q1 * p1) / total;
}

/**
 * 买入成交后：加 open lot（或无 qty 时覆盖成单笔），清空 stopCancel，种固定止损。
 * source=buy-fill 且提供 fillQty 时走 addBuyLot；页面手填 P 走 kline 自己的 patch。
 * fillQty 应为钱包净到账量（已扣标的币手续费）；由 buy-tasks.resolveBuyNetQty 或页面 order.netQty 传入。
 */
async function applyEntryPriceAndSeedStops(options) {
  const opts = options || {};
  const symbol = normalizeSymbol(opts.symbol);
  const fillPrice = Number(opts.price);
  const now = Number(opts.now) || Date.now();
  const source = opts.source ? String(opts.source) : 'manual';
  const fillQty = Number(opts.fillQty);
  const result = {
    ok: false,
    reason: null,
    symbol,
    price: fillPrice,
    fillPrice,
    prevPrice: null,
    prevQty: null,
    fillQty: Number.isFinite(fillQty) && fillQty > 0 ? fillQty : null,
    averaged: false,
    lotAdded: false,
    seeded: false,
  };
  if (!symbol || !(fillPrice > 0)) {
    result.reason = 'bad-args';
    return result;
  }

  let holdingsFile;
  try {
    holdingsFile = await loadJson(HOLDINGS_PATH);
  } catch (error) {
    result.reason = `holdings-load:${error.message || error}`;
    return result;
  }
  let holdings =
    holdingsFile.data && typeof holdingsFile.data === 'object'
      ? { ...holdingsFile.data }
      : {};
  // 旧数据仅有 entryPrices：先迁移出 lots，再加仓
  holdings.entryLots = migrateEntryLotsFromPrices(holdings);

  let nextHoldings;
  if (result.fillQty > 0) {
    const prevLots =
      holdings.entryLots && holdings.entryLots[symbol]
        ? holdings.entryLots[symbol]
        : [];
    result.prevQty = prevLots.reduce(
      (sum, lot) => sum + (Number(lot.qty) || 0),
      0,
    );
    result.prevPrice = lotsVwap(prevLots);
    const added = addBuyLot(holdings, {
      symbol,
      qty: result.fillQty,
      price: fillPrice,
      at: now,
      source,
    });
    nextHoldings = added.holdings;
    result.lotAdded = !!added.lot;
    result.averaged = !!(result.prevQty > 0);
  } else {
    const replaced = replaceLotsWithSingle(holdings, {
      symbol,
      price: fillPrice,
      at: now,
      source,
    });
    nextHoldings = replaced.holdings;
  }

  const stopCancel =
    nextHoldings.stopCancel && typeof nextHoldings.stopCancel === 'object'
      ? nextHoldings.stopCancel
      : {};
  const nextPrice =
    Number(
      nextHoldings.entryPrices &&
        nextHoldings.entryPrices[symbol] &&
        nextHoldings.entryPrices[symbol].price,
    ) || fillPrice;
  result.price = nextPrice;

  try {
    await saveJson(
      HOLDINGS_PATH,
      nextHoldings,
      holdingsFile.sha,
      result.lotAdded
        ? `Entry lot ${symbol} ${fillPrice} → VWAP ${nextPrice}`
        : `Entry price ${symbol} ${nextPrice}`,
    );
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    if (/409|conflict|sha/i.test(message)) {
      result.reason = 'holdings-conflict';
      return result;
    }
    throw error;
  }

  let sellFile;
  try {
    sellFile = await loadJson(SELL_TASKS_PATH);
  } catch (error) {
    result.reason = `sell-load:${error.message || error}`;
    result.ok = true;
    return result;
  }
  const sellData =
    sellFile.data && typeof sellFile.data === 'object' ? sellFile.data : {};
  const tasks = upsertFixedStopTasks(
    sellData.tasks,
    symbol,
    nextPrice,
    stopCancel,
    now,
  );
  try {
    await saveJson(
      SELL_TASKS_PATH,
      {
        updatedAt: now,
        live: sellData.live === true,
        tasks,
      },
      sellFile.sha,
      `Seed stop tasks ${symbol}`,
    );
    result.seeded = true;
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    if (/409|conflict|sha/i.test(message)) {
      result.reason = 'sell-conflict';
      result.ok = true;
      return result;
    }
    throw error;
  }

  result.ok = true;
  result.reason = 'ok';
  return result;
}

module.exports = {
  STOP3_PCT,
  STOP5_PCT,
  normalizeSymbol,
  stopId,
  buildStopTask,
  upsertFixedStopTasks,
  dropFixedStopTasks,
  dropAllSymbolTradeTasks,
  computeWeightedEntryPrice,
  applyEntryPriceAndSeedStops,
};
