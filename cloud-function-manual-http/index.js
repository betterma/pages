'use strict';

/**
 * 华为云 FunctionGraph HTTP 函数 —— 手动现价买/卖
 *
 * 常驻 Web 服务，监听 127.0.0.1:8000；由共享版 APIG 暴露公网 URL。
 * 与 cloud-function-trade（事件函数 + 5min 定时）完全独立：
 *   - 不读写 trade-bot-state.json / 任何状态文件
 *   - 只按现价下币安市价单，返回成交结果给前端
 *   - 成本价更新、止损重挂由前端拿返回值后写 GitHub
 *
 * 路由：
 *   GET  /ping                        健康检查
 *   POST /buy   {symbol, quote}       按 USDT 金额市价买入
 *   POST /sell  {symbol, quantity}    按数量市价卖出
 *
 * 鉴权：请求头 Authorization: Bearer <MANUAL_TRADE_TOKEN>
 */
const http = require('http');
const binance = require('./binance');

const PORT = 8000;
const FEE_RATE = Number(process.env.TRADE_FEE_RATE || 0.001);

function normalizeSymbol(input) {
  const s = String(input || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  if (!s) return '';
  return s.endsWith('USDT') ? s : `${s}USDT`;
}

function authorized(req) {
  const expected = String(process.env.MANUAL_TRADE_TOKEN || '');
  const header = String(req.headers.authorization || '');
  const supplied = header.replace(/^Bearer\s+/i, '').trim();
  return !!expected && !!supplied && supplied === expected;
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 64 * 1024) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch (_) {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
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
  // 现价校验，避免拿过期价格；同时给前端一个参考
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

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    });
    return res.end();
  }

  const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (!authorized(req)) {
    return sendJson(res, 401, {
      ok: false,
      error: '未授权：请设置 Authorization: Bearer <MANUAL_TRADE_TOKEN>',
    });
  }

  try {
    if (path === '/ping' && req.method === 'GET') {
      return sendJson(res, 200, { ok: true, service: 'manual-http', at: Date.now() });
    }
    if (path === '/buy' && req.method === 'POST') {
      return sendJson(res, 200, await handleBuy(await readBody(req)));
    }
    if (path === '/sell' && req.method === 'POST') {
      return sendJson(res, 200, await handleSell(await readBody(req)));
    }
    return sendJson(res, 404, { ok: false, error: '未知端点' });
  } catch (error) {
    console.error('[manual-http] error', error && error.message ? error.message : error);
    return sendJson(res, 500, {
      ok: false,
      error: error && error.message ? error.message : String(error),
    });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`manual-http listening on 127.0.0.1:${PORT}`);
});
