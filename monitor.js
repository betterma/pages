#!/usr/bin/env node

const CONFIG = {
  GITHUB_REPO: process.env.GITHUB_REPO || 'betterma/pages',
  GITHUB_PATH: process.env.GITHUB_PATH || 'watch-data.json',
  GITHUB_API: 'https://api.github.com',
  GITHUB_TOKEN: process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '',
  SNAPSHOT_INTERVAL: 15 * 60 * 1000,
  HISTORY_DURATION: 3 * 24 * 60 * 60 * 1000,
  TOP20: 20,
  MAX_EVENTS: 300,
  DURATION_MS: {
    '15m': 15 * 60 * 1000,
    '30m': 30 * 60 * 1000,
    '1h': 60 * 60 * 1000,
    '2h': 2 * 60 * 60 * 1000,
    '4h': 4 * 60 * 60 * 1000,
  },
  WINDOW_TOLERANCE_MS: {
    '15m': 5 * 60 * 1000,
    '30m': 10 * 60 * 1000,
    '1h': 15 * 60 * 1000,
    '2h': 20 * 60 * 1000,
    '4h': 30 * 60 * 1000,
  },
  SELECTED_DIMENSION: '15m',
};

function githubHeaders() {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${CONFIG.GITHUB_TOKEN}`,
    'Content-Type': 'application/json',
  };
}

function encodeBase64(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return Buffer.from(binary, 'latin1').toString('base64');
}

function decodeBase64(value) {
  const binary = Buffer.from(value.replace(/\n/g, ''), 'base64').toString('latin1');
  return Buffer.from(binary, 'latin1').toString('utf8');
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
    return [...candidates].sort((a, b) => a.timestamp - b.timestamp)[0];
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

  const url = `${CONFIG.GITHUB_API}/repos/${CONFIG.GITHUB_REPO}/contents/${CONFIG.GITHUB_PATH}`;
  console.log(`Reading GitHub state from ${url}`);
  const response = await fetch(url, { headers: githubHeaders() });

  if (response.status === 404) {
    console.log(`GitHub state file not found yet: ${CONFIG.GITHUB_PATH}`);
    return { history: [], events: [], alertState: {}, favorites: [], selectedDimension: CONFIG.SELECTED_DIMENSION, sha: null };
  }

  if (!response.ok) {
    throw new Error(`读取 GitHub 数据失败: ${response.status} ${response.statusText}`);
  }

  const file = await response.json();
  const raw = decodeBase64(file.content);
  const parsed = JSON.parse(raw);

  return {
    history: Array.isArray(parsed.history) ? parsed.history : [],
    events: Array.isArray(parsed.events) ? parsed.events : [],
    alertState: parsed.alertState || {},
    favorites: Array.isArray(parsed.favorites) ? parsed.favorites : [],
    selectedDimension: Object.prototype.hasOwnProperty.call(CONFIG.DURATION_MS, parsed.selectedDimension)
      ? parsed.selectedDimension
      : CONFIG.SELECTED_DIMENSION,
    sha: file.sha,
  };
}

async function writeGithubState(state, sha) {
  const url = `${CONFIG.GITHUB_API}/repos/${CONFIG.GITHUB_REPO}/contents/${CONFIG.GITHUB_PATH}`;
  const payload = {
    message: 'Update Binance radar data',
    content: encodeBase64(JSON.stringify(state)),
  };

  if (sha) payload.sha = sha;

  console.log(`Writing GitHub state to ${url}`);
  const response = await fetch(url, {
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
  console.log('Requesting Binance ticker data');
  const response = await fetch('https://api.binance.com/api/v3/ticker/24hr');
  if (!response.ok) {
    throw new Error(`Binance API HTTP ${response.status} ${response.statusText}`);
  }
  return response.json();
}

async function main() {
  try {
    const state = await readGithubState();
    let history = pruneHistory(state.history.slice());
    let events = state.events.slice();
    let alertState = state.alertState || {};
    let favorites = new Set(state.favorites || []);
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
    const lastSnapshot = history[history.length - 1];

    if (!history.length || Date.now() - lastSnapshot.timestamp >= CONFIG.SNAPSHOT_INTERVAL) {
      history.push(buildSnapshot(marketMap));
      history = pruneHistory(history);
    }

    events = events.slice(0, CONFIG.MAX_EVENTS);

    const nextState = {
      history,
      events,
      alertState,
      favorites: [...favorites],
      selectedDimension,
      savedAt: Date.now(),
    };

    const newSha = await writeGithubState(nextState, state.sha);
    console.log(`Updated ${CONFIG.GITHUB_REPO}/${CONFIG.GITHUB_PATH} at ${new Date().toISOString()} | snapshots=${history.length} | events=${events.length} | sha=${newSha}`);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}

main();
