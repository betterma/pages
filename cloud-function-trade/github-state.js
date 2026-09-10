'use strict';

const https = require('https');

const DEFAULT_REPO = process.env.GITHUB_REPO || 'betterma/pages';
const STATE_PATH = process.env.TRADE_STATE_KEY || 'trade-bot-state.json';
const LOGS_PATH = process.env.TRADE_LOGS_KEY || 'trade-bot-logs.json';
const MAX_ARCHIVE_LOGS = 500;

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
            buffer: Buffer.concat(chunks),
            text: () => Buffer.concat(chunks).toString('utf8'),
          });
        });
        response.on('error', (error) => finish(error));
      },
    );
    request.on('error', (error) => finish(error));
    request.setTimeout(options.timeout || 20000, () => {
      request.destroy();
      finish(new Error(`GitHub timeout: ${url}`));
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

async function loadJson(path) {
  const token = getToken();
  if (!token) throw new Error('Missing GITHUB_TOKEN');
  const response = await requestRaw(
    `https://api.github.com/repos/${DEFAULT_REPO}/contents/${path}?t=${Date.now()}`,
    {
      method: 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'trade-bot-cf',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    },
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
  const raw = decodeBase64Utf8(file.content || '');
  return {
    data: raw.trim() ? JSON.parse(raw) : null,
    sha: file.sha,
  };
}

async function saveJson(path, data, sha, message) {
  const token = getToken();
  if (!token) throw new Error('Missing GITHUB_TOKEN');
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
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'trade-bot-cf',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify(payload),
    },
  );
  if (response.status === 409) {
    const error = new Error('GitHub conflict');
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

async function loadState() {
  return loadJson(STATE_PATH);
}

async function saveState(data, sha) {
  return saveJson(
    STATE_PATH,
    data,
    sha,
    `trade-tick ${data.symbol || '-'} ${data.lastAction || 'update'}`,
  );
}

async function appendLogs(newLogs) {
  if (!Array.isArray(newLogs) || !newLogs.length) return;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const current = await loadJson(LOGS_PATH);
      const base =
        current.data && Array.isArray(current.data.logs) ? current.data.logs : [];
      const merged = [...newLogs, ...base].slice(0, MAX_ARCHIVE_LOGS);
      await saveJson(
        LOGS_PATH,
        {
          updatedAt: Date.now(),
          count: merged.length,
          logs: merged,
        },
        current.sha,
        `Append trade logs x${newLogs.length}`,
      );
      return;
    } catch (error) {
      if (error.code !== 'conflict') {
        console.warn('appendLogs failed', error.message || error);
        return;
      }
    }
  }
}

module.exports = {
  DEFAULT_REPO,
  STATE_PATH,
  LOGS_PATH,
  loadState,
  saveState,
  appendLogs,
};
