'use strict';

const https = require('https');
const crypto = require('crypto');

function okxConfig() {
  return {
    apiKey: process.env.OKX_API_KEY || '',
    secretKey: process.env.OKX_SECRET_KEY || '',
    passphrase: process.env.OKX_PASSPHRASE || '',
    baseUrl: process.env.OKX_WEB3_BASE || 'https://web3.okx.com',
  };
}

function requestRaw(url, options = {}) {
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
                `OKX JSON parse failed: ${response.statusCode} ${text.slice(0, 200)}`,
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
    request.setTimeout(options.timeout || 25000, () => {
      request.destroy();
      finish(new Error(`OKX timeout: ${url}`));
    });
    if (options.body) request.write(options.body);
    request.end();
  });
}

function sign(timestamp, method, requestPath, body, secretKey) {
  const prehash = `${timestamp}${method.toUpperCase()}${requestPath}${body || ''}`;
  return crypto
    .createHmac('sha256', secretKey)
    .update(prehash)
    .digest('base64');
}

function authHeaders(method, requestPath, body) {
  const { apiKey, secretKey, passphrase } = okxConfig();
  if (!apiKey || !secretKey || !passphrase) {
    throw new Error(
      'Missing OKX_API_KEY / OKX_SECRET_KEY / OKX_PASSPHRASE',
    );
  }
  const timestamp = new Date().toISOString();
  return {
    'OK-ACCESS-KEY': apiKey,
    'OK-ACCESS-SIGN': sign(timestamp, method, requestPath, body, secretKey),
    'OK-ACCESS-TIMESTAMP': timestamp,
    'OK-ACCESS-PASSPHRASE': passphrase,
    'Content-Type': 'application/json',
  };
}

function normalizeAddress(chainIndex, address) {
  const raw = String(address || '').trim();
  if (!raw) return '';
  return String(chainIndex) === '501' ? raw : raw.toLowerCase();
}

function mapCandleRow(row) {
  if (!Array.isArray(row) || row.length < 5) return null;
  return {
    time: Number(row[0]),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5]),
    volumeUsd: Number(row[6]),
    confirm: String(row[7] ?? ''),
  };
}

async function fetchHistoricalCandles(params) {
  const { baseUrl } = okxConfig();
  const chainIndex = String(params.chainIndex || '').trim();
  const tokenContractAddress = normalizeAddress(
    chainIndex,
    params.tokenContractAddress,
  );
  if (!chainIndex || !tokenContractAddress) {
    throw new Error('chainIndex and tokenContractAddress are required');
  }

  const query = new URLSearchParams({
    chainIndex,
    tokenContractAddress,
    bar: params.bar || '4H',
    limit: String(Math.min(299, Math.max(1, Number(params.limit) || 100))),
  });
  if (params.after) query.set('after', String(params.after));
  if (params.before) query.set('before', String(params.before));

  const requestPath = `/api/v6/dex/market/historical-candles?${query.toString()}`;
  const headers = authHeaders('GET', requestPath, '');
  const response = await requestRaw(`${baseUrl}${requestPath}`, {
    method: 'GET',
    headers,
  });

  if (!response.ok) {
    throw new Error(
      `OKX candles HTTP ${response.status}: ${String(response.text || '').slice(0, 240)}`,
    );
  }
  if (!response.data || String(response.data.code) !== '0') {
    throw new Error(
      `OKX candles error: ${JSON.stringify(response.data).slice(0, 240)}`,
    );
  }

  const rows = Array.isArray(response.data.data) ? response.data.data : [];
  const candles = rows
    .map(mapCandleRow)
    .filter((item) => item && Number.isFinite(item.time) && Number.isFinite(item.close))
    .sort((a, b) => a.time - b.time);

  return {
    chainIndex,
    tokenContractAddress,
    bar: params.bar || '4H',
    candles,
  };
}

module.exports = {
  okxConfig,
  fetchHistoricalCandles,
  normalizeAddress,
};
