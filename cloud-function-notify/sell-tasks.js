'use strict';

/**
 * 限价卖出任务：网页写入 watch-sell-tasks.json，本模块在 notify 定时里执行。
 * 默认 dry-run（SELL_LIVE≠1 不下单）；数量=可用×%，价格=max(minSell, bid)。
 */

const { loadJson, saveJson } = require('./github-wecom');
const spot = require('./binance-spot');
const { appendTradeActionLog } = require('./trade-action-log');

const SELL_TASKS_PATH = process.env.SELL_TASKS_PATH || 'watch-sell-tasks.json';

function sellLiveEnabled() {
  const raw = String(process.env.SELL_LIVE || '')
    .trim()
    .toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

function baseAssetOf(symbol) {
  const key = String(symbol || '')
    .trim()
    .toUpperCase();
  if (!key) return '';
  if (key === 'USDT') return 'USDT';
  return key.endsWith('USDT') ? key.slice(0, -4) : key;
}

function normalizeSymbol(raw) {
  let key = String(raw || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '');
  if (!key) return '';
  if (key === 'USDT') return '';
  if (!key.endsWith('USDT')) key += 'USDT';
  return key;
}

function emptyState() {
  return { updatedAt: 0, tasks: [] };
}

function normalizeTask(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const symbol = normalizeSymbol(raw.symbol);
  if (!symbol) return null;
  const id = String(raw.id || '').trim() || `${symbol}-${Number(raw.createdAt) || 0}`;
  let sellPercent = Number(raw.sellPercent);
  if (!Number.isFinite(sellPercent) || sellPercent <= 0) sellPercent = 100;
  if (sellPercent > 100) sellPercent = 100;
  const minSell = Number(raw.minSell);
  const status = String(raw.status || 'paused').toLowerCase();
  return {
    id,
    symbol,
    sellPercent,
    minSell: Number.isFinite(minSell) && minSell > 0 ? minSell : 0,
    enabled: raw.enabled !== false,
    status,
    openOrderId: raw.openOrderId != null ? String(raw.openOrderId) : null,
    lastPrice: Number(raw.lastPrice) || null,
    lastQty: Number(raw.lastQty) || null,
    wouldSell: raw.wouldSell && typeof raw.wouldSell === 'object' ? raw.wouldSell : null,
    skipReason: raw.skipReason ? String(raw.skipReason) : null,
    lastError: raw.lastError ? String(raw.lastError).slice(0, 240) : null,
    createdAt: Number(raw.createdAt) || 0,
    updatedAt: Number(raw.updatedAt) || 0,
  };
}

function normalizeState(raw) {
  const data = raw && typeof raw === 'object' ? raw : {};
  const seen = new Set();
  const tasks = [];
  (Array.isArray(data.tasks) ? data.tasks : []).forEach((item) => {
    const task = normalizeTask(item);
    if (!task || seen.has(task.id)) return;
    seen.add(task.id);
    tasks.push(task);
  });
  return {
    updatedAt: Number(data.updatedAt) || 0,
    tasks,
  };
}

async function pollOpenOrder(task, context) {
  const order = await spot.getOrder(task.symbol, task.openOrderId, context);
  const status = String(order.status || '').toUpperCase();
  task.updatedAt = Date.now();
  if (status === 'FILLED') {
    task.status = 'filled';
    task.enabled = false;
    task.openOrderId = null;
    task.skipReason = null;
    task.lastError = null;
    task.lastQty = Number(order.executedQty) || task.lastQty;
    task.lastPrice = Number(order.price) || task.lastPrice;
    task._removeAfterFill = true;
    try {
      await appendTradeActionLog(
        'sell',
        task.symbol,
        task.lastPrice,
        task.lastQty,
      );
    } catch (error) {
      console.warn('sell fill log failed', error && error.message);
    }
    return 'filled';
  }
  if (status === 'CANCELED' || status === 'REJECTED' || status === 'EXPIRED') {
    task.status = 'armed';
    task.openOrderId = null;
    task.skipReason = `order-${status.toLowerCase()}`;
    return 'rearmed';
  }
  if (status === 'PARTIALLY_FILLED') {
    task.status = 'partial';
    task.lastQty = Number(order.executedQty) || task.lastQty;
    return 'partial';
  }
  task.status = 'order_open';
  return 'open';
}

async function planAndMaybePlace(task, context, live) {
  const filters = await spot.getSymbolFilters(task.symbol, context);
  const asset = baseAssetOf(task.symbol);
  const free = await spot.getFreeBalance(asset, context);
  const rawQty = free * (task.sellPercent / 100);
  const qty = spot.floorToStep(rawQty, filters.stepSize);
  if (!(qty > 0) || (Number.isFinite(filters.minQty) && qty < filters.minQty)) {
    task.skipReason = 'qty-too-small';
    task.wouldSell = { free, qty: 0, sellPercent: task.sellPercent };
    task.updatedAt = Date.now();
    return 'skip';
  }

  const book = await spot.getBookTicker(task.symbol, context);
  const bid = Number(book.bidPrice);
  if (!Number.isFinite(bid) || bid <= 0) {
    task.skipReason = 'no-bid';
    task.updatedAt = Date.now();
    return 'skip';
  }
  if (task.minSell > 0 && bid < task.minSell) {
    task.skipReason = 'below-minSell';
    task.wouldSell = {
      free,
      qty,
      bid,
      minSell: task.minSell,
      price: null,
    };
    task.updatedAt = Date.now();
    return 'skip';
  }

  const price = spot.alignPrice(Math.max(task.minSell || 0, bid), filters.tickSize);
  if (!(price > 0)) {
    task.skipReason = 'bad-price';
    task.updatedAt = Date.now();
    return 'skip';
  }
  const notional = qty * price;
  if (
    Number.isFinite(filters.minNotional) &&
    filters.minNotional > 0 &&
    notional < filters.minNotional
  ) {
    task.skipReason = 'below-minNotional';
    task.wouldSell = { free, qty, bid, price, notional };
    task.updatedAt = Date.now();
    return 'skip';
  }

  task.wouldSell = {
    free,
    qty,
    bid,
    price,
    notional,
    sellPercent: task.sellPercent,
    live: !!live,
  };
  task.skipReason = null;
  task.lastError = null;
  task.lastQty = qty;
  task.lastPrice = price;
  task.updatedAt = Date.now();

  if (!live) {
    task.status = 'armed';
    task.skipReason = 'dry-run';
    return 'dry-run';
  }

  const order = await spot.limitSell(task.symbol, qty, price, context);
  task.openOrderId = order.orderId != null ? String(order.orderId) : null;
  task.status = 'order_open';
  return 'placed';
}

/**
 * @returns {Promise<object>}
 */
async function runSellTasks(options) {
  const opts = options || {};
  const now = Number(opts.now) || Date.now();
  const context = opts.context || null;
  const live = sellLiveEnabled();
  const result = {
    skipped: false,
    reason: null,
    live,
    hasKeys: spot.hasKeys(context),
    checked: 0,
    dryRun: 0,
    placed: 0,
    filled: 0,
    skippedTask: 0,
    errors: [],
  };

  if (!result.hasKeys) {
    result.skipped = true;
    result.reason = 'missing-api-keys';
    return result;
  }

  let file;
  try {
    file = await loadJson(SELL_TASKS_PATH);
  } catch (error) {
    result.skipped = true;
    result.reason = `load-failed:${error.message || error}`;
    return result;
  }

  const state = normalizeState(file.data);
  if (!state.tasks.length) {
    result.skipped = true;
    result.reason = 'no-tasks';
    return result;
  }

  let changed = false;
  for (const task of state.tasks) {
    if (!task.enabled) continue;
    if (task.status === 'filled' || task.status === 'done') continue;
    if (task.status === 'paused') continue;
    result.checked += 1;
    try {
      if (task.openOrderId) {
        const poll = await pollOpenOrder(task, context);
        changed = true;
        if (poll === 'filled') result.filled += 1;
        continue;
      }
      if (
        task.status === 'armed' ||
        task.status === 'error' ||
        task.status === 'partial'
      ) {
        const action = await planAndMaybePlace(task, context, live);
        changed = true;
        if (action === 'dry-run') result.dryRun += 1;
        else if (action === 'placed') result.placed += 1;
        else if (action === 'skip') result.skippedTask += 1;
      }
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      task.lastError = message.slice(0, 240);
      task.status = 'error';
      task.updatedAt = now;
      changed = true;
      result.errors.push(`${task.symbol}:${message.slice(0, 120)}`);
    }
  }

  const keptTasks = state.tasks.filter((task) => !task._removeAfterFill);
  if (keptTasks.length !== state.tasks.length) changed = true;

  if (!changed) {
    result.reason = 'no-change';
    return result;
  }

  const next = {
    updatedAt: now,
    tasks: keptTasks.map((task) => {
      const copy = { ...task };
      delete copy._removeAfterFill;
      return copy;
    }),
  };
  try {
    await saveJson(
      SELL_TASKS_PATH,
      next,
      file.sha,
      `Sell tasks sync dry=${result.dryRun} place=${result.placed} fill=${result.filled}`,
    );
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    if (/409|conflict|sha/i.test(message)) {
      result.skipped = true;
      result.reason = 'conflict';
      return result;
    }
    throw error;
  }

  result.reason = 'ok';
  return result;
}

module.exports = {
  runSellTasks,
  normalizeState,
  normalizeTask,
  SELL_TASKS_PATH,
  sellLiveEnabled,
};
