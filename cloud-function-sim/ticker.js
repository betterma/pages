'use strict';

const https = require('https');

const BASE = process.env.BINANCE_API_BASE || 'https://api.binance.com';

function requestJson(url) {
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
                `Binance JSON parse failed: ${response.statusCode} ${text.slice(0, 200)}`,
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
    request.setTimeout(15000, () => {
      request.destroy();
      finish(new Error(`Binance timeout: ${url}`));
    });
    request.end();
  });
}

async function getBookTicker(symbol) {
  const key = String(symbol || '')
    .trim()
    .toUpperCase();
  if (!key) throw new Error('bad-symbol');
  const response = await requestJson(
    `${BASE}/api/v3/ticker/bookTicker?symbol=${encodeURIComponent(key)}`,
  );
  if (!response.ok) {
    throw new Error(`bookTicker ${key} ${response.status}`);
  }
  const bid = Number(response.data && response.data.bidPrice);
  const ask = Number(response.data && response.data.askPrice);
  return {
    symbol: key,
    bidPrice: bid,
    askPrice: ask,
  };
}

module.exports = {
  getBookTicker,
};
