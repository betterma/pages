'use strict';

const https = require('https');
const crypto = require('crypto');

function binanceConfig() {
  return {
    apiKey: process.env.BINANCE_API_KEY || '',
    apiSecret: process.env.BINANCE_API_SECRET || '',
    baseUrl: process.env.BINANCE_API_BASE || 'https://api.binance.com',
  };
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
    const request = https.request(
      target,
      {
        method: options.method || 'GET',
        headers: options.headers || {},
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
    request.on('error', (error) => finish(error));
    request.setTimeout(options.timeout || 20000, () => {
      request.destroy();
      finish(new Error(`Binance timeout: ${url}`));
    });
    if (options.body) request.write(options.body);
    request.end();
  });
}

async function publicGet(path, params = {}) {
  const { baseUrl } = binanceConfig();
  const query = new URLSearchParams(params).toString();
  const url = `${baseUrl}${path}${query ? `?${query}` : ''}`;
  const response = await requestJson(url, { method: 'GET' });
  if (!response.ok) {
    throw new Error(
      `Binance GET ${path} failed: ${response.status} ${JSON.stringify(response.data).slice(0, 240)}`,
    );
  }
  return response.data;
}

async function signedRequest(method, path, params = {}) {
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
  const signature = crypto
    .createHmac('sha256', apiSecret)
    .update(query)
    .digest('hex');
  const url = `${baseUrl}${path}?${query}&signature=${signature}`;
  const response = await requestJson(url, {
    method,
    headers: {
      'X-MBX-APIKEY': apiKey,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
  });
  if (!response.ok) {
    throw new Error(
      `Binance ${method} ${path} failed: ${response.status} ${JSON.stringify(response.data).slice(0, 300)}`,
    );
  }
  return response.data;
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
  getPrice,
  getKlineOpen,
  getSymbolFilters,
  marketBuyQuote,
  marketSellQty,
  filledQtyFromOrder,
  avgPriceFromOrder,
  floorToStep,
};
