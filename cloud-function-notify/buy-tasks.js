'use strict';

/**
 * 限价买入任务：网页写入 watch-buy-tasks.json。
 * 花费 = USDT 可用 × buyPercent%；价格 = min(maxBuy||∞, ask)；LIMIT BUY。
 * 默认 dry-run；`live: true`（页面开关）才真下单。
 */

const { loadJson, saveJson } = require('./github-wecom');
const spot = require('./binance-spot');
const { appendTradeActionLog } = require('./trade-action-log');

const BUY_TASKS_PATH = process.env.BUY_TASKS_PATH || 'watch-buy-tasks.json';

function normalizeSymbol(raw) {
  let key = String(raw || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '');
  if (!key || key === 'USDT') return '';
  if (!key.endsWith('USDT')) key += 'USDT';
  return key;
}

function emptyState() {
  return { updatedAt: 0, live: false, tasks: [] };
}

function normalizeTask(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const symbol = normalizeSymbol(raw.symbol);
  if (!symbol) return null;
  const id =
    String(raw.id || '').trim() ||
    `${symbol}-${Number(raw.createdAt) || 0}`;
  let buyPercent = Number(raw.buyPercent);
  if (!Number.isFinite(buyPercent) || buyPercent <= 0) buyPercent = 100;
  if (buyPercent > 100) buyPercent = 100;
  const maxBuy = Number(raw.maxBuy);
  return {
    id,
    symbol,
    buyPercent,
    maxBuy: Number.isFinite(maxBuy) && maxBuy > 0 ? maxBuy : 0,
    enabled: raw.enabled !== false,
    status: String(raw.status || 'paused').toLowerCase(),
    openOrderId: raw.openOrderId != null ? String(raw.openOrderId) : null,
    lastPrice: Number(raw.lastPrice) || null,
    lastQty: Number(raw.lastQty) || null,
    wouldBuy: raw.wouldBuy && typeof raw.wouldBuy === 'object' ? raw.wouldBuy : null,
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
    live: data.live === true,
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
        'buy',
        task.symbol,
        task.lastPrice,
        task.lastQty,
      );
    } catch (error) {
      console.warn('buy fill log failed', error && error.message);
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
  const usdtFree = await spot.getFreeBalance('USDT', context);
  const spend = usdtFree * (task.buyPercent / 100);
  if (!(spend > 0)) {
    task.skipReason = 'no-usdt';
    task.wouldBuy = { usdtFree, spend: 0, buyPercent: task.buyPercent };
    task.updatedAt = Date.now();
    return 'skip';
  }

  const book = await spot.getBookTicker(task.symbol, context);
  const ask = Number(book.askPrice);
  if (!Number.isFinite(ask) || ask <= 0) {
    task.skipReason = 'no-ask';
    task.updatedAt = Date.now();
    return 'skip';
  }
  if (task.maxBuy > 0 && ask > task.maxBuy) {
    task.skipReason = 'above-maxBuy';
    task.wouldBuy = {
      usdtFree,
      spend,
      ask,
      maxBuy: task.maxBuy,
      price: null,
    };
    task.updatedAt = Date.now();
    return 'skip';
  }

  const cap = task.maxBuy > 0 ? task.maxBuy : ask;
  const price = spot.alignPrice(Math.min(cap, ask), filters.tickSize);
  if (!(price > 0)) {
    task.skipReason = 'bad-price';
    task.updatedAt = Date.now();
    return 'skip';
  }

  const rawQty = spend / price;
  const qty = spot.floorToStep(rawQty, filters.stepSize);
  if (!(qty > 0) || (Number.isFinite(filters.minQty) && qty < filters.minQty)) {
    task.skipReason = 'qty-too-small';
    task.wouldBuy = { usdtFree, spend, ask, price, qty: 0 };
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
    task.wouldBuy = { usdtFree, spend, ask, price, qty, notional };
    task.updatedAt = Date.now();
    return 'skip';
  }
  if (notional > usdtFree + 1e-12) {
    task.skipReason = 'insufficient-usdt';
    task.wouldBuy = { usdtFree, spend, ask, price, qty, notional };
    task.updatedAt = Date.now();
    return 'skip';
  }

  task.wouldBuy = {
    usdtFree,
    spend,
    qty,
    ask,
    price,
    notional,
    buyPercent: task.buyPercent,
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

  const order = await spot.limitBuy(task.symbol, qty, price, context);
  task.openOrderId = order.orderId != null ? String(order.orderId) : null;
  task.status = 'order_open';
  return 'placed';
}

async function runBuyTasks(options) {
  const opts = options || {};
  const now = Number(opts.now) || Date.now();
  const context = opts.context || null;
  const result = {
    skipped: false,
    reason: null,
    live: false,
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
    file = await loadJson(BUY_TASKS_PATH);
  } catch (error) {
    result.skipped = true;
    result.reason = `load-failed:${error.message || error}`;
    return result;
  }

  const state = normalizeState(file.data);
  const live = !!state.live;
  result.live = live;
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
    live: !!state.live,
    tasks: keptTasks.map((task) => {
      const copy = { ...task };
      delete copy._removeAfterFill;
      return copy;
    }),
  };
  try {
    await saveJson(
      BUY_TASKS_PATH,
      next,
      file.sha,
      `Buy tasks sync live=${live ? 1 : 0} dry=${result.dryRun} place=${result.placed} fill=${result.filled}`,
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
  runBuyTasks,
  normalizeState,
  normalizeTask,
  BUY_TASKS_PATH,
  buyLiveEnabled,
};
