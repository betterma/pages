/**
 * 手动下单 HTTP 云函数（Cloudflare Workers 版）
 *
 * 设计原则：
 * - 完全独立于 cloud-function-trade，不读写 trade-bot-state.json
 * - 不碰华为云定时器；原有 5min 自动买/卖逻辑原样运行
 * - 只做「立即按现价市价单成交」，手动单自己管，不进自动仓位
 *
 * 端点：
 *   POST /buy       { symbol, quote }     按 USDT 金额市价买入
 *   POST /sell      { symbol, quantity }  按数量市价卖出（自动按 stepSize 取整）
 *   GET  /balances                       拉币安现货账户余额（即时）
 *   GET  /ping                           健康检查（需鉴权）
 *
 * 鉴权：请求头 Authorization: Bearer <MANUAL_TRADE_TOKEN>
 *
 * 环境变量（Workers Secrets， Never commit）：
 *   BINANCE_API_KEY     币安 API Key（可与华为云同一套，或单独申请）
 *   BINANCE_API_SECRET  HMAC Secret，或自行生成的 Ed25519/RSA PEM 私钥（与华为云 holdings 同格式）
 *   MANUAL_TRADE_TOKEN  自定义口令，用于鉴权
 *   BINANCE_API_BASE    可选，默认 https://api.binance.com
 */

const DEFAULT_BASE = 'https://api.binance.com';
const RECV_WINDOW = 5000;

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    },
  });
}

function fail(message, status = 400) {
  return json({ ok: false, error: message }, status);
}

function normalizeSymbol(input) {
  const s = String(input || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  if (!s) return '';
  return s.endsWith('USDT') ? s : `${s}USDT`;
}

function baseUrl(env) {
  return String(env.BINANCE_API_BASE || DEFAULT_BASE).replace(/\/$/, '');
}

function authorized(request, env) {
  const header = request.headers.get('Authorization') || '';
  const supplied = header.replace(/^Bearer\s+/i, '').trim();
  const expected = String(env.MANUAL_TRADE_TOKEN || '');
  // 两边都必须非空，避免未配置 token 时任意请求都能下单
  return !!expected && !!supplied && supplied === expected;
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

/** 与华为云 holdings.js 同逻辑：还原 PEM / 字面 \\n */
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

function bytesToBase64(bytes) {
  let s = '';
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i += 1) s += String.fromCharCode(arr[i]);
  return btoa(s);
}

function bytesToHex(bytes) {
  return Array.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function pemToPkcs8Buffer(pem) {
  const body = String(pem || '')
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s+/g, '');
  const raw = atob(body);
  const buf = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) buf[i] = raw.charCodeAt(i);
  return buf.buffer;
}

async function hmacHex(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return bytesToHex(sig);
}

/**
 * HMAC → hex；Ed25519 / RSA PEM → base64（对齐币安自签 Key + 华为云 signBinanceQuery）
 */
async function signBinanceQuery(query, secret) {
  const material = normalizeSecret(secret);
  if (!material) throw new Error('Empty BINANCE_API_SECRET');
  if (!isPemPrivateKey(material)) {
    return hmacHex(material, query);
  }

  const keyData = pemToPkcs8Buffer(material);
  const data = new TextEncoder().encode(query);
  const attempts = [
    { name: 'Ed25519', algorithm: { name: 'Ed25519' }, signAlgo: 'Ed25519' },
    {
      name: 'RSASSA-PKCS1-v1_5',
      algorithm: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      signAlgo: { name: 'RSASSA-PKCS1-v1_5' },
    },
  ];
  let lastError = null;
  for (const attempt of attempts) {
    try {
      const key = await crypto.subtle.importKey(
        'pkcs8',
        keyData,
        attempt.algorithm,
        false,
        ['sign'],
      );
      const sig = await crypto.subtle.sign(attempt.signAlgo, key, data);
      return bytesToBase64(sig);
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    `PEM 私钥无法用于 Ed25519/RSA 签名：${
      lastError && lastError.message ? lastError.message : lastError
    }`,
  );
}

async function publicGet(env, path, params = {}) {
  const query = new URLSearchParams(
    Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => [k, String(v)]),
  ).toString();
  const url = `${baseUrl(env)}${path}${query ? `?${query}` : ''}`;
  const res = await fetch(url, { method: 'GET' });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (_) {
    throw new Error(`Binance 返回非 JSON：${res.status} ${text.slice(0, 160)}`);
  }
  if (!res.ok) {
    throw new Error(`Binance ${res.status}: ${JSON.stringify(data).slice(0, 200)}`);
  }
  return data;
}

async function signedRequest(env, method, path, params = {}) {
  const apiKey = String(env.BINANCE_API_KEY || '');
  const apiSecret = String(env.BINANCE_API_SECRET || '');
  if (!apiKey || !apiSecret) {
    throw new Error('未配置 BINANCE_API_KEY / BINANCE_API_SECRET（Workers Secrets）');
  }
  const payload = {
    ...params,
    timestamp: Date.now(),
    recvWindow: RECV_WINDOW,
  };
  const query = new URLSearchParams(
    Object.entries(payload)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => [k, String(v)]),
  ).toString();
  const signature = await signBinanceQuery(query, apiSecret);
  const headers = { 'X-MBX-APIKEY': apiKey };
  if (method === 'POST') {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
  }
  const res = await fetch(
    `${baseUrl(env)}${path}?${query}&signature=${encodeURIComponent(signature)}`,
    {
      method,
      headers,
    },
  );
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (_) {
    throw new Error(`Binance 返回非 JSON：${res.status} ${text.slice(0, 160)}`);
  }
  if (!res.ok) {
    throw new Error(`Binance ${res.status}: ${JSON.stringify(data).slice(0, 250)}`);
  }
  return data;
}

async function signedGet(env, path, params = {}) {
  return signedRequest(env, 'GET', path, params);
}

async function signedPost(env, path, params) {
  return signedRequest(env, 'POST', path, params);
}

async function getLotFilters(env, symbol) {
  const info = await publicGet(env, '/api/v3/exchangeInfo', { symbol });
  const row = Array.isArray(info.symbols) ? info.symbols[0] : null;
  if (!row) throw new Error(`币安未找到交易对 ${symbol}`);
  let stepSize = 0;
  let minQty = 0;
  for (const f of row.filters || []) {
    if (f.filterType === 'LOT_SIZE') {
      stepSize = Number(f.stepSize) || 0;
      minQty = Number(f.minQty) || 0;
      break;
    }
  }
  return { stepSize, minQty };
}

function floorToStep(value, step) {
  if (!(step > 0)) return value;
  const precision = Math.max(0, Math.round(-Math.log10(step)));
  return Number((Math.floor(value / step) * step).toFixed(precision));
}

function filledQty(order) {
  const n = Number(order.executedQty);
  if (Number.isFinite(n) && n > 0) return n;
  const fills = Array.isArray(order.fills) ? order.fills : [];
  return fills.reduce((sum, f) => sum + (Number(f.qty) || 0), 0);
}

function avgPrice(order) {
  const q = filledQty(order);
  if (!(q > 0)) return null;
  const fills = Array.isArray(order.fills) ? order.fills : [];
  if (fills.length) {
    const quote = fills.reduce(
      (sum, f) => sum + (Number(f.price) || 0) * (Number(f.qty) || 0),
      0,
    );
    return quote / q;
  }
  const cq = Number(order.cummulativeQuoteQty);
  return Number.isFinite(cq) && cq > 0 ? cq / q : null;
}

function summarize(order) {
  return {
    orderId: order.orderId,
    symbol: order.symbol,
    side: order.side,
    type: order.type,
    status: order.status,
    transactTime: order.transactTime,
    executedQty: filledQty(order),
    cummulativeQuoteQty: Number(order.cummulativeQuoteQty) || null,
    avgPrice: avgPrice(order),
  };
}

async function handleBuy(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (_) {
    return fail('请求体必须是 JSON');
  }
  const symbol = normalizeSymbol(body.symbol);
  const quote = Number(body.quote);
  if (!symbol) return fail('缺少 symbol');
  if (!(quote > 0)) return fail('quote 必须是大于 0 的 USDT 金额');
  if (quote < 5) return fail('币安市价单最小名义金额约 5 USDT');

  const order = await signedPost(env, '/api/v3/order', {
    symbol,
    side: 'BUY',
    type: 'MARKET',
    quoteOrderQty: quote.toFixed(2),
  });
  return json({
    ok: true,
    action: 'manual_buy',
    at: new Date().toISOString(),
    note: '手动单：仅成交，不写入自动仓位 trade-bot-state.json',
    order: summarize(order),
  });
}

async function handleSell(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (_) {
    return fail('请求体必须是 JSON');
  }
  const symbol = normalizeSymbol(body.symbol);
  let quantity = Number(body.quantity);
  if (!symbol) return fail('缺少 symbol');
  if (!(quantity > 0)) return fail('quantity 必须是大于 0 的数量');

  const filters = await getLotFilters(env, symbol);
  quantity = floorToStep(quantity, filters.stepSize);
  if (!(quantity > 0)) return fail(`数量按 stepSize 取整后为 0（stepSize=${filters.stepSize}）`);
  if (filters.minQty > 0 && quantity < filters.minQty) {
    return fail(`数量 ${quantity} 小于币安最小下单量 ${filters.minQty}`);
  }

  const order = await signedPost(env, '/api/v3/order', {
    symbol,
    side: 'SELL',
    type: 'MARKET',
    quantity: String(quantity),
  });
  return json({
    ok: true,
    action: 'manual_sell',
    at: new Date().toISOString(),
    note: '手动单：仅成交，不写入自动仓位 trade-bot-state.json',
    order: summarize(order),
  });
}

async function handleBalances(env) {
  const account = await signedGet(env, '/api/v3/account');
  const now = Date.now();
  const balances = {};
  (account.balances || []).forEach((row) => {
    const asset = String((row && row.asset) || '').toUpperCase();
    if (!asset) return;
    const free = Number(row.free) || 0;
    const locked = Number(row.locked) || 0;
    // 只回非零资产 + USDT，减小 payload；关注币若为零由页面按 symbols 补 0
    if (asset !== 'USDT' && free <= 0 && locked <= 0) return;
    balances[asset] = { free, locked, at: now };
  });
  if (!balances.USDT) {
    balances.USDT = { free: 0, locked: 0, at: now };
  }
  return json({
    ok: true,
    action: 'balances',
    at: now,
    balances,
  });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': 'Authorization, Content-Type',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        },
      });
    }

    if (!authorized(request, env)) {
      return fail('未授权：请设置 Authorization: Bearer <MANUAL_TRADE_TOKEN>', 401);
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    try {
      if (path === '/ping' && request.method === 'GET') {
        return json({ ok: true, service: 'manual-trade', at: Date.now() });
      }
      if (path === '/balances' && (request.method === 'GET' || request.method === 'POST')) {
        return await handleBalances(env);
      }
      if (path === '/buy' && request.method === 'POST') return await handleBuy(request, env);
      if (path === '/sell' && request.method === 'POST') return await handleSell(request, env);
      return fail('未知端点', 404);
    } catch (error) {
      return fail(error && error.message ? error.message : String(error), 500);
    }
  },
};
