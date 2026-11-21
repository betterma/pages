'use strict';

/**
 * 腾讯云 SCF（事件函数）+ 函数 URL —— 手动现价买/卖
 *
 * 与华为云定时器 / cloud-function-trade 完全独立：
 *   - 不读写任何状态文件
 *   - 只下币安市价单，返回成交结果；成本与止损由前端写 GitHub
 *
 * 路由（路径最后一段匹配）：
 *   GET  /ping
 *   GET  /balances   即时拉币安现货余额（供持有页刷新）
 *   POST /buy   {symbol, quote}
 *   POST /sell  {symbol, quantity}
 *
 * 鉴权：Authorization: Bearer <MANUAL_TRADE_TOKEN>
 * 执行方法：index.main_handler
 * 触发器：函数 URL（公网 + CORS + 授权开放）；地域用新加坡
 */
const binance = require('./binance');

const FEE_RATE = Number(process.env.TRADE_FEE_RATE || 0.001);

const CORS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

function normalizeSymbol(input) {
  const s = String(input || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  if (!s) return '';
  return s.endsWith('USDT') ? s : `${s}USDT`;
}

function getHeader(headers, name) {
  if (!headers || typeof headers !== 'object') return '';
  const want = String(name).toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLowerCase() !== want) continue;
    if (Array.isArray(value)) return String(value[0] || '');
    return String(value || '');
  }
  return '';
}

function authorized(event) {
  const expected = String(process.env.MANUAL_TRADE_TOKEN || '').trim();
  const header = getHeader(event.headers, 'Authorization');
  const supplied = header.replace(/^Bearer\s+/i, '').trim();
  return !!expected && !!supplied && supplied === expected;
}

function respond(statusCode, data) {
  return {
    isBase64Encoded: false,
    statusCode,
    headers: CORS,
    body: JSON.stringify(data),
  };
}

function routePath(event) {
  let path = String(event.path || (event.requestContext && event.requestContext.path) || '/');
  path = path.split('?')[0].replace(/\/+$/, '') || '/';
  const parts = path.split('/').filter(Boolean);
  const last = parts[parts.length - 1] || '';
  if (last === 'ping' || last === 'balances' || last === 'buy' || last === 'sell') {
    return `/${last}`;
  }
  return path.startsWith('/') ? path : `/${path}`;
}

function parseBody(event) {
  if (!event) return {};
  let text = event.body;
  if (text == null || text === '') return {};
  if (event.isBase64Encoded) {
    text = Buffer.from(String(text), 'base64').toString('utf8');
  }
  if (typeof text === 'object') return text;
  try {
    return JSON.parse(String(text));
  } catch (_) {
    throw new Error('请求体不是合法 JSON');
  }
}

function summarize(order, side) {
  const qty = binance.filledQtyFromOrder(order);
  const avg = binance.avgPriceFromOrder(order);
  const gross = Number(order.cummulativeQuoteQty) || (qty && avg ? qty * avg : 0);
  return {
    orderId: order.orderId,
    symbol: order.symbol,
    side,
    type: order.type,
    status: order.status,
    transactTime: order.transactTime,
    executedQty: qty,
    cummulativeQuoteQty: gross || null,
    avgPrice: avg,
    fee: gross * FEE_RATE,
  };
}

async function handleBuy(body) {
  const symbol = normalizeSymbol(body.symbol);
  const quote = Number(body.quote);
  if (!symbol) throw new Error('缺少 symbol');
  if (!(quote > 0)) throw new Error('quote 必须是大于 0 的 USDT 金额');
  if (quote < 5) throw new Error('币安市价单最小名义金额约 5 USDT');
  const spot = await binance.getPrice(symbol);
  const order = await binance.marketBuyQuote(symbol, quote);
  return {
    ok: true,
    action: 'manual_market_buy',
    at: new Date().toISOString(),
    spotBefore: spot,
    note: '手动现价单：不写入自动仓位，成本与止损由前端更新',
    order: summarize(order, 'BUY'),
  };
}

async function handleSell(body) {
  const symbol = normalizeSymbol(body.symbol);
  let quantity = Number(body.quantity);
  if (!symbol) throw new Error('缺少 symbol');
  if (!(quantity > 0)) throw new Error('quantity 必须是大于 0 的数量');
  const filters = await binance.getSymbolFilters(symbol);
  quantity = binance.floorToStep(quantity, filters.stepSize);
  if (!(quantity > 0)) {
    throw new Error(`数量按 stepSize 取整后为 0（stepSize=${filters.stepSize}）`);
  }
  if (filters.minQty > 0 && quantity < filters.minQty) {
    throw new Error(`数量 ${quantity} 小于币安最小下单量 ${filters.minQty}`);
  }
  const order = await binance.marketSellQty(symbol, quantity);
  return {
    ok: true,
    action: 'manual_market_sell',
    at: new Date().toISOString(),
    note: '手动现价单：不写入自动仓位',
    order: summarize(order, 'SELL'),
  };
}

async function handlePing() {
  let binanceOk = false;
  let binanceError = null;
  const base = process.env.BINANCE_API_BASE || 'https://api.binance.com';
  try {
    // short timeout so SCF 不会拖到平台 60s
    await binance.publicGet('/api/v3/ping', {}, { timeout: 8000 });
    binanceOk = true;
  } catch (error) {
    binanceError = error && error.message ? error.message : String(error);
  }
  return {
    ok: true,
    service: 'manual-tencent-scf',
    at: Date.now(),
    binanceBase: base,
    binanceOk,
    binanceError,
  };
}

async function handleBalances() {
  const live = await binance.getAccountBalances({ timeout: 15000 });
  return {
    ok: true,
    action: 'balances',
    at: live.at,
    balances: live.balances,
  };
}

exports.main_handler = async (event) => {
  const method = String(
    (event && event.httpMethod) ||
      (event && event.requestContext && event.requestContext.httpMethod) ||
      'GET',
  ).toUpperCase();

  if (method === 'OPTIONS') {
    return {
      isBase64Encoded: false,
      statusCode: 204,
      headers: CORS,
      body: '',
    };
  }

  if (!authorized(event || {})) {
    return respond(401, {
      ok: false,
      error: '未授权：请设置 Authorization: Bearer <MANUAL_TRADE_TOKEN>',
    });
  }

  const path = routePath(event || {});

  try {
    if (path === '/ping' && method === 'GET') {
      return respond(200, await handlePing());
    }
    if (path === '/balances' && (method === 'GET' || method === 'POST')) {
      return respond(200, await handleBalances());
    }
    if (path === '/buy' && method === 'POST') {
      return respond(200, await handleBuy(parseBody(event)));
    }
    if (path === '/sell' && method === 'POST') {
      return respond(200, await handleSell(parseBody(event)));
    }
    return respond(404, {
      ok: false,
      error: `未知端点 ${method} ${path}`,
    });
  } catch (error) {
    console.error('[manual-tencent] error', error && error.message ? error.message : error);
    return respond(500, {
      ok: false,
      error: error && error.message ? error.message : String(error),
    });
  }
};
