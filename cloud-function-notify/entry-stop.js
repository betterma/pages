'use strict';

/**
 * 持仓买入价 P → 固定止损任务（-3% 卖一半 / -5% 卖剩余，市价）。
 * 与限价「设置卖出」并存；取消过的固定档记在 holdings.stopCancel，避免自动复活。
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
 * 写入/刷新固定止损（尊重 stopCancel；改 P 时应先清空该币 cancel）。
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
 * 买入成交或手填 P 后：写 holdings.entryPrices，清空该币 stopCancel，种固定止损。
 */
async function applyEntryPriceAndSeedStops(options) {
  const opts = options || {};
  const symbol = normalizeSymbol(opts.symbol);
  const price = Number(opts.price);
  const now = Number(opts.now) || Date.now();
  const source = opts.source ? String(opts.source) : 'manual';
  const result = {
    ok: false,
    reason: null,
    symbol,
    price,
    seeded: false,
  };
  if (!symbol || !(price > 0)) {
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
  entryPrices[symbol] = { price, at: now, source };
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
      `Entry price ${symbol} ${price}`,
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
    price,
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
  applyEntryPriceAndSeedStops,
};
