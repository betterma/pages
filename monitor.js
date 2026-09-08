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
  // Keep snapshots lean so watch-data.json stays under GitHub Contents 1MB limit.
  SNAPSHOT_MAX_RANK: 150,
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

// Keep favorites helpers inline so Huawei cloud can deploy monitor.js alone.
function normalizeFavoriteItem(item) {
  if (typeof item === 'string' && item.trim()) {
    return {
      symbol: item.trim().toUpperCase(),
      addedAt: 0,
      source: 'legacy',
    };
  }
  if (item && typeof item === 'object' && item.symbol) {
    const symbol = String(item.symbol).trim().toUpperCase();
    if (!symbol) return null;
    return {
      symbol,
      addedAt: Number.isFinite(Number(item.addedAt)) ? Number(item.addedAt) : 0,
      source: item.source ? String(item.source) : 'legacy',
    };
  }
  return null;
}

function normalizeFavorites(raw) {
  if (!Array.isArray(raw)) return [];
  const map = new Map();
  raw.forEach((item) => {
    const normalized = normalizeFavoriteItem(item);
    if (!normalized) return;
    const prev = map.get(normalized.symbol);
    if (!prev || normalized.addedAt >= prev.addedAt) {
      map.set(normalized.symbol, normalized);
    }
  });
  return [...map.values()].sort((a, b) => {
    if (b.addedAt !== a.addedAt) return b.addedAt - a.addedAt;
    return a.symbol.localeCompare(b.symbol);
  });
}

function serializeFavorites(list) {
  return normalizeFavorites(list).map((item) => ({
    symbol: item.symbol,
    addedAt: item.addedAt,
    source: item.source || 'legacy',
  }));
}

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
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(value);
    };

    const target = new URL(url);
    const timeoutMs = options.timeout || 15000;
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
          finish(null, {
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
        response.on('error', (error) => finish(error));
      },
    );

    request.on('error', (error) => finish(error));
    request.setTimeout(timeoutMs, () => {
      request.destroy();
      finish(new Error(`Request timeout after ${timeoutMs}ms: ${url}`));
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
  const list = ranking(marketMap).slice(0, CONFIG.SNAPSHOT_MAX_RANK);
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

function slimSnapshot(snapshot) {
  if (!snapshot || !snapshot.ranks) return snapshot;
  const ranked = Object.entries(snapshot.ranks)
    .sort((a, b) => a[1] - b[1])
    .slice(0, CONFIG.SNAPSHOT_MAX_RANK);
  const ranks = {};
  const prices = {};
  ranked.forEach(([symbol, rank]) => {
    ranks[symbol] = rank;
    if (snapshot.prices && Number.isFinite(snapshot.prices[symbol])) {
      prices[symbol] = snapshot.prices[symbol];
    }
  });
  return {
    timestamp: snapshot.timestamp,
    ranks,
    prices,
  };
}

function slimHistory(history) {
  return history.map(slimSnapshot);
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
  const response = await requestJson(url, {
    headers: githubHeaders(),
    timeout: 15000,
  });

  if (response.status === 404) {
    console.log(`GitHub state file not found yet: ${CONFIG.DATA_PATH}`);
    return { history: [], events: [], alertState: {}, favorites: [], favoritesUpdatedAt: null, watchPool: [], selectedDimension: CONFIG.SELECTED_DIMENSION, sha: null };
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`读取 GitHub 数据失败: ${response.status} ${response.statusText} :: ${text.slice(0, 500)}`);
  }

  const file = await response.json();
  let raw = file.content ? decodeBase64(file.content) : '';

  // Contents API omits inline content when file > 1MB. Prefer GitHub API
  // (api.github.com) over raw.githubusercontent.com — the latter often hangs
  // on China cloud networks.
  if (!raw.trim()) {
    if (!file.sha) {
      throw new Error(`GitHub Contents 无 content 且无 sha: ${CONFIG.DATA_PATH}`);
    }
    const blobUrl = `${CONFIG.GITHUB_API}/repos/${CONFIG.GITHUB_REPO}/git/blobs/${file.sha}`;
    console.warn(
      `GitHub Contents inline empty (file likely >1MB); fetching blob ${file.sha}`,
    );
    const blobResponse = await requestJson(blobUrl, {
      headers: githubHeaders(),
      timeout: 20000,
    });
    if (!blobResponse.ok) {
      const text = await blobResponse.text();
      throw new Error(
        `读取 GitHub Blob 失败: ${blobResponse.status} ${blobResponse.statusText} :: ${text.slice(0, 300)}`,
      );
    }
    const blob = await blobResponse.json();
    if (!blob.content) {
      throw new Error(`GitHub Blob 无 content: ${file.sha}`);
    }
    raw = decodeBase64(blob.content);
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

  console.log(
    `Loaded GitHub state · history=${Array.isArray(parsed.history) ? parsed.history.length : 0} · bytes≈${Buffer.byteLength(raw, 'utf8')}`,
  );

  return {
    history: Array.isArray(parsed.history) ? parsed.history : [],
    events: Array.isArray(parsed.events) ? parsed.events : [],
    alertState: parsed.alertState || {},
    favorites: normalizeFavorites(parsed.favorites),
    favoritesUpdatedAt: Number.isFinite(Number(parsed.favoritesUpdatedAt))
      ? Number(parsed.favoritesUpdatedAt)
      : null,
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

async function runMonitorOnce() {
  const state = await readGithubState();
  let history = pruneHistory(state.history.slice());
  let events = state.events.slice();
  let alertState = state.alertState || {};
  // Personal favorites are owned by the page; monitor only preserves them.
  const favorites = serializeFavorites(state.favorites || []);
  const favoritesUpdatedAt = state.favoritesUpdatedAt;
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
  history = slimHistory(pruneHistory(history));

  events = events.slice(0, CONFIG.MAX_EVENTS);

  const nextState = {
    history,
    events,
    alertState,
    favorites,
    favoritesUpdatedAt,
    watchPool: [...watchPool],
    selectedDimension,
    savedAt: Date.now(),
  };

  const encodedSize = Buffer.byteLength(JSON.stringify(nextState), 'utf8');
  console.log(`Prepared state size ${(encodedSize / 1024).toFixed(1)}KB · snapshots=${history.length}`);
  if (encodedSize > 900 * 1024) {
    console.warn(
      'State still large for Contents API; trimming older snapshots to fit ~900KB',
    );
    while (history.length > 12) {
      const size = Buffer.byteLength(
        JSON.stringify({ ...nextState, history }),
        'utf8',
      );
      if (size <= 900 * 1024) break;
      history.shift();
    }
    nextState.history = history;
    console.log(
      `Trimmed state size ${(Buffer.byteLength(JSON.stringify(nextState), 'utf8') / 1024).toFixed(1)}KB · snapshots=${history.length}`,
    );
  }

  const newSha = await writeGithubState(nextState, state.sha);
  const resultSummary = {
    repository: CONFIG.GITHUB_REPO,
    path: CONFIG.DATA_PATH,
    updatedAt: new Date().toISOString(),
    snapshots: history.length,
    events: events.length,
    watchPool: watchPool.size,
    favorites: favorites.length,
    sha: newSha,
  };
  console.log(
    `Updated ${CONFIG.GITHUB_REPO}/${CONFIG.DATA_PATH} at ${resultSummary.updatedAt} | snapshots=${history.length} | events=${events.length} | watchPool=${watchPool.size} | favorites=${favorites.length} | sha=${newSha}`,
  );
  return resultSummary;
}

async function main() {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await runMonitorOnce();
    } catch (error) {
      lastError = error;
      const message = String(error && error.message ? error.message : error);
      if (!message.includes('409') && !/conflict/i.test(message)) throw error;
      console.warn(`GitHub write conflict, retrying monitor (${attempt + 1}/3)`);
    }
  }
  throw lastError || new Error('monitor failed after conflicts');
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { main };
