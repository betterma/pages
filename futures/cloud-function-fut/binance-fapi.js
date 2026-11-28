'use strict';

/**
 * 币安 U 本位合约公开接口（只读，无需 API Key）。
 * 与现货 /api/v3 完全独立。
 */

const https = require('https');

const FAPI_ROOTS = (
  process.env.FAPI_BASE_URLS ||
  [
    'https://fapi.binance.com',
    'https://fapi1.binance.com',
    'https://fapi2.binance.com',
    'https://fapi3.binance.com',
  ].join(',')
)
  .split(',')
  .map((item) => String(item || '').trim().replace(/\/$/, ''))
  .filter(Boolean);

function requestJson(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(value);
    };
    let target;
    try {
      target = new URL(url);
    } catch (error) {
      reject(error);
      return;
    }
    const request = https.request(
      target,
      { method: 'GET' },
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
                `FAPI JSON parse failed: ${response.statusCode} ${text.slice(0, 200)}`,
              ),
            );
            return;
          }
          finish(null, {
            ok: response.statusCode >= 200 && response.statusCode < 300,
            status: response.statusCode,
            data,
          });
        });
        response.on('error', (error) => finish(error));
      },
    );
    request.on('error', (error) => finish(error));
    request.setTimeout(timeoutMs || 15000, () => {
      request.destroy();
      finish(new Error(`FAPI timeout: ${url}`));
    });
    request.end();
  });
}

async function fapiGet(path, timeoutMs) {
  const errors = [];
  for (const root of FAPI_ROOTS) {
    const url = `${root}${path}`;
    try {
      const response = await requestJson(url, timeoutMs);
      if (!response.ok) {
        errors.push(`${root} HTTP ${response.status}`);
        continue;
      }
      return response.data;
    } catch (error) {
      errors.push(error && error.message ? error.message : String(error));
    }
  }
  throw new Error(
    `All FAPI endpoints failed for ${path}: ${errors.slice(0, 4).join(' | ')}`,
  );
}

/**
 * 永续 USDT 合约 TRADING 集合。
 * @returns {Promise<Set<string>>}
 */
async function fetchUsdtPerpTradingSet() {
  const info = await fapiGet('/fapi/v1/exchangeInfo');
  const set = new Set();
  const list = Array.isArray(info && info.symbols) ? info.symbols : [];
  for (const row of list) {
    if (!row || !row.symbol) continue;
    const symbol = String(row.symbol).trim().toUpperCase();
    if (!symbol.endsWith('USDT')) continue;
    if (String(row.status || '').toUpperCase() !== 'TRADING') continue;
    const contractType = String(row.contractType || '').toUpperCase();
    // 只要永续；交割合约先排除
    if (contractType && contractType !== 'PERPETUAL') continue;
    set.add(symbol);
  }
  return set;
}

/**
 * 全市场（或过滤后）U 本位 24hr ticker → { [symbol]: { price, change24h } }
 */
async function fetchFutTickers(tradingSet) {
  const raw = await fapiGet('/fapi/v1/ticker/24hr');
  const list = Array.isArray(raw) ? raw : [];
  const map = {};
  for (const item of list) {
    if (!item || !item.symbol) continue;
    const symbol = String(item.symbol).trim().toUpperCase();
    if (!symbol.endsWith('USDT')) continue;
    if (tradingSet && tradingSet.size && !tradingSet.has(symbol)) continue;
    const price = Number(item.lastPrice);
    const change24h = Number(item.priceChangePercent);
    if (!Number.isFinite(price) || price <= 0) continue;
    map[symbol] = {
      price,
      change24h: Number.isFinite(change24h) ? change24h : null,
    };
  }
  return map;
}

/**
 * U 本位 K 线（公开接口）。返回 { time, open, high, low, close, closeTime }[]。
 */
async function fetchFutKlines(symbol, interval, limit) {
  const key = String(symbol || '')
    .trim()
    .toUpperCase();
  if (!key) throw new Error('fetchFutKlines: empty symbol');
  const iv = String(interval || '4h').trim() || '4h';
  const lim = Math.max(1, Math.min(1500, Number(limit) || 18));
  const path = `/fapi/v1/klines?symbol=${encodeURIComponent(key)}&interval=${encodeURIComponent(iv)}&limit=${lim}`;
  const raw = await fapiGet(path);
  if (!Array.isArray(raw)) {
    throw new Error(`fetchFutKlines: unexpected payload for ${key}`);
  }
  return raw.map((item) => ({
    time: Number(item[0]),
    open: Number(item[1]),
    high: Number(item[2]),
    low: Number(item[3]),
    close: Number(item[4]),
    closeTime: Number(item[6]),
  }));
}

module.exports = {
  fapiGet,
  fetchUsdtPerpTradingSet,
  fetchFutTickers,
  fetchFutKlines,
};
