'use strict';

/**
 * 币安现货签名与下单（HMAC / Ed25519 PEM）。
 * 密钥只从 context / RUNTIME_USERDATA 读，不进仓库。
 */

const https = require('https');
const crypto = require('crypto');
const { getUserDataFirst } = require('./runtime-env');

const KEY_NAMES = [
  'BINANCE_API_KEY',
  'BINANCE_KEY',
  'BN_API_KEY',
  'BINANCE_APIKEY',
];
const SECRET_NAMES = [
  'BINANCE_API_SECRET',
  'BINANCE_SECRET',
  'BN_API_SECRET',
  'BINANCE_SECRET_KEY',
];

function reformatPemSingleLine(text) {
  const match = String(text || '').match(
    /-----BEGIN ([A-Z0-9 ]+)-----([A-Za-z0-9+/=\s]+)-----END \1-----/,
  );
  if (!match) return text;
  const label = match[1];
  const body = match[2].replace(/\s+/g, '');
  if (!body) return text;
  const lines = [];
  for (let i = 0; i < body.length; i += 64) {
    lines.push(body.slice(i, i + 64));
  }
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----`;
}

function normalizeSecret(raw) {
  let text = String(raw || '').trim();
  if (!text) return '';
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    text = text.slice(1, -1).trim();
  }
  if (text.includes('\\n')) text = text.replace(/\\n/g, '\n');
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  if (text.includes('BEGIN') && !text.includes('\n')) {
    text = reformatPemSingleLine(text);
  }
  return text.trim();
}

function isPemPrivateKey(secret) {
  const text = normalizeSecret(secret);
  return (
    text.includes('BEGIN PRIVATE KEY') ||
    text.includes('BEGIN RSA PRIVATE KEY') ||
    text.includes('BEGIN ENCRYPTED PRIVATE KEY')
  );
}

function signBinanceQuery(query, secret) {
  const material = normalizeSecret(secret);
  if (!material) throw new Error('Empty BINANCE_API_SECRET');
  if (isPemPrivateKey(material)) {
    const keyObject = crypto.createPrivateKey(material);
    return crypto
      .sign(null, Buffer.from(query, 'ascii'), keyObject)
      .toString('base64');
  }
  return crypto.createHmac('sha256', material).update(query).digest('hex');
}

function binanceConfig(context) {
  return {
    apiKey: getUserDataFirst(context, KEY_NAMES),
    apiSecret: getUserDataFirst(context, SECRET_NAMES),
    baseUrl:
      getUserDataFirst(context, ['BINANCE_API_BASE', 'BINANCE_BASE_URL']) ||
      'https://api.binance.com',
  };
}

function hasKeys(context) {
  const { apiKey, apiSecret } = binanceConfig(context);
  return !!(apiKey && apiSecret);
}

function requestJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(value);
    };
    const target = new URL(url);
    const req = https.request(
      target,
      {
        method: options.method || 'GET',
        headers: options.headers || {},
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let data = null;
          try {
            data = text ? JSON.parse(text) : null;
          } catch (error) {
            finish(
              new Error(
                `Binance JSON parse failed: ${res.statusCode} ${text.slice(0, 200)}`,
              ),
            );
            return;
          }
          finish(null, {
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            data,
            text,
          });
        });
        res.on('error', (error) => finish(error));
      },
    );
    req.on('error', (error) => finish(error));
    req.setTimeout(options.timeout || 20000, () => {
      req.destroy();
      finish(new Error(`Binance timeout: ${url}`));
    });
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function signedRequest(method, path, params, context) {
  const { apiKey, apiSecret, baseUrl } = binanceConfig(context);
  if (!apiKey || !apiSecret) {
    throw new Error('Missing BINANCE_API_KEY / BINANCE_API_SECRET');
  }
  const payload = {
    ...params,
    timestamp: Date.now(),
    recvWindow: 5000,
  };
  const query = new URLSearchParams(
    Object.entries(payload).reduce((map, [key, value]) => {
      if (value !== undefined && value !== null) map[key] = String(value);
      return map;
    }, {}),
  ).toString();
  const signature = signBinanceQuery(query, apiSecret);
  const url = `${baseUrl}${path}?${query}&signature=${encodeURIComponent(signature)}`;
  const response = await requestJson(url, {
    method: method || 'GET',
    headers: { 'X-MBX-APIKEY': apiKey },
  });
  if (!response.ok) {
    throw new Error(
      `Binance ${method} ${path} ${response.status} ${JSON.stringify(response.data).slice(0, 280)}`,
    );
  }
  return response.data;
}

async function publicGet(path, params, context) {
  const { baseUrl } = binanceConfig(context);
  const query = new URLSearchParams(
    Object.entries(params || {}).reduce((map, [key, value]) => {
      if (value !== undefined && value !== null) map[key] = String(value);
      return map;
    }, {}),
  ).toString();
  const url = query ? `${baseUrl}${path}?${query}` : `${baseUrl}${path}`;
  const response = await requestJson(url, { method: 'GET' });
  if (!response.ok) {
    throw new Error(
      `Binance GET ${path} ${response.status} ${JSON.stringify(response.data).slice(0, 200)}`,
    );
  }
  return response.data;
}

function filterValue(filters, filterType, field) {
  const row = (filters || []).find((f) => f.filterType === filterType);
  return row ? Number(row[field]) : NaN;
}

function floorToStep(value, step) {
  const n = Number(value);
  const s = Number(step);
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (!Number.isFinite(s) || s <= 0) return n;
  const precision = Math.max(0, (String(s).split('.')[1] || '').length);
  const units = Math.floor(n / s + 1e-12);
  return Number((units * s).toFixed(precision));
}

function alignPrice(price, tickSize) {
  const n = Number(price);
  const t = Number(tickSize);
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (!Number.isFinite(t) || t <= 0) return n;
  const precision = Math.max(0, (String(t).split('.')[1] || '').length);
  const units = Math.floor(n / t + 1e-12);
  return Number((units * t).toFixed(precision));
}

/** 卖单价向上靠档，避免 floor 后跌破最低卖出价。 */
function alignPriceCeil(price, tickSize) {
  const n = Number(price);
  const t = Number(tickSize);
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (!Number.isFinite(t) || t <= 0) return n;
  const precision = Math.max(0, (String(t).split('.')[1] || '').length);
  const units = Math.ceil(n / t - 1e-12);
  return Number((units * t).toFixed(precision));
}

const symbolFilterCache = new Map();

async function getSymbolFilters(symbol, context) {
  const key = String(symbol || '').toUpperCase();
  if (symbolFilterCache.has(key)) return symbolFilterCache.get(key);
  const info = await publicGet(
    '/api/v3/exchangeInfo',
    { symbol: key },
    context,
  );
  const row = (info.symbols || [])[0];
  if (!row) throw new Error(`exchangeInfo missing ${key}`);
  const filters = {
    stepSize: filterValue(row.filters, 'LOT_SIZE', 'stepSize'),
    minQty: filterValue(row.filters, 'LOT_SIZE', 'minQty'),
    tickSize: filterValue(row.filters, 'PRICE_FILTER', 'tickSize'),
    minNotional:
      filterValue(row.filters, 'NOTIONAL', 'minNotional') ||
      filterValue(row.filters, 'MIN_NOTIONAL', 'minNotional'),
  };
  symbolFilterCache.set(key, filters);
  return filters;
}

async function getBookTicker(symbol, context) {
  return publicGet(
    '/api/v3/ticker/bookTicker',
    { symbol: String(symbol).toUpperCase() },
    context,
  );
}

async function getAccount(context) {
  return signedRequest('GET', '/api/v3/account', {}, context);
}

async function getFreeBalance(asset, context) {
  const account = await getAccount(context);
  const key = String(asset || '').toUpperCase();
  const row = (account.balances || []).find(
    (b) => String(b.asset || '').toUpperCase() === key,
  );
  const free = Number(row && row.free);
  return Number.isFinite(free) && free > 0 ? free : 0;
}

async function limitSell(symbol, quantity, price, context) {
  return signedRequest(
    'POST',
    '/api/v3/order',
    {
      symbol: String(symbol).toUpperCase(),
      side: 'SELL',
      type: 'LIMIT',
      timeInForce: 'GTC',
      quantity: String(quantity),
      price: String(price),
      newOrderRespType: 'FULL',
    },
    context,
  );
}

async function limitBuy(symbol, quantity, price, context) {
  return signedRequest(
    'POST',
    '/api/v3/order',
    {
      symbol: String(symbol).toUpperCase(),
      side: 'BUY',
      type: 'LIMIT',
      timeInForce: 'GTC',
      quantity: String(quantity),
      price: String(price),
      newOrderRespType: 'FULL',
    },
    context,
  );
}

async function getOrder(symbol, orderId, context) {
  return signedRequest(
    'GET',
    '/api/v3/order',
    {
      symbol: String(symbol).toUpperCase(),
      orderId: String(orderId),
    },
    context,
  );
}

async function cancelOrder(symbol, orderId, context) {
  return signedRequest(
    'DELETE',
    '/api/v3/order',
    {
      symbol: String(symbol).toUpperCase(),
      orderId: String(orderId),
    },
    context,
  );
}

function fillAvgPrice(order) {
  const qty = Number(order && order.executedQty);
  const quote = Number(order && order.cummulativeQuoteQty);
  if (Number.isFinite(qty) && qty > 0 && Number.isFinite(quote) && quote > 0) {
    return quote / qty;
  }
  const px = Number(order && order.price);
  return Number.isFinite(px) && px > 0 ? px : null;
}

module.exports = {
  hasKeys,
  binanceConfig,
  getSymbolFilters,
  getBookTicker,
  getAccount,
  getFreeBalance,
  floorToStep,
  alignPrice,
  alignPriceCeil,
  limitSell,
  limitBuy,
  getOrder,
  cancelOrder,
  fillAvgPrice,
};
