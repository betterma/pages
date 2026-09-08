#!/usr/bin/env node

const https = require('https');

const CONFIG = {
  GITHUB_REPO: process.env.GITHUB_REPO || 'betterma/pages',
  DATA_PATH: process.env.DATA_PATH || 'watch-data.json',
  GITHUB_API: 'https://api.github.com',
  GITHUB_TOKEN: process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '',
  SNAPSHOT_INTERVAL: 15 * 60 * 1000,
  HISTORY_DURATION: 3 * 24 * 60 * 60 * 1000,
  TOP20: 20,
  WATCH_POOL_RANK: 30,
  MAX_EVENTS: 300,
  DURATION_MS: {
    '15m': 15 * 60 * 1000,
    '30m': 30 * 60 * 1000,
    '1h': 60 * 60 * 1000,
    '2h': 2 * 60 * 60 * 1000,
    '4h': 4 * 60 * 60 * 1000,
  },
  WINDOW_TOLERANCE_MS: {
    '15m': 2 * 60 * 1000,
    '30m': 2 * 60 * 1000,
    '1h': 2 * 60 * 1000,
    '2h': 2 * 60 * 1000,
    '4h': 2 * 60 * 1000,
  },
  SELECTED_DIMENSION: '15m',
};

function githubHeaders() {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${CONFIG.GITHUB_TOKEN}`,
    'Content-Type': 'application/json',
    'User-Agent': 'binance-radar-monitor',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

function requestJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const request = https.request(
      target,
      {
        method: options.method || 'GET',
        headers: options.headers || {},
      },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          body += chunk;
        });
        response.on('end', () => {
          resolve({
            ok: response.statusCode >= 200 && response.statusCode < 300,
            status: response.statusCode,
            statusText: response.statusMessage || '',
            async json() {
              return JSON.parse(body);
            },
            async text() {
              return body;
            },
          });
        });
      },
    );

    request.on('error', reject);
    request.setTimeout(options.timeout || 10000, () => {
      request.destroy(new Error(`Request timeout: ${url}`));
    });
    if (options.body) request.write(options.body);
    request.end();
  });
}

function encodeBase64(value) {
  return Buffer.from(value, 'utf8').toString('base64');
}

function decodeBase64(value) {
  return Buffer.from(value.replace(/\n/g, ''), 'base64').toString('utf8');
}

function ranking(marketMap) {
  return Object.entries(marketMap)
    .sort((a, b) => b[1].change24h - a[1].change24h)
    .map(([symbol]) => symbol);
}

function getWindowStart(timestamp, duration) {
  return Math.floor(timestamp / duration) * duration;
}

function getWindowTolerance(selectedDimension) {
  return (
    CONFIG.WINDOW_TOLERANCE_MS[selectedDimension] ||
    Math.min(30 * 60 * 1000, Math.max(5 * 60 * 1000, CONFIG.DURATION_MS[selectedDimension] / 2 || 15 * 60 * 1000))
  );
}

function selectWindowSnapshot(history, windowStart, duration, selectedDimension) {
  const tolerance = getWindowTolerance(selectedDimension);
  const windowEnd = windowStart + duration;
  const candidates = history.filter(
    (snapshot) =>
      snapshot.timestamp >= windowStart &&
      snapshot.timestamp <= windowEnd + tolerance,
  );

  if (candidates.length) {
    return [...candidates].sort((a, b) => b.timestamp - a.timestamp)[0];
  }

  const previous = [...history]
    .filter((snapshot) => snapshot.timestamp < windowStart)
    .sort((a, b) => b.timestamp - a.timestamp)[0];

  return previous || null;
}

function comparison(history, selectedDimension) {
  if (!history.length) return null;
  const duration = CONFIG.DURATION_MS[selectedDimension] || 0;
  if (!duration) return null;

  const now = Date.now();
  const currentWindowStart = getWindowStart(now, duration);
  const series = [];
  for (let index = 0; index < 2; index += 1) {
    const windowStart = currentWindowStart - index * duration;
    const snapshot = selectWindowSnapshot(history, windowStart, duration, selectedDimension);
    if (snapshot) series.push(snapshot);
  }
  return series[1] || series[0] || null;
}

function selectEarliestWindowSnapshot(history, windowStart, duration, selectedDimension) {
  const tolerance = getWindowTolerance(selectedDimension);
  const windowEnd = windowStart + duration;
  const strictCandidates = history.filter(
    (snapshot) => snapshot.timestamp >= windowStart && snapshot.timestamp < windowEnd,
  );
  const candidates = strictCandidates.length
    ? strictCandidates
    : history.filter(
        (snapshot) =>
          snapshot.timestamp >= windowStart &&
          snapshot.timestamp < windowEnd + tolerance,
      );
  if (!candidates.length) return null;
  return [...candidates].sort((a, b) => a.timestamp - b.timestamp)[0];
}

function getWindowPriceChange(history, marketMap, symbol, selectedDimension) {
  const duration = CONFIG.DURATION_MS[selectedDimension] || 0;
  if (!duration) return null;
  const snapshot = selectEarliestWindowSnapshot(
    history,
    getWindowStart(Date.now(), duration),
    duration,
    selectedDimension,
  );
  if (!snapshot) return null;
  const oldPrice = snapshot.prices?.[symbol];
  const currentPrice = marketMap[symbol]?.price;
  if (!Number.isFinite(oldPrice) || !Number.isFinite(currentPrice) || oldPrice === 0) {
    return null;
  }
  return ((currentPrice - oldPrice) / oldPrice) * 100;
}

function updateWatchPool(history, marketMap, watchPool) {
  const list = ranking(marketMap);
  const nextPool = new Set(watchPool);

  for (const symbol of [...nextPool]) {
    const rank = list.indexOf(symbol) + 1;
    if (!rank || rank > CONFIG.WATCH_POOL_RANK) nextPool.delete(symbol);
  }

  for (const symbol of list.slice(0, CONFIG.WATCH_POOL_RANK)) {
    const change = getWindowPriceChange(history, marketMap, symbol, '4h');
    if (Number.isFinite(change) && change > 0) nextPool.add(symbol);
  }

  return nextPool;
}

function pruneHistory(history) {
  const cutoff = Date.now() - CONFIG.HISTORY_DURATION;
  return history.filter((item) => item.timestamp >= cutoff);
}

function buildSnapshot(marketMap) {
  const list = ranking(marketMap);
  const ranks = {};
  const prices = {};
  list.forEach((symbol, index) => {
    ranks[symbol] = index + 1;
    prices[symbol] = marketMap[symbol].price;
  });

  return {
    timestamp: Date.now(),
    ranks,
    prices,
  };
}

function evaluateTop20(history, marketMap, alertState, selectedDimension) {
  const list = ranking(marketMap);
  const nextState = { ...alertState };
  const newTop20Symbols = new Set();

  for (const symbol of list) {
    const state = nextState[symbol] || { top20: false };
    const currentRank = list.indexOf(symbol) + 1;
    const oldRank = comparison(history, selectedDimension)?.ranks[symbol] || 999;

    if (currentRank > CONFIG.TOP20) {
      state.top20 = false;
      nextState[symbol] = state;
      continue;
    }

    if (!state.top20 && oldRank > CONFIG.TOP20 && currentRank <= CONFIG.TOP20) {
      newTop20Symbols.add(symbol);
      state.top20 = true;
      nextState[symbol] = state;
    }
  }

  return { alertState: nextState, newTop20Symbols };
}

async function readGithubState() {
  if (!CONFIG.GITHUB_TOKEN) {
    throw new Error('Missing GITHUB_TOKEN. Set it in the environment or GitHub Actions secrets.');
  }

  const url = `${CONFIG.GITHUB_API}/repos/${CONFIG.GITHUB_REPO}/contents/${CONFIG.DATA_PATH}`;
  console.log(`Reading GitHub state from ${url}`);
  const response = await requestJson(url, { headers: githubHeaders() });

  if (response.status === 404) {
    console.log(`GitHub state file not found yet: ${CONFIG.DATA_PATH}`);
    return { history: [], events: [], alertState: {}, favorites: [], watchPool: [], selectedDimension: CONFIG.SELECTED_DIMENSION, sha: null };
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`读取 GitHub 数据失败: ${response.status} ${response.statusText} :: ${text.slice(0, 500)}`);
  }

  const file = await response.json();
  let raw = file.content ? decodeBase64(file.content) : '';

  if (!raw.trim()) {
    const rawUrl = `https://raw.githubusercontent.com/${CONFIG.GITHUB_REPO}/main/${CONFIG.DATA_PATH}?t=${Date.now()}`;
    console.warn(`GitHub Contents response had no content; reading ${rawUrl}`);
    const rawResponse = await requestJson(rawUrl, {
      headers: { 'User-Agent': 'binance-radar-monitor' },
    });
    if (!rawResponse.ok) {
      const text = await rawResponse.text();
      throw new Error(`读取 GitHub Raw 数据失败: ${rawResponse.status} ${rawResponse.statusText} :: ${text.slice(0, 300)}`);
    }
    raw = await rawResponse.text();
  }

  if (!raw.trim()) {
    throw new Error(`GitHub 数据文件为空: ${CONFIG.DATA_PATH}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`GitHub 数据文件不是有效 JSON: ${error.message} :: ${raw.slice(0, 120)}`);
  }

  return {
    history: Array.isArray(parsed.history) ? parsed.history : [],
    events: Array.isArray(parsed.events) ? parsed.events : [],
    alertState: parsed.alertState || {},
    favorites: Array.isArray(parsed.favorites) ? parsed.favorites : [],
    watchPool: Array.isArray(parsed.watchPool) ? parsed.watchPool : [],
    selectedDimension: Object.prototype.hasOwnProperty.call(CONFIG.DURATION_MS, parsed.selectedDimension)
      ? parsed.selectedDimension
      : CONFIG.SELECTED_DIMENSION,
    sha: file.sha,
  };
}

async function writeGithubState(state, sha) {
  const url = `${CONFIG.GITHUB_API}/repos/${CONFIG.GITHUB_REPO}/contents/${CONFIG.DATA_PATH}`;
  const payload = {
    message: 'Update Binance radar data',
    content: encodeBase64(JSON.stringify(state)),
  };

  if (sha) payload.sha = sha;

  console.log(`Writing GitHub state to ${url}`);
  const response = await requestJson(url, {
    method: 'PUT',
    headers: githubHeaders(),
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`保存 GitHub 数据失败: ${response.status} ${response.statusText} :: ${text.slice(0, 300)}`);
  }

  const result = await response.json();
  return result.content.sha;
}

async function fetchBinanceTicker() {
  const endpoints = [
    'https://data-api.binance.vision/api/v3/ticker/24hr',
    'https://api.binance.com/api/v3/ticker/24hr',
  ];

  for (const endpoint of endpoints) {
    try {
      console.log(`Requesting Binance ticker data from ${endpoint}`);
      const response = await requestJson(endpoint);
      if (response.ok) return response.json();

      const text = await response.text();
      console.warn(`Binance API HTTP ${response.status} ${response.statusText} from ${endpoint}: ${text.slice(0, 200)}`);
    } catch (error) {
      console.warn(`Binance API request failed for ${endpoint}: ${error.message}`);
    }
  }

  throw new Error('All Binance ticker endpoints failed');
}

async function main() {
  const state = await readGithubState();
  let history = pruneHistory(state.history.slice());
  let events = state.events.slice();
  let alertState = state.alertState || {};
  let favorites = new Set(state.favorites || []);
  let watchPool = new Set(state.watchPool || []);
  let selectedDimension = Object.prototype.hasOwnProperty.call(CONFIG.DURATION_MS, state.selectedDimension)
    ? state.selectedDimension
    : CONFIG.SELECTED_DIMENSION;

  const data = await fetchBinanceTicker();
  const marketMap = {};

  for (const ticker of data) {
    if (!ticker.symbol.endsWith('USDT')) continue;
    const price = Number(ticker.lastPrice);
    const change = Number(ticker.priceChangePercent);
    if (Number.isFinite(price) && Number.isFinite(change)) {
      marketMap[ticker.symbol] = {
        price,
        change24h: change,
        updateTime: Date.now(),
      };
    }
  }

  const result = evaluateTop20(history, marketMap, alertState, selectedDimension);
  alertState = result.alertState;
  watchPool = updateWatchPool(history, marketMap, watchPool);
  history.push(buildSnapshot(marketMap));
  history = pruneHistory(history);

  events = events.slice(0, CONFIG.MAX_EVENTS);

  const nextState = {
    history,
    events,
    alertState,
    favorites: [...favorites],
    watchPool: [...watchPool],
    selectedDimension,
    savedAt: Date.now(),
  };

  const newSha = await writeGithubState(nextState, state.sha);
  const resultSummary = {
    repository: CONFIG.GITHUB_REPO,
    path: CONFIG.DATA_PATH,
    updatedAt: new Date().toISOString(),
    snapshots: history.length,
    events: events.length,
    watchPool: watchPool.size,
    sha: newSha,
  };
  console.log(
    `Updated ${CONFIG.GITHUB_REPO}/${CONFIG.DATA_PATH} at ${resultSummary.updatedAt} | snapshots=${history.length} | events=${events.length} | watchPool=${watchPool.size} | sha=${newSha}`,
  );
  return resultSummary;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { main };
