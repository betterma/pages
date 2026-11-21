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
 *   BINANCE_API_BASES   可选，逗号分隔备用域名（403 时轮询）
 */

const DEFAULT_BASE = 'https://api.binance.com';
const DEFAULT_BASES = [
  'https://api.binance.com',
  'https://api1.binance.com',
  'https://api2.binance.com',
  'https://api3.binance.com',
  'https://api4.binance.com',
];
const RECV_WINDOW = 5000;
const BINANCE_UA =
  'Mozilla/5.0 (compatible; manual-trade-worker/1.0; +https://developers.binance.com)';

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

function apiBases(env) {
  const raw = String(env.BINANCE_API_BASES || '').trim();
  const list = raw
    ? raw.split(/[,|\s]+/).map((s) => s.trim().replace(/\/$/, '')).filter(Boolean)
    : DEFAULT_BASES.slice();
  const preferred = baseUrl(env);
  const out = [];
  const seen = new Set();
  for (const item of [preferred, ...list]) {
    if (!item || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out.length ? out : [DEFAULT_BASE];
}

function looksLikeHtml(text) {
  const s = String(text || '').trim().slice(0, 80).toLowerCase();
  return s.startsWith('<!doctype') || s.startsWith('<html') || s.includes('<html');
}

function binanceHttpError(status, text, base) {
  const snippet = String(text || '').replace(/\s+/g, ' ').slice(0, 160);
  if (status === 403 && looksLikeHtml(text)) {
    return new Error(
      `币安 403 HTML（疑似拦截 Cloudflare 出口 IP，base=${base}）。可设 BINANCE_API_BASE / BINANCE_API_BASES 换线路，或经自有代理转发。片段: ${snippet}`,
    );
  }
  if (looksLikeHtml(text)) {
    return new Error(`Binance 返回 HTML 而非 JSON：${status} base=${base} ${snippet}`);
  }
  return new Error(`Binance 返回非 JSON：${status} base=${base} ${snippet}`);
}

async function fetchBinance(env, method, pathWithQuery, headers = {}) {
  const bases = apiBases(env);
  let lastError = null;
  for (const base of bases) {
    const url = `${base}${pathWithQuery.startsWith('/') ? pathWithQuery : `/${pathWithQuery}`}`;
    try {
      const res = await fetch(url, {
        method,
        headers: {
          'User-Agent': BINANCE_UA,
          Accept: 'application/json',
          ...headers,
        },
      });
      const text = await res.text();
      if (looksLikeHtml(text) || (res.status === 403 && !text.trim().startsWith('{'))) {
        lastError = binanceHttpError(res.status, text, base);
        continue;
      }
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch (_) {
        lastError = binanceHttpError(res.status, text, base);
        continue;
      }
      if (!res.ok) {
        throw new Error(
          `Binance ${res.status} base=${base}: ${JSON.stringify(data).slice(0, 250)}`,
        );
      }
      return data;
    } catch (error) {
      lastError = error;
      // 业务 JSON 错误（签名/权限）不要盲重试其它域名
      const msg = error && error.message ? error.message : String(error);
      if (/Binance \d{3} base=/.test(msg) && !/403 HTML|返回 HTML|非 JSON/.test(msg)) {
        throw error;
      }
    }
  }
  throw lastError || new Error('Binance 请求失败');
}

async function authorized(request, env) {
  const header = request.headers.get('Authorization') || '';
  const supplied = header.replace(/^Bearer\s+/i, '').trim();
  const expected = String(await resolveEnvSecret(env.MANUAL_TRADE_TOKEN) || '').trim();
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

function pemLabelOf(pem) {
  const m = String(pem || '').match(/-----BEGIN ([^-]+)-----/);
  return m ? m[1].trim() : '';
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

function concatBytes(...parts) {
  const arrays = parts.map((p) =>
    p instanceof Uint8Array ? p : new Uint8Array(p),
  );
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  arrays.forEach((a) => {
    out.set(a, off);
    off += a.length;
  });
  return out;
}

function encodeAsn1Length(len) {
  if (len < 0x80) return new Uint8Array([len]);
  if (len < 0x100) return new Uint8Array([0x81, len]);
  if (len < 0x10000) {
    return new Uint8Array([0x82, (len >> 8) & 0xff, len & 0xff]);
  }
  return new Uint8Array([
    0x83,
    (len >> 16) & 0xff,
    (len >> 8) & 0xff,
    len & 0xff,
  ]);
}

function encodeAsn1Sequence(contents) {
  const body = contents instanceof Uint8Array ? contents : new Uint8Array(contents);
  const len = encodeAsn1Length(body.length);
  return concatBytes(new Uint8Array([0x30]), len, body);
}

function encodeAsn1OctetString(contents) {
  const body = contents instanceof Uint8Array ? contents : new Uint8Array(contents);
  const len = encodeAsn1Length(body.length);
  return concatBytes(new Uint8Array([0x04]), len, body);
}

/** PKCS#1 RSA → PKCS#8，供 Web Crypto importKey('pkcs8') 使用 */
function wrapRsaPkcs1ToPkcs8(pkcs1Der) {
  const version = new Uint8Array([0x02, 0x01, 0x00]);
  // AlgorithmIdentifier: rsaEncryption + NULL
  const algId = new Uint8Array([
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01,
    0x01, 0x05, 0x00,
  ]);
  const octet = encodeAsn1OctetString(pkcs1Der);
  return encodeAsn1Sequence(concatBytes(version, algId, octet));
}

function extractPemBase64(pem) {
  const text = String(pem || '').replace(/\r/g, '\n');
  const lines = text.split('\n');
  const chunks = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith('-----')) continue;
    if (t.includes(':')) continue; // Proc-Type / DEK-Info
    if (!/^[A-Za-z0-9+/]+=*$/.test(t)) continue;
    chunks.push(t);
  }
  let body = chunks.join('');
  if (!body) {
    // 单行 PEM：去掉头尾后只留 Base64
    body = text
      .replace(/-----BEGIN [^-]+-----/g, '')
      .replace(/-----END [^-]+-----/g, '')
      .replace(/\s+/g, '');
  }
  return body;
}

function pemBodyToBytes(pem) {
  const body = extractPemBase64(pem);
  if (!body) throw new Error('PEM 正文为空');
  let raw;
  try {
    raw = atob(body);
  } catch (_) {
    throw new Error('PEM Base64 无法解码（可能被截断或含非法字符）');
  }
  const buf = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) buf[i] = raw.charCodeAt(i);
  return buf;
}

async function resolveEnvSecret(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value.get === 'function') {
    const got = await value.get();
    return got == null ? '' : String(got);
  }
  return String(value);
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

async function subtleSignWithPkcs8(pkcs8Der, query, algorithms) {
  const data = new TextEncoder().encode(query);
  let lastError = null;
  for (const attempt of algorithms) {
    try {
      const key = await crypto.subtle.importKey(
        'pkcs8',
        pkcs8Der,
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
  throw lastError || new Error('subtle import/sign failed');
}

/** 与华为云一致：Node createPrivateKey + sign（需 Worker 开启 nodejs_compat） */
async function signPemWithNodeCrypto(query, pem) {
  const nodeCrypto = await import('node:crypto');
  const keyObject = nodeCrypto.createPrivateKey(pem);
  const sig = nodeCrypto.sign(null, Buffer.from(query, 'ascii'), keyObject);
  return Buffer.from(sig).toString('base64');
}

/**
 * HMAC → hex；Ed25519 / RSA PEM → base64（对齐币安自签 Key + 华为云 signBinanceQuery）
 * 兼容 BEGIN PRIVATE KEY（PKCS#8）与 BEGIN RSA PRIVATE KEY（PKCS#1，自动包一层 PKCS#8）
 */
async function signBinanceQuery(query, secret) {
  const material = normalizeSecret(secret);
  if (!material) throw new Error('Empty BINANCE_API_SECRET');
  if (!isPemPrivateKey(material)) {
    return hmacHex(material, query);
  }

  const label = pemLabelOf(material);
  if (/ENCRYPTED/i.test(label)) {
    throw new Error('不支持加密 PEM（ENCRYPTED PRIVATE KEY），请改用未加密私钥');
  }

  const b64 = extractPemBase64(material);
  const b64Prefix = b64.slice(0, 16);
  const errors = [];

  // 优先 Node 路径（与华为云 holdings.js 相同），避免 WebCrypto PKCS8 解析差异
  try {
    return await signPemWithNodeCrypto(query, material);
  } catch (error) {
    errors.push(
      `node:${error && error.message ? error.message : String(error)}`,
    );
  }

  const der = pemBodyToBytes(material);
  if (der.length && der[0] !== 0x30) {
    throw new Error(
      `BINANCE_API_SECRET 不是合法 PKCS#8/PEM（label=${label} derLen=${der.length} head=${bytesToHex(der.slice(0, 4))} b64Prefix=${b64Prefix}）。合法 Ed25519 私钥 Base64 通常以 MC4CAQAwBQYDK2Vw 开头。请从本地 .pem 文件整段重新粘贴到 Cloudflare Secret（不要从截断的控制台复制）。node错误: ${errors.join(' | ')}`,
    );
  }

  const rsaAlgos = [
    {
      name: 'RSASSA-PKCS1-v1_5',
      algorithm: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      signAlgo: { name: 'RSASSA-PKCS1-v1_5' },
    },
  ];
  const bothAlgos = [
    { name: 'Ed25519', algorithm: { name: 'Ed25519' }, signAlgo: 'Ed25519' },
    ...rsaAlgos,
  ];

  const trySign = async (pkcs8Der, algorithms, tag) => {
    try {
      return await subtleSignWithPkcs8(pkcs8Der, query, algorithms);
    } catch (error) {
      errors.push(
        `${tag}:${error && error.message ? error.message : String(error)}`,
      );
      return null;
    }
  };

  if (/RSA PRIVATE KEY/i.test(label)) {
    const wrapped = wrapRsaPkcs1ToPkcs8(der);
    const sig = await trySign(wrapped, rsaAlgos, 'pkcs1→pkcs8/rsa');
    if (sig) return sig;
  } else {
    let sig = await trySign(der, bothAlgos, 'pkcs8');
    if (sig) return sig;
    const wrapped = wrapRsaPkcs1ToPkcs8(der);
    sig = await trySign(wrapped, rsaAlgos, 'wrap/rsa');
    if (sig) return sig;
  }

  throw new Error(
    `PEM 私钥无法用于签名（label=${label || '?'} derLen=${der.length} head=${bytesToHex(der.slice(0, 4))} b64Prefix=${b64Prefix}）：${errors.join(' | ')}`,
  );
}

async function publicGet(env, path, params = {}) {
  const query = new URLSearchParams(
    Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => [k, String(v)]),
  ).toString();
  return fetchBinance(env, 'GET', `${path}${query ? `?${query}` : ''}`);
}

async function signedRequest(env, method, path, params = {}) {
  const apiKey = String(await resolveEnvSecret(env.BINANCE_API_KEY) || '').trim();
  const apiSecret = String(await resolveEnvSecret(env.BINANCE_API_SECRET) || '');
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
  return fetchBinance(
    env,
    method,
    `${path}?${query}&signature=${encodeURIComponent(signature)}`,
    headers,
  );
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

    if (!(await authorized(request, env))) {
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
