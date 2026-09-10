'use strict';

const githubState = require('./github-state');
const binance = require('./binance');

const WINDOW_MS = 4 * 60 * 60 * 1000;
const SELL_BUFFER = Number(process.env.TRADE_SELL_BUFFER || 0.005);
const REBUY_BUFFER = Number(process.env.TRADE_REBUY_BUFFER || 0.003);
const COOLDOWN_MS = Number(process.env.TRADE_COOLDOWN_MS || 10 * 60 * 1000);
const FEE_RATE = Number(process.env.TRADE_FEE_RATE || 0.001);
const MAX_LOGS = 200;

function tradeMode() {
  const mode = String(process.env.TRADE_MODE || 'paper').toLowerCase();
  return mode === 'live' ? 'live' : 'paper';
}

function windowStart(timestamp) {
  return Math.floor(Number(timestamp) / WINDOW_MS) * WINDOW_MS;
}

function pushLog(state, message, meta) {
  const entry = {
    at: Date.now(),
    source: (meta && meta.source) || 'timer',
    level: (meta && meta.level) || 'info',
    message: String(message),
  };
  const logs = Array.isArray(state.logs) ? state.logs.slice() : [];
  logs.unshift(entry);
  state.logs = logs.slice(0, MAX_LOGS);
  if (!Array.isArray(state._newLogs)) state._newLogs = [];
  state._newLogs.push(entry);
  console.log(`[trade-log][${entry.source}] ${entry.message}`);
}

function markEquity(state, price) {
  const px = Number.isFinite(price) ? price : Number(state.lastPrice);
  if (state.status === 'holding' && state.quantity > 0 && Number.isFinite(px)) {
    state.equity = state.quantity * px;
    state.cash = 0;
    return;
  }
  if (Number.isFinite(Number(state.cash))) {
    state.equity = Number(state.cash);
  }
}

async function getPrice(symbol) {
  return binance.getPrice(symbol);
}

async function getWindowOpen(symbol, atMs) {
  const ws = windowStart(atMs || Date.now());
  const open = await binance.getKlineOpen(symbol, '4h', ws);
  return { open, windowStartMs: ws };
}

/**
 * 成交适配层：paper 用公式模拟；live 走币安下单。
 * 以后真实交易主要改这里。
 */
async function executeBuy(symbol, quoteAmount, markPrice) {
  if (tradeMode() === 'live') {
    const order = await binance.marketBuyQuote(symbol, quoteAmount);
    return {
      quantity: binance.filledQtyFromOrder(order),
      avgPrice: binance.avgPriceFromOrder(order),
      fee: Number(order.cummulativeQuoteQty || quoteAmount) * FEE_RATE,
      raw: order,
    };
  }
  const fee = quoteAmount * FEE_RATE;
  const qty = (quoteAmount - fee) / markPrice;
  return { quantity: qty, avgPrice: markPrice, fee, raw: null };
}

async function executeSell(symbol, quantity, markPrice) {
  if (tradeMode() === 'live') {
    const order = await binance.marketSellQty(symbol, quantity);
    const avg = binance.avgPriceFromOrder(order) || markPrice;
    const gross = Number(order.cummulativeQuoteQty) || quantity * avg;
    return {
      avgPrice: avg,
      proceeds: gross * (1 - FEE_RATE),
      fee: gross * FEE_RATE,
      raw: order,
    };
  }
  const gross = quantity * markPrice;
  const fee = gross * FEE_RATE;
  return {
    avgPrice: markPrice,
    proceeds: gross - fee,
    fee,
    raw: null,
  };
}

async function applyTick(state) {
  const now = Date.now();
  state.lastCheckAt = now;
  state.mode = tradeMode();
  state._newLogs = [];

  pushLog(state, `[${state.mode}] 定时检测开始 symbol=${state.symbol || '-'} status=${state.status} enabled=${state.enabled}`);

  if (!state.enabled) {
    state.lastAction = 'tick_skipped';
    pushLog(state, `[${state.mode}] 检测跳过：自动检测已关闭`);
    return { skipped: true };
  }
  if (!state.symbol) {
    state.lastAction = 'tick_no_symbol';
    pushLog(state, `[${state.mode}] 检测跳过：无币种`);
    return { skipped: true };
  }

  const price = await getPrice(state.symbol);
  state.lastPrice = price;
  state.lastError = null;

  if (state.status === 'holding') {
    const ws = windowStart(now);
    if (state.windowStartMs !== ws) {
      const { open } = await getWindowOpen(state.symbol, now);
      pushLog(state, `换窗：起步价 ${state.anchorPrice} → ${open}`);
      state.anchorPrice = open;
      state.windowStartMs = ws;
    }
    const sellLine = state.anchorPrice * (1 - SELL_BUFFER);
    if (price <= sellLine) {
      const fill = await executeSell(state.symbol, state.quantity, price);
      state.cash = fill.proceeds;
      state.feesPaid = (state.feesPaid || 0) + fill.fee;
      state.quantity = 0;
      state.status = 'cooldown';
      state.cooldownUntil = now + COOLDOWN_MS;
      state.lastAction = 'sell_stop';
      markEquity(state, price);
      pushLog(
        state,
        `【${state.mode}卖出】现价 ${price} ≤ ${sellLine.toPrecision(6)}，到账 ${fill.proceeds.toFixed(2)}，冷静 10 分钟`,
      );
      return { sold: true };
    }
    markEquity(state, price);
    state.lastAction = 'hold';
    pushLog(
      state,
      `持仓中：现价 ${price}，卖出线 ${sellLine.toPrecision(6)}，权益 ${Number(state.equity).toFixed(2)}`,
    );
    return { holding: true };
  }

  if (state.status === 'cooldown') {
    if (!state.cooldownUntil || now >= state.cooldownUntil) {
      state.status = 'flat_rebuy';
      state.cooldownUntil = null;
      state.lastAction = 'cooldown_end';
      pushLog(state, '冷静期结束，等待回补');
    } else {
      const left = Math.ceil((state.cooldownUntil - now) / 60000);
      state.lastAction = 'cooldown';
      pushLog(state, `冷静期中，约剩 ${left} 分钟`);
    }
    markEquity(state, price);
    return { cooldown: true };
  }

  if (state.status === 'flat_rebuy') {
    const { open, windowStartMs } = await getWindowOpen(state.symbol, now);
    const rebuyLine = open * (1 + REBUY_BUFFER);
    const budget =
      Number.isFinite(state.cash) && state.cash > 0
        ? state.cash
        : state.quoteAmount;
    if (price >= rebuyLine && budget > 0) {
      const fill = await executeBuy(state.symbol, budget, price);
      if (!(fill.quantity > 0)) throw new Error('回补成交数量为 0');
      state.feesPaid = (state.feesPaid || 0) + fill.fee;
      state.quantity = fill.quantity;
      state.cash = 0;
      state.entryPrice = fill.avgPrice;
      state.anchorPrice = open;
      state.windowStartMs = windowStartMs;
      state.status = 'holding';
      state.lastAction = 'rebuy';
      markEquity(state, price);
      pushLog(
        state,
        `【${state.mode}回补】现价 ${price} ≥ ${rebuyLine.toPrecision(6)}，用 ${budget.toFixed(2)} USDT，起步价 ${open}`,
      );
      return { rebuy: true };
    }
    markEquity(state, price);
    state.lastAction = 'wait_rebuy';
    pushLog(
      state,
      `等待回补：现价 ${price}，回补线 ${rebuyLine.toPrecision(6)}，现金 ${Number(budget || 0).toFixed(2)}`,
    );
    return { waiting: true };
  }

  state.lastAction = 'idle';
  pushLog(state, '空闲，无持仓');
  return { idle: true };
}

async function runScheduledTick() {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const current = await githubState.loadState();
      if (!current.data) {
        console.log('[trade-log][timer] no state file, skip');
        return {
          ok: true,
          skipped: true,
          reason: 'no_state_file',
          mode: tradeMode(),
        };
      }
      const state = current.data;
      const meta = await applyTick(state);
      state.updatedAt = Date.now();
      const newLogs = Array.isArray(state._newLogs) ? state._newLogs.slice() : [];
      delete state._newLogs;
      await githubState.saveState(state, current.sha);
      await githubState.appendLogs(newLogs);
      return {
        ok: true,
        mode: tradeMode(),
        symbol: state.symbol,
        status: state.status,
        enabled: state.enabled,
        lastAction: state.lastAction,
        equity: state.equity,
        logCount: newLogs.length,
        meta,
      };
    } catch (error) {
      lastError = error;
      console.error('[trade-log][timer] error', error.message || error);
      if (error.code !== 'conflict') break;
    }
  }
  throw lastError || new Error('tick failed');
}

module.exports = {
  runScheduledTick,
  applyTick,
  tradeMode,
  executeBuy,
  executeSell,
};
