'use strict';

/**
 * 闄愪环鍗栧嚭浠诲姟锛氱綉椤靛啓鍏?watch-sell-tasks.json锛屾湰妯″潡鍦?notify 瀹氭椂閲屾墽琛屻€?
 * 榛樿 dry-run锛沗live: true`锛堥〉闈㈠紑鍏冲啓鍏?JSON锛夋墠鐪熶笅鍗曘€?
 * 鏁伴噺=鍙敤脳%锛屼环鏍?max(minSell, bid)銆?
 */

const { loadJson, saveJson } = require('./github-wecom');
const spot = require('./binance-spot');
const { appendTradeActionLog } = require('./trade-action-log');

const SELL_TASKS_PATH = process.env.SELL_TASKS_PATH || 'watch-sell-tasks.json';

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
  return { updatedAt: 0, live: false, tasks: [] };
}

function normalizeTask(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const symbol = normalizeSymbol(raw.symbol);
  if (!symbol) return null;
  const kind =
    String(raw.kind || '')
      .trim()
      .toLowerCase() === 'stop'
      ? 'stop'
      : 'limit';
  const stopKeyRaw = String(raw.stopKey || '')
    .trim()
    .toLowerCase();
  const stopKey =
    kind === 'stop' && (stopKeyRaw === 'stop3' || stopKeyRaw === 'stop5')
      ? stopKeyRaw
      : kind === 'stop'
        ? 'stop3'
        : null;
  const id =
    String(raw.id || '').trim() ||
    (kind === 'stop' && stopKey
      ? `${symbol}-${stopKey}`
      : `${symbol}-${Number(raw.createdAt) || 0}`);
  let sellPercent = Number(raw.sellPercent);
  if (!Number.isFinite(sellPercent) || sellPercent <= 0) sellPercent = 100;
  if (sellPercent > 100) sellPercent = 100;
  const minSell = Number(raw.minSell);
  const triggerPrice = Number(raw.triggerPrice);
  const entryPrice = Number(raw.entryPrice);
  const status = String(raw.status || 'paused').toLowerCase();
  const orderType =
    kind === 'stop' ||
    String(raw.orderType || '')
      .trim()
      .toUpperCase() === 'MARKET'
      ? 'MARKET'
      : 'LIMIT';
  return {
    id,
    symbol,
    kind,
    stopKey,
    orderType,
    sellPercent,
    minSell:
      kind === 'stop'
        ? 0
        : Number.isFinite(minSell) && minSell > 0
          ? minSell
          : 0,
    triggerPrice:
      kind === 'stop' && Number.isFinite(triggerPrice) && triggerPrice > 0
        ? triggerPrice
        : null,
    entryPrice:
      Number.isFinite(entryPrice) && entryPrice > 0 ? entryPrice : null,
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
    task.lastPrice = spot.fillAvgPrice(order) || Number(order.price) || task.lastPrice;
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
  const isStop =
    String(task.kind || '') === 'stop' || task.orderType === 'MARKET';
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

  if (isStop) {
    const trigger = Number(task.triggerPrice);
    if (!(Number.isFinite(trigger) && trigger > 0)) {
      task.skipReason = 'bad-trigger';
      task.updatedAt = Date.now();
      return 'skip';
    }
    if (bid > trigger) {
      task.skipReason = 'above-trigger';
      task.wouldSell = { free, qty, bid, triggerPrice: trigger, price: null };
      task.updatedAt = Date.now();
      return 'skip';
    }
    const stopNotional = qty * bid;
    if (
      Number.isFinite(filters.minNotional) &&
      filters.minNotional > 0 &&
      stopNotional < filters.minNotional
    ) {
      task.skipReason = 'below-minNotional';
      task.wouldSell = {
        free,
        qty,
        bid,
        triggerPrice: trigger,
        notional: stopNotional,
      };
      task.updatedAt = Date.now();
      return 'skip';
    }
    task.wouldSell = {
      free,
      qty,
      bid,
      triggerPrice: trigger,
      price: bid,
      notional: stopNotional,
      sellPercent: task.sellPercent,
      orderType: 'MARKET',
      live: !!live,
    };
    task.skipReason = null;
    task.lastError = null;
    task.lastQty = qty;
    task.lastPrice = bid;
    task.updatedAt = Date.now();
    if (!live) {
      task.status = 'armed';
      task.skipReason = 'dry-run';
      return 'dry-run';
    }
    const mkt = await spot.marketSell(task.symbol, qty, context);
    task.openOrderId = mkt.orderId != null ? String(mkt.orderId) : null;
    const mktStatus = String(mkt.status || '').toUpperCase();
    task.lastQty = Number(mkt.executedQty) || qty;
    task.lastPrice = spot.fillsAvgPrice(mkt) || Number(mkt.price) || bid;
    if (mktStatus === 'FILLED' || Number(mkt.executedQty) > 0) {
      task.status = 'filled';
      task.enabled = false;
      task.openOrderId = null;
      task.skipReason = null;
      task.lastError = null;
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
    task.status = 'order_open';
    return 'placed';
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

  let price = spot.alignPriceCeil(
    Math.max(task.minSell || 0, bid),
    filters.tickSize,
  );
  if (task.minSell > 0 && price + 1e-12 < task.minSell) {
    price = spot.alignPriceCeil(task.minSell, filters.tickSize);
  }
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
  const placeStatus = String(order.status || '').toUpperCase();
  if (placeStatus === 'FILLED') {
    task.status = 'filled';
    task.enabled = false;
    task.openOrderId = null;
    task.skipReason = null;
    task.lastError = null;
    task.lastQty = Number(order.executedQty) || qty;
    task.lastPrice = spot.fillAvgPrice(order) || price;
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
  task.status = 'order_open';
  return 'placed';
}

async function cancelAndDrop(task, context) {
  if (task.openOrderId) {
    try {
      await spot.cancelOrder(task.symbol, task.openOrderId, context);
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      // 宸叉垚浜?宸叉挙閿€锛氫粛鍏佽浠庝换鍔″垪琛ㄧЩ闄?
      if (!/UNKNOWN_ORDER|does not exist|-2011|-2013/i.test(message)) {
        throw error;
      }
    }
  }
  task.openOrderId = null;
  task._removeAfterFill = true;
  task.status = 'canceled';
  task.enabled = false;
  task.updatedAt = Date.now();
  return 'canceled';
}

/**
 * @returns {Promise<object>}
 */
async function runSellTasks(options) {
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
    canceled: 0,
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
  const live = !!state.live;
  result.live = live;
  if (!state.tasks.length) {
    result.skipped = true;
    result.reason = 'no-tasks';
    return result;
  }

  let changed = false;
  // 跳空：同币若已触及 -5%，本轮只打 stop5，跳过 stop3。
  const stopSkipIds = new Set();
  const armedStops = state.tasks.filter(
    (t) =>
      t &&
      t.kind === 'stop' &&
      t.enabled !== false &&
      (t.status === 'armed' || t.status === 'error' || t.status === 'partial') &&
      !t.openOrderId,
  );
  const bySym = new Map();
  armedStops.forEach((t) => {
    const key = String(t.symbol || '').toUpperCase();
    if (!bySym.has(key)) bySym.set(key, []);
    bySym.get(key).push(t);
  });
  for (const [, list] of bySym) {
    const s5 = list.find((t) => t.stopKey === 'stop5');
    const s3 = list.find((t) => t.stopKey === 'stop3');
    if (!s5 || !s3) continue;
    const trigger5 = Number(s5.triggerPrice);
    if (!(trigger5 > 0)) continue;
    try {
      const book = await spot.getBookTicker(s5.symbol, context);
      const bid = Number(book.bidPrice);
      if (Number.isFinite(bid) && bid > 0 && bid <= trigger5) {
        stopSkipIds.add(s3.id);
        s3.skipReason = 'superseded-by-stop5';
        s3.updatedAt = now;
        changed = true;
      }
    } catch (_) {
      /* ignore book peek */
    }
  }

  for (const task of state.tasks) {
    if (task.status === 'filled' || task.status === 'done') continue;
    result.checked += 1;
    try {
      if (task.status === 'cancel_requested') {
        await cancelAndDrop(task, context);
        changed = true;
        result.canceled += 1;
        continue;
      }
      if (!task.enabled) continue;
      if (task.status === 'paused') {
        if (task.openOrderId) {
          const poll = await pollOpenOrder(task, context);
          changed = true;
          if (poll === 'filled') result.filled += 1;
        }
        continue;
      }
      if (task.openOrderId) {
        const poll = await pollOpenOrder(task, context);
        changed = true;
        if (poll === 'filled') result.filled += 1;
        continue;
      }
      if (stopSkipIds.has(task.id)) {
        result.skippedTask += 1;
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
        else if (action === 'filled') {
          result.filled += 1;
          // -5% 全出后丢掉同币未完成的 -3% 固定档
          if (task.kind === 'stop' && task.stopKey === 'stop5') {
            state.tasks.forEach((other) => {
              if (
                other &&
                other.symbol === task.symbol &&
                other.kind === 'stop' &&
                other.stopKey === 'stop3' &&
                !other.openOrderId
              ) {
                other._removeAfterFill = true;
                other.status = 'canceled';
                other.enabled = false;
                other.skipReason = 'superseded-by-stop5';
              }
            });
          }
        } else if (action === 'skip') result.skippedTask += 1;
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
      SELL_TASKS_PATH,
      next,
      file.sha,
      `Sell tasks sync live=${live ? 1 : 0} dry=${result.dryRun} place=${result.placed} fill=${result.filled} cancel=${result.canceled}`,
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
};
