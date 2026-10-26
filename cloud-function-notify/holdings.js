'use strict';

/**
 * 只读持仓余额：网页指定关注币种 → 云函数用「允许读取」API Key 拉账户余额写回 GitHub。
 * 不包含任何下单 / 卖出逻辑。
 */

const https = require('https');
const crypto = require('crypto');
const { loadJson, saveJson } = require('./github-wecom');

const HOLDINGS_PATH = process.env.HOLDINGS_PATH || 'watch-holdings.json';

function binanceConfig() {
  return {
    apiKey: process.env.BINANCE_API_KEY || '',
    apiSecret: process.env.BINANCE_API_SECRET || '',
    baseUrl: process.env.BINANCE_API_BASE || 'https://api.binance.com',
  };
}

function hasReadKeys() {
  const { apiKey, apiSecret } = binanceConfig();
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

async function signedGet(path, params = {}) {
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
    method: 'GET',
    headers: { 'X-MBX-APIKEY': apiKey },
  });
  if (!response.ok) {
    throw new Error(
      `Binance signed GET ${path} ${response.status} ${JSON.stringify(response.data).slice(0, 240)}`,
    );
  }
  return response.data;
}

function normalizeSymbol(raw) {
  let key = String(raw || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '');
  if (!key) return '';
  if (!key.endsWith('USDT')) key += 'USDT';
  return key;
}

function baseAssetOf(symbol) {
  const key = normalizeSymbol(symbol);
  return key.endsWith('USDT') ? key.slice(0, -4) : key;
}

function normalizeState(raw) {
  const data = raw && typeof raw === 'object' ? raw : {};
  const seen = new Set();
  const symbols = [];
  (Array.isArray(data.symbols) ? data.symbols : []).forEach((item) => {
    const symbol = normalizeSymbol(item);
    if (!symbol || seen.has(symbol)) return;
    seen.add(symbol);
    symbols.push(symbol);
  });
  const balances = {};
  const rawBal =
    data.balances && typeof data.balances === 'object' ? data.balances : {};
  Object.keys(rawBal).forEach((asset) => {
    const row = rawBal[asset];
    if (!row || typeof row !== 'object') return;
    const key = String(asset || '').toUpperCase();
    if (!key) return;
    balances[key] = {
      free: Number(row.free) || 0,
      locked: Number(row.locked) || 0,
      at: Number(row.at) || 0,
    };
  });
  return {
    updatedAt: Number(data.updatedAt) || 0,
    symbols,
    balances,
    lastError: data.lastError ? String(data.lastError) : null,
  };
}

/**
 * @returns {Promise<object>}
 */
async function runHoldingsSync(options) {
  const opts = options || {};
  const now = Number(opts.now) || Date.now();
  const result = {
    skipped: false,
    reason: null,
    hasKeys: hasReadKeys(),
    symbols: 0,
    updated: 0,
  };

  let file;
  try {
    file = await loadJson(HOLDINGS_PATH);
  } catch (error) {
    result.skipped = true;
    result.reason = `load-failed:${error.message || error}`;
    return result;
  }

  const state = normalizeState(file.data);
  result.symbols = state.symbols.length;
  if (!state.symbols.length) {
    result.skipped = true;
    result.reason = 'no-symbols';
    return result;
  }
  if (!hasReadKeys()) {
    const next = {
      ...state,
      updatedAt: now,
      lastError: 'missing-api-keys',
    };
    try {
      await saveJson(
        HOLDINGS_PATH,
        next,
        file.sha,
        'Holdings: missing API keys',
      );
    } catch (error) {
      /* ignore write if conflict */
    }
    result.skipped = true;
    result.reason = 'no-api-keys';
    return result;
  }

  let account;
  try {
    account = await signedGet('/api/v3/account');
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    const next = {
      ...state,
      updatedAt: now,
      lastError: message.slice(0, 240),
    };
    try {
      await saveJson(
        HOLDINGS_PATH,
        next,
        file.sha,
        'Holdings: account read failed',
      );
    } catch (writeError) {
      if (!/409|conflict|sha/i.test(String(writeError && writeError.message))) {
        throw writeError;
      }
      result.skipped = true;
      result.reason = 'conflict';
      return result;
    }
    result.skipped = true;
    result.reason = 'account-failed';
    result.error = message;
    return result;
  }

  const byAsset = new Map();
  (account.balances || []).forEach((row) => {
    const asset = String((row && row.asset) || '').toUpperCase();
    if (!asset) return;
    byAsset.set(asset, {
      free: Number(row.free) || 0,
      locked: Number(row.locked) || 0,
    });
  });

  const balances = { ...(state.balances || {}) };
  state.symbols.forEach((symbol) => {
    const asset = baseAssetOf(symbol);
    const row = byAsset.get(asset) || { free: 0, locked: 0 };
    balances[asset] = {
      free: row.free,
      locked: row.locked,
      at: now,
    };
    result.updated += 1;
  });

  const nextState = {
    updatedAt: now,
    symbols: state.symbols,
    balances,
    lastError: null,
  };

  try {
    await saveJson(
      HOLDINGS_PATH,
      nextState,
      file.sha,
      `Holdings sync ${result.updated} assets`,
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
  runHoldingsSync,
  normalizeState,
  HOLDINGS_PATH,
};
