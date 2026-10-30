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
    'User-Agent': 'baby-chat-cf',
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
  if (response.status === 409) {
    const error = new Error(`GitHub conflict on ${path}`);
    error.code = 'conflict';
    throw error;
  }
  if (!response.ok) {
    throw new Error(
      `GitHub PUT ${path} failed: ${response.status} ${response.text().slice(0, 220)}`,
    );
  }
  return JSON.parse(response.text());
}

function utf8ByteLength(text) {
  return Buffer.byteLength(String(text || ''), 'utf8');
}

function truncateUtf8(text, maxBytes) {
  const raw = String(text || '');
  const buf = Buffer.from(raw, 'utf8');
  if (buf.length <= maxBytes) return raw;
  let end = maxBytes;
  while (end > 0 && (buf[end - 1] & 0xc0) === 0x80) end -= 1;
  return buf.slice(0, end).toString('utf8');
}

async function sendPushPlus(options) {
  const opts = options || {};
  const token = String(opts.token || process.env.PUSHPLUS_TOKEN || '').trim();
  if (!token) throw new Error('Missing PUSHPLUS_TOKEN');
  const title = truncateUtf8(String(opts.title || '宝宝日记'), 100);
  const content = String(opts.content || '').trim();
  if (!content) throw new Error('PushPlus content empty');
  const body = JSON.stringify({
    token,
    title,
    content: truncateUtf8(content, 8000),
    template: 'txt',
    channel: 'wechat',
  });
  const response = await requestRaw('https://www.pushplus.plus/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  const raw = response.text();
  if (!response.ok) {
    throw new Error(`PushPlus HTTP ${response.status} ${raw.slice(0, 200)}`);
  }
  let data = {};
  try {
    data = JSON.parse(raw || '{}');
  } catch (error) {
    throw new Error(`PushPlus bad JSON ${raw.slice(0, 200)}`);
  }
  if (Number(data.code) !== 200) {
    throw new Error(
      `PushPlus code ${data.code}: ${data.msg || data.message || ''}`,
    );
  }
  return data;
}

module.exports = {
  loadJson,
  saveJson,
  sendPushPlus,
  requestRaw,
  utf8ByteLength,
  truncateUtf8,
};
