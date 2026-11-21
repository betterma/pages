'use strict';

const https = require('https');
const crypto = require('crypto');

function binanceConfig() {
  return {
    apiKey: String(process.env.BINANCE_API_KEY || '').trim(),
    apiSecret: String(process.env.BINANCE_API_SECRET || '').trim(),
    baseUrl: String(
      process.env.BINANCE_API_BASE || 'https://api.binance.com',
    ).trim().replace(/\/+$/, ''),
  };
}

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

function secretKindOf(secret) {
  if (!secret) return 'none';
  if (!isPemPrivateKey(secret)) return 'hmac';
  const text = normalizeSecret(secret);
  try {
    const keyObject = crypto.createPrivateKey(text);
    const type = keyObject.asymmetricKeyType || '';
    if (type === 'ed25519') return 'ed25519';
    if (type === 'rsa') return 'rsa';
    return `pem:${type || 'unknown'}`;
  } catch (error) {
    return 'pem-invalid';
  }
}

function requestJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeoutMs = options.timeout || 12000;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      if (error) reject(error);
      else resolve(value);
    };

    const target = new URL(url);
    // 用 pathname+search 固定查询串，避免 URL 对象重编码导致签名不一致
    const request = https.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || undefined,
        path: `${target.pathname}${target.search}`,
        method: options.method || 'GET',
        headers: options.headers || {},
        timeout: timeoutMs,
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let data = null;
          try {
            data = text ? JSON.parse(text) : null;
          } catch (error) {
            finish(
              new Error(
                `Binance JSON parse failed: ${response.statusCode} ${text.slice(0, 200)}`,
              ),
            );
            return;
          }
          finish(null, {
            ok: response.statusCode >= 200 && response.statusCode < 300,
            status: response.statusCode,
            data,
            text,
          });
        });
        response.on('error', (error) => finish(error));
      },
    );

    const hardTimer = setTimeout(() => {
      request.destroy();
      finish(new Error(`Binance timeout after ${timeoutMs}ms: ${url}`));
    }, timeoutMs);

    request.on('timeout', () => {
      request.destroy();
      finish(new Error(`Binance socket timeout: ${url}`));
    });
    request.on('socket', (socket) => {
      socket.setTimeout(timeoutMs);
      socket.on('timeout', () => {
        request.destroy();
        finish(new Error(`Binance connect timeout: ${url}`));
      });
    });
    request.on('error', (error) => finish(error));
    if (options.body) request.write(options.body);
    request.end();
  });
}

async function publicGet(path, params = {}, options = {}) {
  const { baseUrl } = binanceConfig();
  const query = new URLSearchParams(params).toString();
  const url = `${baseUrl}${path}${query ? `?${query}` : ''}`;
  const response = await requestJson(url, {
    method: 'GET',
    timeout: options.timeout,
  });
  if (!response.ok) {
    throw new Error(
      `Binance GET ${path} failed: ${response.status} ${JSON.stringify(response.data).slice(0, 240)}`,
    );
  }
  return response.data;
}

async function signedRequest(method, path, params = {}, options = {}) {
  const { apiKey, apiSecret, baseUrl } = binanceConfig();
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
    method,
    timeout: options.timeout,
    headers: {
      'X-MBX-APIKEY': apiKey,
    },
  });
  if (!response.ok) {
    throw new Error(
      `Binance ${method} ${path} failed: ${response.status} ${JSON.stringify(response.data).slice(0, 300)}`,
    );
  }
  return response.data;
}

async function getAccountBalances(options = {}) {
  const account = await signedRequest('GET', '/api/v3/account', {}, options);
  const now = Date.now();
  const balances = {};
  (account.balances || []).forEach((row) => {
    const asset = String((row && row.asset) || '').toUpperCase();
    if (!asset) return;
    const free = Number(row.free) || 0;
    const locked = Number(row.locked) || 0;
    if (asset !== 'USDT' && free <= 0 && locked <= 0) return;
    balances[asset] = { free, locked, at: now };
  });
  if (!balances.USDT) {
    balances.USDT = { free: 0, locked: 0, at: now };
  }
  return { at: now, balances };
}

async function getPrice(symbol) {
  const data = await publicGet('/api/v3/ticker/price', { symbol });
  const price = Number(data.price);
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error(`Invalid price for ${symbol}`);
  }
  return price;
}

async function getKlineOpen(symbol, interval, windowStartMs) {
  const rows = await publicGet('/api/v3/klines', {
    symbol,
    interval,
    startTime: windowStartMs,
    limit: 1,
  });
  if (!Array.isArray(rows) || !rows.length) {
    throw new Error(`No kline for ${symbol} ${interval} @ ${windowStartMs}`);
  }
  const open = Number(rows[0][1]);
  if (!Number.isFinite(open) || open <= 0) {
    throw new Error(`Invalid kline open for ${symbol}`);
  }
  return open;
}

async function getSymbolFilters(symbol) {
  const info = await publicGet('/api/v3/exchangeInfo', { symbol });
  const item = info.symbols && info.symbols[0];
  if (!item) throw new Error(`exchangeInfo missing ${symbol}`);
  const lot = item.filters.find((f) => f.filterType === 'LOT_SIZE');
  const minNotional =
    item.filters.find((f) => f.filterType === 'NOTIONAL') ||
    item.filters.find((f) => f.filterType === 'MIN_NOTIONAL');
  return {
    stepSize: lot ? Number(lot.stepSize) : 0.0001,
    minQty: lot ? Number(lot.minQty) : 0,
    minNotional: minNotional
      ? Number(minNotional.minNotional || minNotional.notional || 5)
      : 5,
  };
}

function floorToStep(value, step) {
  if (!step || step <= 0) return value;
  const precision = Math.max(0, Math.round(-Math.log10(step)));
  const floored = Math.floor(value / step) * step;
  return Number(floored.toFixed(precision));
}

async function marketBuyQuote(symbol, quoteOrderQty) {
  return signedRequest('POST', '/api/v3/order', {
    symbol,
    side: 'BUY',
    type: 'MARKET',
    quoteOrderQty: Number(quoteOrderQty).toFixed(2),
  });
}

async function marketSellQty(symbol, quantity) {
  const filters = await getSymbolFilters(symbol);
  const qty = floorToStep(Number(quantity), filters.stepSize);
  if (qty < filters.minQty) {
    throw new Error(`Sell qty ${qty} below minQty ${filters.minQty}`);
  }
  return signedRequest('POST', '/api/v3/order', {
    symbol,
    side: 'SELL',
    type: 'MARKET',
    quantity: String(qty),
  });
}

function filledQtyFromOrder(order) {
  if (Number.isFinite(Number(order.executedQty)) && Number(order.executedQty) > 0) {
    return Number(order.executedQty);
  }
  if (Array.isArray(order.fills) && order.fills.length) {
    return order.fills.reduce((sum, fill) => sum + Number(fill.qty || 0), 0);
  }
  return 0;
}

function avgPriceFromOrder(order) {
  const qty = filledQtyFromOrder(order);
  if (!qty) return null;
  if (Array.isArray(order.fills) && order.fills.length) {
    const quote = order.fills.reduce(
      (sum, fill) => sum + Number(fill.price) * Number(fill.qty),
      0,
    );
    return quote / qty;
  }
  if (Number.isFinite(Number(order.cummulativeQuoteQty))) {
    return Number(order.cummulativeQuoteQty) / qty;
  }
  return null;
}

module.exports = {
  publicGet,
  getAccountBalances,
  getPrice,
  getKlineOpen,
  getSymbolFilters,
  marketBuyQuote,
  marketSellQty,
  filledQtyFromOrder,
  avgPriceFromOrder,
  floorToStep,
  secretKindOf,
  normalizeSecret,
};
