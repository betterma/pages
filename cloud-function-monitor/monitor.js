#!/usr/bin/env node

const https = require('https');
const { getObjectJson, putObjectJson, obsConfig } = require('./obs-client');

const CONFIG = {
  GITHUB_REPO: process.env.GITHUB_REPO || 'betterma/pages',
  DATA_PATH: process.env.DATA_PATH || 'watch-data.json',
  BLACKLIST_PATH: process.env.BLACKLIST_PATH || 'watch-blacklist.json',
  PINS_PATH: process.env.PINS_PATH || 'watch-pins.json',
  GITHUB_API: 'https://api.github.com',
  GITHUB_TOKEN: process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '',
  SNAPSHOT_INTERVAL: 15 * 60 * 1000,
  // OBS 完整档：约 3 天全市场快照（云函数自用 / 备份）。
  HISTORY_DURATION: 3 * 24 * 60 * 60 * 1000,
  // GitHub 瘦身档：给页面狂读；只留近 N 小时 + 观察池/榜前/盯住币种。
  GH_HISTORY_MS: Number(
    process.env.GH_HISTORY_MS || 48 * 60 * 60 * 1000,
  ),
  GH_SLIM_RANK_KEEP: Number(process.env.GH_SLIM_RANK_KEEP || 80),
  TOP20: 20,
  WATCH_POOL_RANK: 30,
  MAX_EVENTS: 300,
  // Store all USDT symbols in each OBS snapshot (no Top-N trim).
  // File size stays bounded by HISTORY_DURATION (~3 days of 15m snaps).
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
    let request = null;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(wallTimer);
      if (error) reject(error);
      else resolve(value);
    };

    const target = new URL(url);
    const timeoutMs = options.timeout || 10000;
    // Wall-clock timeout: socket setTimeout only starts after connect,
    // which can hang forever from some regions (e.g. CN → Binance).
    const wallTimer = setTimeout(() => {
      if (request) request.destroy();
      finish(new Error(`Request timeout after ${timeoutMs}ms: ${url}`));
    }, timeoutMs);

    request = https.request(
      target,
      {
        method: options.method || 'GET',
        headers: {
          'User-Agent': 'binance-radar-monitor',
          Accept: 'application/json',
          ...(options.headers || {}),
        },
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
      finish(new Error(`Socket timeout after ${timeoutMs}ms: ${url}`));
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

function updateWatchPool(history, marketMap, watchPool, blacklist) {
  const blocked = blacklist instanceof Set ? blacklist : new Set(blacklist || []);
  const list = ranking(marketMap).filter((symbol) => !blocked.has(symbol));
  const nextPool = new Set(watchPool);

  for (const symbol of [...nextPool]) {
    const rank = list.indexOf(symbol) + 1;
    if (blocked.has(symbol) || !rank || rank > CONFIG.WATCH_POOL_RANK) {
      nextPool.delete(symbol);
    }
  }

  for (const symbol of list.slice(0, CONFIG.WATCH_POOL_RANK)) {
    if (blocked.has(symbol)) continue;
    const change = getWindowPriceChange(history, marketMap, symbol, '4h');
    if (Number.isFinite(change) && change > 0) nextPool.add(symbol);
  }

  return nextPool;
}

async function loadGithubJsonFile(path) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'binance-radar-monitor',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (CONFIG.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${CONFIG.GITHUB_TOKEN}`;
  }
  const url = `${CONFIG.GITHUB_API}/repos/${CONFIG.GITHUB_REPO}/contents/${path}`;
  const response = await requestJson(url, { headers, timeout: 12000 });
  if (response.status === 404) {
    return { data: null, sha: null };
  }
  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `读取 GitHub ${path} 失败: ${response.status} :: ${text.slice(0, 200)}`,
    );
  }
  const file = await response.json();
  if (!file.content) {
    return { data: null, sha: file.sha || null };
  }
  return {
    data: JSON.parse(decodeBase64(file.content)),
    sha: file.sha || null,
  };
}

async function loadBlacklistSymbols() {
  const path = CONFIG.BLACKLIST_PATH;
  try {
    const file = await loadGithubJsonFile(path);
    if (!file.data) {
      console.log(`Blacklist file not found: ${path}`);
      return new Set();
    }
    const list = normalizeFavorites(file.data.blacklist);
    console.log(`Loaded blacklist ${list.length} symbols`);
    return new Set(list.map((item) => item.symbol));
  } catch (error) {
    console.warn(`loadBlacklist failed: ${error.message}`);
    return new Set();
  }
}

async function loadPinSymbols() {
  try {
    const file = await loadGithubJsonFile(CONFIG.PINS_PATH);
    const raw =
      (file.data && file.data.pins) ||
      (Array.isArray(file.data) ? file.data : []);
    const set = new Set();
    (raw || []).forEach((item) => {
      const symbol =
        typeof item === 'string'
          ? item.trim().toUpperCase()
          : String((item && item.symbol) || '')
              .trim()
              .toUpperCase();
      if (symbol) set.add(symbol);
    });
    console.log(`Loaded pins ${set.size} symbols for GitHub slim keep-set`);
    return set;
  } catch (error) {
    console.warn(`loadPinSymbols failed: ${error.message}`);
    return new Set();
  }
}

/**
 * GitHub 热库：短历史 + 少量币种价格，供页面/notify 高频读取。
 * OBS 仍保留完整 history（全市场 × 约 3 天）。
 */
function buildGithubSlimState(fullState, marketMap, extraSymbols) {
  const keep = new Set();
  for (const symbol of fullState.watchPool || []) {
    const key = String(symbol || '')
      .trim()
      .toUpperCase();
    if (key) keep.add(key);
  }
  for (const symbol of extraSymbols || []) {
    const key = String(symbol || '')
      .trim()
      .toUpperCase();
    if (key) keep.add(key);
  }
  const ranked = ranking(marketMap || {});
  const rankKeep = Math.max(
    CONFIG.WATCH_POOL_RANK,
    Number(CONFIG.GH_SLIM_RANK_KEEP) || 80,
  );
  ranked.slice(0, rankKeep).forEach((symbol) => keep.add(symbol));

  const cutoff = Date.now() - (Number(CONFIG.GH_HISTORY_MS) || 48 * 60 * 60 * 1000);
  const history = (Array.isArray(fullState.history) ? fullState.history : [])
    .filter((snap) => Number(snap && snap.timestamp) >= cutoff)
    .map((snap) => {
      const prices = {};
      const src = (snap && snap.prices) || {};
      for (const symbol of keep) {
        const price = Number(src[symbol]);
        if (Number.isFinite(price)) prices[symbol] = price;
      }
      return {
        timestamp: Number(snap.timestamp) || 0,
        prices,
      };
    })
    .filter((snap) => snap.timestamp > 0);

  return {
    history,
    watchPool: Array.isArray(fullState.watchPool)
      ? fullState.watchPool.slice()
      : [],
    selectedDimension: fullState.selectedDimension || CONFIG.SELECTED_DIMENSION,
    savedAt: Number(fullState.savedAt) || Date.now(),
    source: 'github-slim',
    slim: {
      historyMs: Number(CONFIG.GH_HISTORY_MS) || 48 * 60 * 60 * 1000,
      keepCount: keep.size,
      rankKeep,
      snapshots: history.length,
    },
  };
}

function pruneHistory(history) {
  const cutoff = Date.now() - CONFIG.HISTORY_DURATION;
  return history.filter((item) => item.timestamp >= cutoff);
}

function buildSnapshot(marketMap) {
  // Persist full USDT ranking so late breakouts still have baseline prices
  // for window-gain / watch-pool detection.
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

function slimSnapshot(snapshot) {
  if (!snapshot || !snapshot.ranks) return snapshot;
  // Keep every symbol already present; only drop broken price entries.
  const ranked = Object.entries(snapshot.ranks).sort((a, b) => a[1] - b[1]);
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
  const body = JSON.stringify(state);
  const bytes = Buffer.byteLength(body, 'utf8');
  if (bytes > 900 * 1024) {
    throw new Error(
      `GitHub slim watch-data too large: ${(bytes / 1024).toFixed(1)}KB (limit ~900KB)`,
    );
  }
  const payload = {
    message: `Update slim watch-data (${(bytes / 1024).toFixed(0)}KB)`,
    content: encodeBase64(body),
  };

  if (sha) payload.sha = sha;

  console.log(`Writing GitHub slim state to ${url} · ${(bytes / 1024).toFixed(1)}KB`);
  const response = await requestJson(url, {
    method: 'PUT',
    headers: githubHeaders(),
    body: JSON.stringify(payload),
    timeout: 30000,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`保存 GitHub 数据失败: ${response.status} ${response.statusText} :: ${text.slice(0, 300)}`);
  }

  const result = await response.json();
  return {
    sha: result.content && result.content.sha,
    bytes,
  };
}

async function writeGithubSlimState(slimState) {
  if (!CONFIG.GITHUB_TOKEN) {
    throw new Error('Missing GITHUB_TOKEN for GitHub slim write');
  }
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const current = await loadGithubJsonFile(CONFIG.DATA_PATH);
      return await writeGithubState(slimState, current.sha);
    } catch (error) {
      lastError = error;
      const message = error && error.message ? error.message : String(error);
      if (!/409|conflict|sha/i.test(message)) break;
      console.warn(`GitHub slim write conflict, retry ${attempt + 1}`);
    }
  }
  throw lastError || new Error('GitHub slim write failed');
}

async function readObsState() {
  const key = process.env.OBS_DATA_PATH || CONFIG.DATA_PATH || 'watch-data.json';
  console.log(`Reading OBS state ${obsConfig().publicBase}/${key}`);
  const parsed = await getObjectJson(key);
  if (!parsed) {
    console.log(`OBS state not found yet: ${key}`);
    return {
      history: [],
      events: [],
      alertState: {},
      watchPool: [],
      selectedDimension: CONFIG.SELECTED_DIMENSION,
    };
  }
  console.log(
    `Loaded OBS state · history=${Array.isArray(parsed.history) ? parsed.history.length : 0}`,
  );
  return {
    history: Array.isArray(parsed.history) ? parsed.history : [],
    events: Array.isArray(parsed.events) ? parsed.events : [],
    alertState: parsed.alertState || {},
    watchPool: Array.isArray(parsed.watchPool) ? parsed.watchPool : [],
    selectedDimension: Object.prototype.hasOwnProperty.call(
      CONFIG.DURATION_MS,
      parsed.selectedDimension,
    )
      ? parsed.selectedDimension
      : CONFIG.SELECTED_DIMENSION,
  };
}

async function writeObsState(state) {
  const key = process.env.OBS_DATA_PATH || CONFIG.DATA_PATH || 'watch-data.json';
  await putObjectJson(key, state);
  return key;
}

async function readMonitorState() {
  try {
    return await readObsState();
  } catch (error) {
    console.warn(`OBS read failed, fallback GitHub: ${error.message}`);
    if (!CONFIG.GITHUB_TOKEN) throw error;
    const github = await readGithubState();
    return {
      history: github.history,
      events: github.events,
      alertState: github.alertState,
      watchPool: github.watchPool,
      selectedDimension: github.selectedDimension,
    };
  }
}

async function fetchBinanceTicker() {
  const fromEnv = process.env.BINANCE_TICKER_URLS;
  const endpoints = (
    fromEnv ||
    [
      'https://api.binance.com/api/v3/ticker/24hr',
      'https://api1.binance.com/api/v3/ticker/24hr',
      'https://api2.binance.com/api/v3/ticker/24hr',
      'https://data-api.binance.vision/api/v3/ticker/24hr',
    ].join(',')
  )
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  const timeoutMs = Number(process.env.BINANCE_TIMEOUT_MS) || 8000;
  const errors = [];

  // Parallel race: first healthy response wins (faster under regional blocks).
  try {
    const data = await Promise.any(
      endpoints.map(async (endpoint) => {
        console.log(`Requesting Binance ticker from ${endpoint}`);
        const response = await requestJson(endpoint, { timeout: timeoutMs });
        if (!response.ok) {
          throw new Error(`${endpoint} HTTP ${response.status}`);
        }
        const json = await response.json();
        if (!Array.isArray(json) || !json.length) {
          throw new Error(`${endpoint} empty ticker`);
        }
        console.log(`Binance OK via ${endpoint}, rows=${json.length}`);
        return json;
      }),
    );
    return data;
  } catch (error) {
    if (error && Array.isArray(error.errors)) {
      error.errors.forEach((item) => {
        errors.push(item && item.message ? item.message : String(item));
        console.warn(`Binance endpoint failed: ${item && item.message}`);
      });
    }
    throw new Error(
      `All Binance ticker endpoints failed within ${timeoutMs}ms. ` +
        `If function region is 华北, Binance is often unreachable — use 香港/新加坡 region, or set BINANCE_TICKER_URLS. ` +
        `Details: ${errors.slice(0, 4).join(' | ') || error.message}`,
    );
  }
}

async function runMonitorOnce() {
  const state = await readMonitorState();
  let history = pruneHistory(state.history.slice());
  let events = state.events.slice();
  let alertState = state.alertState || {};
  let watchPool = new Set(state.watchPool || []);
  let selectedDimension = Object.prototype.hasOwnProperty.call(
    CONFIG.DURATION_MS,
    state.selectedDimension,
  )
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
  const blacklist = await loadBlacklistSymbols();
  watchPool = updateWatchPool(history, marketMap, watchPool, blacklist);
  history.push(buildSnapshot(marketMap));
  history = slimHistory(pruneHistory(history));
  events = events.slice(0, CONFIG.MAX_EVENTS);

  // Personal favorites / blacklist live in GitHub small JSON files (browser-written).
  const nextState = {
    history,
    events,
    alertState,
    watchPool: [...watchPool],
    selectedDimension,
    savedAt: Date.now(),
  };

  const encodedSize = Buffer.byteLength(JSON.stringify(nextState), 'utf8');
  const latestSymbols = history.length
    ? Object.keys(history[history.length - 1].ranks || {}).length
    : 0;
  console.log(
    `Prepared state size ${(encodedSize / 1024).toFixed(1)}KB · snapshots=${history.length} · latestSymbols=${latestSymbols} · blacklist=${blacklist.size}`,
  );

  const key = await writeObsState(nextState);
  const resultSummary = {
    storage: 'obs+github-slim',
    bucket: obsConfig().bucket,
    path: key,
    publicBase: obsConfig().publicBase,
    updatedAt: new Date().toISOString(),
    snapshots: history.length,
    events: events.length,
    watchPool: watchPool.size,
    bytes: encodedSize,
    githubSlim: null,
  };
  console.log(
    `Updated OBS ${resultSummary.bucket}/${key} | snapshots=${history.length} | watchPool=${watchPool.size} | bytes=${encodedSize}`,
  );

  // 页面热路径：瘦身写入 GitHub（失败不回滚 OBS）。
  try {
    const pinSymbols = await loadPinSymbols();
    const slimState = buildGithubSlimState(nextState, marketMap, pinSymbols);
    const slimBytes = Buffer.byteLength(JSON.stringify(slimState), 'utf8');
    console.log(
      `Prepared GitHub slim · ${(slimBytes / 1024).toFixed(1)}KB · snaps=${slimState.history.length} · keep≈${slimState.slim && slimState.slim.keepCount}`,
    );
    const written = await writeGithubSlimState(slimState);
    resultSummary.githubSlim = {
      path: CONFIG.DATA_PATH,
      bytes: written.bytes,
      snapshots: slimState.history.length,
      keepCount: slimState.slim && slimState.slim.keepCount,
    };
    console.log(
      `Updated GitHub slim ${CONFIG.DATA_PATH} | bytes=${written.bytes} | snaps=${slimState.history.length}`,
    );
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    resultSummary.githubSlim = { error: message };
    console.warn(`GitHub slim write skipped: ${message}`);
  }

  return resultSummary;
}

async function main() {
  return runMonitorOnce();
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { main };
