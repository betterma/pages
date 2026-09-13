'use strict';

/**
 * Robinhood screener proxy — avoids browser CORS to DexPaprika.
 * Handler: index.handler
 *
 * Routes (append to HTTP trigger URL):
 *   GET /health
 *   GET /tokens?fdvMin=5000000&fdvMax=30000000&limit=24&orderBy=volume_usd_24h
 *   GET /pools?token=0x...&limit=3
 *   GET /ohlcv?pool=0x...&days=90
 */

const https = require('https');

const CONFIG = {
  BASE: String(process.env.DEXPAPRIKA_BASE || 'https://api.dexpaprika.com').replace(
    /\/$/,
    '',
  ),
  API_KEY: String(process.env.DEXPAPRIKA_API_KEY || '').trim(),
  NETWORK: 'robinhood',
};

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json; charset=utf-8',
  };
}

function requestJson(url) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const headers = {
      Accept: 'application/json',
      'User-Agent': 'rh-screener-cf',
    };
    if (CONFIG.API_KEY) {
      headers.Authorization = `Bearer ${CONFIG.API_KEY}`;
      headers['X-API-Key'] = CONFIG.API_KEY;
    }
    const req = https.request(
      {
        hostname: target.hostname,
        path: `${target.pathname}${target.search}`,
        method: 'GET',
        headers,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode || 0, text });
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(25000, () => {
      req.destroy();
      reject(new Error(`timeout ${url}`));
    });
    req.end();
  });
}

function parseEvent(event) {
  const rawPath =
    (event && (event.path || event.rawPath || event.requestURI)) || '/';
  const path = String(rawPath).split('?')[0].replace(/\/+$/, '') || '/';
  const method = String(
    (event &&
      (event.httpMethod ||
        event.requestContext?.http?.method ||
        event.method)) ||
      'GET',
  ).toUpperCase();
  const q = { ...(event.queryStringParameters || {}) };
  if (event.multiValueQueryStringParameters) {
    Object.entries(event.multiValueQueryStringParameters).forEach(([k, v]) => {
      if (q[k] == null && Array.isArray(v) && v.length) q[k] = v[0];
    });
  }
  // Some gateways nest path after stage; keep last meaningful segment chain.
  const parts = path.split('/').filter(Boolean);
  const tail = parts[parts.length - 1] || '';
  const route =
    tail === 'tokens' || tail === 'pools' || tail === 'ohlcv' || tail === 'health'
      ? `/${tail}`
      : path.endsWith('/tokens')
        ? '/tokens'
        : path.endsWith('/pools')
          ? '/pools'
          : path.endsWith('/ohlcv')
            ? '/ohlcv'
            : path.endsWith('/health')
              ? '/health'
              : path;
  return { method, route, q };
}

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function startDateIso(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - Math.max(7, Math.min(365, days || 90)));
  return d.toISOString().slice(0, 10);
}

async function handleTokens(q) {
  const fdvMin = num(q.fdvMin, 5_000_000);
  const fdvMax = num(q.fdvMax, 30_000_000);
  const limit = Math.max(1, Math.min(100, num(q.limit, 24)));
  const orderBy = String(q.orderBy || 'volume_usd_24h');
  const params = new URLSearchParams({
    fdv_usd_min: String(fdvMin),
    fdv_usd_max: String(fdvMax),
    order_by: orderBy,
    sort: 'desc',
    limit: String(limit),
    detailed: 'true',
  });
  if (q.cursor) params.set('cursor', String(q.cursor));
  const url = `${CONFIG.BASE}/networks/${CONFIG.NETWORK}/tokens/search?${params}`;
  const res = await requestJson(url);
  return { status: res.status, body: res.text };
}

async function handlePools(q) {
  const token = String(q.token || '').trim();
  if (!token) {
    return {
      status: 400,
      body: JSON.stringify({ error: 'missing token' }),
    };
  }
  const limit = Math.max(1, Math.min(20, num(q.limit, 3)));
  const params = new URLSearchParams({
    token_address: token,
    order_by: 'liquidity_usd',
    sort: 'desc',
    limit: String(limit),
  });
  const url = `${CONFIG.BASE}/networks/${CONFIG.NETWORK}/pools/search?${params}`;
  const res = await requestJson(url);
  return { status: res.status, body: res.text };
}

async function handleOhlcv(q) {
  const pool = String(q.pool || '').trim();
  if (!pool) {
    return {
      status: 400,
      body: JSON.stringify({ error: 'missing pool' }),
    };
  }
  const days = Math.max(7, Math.min(365, num(q.days, 90)));
  const end = new Date().toISOString().slice(0, 10);
  const params = new URLSearchParams({
    start: startDateIso(days),
    end,
    interval: '24h',
    limit: String(days),
  });
  const url = `${CONFIG.BASE}/networks/${CONFIG.NETWORK}/pools/${pool}/ohlcv?${params}`;
  const res = await requestJson(url);
  return { status: res.status, body: res.text };
}

exports.handler = async (event) => {
  const { method, route, q } = parseEvent(event || {});
  if (method === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(), body: '' };
  }
  if (method !== 'GET') {
    return {
      statusCode: 405,
      headers: corsHeaders(),
      body: JSON.stringify({ error: 'method not allowed' }),
    };
  }

  try {
    if (route === '/health' || route === '/' || route === '') {
      return {
        statusCode: 200,
        headers: corsHeaders(),
        body: JSON.stringify({
          ok: true,
          network: CONFIG.NETWORK,
          base: CONFIG.BASE,
          hasKey: !!CONFIG.API_KEY,
        }),
      };
    }

    let out;
    if (route === '/tokens') out = await handleTokens(q);
    else if (route === '/pools') out = await handlePools(q);
    else if (route === '/ohlcv') out = await handleOhlcv(q);
    else {
      return {
        statusCode: 404,
        headers: corsHeaders(),
        body: JSON.stringify({
          error: 'not found',
          routes: ['/health', '/tokens', '/pools', '/ohlcv'],
        }),
      };
    }

    return {
      statusCode: out.status || 502,
      headers: corsHeaders(),
      body: out.body,
    };
  } catch (error) {
    return {
      statusCode: 500,
      headers: corsHeaders(),
      body: JSON.stringify({
        error: error && error.message ? error.message : String(error),
      }),
    };
  }
};
