'use strict';

/**
 * 持仓余额同步：网页指定关注币种 → 云函数拉账户余额写回 GitHub。
 * 签名支持 HMAC（系统生成 Secret）与 Ed25519/RSA（自行生成 PEM 私钥）。
 * 本文件仍不做下单；交易权限 Key 也可用于只读 account。
 */

const https = require('https');
const crypto = require('crypto');
const { loadJson, saveJson } = require('./github-wecom');
const {
  getUserDataFirst,
  diagSources,
} = require('./runtime-env');

const HOLDINGS_PATH = process.env.HOLDINGS_PATH || 'watch-holdings.json';

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

/**
 * 华为云环境变量常把 PEM 换行吃掉，变成单行，OpenSSL 报 bad end line。
 * 这里把字面 \\n、以及「一整行的 PEM」还原成标准多行 PKCS#8。
 */
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

/**
 * HMAC → hex；Ed25519/RSA PEM → base64（币安自签 Key）。
 * @param {string} query
 * @param {string} secret
 */
function signBinanceQuery(query, secret) {
  const material = normalizeSecret(secret);
  if (!material) throw new Error('Empty BINANCE_API_SECRET');
  if (isPemPrivateKey(material)) {
    const keyObject = crypto.createPrivateKey(material);
    return crypto.sign(null, Buffer.from(query, 'ascii'), keyObject).toString('base64');
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

function binanceConfig(context) {
  return {
    // 事件函数加密变量：优先 context.getUserData，其次 process.env / RUNTIME_USERDATA。
    apiKey: getUserDataFirst(context, KEY_NAMES),
    apiSecret: getUserDataFirst(context, SECRET_NAMES),
    baseUrl:
      getUserDataFirst(context, ['BINANCE_API_BASE', 'BINANCE_BASE_URL']) ||
      'https://api.binance.com',
  };
}

function keyDiag(context) {
  const { apiKey, apiSecret } = binanceConfig(context);
  const sources = diagSources(context, [
    ...KEY_NAMES,
    ...SECRET_NAMES,
  ]);
  const secretNorm = normalizeSecret(apiSecret);
  return {
    hasKey: !!apiKey,
    hasSecret: !!apiSecret,
    keyLen: apiKey ? apiKey.length : 0,
    secretLen: apiSecret ? apiSecret.length : 0,
    secretNormLen: secretNorm ? secretNorm.length : 0,
    secretHasNewline: secretNorm.includes('\n'),
    secretHasBegin: /BEGIN [A-Z0-9 ]+ PRIVATE KEY/.test(secretNorm),
    secretHasEnd: /END [A-Z0-9 ]+ PRIVATE KEY/.test(secretNorm),
    secretKind: secretKindOf(apiSecret),
    hasGetUserData: sources.hasGetUserData,
    runtimeUserDataLen: sources.runtimeUserDataLen,
    sources: sources.seen,
  };
}

function hasReadKeys(context) {
  const d = keyDiag(context);
  return d.hasKey && d.hasSecret;
}

function missingKeysReason(context) {
  const d = keyDiag(context);
  if (!d.hasKey && !d.hasSecret) return 'missing-api-keys:both';
  if (!d.hasKey) return 'missing-api-keys:no-key';
  if (!d.hasSecret) return 'missing-api-keys:no-secret';
  return 'missing-api-keys';
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

async function signedGet(path, params = {}, context) {
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

async function fetchAccountBalances(context) {
  return signedGet('/api/v3/account', {}, context);
}

function normalizeSymbol(raw) {
  let key = String(raw || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '');
  if (!key) return '';
  // 允许直接关注 USDT 余额。
  if (key === 'USDT') return 'USDT';
  if (!key.endsWith('USDT')) key += 'USDT';
  return key;
}

function baseAssetOf(symbol) {
  const key = normalizeSymbol(symbol);
  // USDT 本身是资产，不是 *USDT 交易对。
  if (key === 'USDT') return 'USDT';
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
  const context = opts.context || null;
  const result = {
    skipped: false,
    reason: null,
    hasKeys: hasReadKeys(context),
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
  const diag = keyDiag(context);
  console.log('holdings key-diag', JSON.stringify(diag));

  if (!hasReadKeys(context)) {
    const reason = missingKeysReason(context);
    const next = {
      ...state,
      updatedAt: now,
      lastError: reason,
    };
    try {
      await saveJson(
        HOLDINGS_PATH,
        next,
        file.sha,
        `Holdings: ${reason}`,
      );
    } catch (error) {
      /* ignore write if conflict */
    }
    result.skipped = true;
    result.reason = reason;
    return result;
  }

  let account;
  try {
    account = await fetchAccountBalances(context);
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
