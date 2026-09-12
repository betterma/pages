'use strict';

const https = require('https');

const DEFAULT_REPO = process.env.GITHUB_REPO || 'betterma/pages';

function getToken() {
  return process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
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
          finish(null, {
            ok: response.statusCode >= 200 && response.statusCode < 300,
            status: response.statusCode,
            text: () => Buffer.concat(chunks).toString('utf8'),
          });
        });
        response.on('error', (error) => finish(error));
      },
    );
    request.on('error', (error) => finish(error));
    request.setTimeout(options.timeout || 25000, () => {
      request.destroy();
      finish(new Error(`request timeout: ${url}`));
    });
    if (options.body) request.write(options.body);
    request.end();
  });
}

function encodeBase64Utf8(text) {
  return Buffer.from(text, 'utf8').toString('base64');
}

function decodeBase64Utf8(content) {
  return Buffer.from(String(content || '').replace(/\n/g, ''), 'base64').toString(
    'utf8',
  );
}

function githubHeaders() {
  const token = getToken();
  if (!token) throw new Error('Missing GITHUB_TOKEN');
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'User-Agent': 'watch-notify-cf',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

async function loadJson(path) {
  const response = await requestRaw(
    `https://api.github.com/repos/${DEFAULT_REPO}/contents/${path}?t=${Date.now()}`,
    { method: 'GET', headers: githubHeaders() },
  );
  if (response.status === 404) {
    return { data: null, sha: null };
  }
  if (!response.ok) {
    throw new Error(
      `GitHub GET ${path} failed: ${response.status} ${response.text().slice(0, 200)}`,
    );
  }
  const file = JSON.parse(response.text());
  let raw = decodeBase64Utf8(file.content || '');
  if (!raw.trim() && file.sha) {
    const blob = await requestRaw(
      `https://api.github.com/repos/${DEFAULT_REPO}/git/blobs/${file.sha}`,
      { method: 'GET', headers: githubHeaders() },
    );
    if (!blob.ok) {
      throw new Error(`GitHub blob ${path} failed: ${blob.status}`);
    }
    const body = JSON.parse(blob.text());
    raw = decodeBase64Utf8(body.content || '');
  }
  return {
    data: raw.trim() ? JSON.parse(raw) : null,
    sha: file.sha,
  };
}

async function saveJson(path, data, sha, message) {
  const payload = {
    message: message || `Update ${path}`,
    content: encodeBase64Utf8(JSON.stringify(data, null, 2)),
  };
  if (sha) payload.sha = sha;
  const response = await requestRaw(
    `https://api.github.com/repos/${DEFAULT_REPO}/contents/${path}`,
    {
      method: 'PUT',
      headers: {
        ...githubHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    },
  );
  if (!response.ok) {
    throw new Error(
      `GitHub PUT ${path} failed: ${response.status} ${response.text().slice(0, 220)}`,
    );
  }
  return JSON.parse(response.text());
}

async function fetchBinancePrices(symbols) {
  const set = new Set(
    (symbols || []).map((s) => String(s || '').toUpperCase()).filter(Boolean),
  );
  if (!set.size) return {};
  const endpoints = [
    'https://data-api.binance.vision/api/v3/ticker/price',
    'https://api.binance.com/api/v3/ticker/price',
  ];
  let lastError = null;
  for (const endpoint of endpoints) {
    try {
      const response = await requestRaw(endpoint, { method: 'GET' });
      if (!response.ok) {
        lastError = new Error(`Binance price ${response.status}`);
        continue;
      }
      const list = JSON.parse(response.text());
      const map = {};
      list.forEach((item) => {
        if (!item || !set.has(item.symbol)) return;
        const price = Number(item.price);
        if (Number.isFinite(price)) map[item.symbol] = price;
      });
      return map;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('Binance price fetch failed');
}

async function sendWecomMarkdown(content) {
  const webhook = process.env.WECOM_WEBHOOK_URL || '';
  if (!webhook) throw new Error('Missing WECOM_WEBHOOK_URL');
  const body = JSON.stringify({
    msgtype: 'markdown',
    markdown: { content: String(content || '').slice(0, 4000) },
  });
  const response = await requestRaw(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  if (!response.ok) {
    throw new Error(
      `WeCom webhook failed: ${response.status} ${response.text().slice(0, 200)}`,
    );
  }
  const data = JSON.parse(response.text() || '{}');
  if (data.errcode && data.errcode !== 0) {
    throw new Error(`WeCom errcode ${data.errcode}: ${data.errmsg || ''}`);
  }
  return data;
}

/** @deprecated prefer sendWecomMarkdown */
async function sendWecomText(content) {
  const webhook = process.env.WECOM_WEBHOOK_URL || '';
  if (!webhook) throw new Error('Missing WECOM_WEBHOOK_URL');
  const body = JSON.stringify({
    msgtype: 'text',
    text: { content: String(content || '').slice(0, 2000) },
  });
  const response = await requestRaw(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  if (!response.ok) {
    throw new Error(
      `WeCom webhook failed: ${response.status} ${response.text().slice(0, 200)}`,
    );
  }
  const data = JSON.parse(response.text() || '{}');
  if (data.errcode && data.errcode !== 0) {
    throw new Error(`WeCom errcode ${data.errcode}: ${data.errmsg || ''}`);
  }
  return data;
}

module.exports = {
  loadJson,
  saveJson,
  fetchBinancePrices,
  sendWecomMarkdown,
  sendWecomText,
};
