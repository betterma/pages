'use strict';

/**
 * 持仓买入价 P → 固定止损任务（-3% 卖一半 / -5% 卖剩余，市价）。
 * 与限价「设置卖出」并存；取消记在 holdings.stopCancel。
 * 买入成交：加仓时按加权均价更新 P；页面手填 P 仍为覆盖。
 * 成交 / 保存 P 都会清 stopCancel 并按新 P 重挂两档。
 */

const { loadJson, saveJson } = require('./github-wecom');

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
 * 买入成交后：写 holdings.entryPrices，清空该币 stopCancel，种固定止损。
 * source=buy-fill 且提供 fillQty+prevQty（或 average:true）时做加权均价；
 * 页面手填 P 走 kline 自己的 patch，语义仍为覆盖。
 */
async function applyEntryPriceAndSeedStops(options) {
  const opts = options || {};
  const symbol = normalizeSymbol(opts.symbol);
  const fillPrice = Number(opts.price);
  const now = Number(opts.now) || Date.now();
  const source = opts.source ? String(opts.source) : 'manual';
  const wantAverage = opts.average === true || source === 'buy-fill';
  const result = {
    ok: false,
    reason: null,
    symbol,
    price: fillPrice,
    fillPrice,
    prevPrice: null,
    prevQty: null,
    fillQty: null,
    averaged: false,
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
  const holdings =
    holdingsFile.data && typeof holdingsFile.data === 'object'
      ? { ...holdingsFile.data }
      : {};
  const entryPrices =
    holdings.entryPrices && typeof holdings.entryPrices === 'object'
      ? { ...holdings.entryPrices }
      : {};
  const stopCancel =
    holdings.stopCancel && typeof holdings.stopCancel === 'object'
      ? { ...holdings.stopCancel }
      : {};

  let nextPrice = fillPrice;
  if (wantAverage) {
    const prevRow = entryPrices[symbol];
    const prevPrice = Number(prevRow && prevRow.price);
    const fillQty = Number(opts.fillQty);
    let prevQty = Number(opts.prevQty);
    if (!(prevQty > 0) && Number.isFinite(fillQty) && fillQty > 0) {
      // 未显式传旧仓时：用 holdings 余额（可能已含本笔）反推
      const asset = symbol.replace(/USDT$/i, '');
      const bal =
        holdings.balances && typeof holdings.balances === 'object'
          ? holdings.balances[asset]
          : null;
      const free = Number(bal && bal.free) || 0;
      const locked = Number(bal && bal.locked) || 0;
      const total = free + locked;
      if (total > 0) prevQty = Math.max(0, total - fillQty);
    }
    result.prevPrice = Number.isFinite(prevPrice) && prevPrice > 0 ? prevPrice : null;
    result.prevQty = Number.isFinite(prevQty) && prevQty > 0 ? prevQty : null;
    result.fillQty = Number.isFinite(fillQty) && fillQty > 0 ? fillQty : null;
    const averaged = computeWeightedEntryPrice(
      prevPrice,
      prevQty,
      fillPrice,
      fillQty,
    );
    if (averaged > 0) {
      nextPrice = averaged;
      result.averaged = !!(
        prevPrice > 0 &&
        prevQty > 0 &&
        fillQty > 0
      );
    }
  }

  result.price = nextPrice;
  entryPrices[symbol] = {
    price: nextPrice,
    at: now,
    source,
    ...(result.averaged
      ? {
          avgFrom: {
            prevPrice: result.prevPrice,
            prevQty: result.prevQty,
            fillPrice,
            fillQty: result.fillQty,
          },
        }
      : {}),
  };
  if (stopCancel[symbol]) delete stopCancel[symbol];
  const symbols = Array.isArray(holdings.symbols) ? holdings.symbols.slice() : [];
  if (!symbols.includes(symbol)) symbols.push(symbol);
  const nextHoldings = {
    ...holdings,
    symbols,
    entryPrices,
    stopCancel,
    updatedAt: now,
  };
  try {
    await saveJson(
      HOLDINGS_PATH,
      nextHoldings,
      holdingsFile.sha,
      result.averaged
        ? `Entry VWAP ${symbol} ${nextPrice}`
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
  computeWeightedEntryPrice,
  applyEntryPriceAndSeedStops,
};
