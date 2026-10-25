#!/usr/bin/env node

const https = require('https');

const CONFIG = {
  GITHUB_REPO: process.env.GITHUB_REPO || 'betterma/pages',
  DATA_PATH: process.env.DATA_PATH || 'watch-data.json',
  BLACKLIST_PATH: process.env.BLACKLIST_PATH || 'watch-blacklist.json',
  PINS_PATH: process.env.PINS_PATH || 'watch-pins.json',
  GITHUB_API: 'https://api.github.com',
  GITHUB_TOKEN: process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '',
  SNAPSHOT_INTERVAL: 15 * 60 * 1000,
  // 内存侧历史上限（写入 GitHub 前还会按 GH_HISTORY_MS 再裁）。
  HISTORY_DURATION: 3 * 24 * 60 * 60 * 1000,
  // GitHub 热库：近 N 小时；价格只留观察池/榜前/盯住/钉子；名次用紧凑 r[]（前 N 名，冲榜雷达）。
  GH_HISTORY_MS: Number(
    process.env.GH_HISTORY_MS || 48 * 60 * 60 * 1000,
  ),
  // 价格 keep 与冲榜雷达对齐，默认 120 留余量。
  GH_SLIM_RANK_KEEP: Number(process.env.GH_SLIM_RANK_KEEP || 120),
  // 紧凑名次 r[] 只保留前 N 名（写入全市场会撑爆 900KB）；冲榜列表通常 ≤100。
  GH_RANK_LIST_KEEP: Number(process.env.GH_RANK_LIST_KEEP || 150),
  GH_MAX_BYTES: Number(process.env.GH_MAX_BYTES || 900 * 1024),
  // 关注币若历史快照缺价：用币安 15m K 线回填（覆盖 4h 窗口 + 余量）。
  GH_BACKFILL_MS: Number(process.env.GH_BACKFILL_MS || 6 * 60 * 60 * 1000),
  GH_BACKFILL_CONCURRENCY: Number(process.env.GH_BACKFILL_CONCURRENCY || 4),
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

  // 入池：24h 前 N 即进，不要求当前 4h 窗涨（与自动盯「榜高就盯」一致）。
  for (const symbol of list.slice(0, CONFIG.WATCH_POOL_RANK)) {
    if (blocked.has(symbol)) continue;
    nextPool.add(symbol);
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
      // Only keep real *USDT; never invent ADAGBP→ADAGBPUSDT.
      if (symbol && symbol.endsWith('USDT')) set.add(symbol);
    });
    console.log(`Loaded pins ${set.size} symbols for GitHub slim keep-set`);
    return set;
  } catch (error) {
    console.warn(`loadPinSymbols failed: ${error.message}`);
    return new Set();
  }
}

async function loadNailSymbols() {
  const path = process.env.NAILS_PATH || 'watch-nails.json';
  try {
    const file = await loadGithubJsonFile(path);
    const raw =
      (file.data && file.data.nails) ||
      (Array.isArray(file.data) ? file.data : []);
    const set = new Set();
    (raw || []).forEach((item) => {
      const symbol =
        typeof item === 'string'
          ? item.trim().toUpperCase()
          : String((item && item.symbol) || '')
              .trim()
              .toUpperCase();
      if (symbol && symbol.endsWith('USDT')) set.add(symbol);
    });
    console.log(`Loaded nails ${set.size} symbols for GitHub slim keep-set`);
    return set;
  } catch (error) {
    console.warn(`loadNailSymbols failed: ${error.message}`);
    return new Set();
  }
}

/** 快照名次：优先 ranks 对象，否则紧凑 r[]（按名次排列的 symbol 列表）。 */
function rankListFromSnap(snap, limit) {
  const cap = Math.max(0, Number(limit) || 0);
  let list = [];
  if (!snap || typeof snap !== 'object') return list;
  if (Array.isArray(snap.r) && snap.r.length) {
    list = snap.r
      .map((symbol) => String(symbol || '').trim().toUpperCase())
      .filter(Boolean);
  } else if (snap.ranks && typeof snap.ranks === 'object') {
    list = Object.entries(snap.ranks)
      .sort((a, b) => Number(a[1]) - Number(b[1]))
      .map(([symbol]) => String(symbol || '').trim().toUpperCase())
      .filter(Boolean);
  }
  return cap > 0 ? list.slice(0, cap) : list;
}

function ranksFromRankList(list) {
  const ranks = {};
  (Array.isArray(list) ? list : []).forEach((symbol, index) => {
    const key = String(symbol || '').trim().toUpperCase();
    if (key) ranks[key] = index + 1;
  });
  return ranks;
}

/** 读入后补齐 ranks，供冲榜 / 观察池窗口逻辑无感使用。 */
function hydrateWatchSnap(snap) {
  if (!snap || typeof snap !== 'object') return snap;
  const hasRanks =
    snap.ranks &&
    typeof snap.ranks === 'object' &&
    Object.keys(snap.ranks).length > 0;
  if (hasRanks) return snap;
  const list = rankListFromSnap(snap, 0);
  if (!list.length) return snap;
  return {
    ...snap,
    ranks: ranksFromRankList(list),
  };
}

function hydrateWatchHistory(history) {
  return (Array.isArray(history) ? history : []).map(hydrateWatchSnap);
}

/** 热库价格 keep 集：观察池 ∪ 盯/钉 ∪ 榜前 N。 */
function collectKeepSymbols(fullState, marketMap, extraSymbols) {
  const keep = new Set();
  for (const symbol of (fullState && fullState.watchPool) || []) {
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
    Number(CONFIG.GH_SLIM_RANK_KEEP) || 120,
  );
  ranked.slice(0, rankKeep).forEach((symbol) => keep.add(symbol));
  return { keep, rankKeep };
}

/**
 * 用 15m K 线估算快照时刻价：取 openTime ≤ ts 的最后一根收盘；
 * 若快照早于返回的第一根，用第一根开盘兜底（避免窗起点永久缺价）。
 */
function priceFromKlines(klines, timestamp) {
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || !Array.isArray(klines) || !klines.length) {
    return null;
  }
  let best = null;
  for (let i = 0; i < klines.length; i += 1) {
    const openTime = Number(klines[i][0]);
    const close = Number(klines[i][4]);
    if (!Number.isFinite(openTime) || !Number.isFinite(close)) continue;
    if (openTime <= ts) best = close;
    else break;
  }
  if (Number.isFinite(best)) return best;
  const open = Number(klines[0][1]);
  const close = Number(klines[0][4]);
  if (Number.isFinite(open) && open > 0) return open;
  if (Number.isFinite(close) && close > 0) return close;
  return null;
}

async function fetchBinanceKlines(symbol, startMs, endMs) {
  const timeoutMs = Number(process.env.BINANCE_TIMEOUT_MS) || 8000;
  const bases = (
    process.env.BINANCE_KLINE_URLS ||
    [
      'https://api.binance.com',
      'https://data-api.binance.vision',
    ].join(',')
  )
    .split(',')
    .map((item) => item.trim().replace(/\/$/, ''))
    .filter(Boolean);

  let lastError = null;
  for (const base of bases) {
    const url =
      `${base}/api/v3/klines?symbol=${encodeURIComponent(symbol)}` +
      `&interval=15m&startTime=${startMs}&endTime=${endMs}&limit=1000`;
    try {
      const response = await requestJson(url, { timeout: timeoutMs });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const json = await response.json();
      if (!Array.isArray(json)) throw new Error('klines not array');
      return json;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error(`klines failed for ${symbol}`);
}

async function mapPool(items, concurrency, worker) {
  const list = Array.isArray(items) ? items : [];
  const limit = Math.max(1, Number(concurrency) || 1);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, list.length) }, async () => {
    while (cursor < list.length) {
      const index = cursor;
      cursor += 1;
      await worker(list[index], index);
    }
  });
  await Promise.all(runners);
}

/** 当前 4h 窗内最早一张快照（窗涨基准格）。 */
function earliestSnapInCurrentWindow(history, nowMs) {
  const duration = CONFIG.DURATION_MS['4h'] || 4 * 60 * 60 * 1000;
  const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  const windowStart = Math.floor(now / duration) * duration;
  const inWin = (Array.isArray(history) ? history : []).filter((snap) => {
    const t = Number(snap && snap.timestamp) || 0;
    return t >= windowStart && t < windowStart + duration;
  });
  if (!inWin.length) return null;
  return inWin.reduce((earliest, item) =>
    Number(item.timestamp) < Number(earliest.timestamp) ? item : earliest,
  );
}

/**
 * 关注币冲进 keep 时，旧 slim 快照可能没有它的价。
 * 用币安 15m K 线把 lookback 内缺价补上；并强制覆盖「当前 4h 窗起点」那格。
 */
async function backfillKeepPricesInHistory(history, symbols, lookbackMs) {
  const now = Date.now();
  const duration4h = CONFIG.DURATION_MS['4h'] || 4 * 60 * 60 * 1000;
  // 至少盖住一整根 4h + 余量；默认 GH_BACKFILL_MS=6h。
  const span = Math.max(
    Number(lookbackMs) || 0,
    duration4h + 60 * 60 * 1000,
  );
  const snaps = (Array.isArray(history) ? history : []).filter(
    (snap) => Number(snap && snap.timestamp) >= now - span,
  );
  if (!snaps.length) return { fetched: 0, filled: 0, windowStartMiss: 0 };

  const need = [];
  for (const symbol of symbols || []) {
    const key = String(symbol || '')
      .trim()
      .toUpperCase();
    if (!key) continue;
    const missing = snaps.some(
      (snap) => !Number.isFinite(Number(snap.prices && snap.prices[key])),
    );
    if (missing) need.push(key);
  }
  if (!need.length) {
    return { fetched: 0, filled: 0, windowStartMiss: 0 };
  }

  // 多往前多拉一根，避免窗起点落在 K 线区间外。
  const startMs = now - span - CONFIG.SNAPSHOT_INTERVAL * 2;
  const endMs = now;
  let filled = 0;
  const failed = [];
  await mapPool(need, CONFIG.GH_BACKFILL_CONCURRENCY, async (symbol) => {
    try {
      const klines = await fetchBinanceKlines(symbol, startMs, endMs);
      if (!klines.length) {
        failed.push(symbol);
        return;
      }
      for (const snap of snaps) {
        if (!snap.prices || typeof snap.prices !== 'object') snap.prices = {};
        if (Number.isFinite(Number(snap.prices[symbol]))) continue;
        const price = priceFromKlines(klines, snap.timestamp);
        if (Number.isFinite(price) && price > 0) {
          snap.prices[symbol] = price;
          filled += 1;
        }
      }
    } catch (error) {
      failed.push(symbol);
      console.warn(
        `backfill ${symbol} failed: ${error && error.message ? error.message : error}`,
      );
    }
  });

  const winEarliest = earliestSnapInCurrentWindow(history, now);
  let windowStartMiss = 0;
  if (winEarliest) {
    if (!winEarliest.prices || typeof winEarliest.prices !== 'object') {
      winEarliest.prices = {};
    }
    for (const symbol of need) {
      if (Number.isFinite(Number(winEarliest.prices[symbol]))) continue;
      windowStartMiss += 1;
    }
  }

  console.log(
    `Backfilled keep prices · symbols=${need.length} · cells=${filled}` +
      ` · lookback≈${Math.round(span / 3600000)}h` +
      ` · winStartMiss=${windowStartMiss}` +
      (failed.length ? ` · failed=${failed.length}` : ''),
  );
  return { fetched: need.length, filled, windowStartMiss, failed: failed.length };
}

/**
 * GitHub 热库：短历史 + 少量币种价格 + 紧凑名次 r[]（前 N 名，冲榜雷达）。
 */
function buildGithubSlimState(fullState, marketMap, extraSymbols) {
  const { keep, rankKeep } = collectKeepSymbols(
    fullState,
    marketMap,
    extraSymbols,
  );

  const historyMs = Number(CONFIG.GH_HISTORY_MS) || 48 * 60 * 60 * 1000;
  const rankListKeep = Math.max(
    rankKeep,
    Number(CONFIG.GH_RANK_LIST_KEEP) || 150,
  );
  const cutoff = Date.now() - historyMs;
  // 至少保留约 5h，避免 4h 窗口涨跌失效。
  const minSnaps = Math.max(12, Math.ceil((5 * 60 * 60 * 1000) / CONFIG.SNAPSHOT_INTERVAL));
  let history = (Array.isArray(fullState.history) ? fullState.history : [])
    .filter((snap) => Number(snap && snap.timestamp) >= cutoff)
    .map((snap) => {
      const prices = {};
      const src = (snap && snap.prices) || {};
      for (const symbol of keep) {
        const price = Number(src[symbol]);
        if (Number.isFinite(price)) prices[symbol] = price;
      }
      const r = rankListFromSnap(snap, rankListKeep);
      const row = {
        timestamp: Number(snap.timestamp) || 0,
        prices,
      };
      if (r.length) row.r = r;
      return row;
    })
    .filter((snap) => snap.timestamp > 0);

  const maxBytes = Number(CONFIG.GH_MAX_BYTES) || 900 * 1024;
  const pack = (snaps) => ({
    history: snaps,
    watchPool: Array.isArray(fullState.watchPool)
      ? fullState.watchPool.slice()
      : [],
    // Top20 去重态必须进热库，否则同一窗口每 15 分钟会重复判定进入榜。
    alertState: compactAlertState(fullState.alertState),
    events: Array.isArray(fullState.events) ? fullState.events.slice(0, CONFIG.MAX_EVENTS) : [],
    selectedDimension: fullState.selectedDimension || CONFIG.SELECTED_DIMENSION,
    savedAt: Number(fullState.savedAt) || Date.now(),
    source: 'github-slim',
    slim: {
      historyMs,
      keepCount: keep.size,
      rankKeep,
      rankListKeep,
      snapshots: snaps.length,
      hasRankList: snaps.some((s) => Array.isArray(s.r) && s.r.length > 0),
    },
  });

  let state = pack(history);
  let bytes = Buffer.byteLength(JSON.stringify(state), 'utf8');
  let trimmed = false;
  while (bytes > maxBytes && history.length > minSnaps) {
    history = history.slice(1);
    state = pack(history);
    bytes = Buffer.byteLength(JSON.stringify(state), 'utf8');
    trimmed = true;
  }
  if (bytes > maxBytes) {
    throw new Error(
      `GitHub slim still too large after trim: ${(bytes / 1024).toFixed(1)}KB ` +
        `(snaps=${history.length}, limit ~${(maxBytes / 1024).toFixed(0)}KB). ` +
        `Lower GH_RANK_LIST_KEEP / GH_HISTORY_MS.`,
    );
  }
  state.slim.bytes = bytes;
  state.slim.trimmed = trimmed;
  if (trimmed) {
    console.warn(
      `GitHub slim trimmed to ${history.length} snaps · ${(bytes / 1024).toFixed(1)}KB`,
    );
  }
  return state;
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

/** 热库只保留 top20:true；缺省即 false，避免全市场 alertState 撑爆 slim。 */
function compactAlertState(alertState) {
  const out = {};
  for (const [symbol, state] of Object.entries(alertState || {})) {
    if (state && state.top20) {
      const key = String(symbol || '')
        .trim()
        .toUpperCase();
      if (key) out[key] = { top20: true };
    }
  }
  return out;
}

function evaluateTop20(history, marketMap, alertState, selectedDimension) {
  const list = ranking(marketMap);
  const prev = alertState || {};
  const nextState = {};
  const newTop20Symbols = new Set();
  const oldRanks = comparison(history, selectedDimension)?.ranks;

  for (let index = 0; index < list.length; index += 1) {
    const symbol = list[index];
    const currentRank = index + 1;
    if (currentRank > CONFIG.TOP20) continue;

    const wasTop20 = !!(prev[symbol] && prev[symbol].top20);
    const oldRank =
      oldRanks && Number.isFinite(Number(oldRanks[symbol]))
        ? Number(oldRanks[symbol])
        : 999;

    // 与旧逻辑一致：仅「窗口对照时未在榜 → 现进入 Top20」触发一次；
    // 仍在榜则保留标记，离开榜则丢弃（compact 后不再写入）。
    if (!wasTop20 && oldRank > CONFIG.TOP20) {
      newTop20Symbols.add(symbol);
      nextState[symbol] = { top20: true };
    } else if (wasTop20) {
      nextState[symbol] = { top20: true };
    }
  }

  return { alertState: compactAlertState(nextState), newTop20Symbols };
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
    history: hydrateWatchHistory(
      Array.isArray(parsed.history) ? parsed.history : [],
    ),
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
    source: parsed.source || 'github',
  };
}

async function writeGithubState(state, sha) {
  const url = `${CONFIG.GITHUB_API}/repos/${CONFIG.GITHUB_REPO}/contents/${CONFIG.DATA_PATH}`;
  const body = JSON.stringify(state);
  const bytes = Buffer.byteLength(body, 'utf8');
  const limit = Number(CONFIG.GH_MAX_BYTES) || 900 * 1024;
  if (bytes > limit) {
    throw new Error(
      `GitHub slim watch-data too large: ${(bytes / 1024).toFixed(1)}KB (limit ~${(limit / 1024).toFixed(0)}KB)`,
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

async function readMonitorState() {
  if (!CONFIG.GITHUB_TOKEN) {
    throw new Error(
      'Missing GITHUB_TOKEN / GH_TOKEN — set it on the cloud function',
    );
  }
  try {
    const github = await readGithubState();
    return {
      history: github.history,
      events: github.events,
      alertState: github.alertState,
      watchPool: github.watchPool,
      selectedDimension: github.selectedDimension,
    };
  } catch (error) {
    // 读失败直接中止，绝不空写覆盖热库。
    throw new Error(`GitHub watch-data read failed: ${error.message}`);
  }
}

async function fetchBinanceUsdtTradingSet() {
  const endpoints = [
    'https://data-api.binance.vision/api/v3/exchangeInfo',
    'https://api.binance.com/api/v3/exchangeInfo',
  ];
  const timeoutMs = Number(process.env.BINANCE_TIMEOUT_MS) || 8000;
  let lastError = null;
  for (const endpoint of endpoints) {
    try {
      const response = await requestJson(endpoint, { timeout: timeoutMs });
      if (!response.ok) {
        lastError = new Error(`exchangeInfo HTTP ${response.status}`);
        continue;
      }
      const data = await response.json();
      const set = new Set();
      (data.symbols || []).forEach((row) => {
        if (!row || row.status !== 'TRADING' || row.quoteAsset !== 'USDT') return;
        const symbol = String(row.symbol || '').toUpperCase();
        if (symbol) set.add(symbol);
      });
      if (set.size) {
        console.log(`Binance USDT TRADING set size=${set.size}`);
        return set;
      }
      lastError = new Error('exchangeInfo empty USDT TRADING set');
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('Binance exchangeInfo fetch failed');
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
  let history = hydrateWatchHistory(pruneHistory(state.history.slice()));
  let events = Array.isArray(state.events) ? state.events.slice() : [];
  let alertState = state.alertState || {};
  let watchPool = new Set(state.watchPool || []);
  let selectedDimension = Object.prototype.hasOwnProperty.call(
    CONFIG.DURATION_MS,
    state.selectedDimension,
  )
    ? state.selectedDimension
    : CONFIG.SELECTED_DIMENSION;

  const [data, trading] = await Promise.all([
    fetchBinanceTicker(),
    fetchBinanceUsdtTradingSet(),
  ]);
  const marketMap = {};

  for (const ticker of data) {
    const symbol = String(ticker.symbol || '').toUpperCase();
    // 24hr 仍含 BREAK 下架对；只进 TRADING USDT，避免假前 N / 脏自动盯。
    if (!symbol.endsWith('USDT') || !trading.has(symbol)) continue;
    const price = Number(ticker.lastPrice);
    const change = Number(ticker.priceChangePercent);
    if (Number.isFinite(price) && price > 0 && Number.isFinite(change)) {
      marketMap[symbol] = {
        price,
        change24h: change,
        updateTime: Date.now(),
      };
    }
  }

  const blacklist = await loadBlacklistSymbols();
  const [pinSymbols, nailSymbols] = await Promise.all([
    loadPinSymbols(),
    loadNailSymbols(),
  ]);
  const extraKeep = new Set([...pinSymbols, ...nailSymbols]);

  // 先更新观察池（前 N 入池），再用「新池 ∪ 榜前 ∪ 盯钉」回填历史缺价。
  // 旧顺序是先回填再入池：新进榜币若还没进 keep，窗起点会永久空着。
  const result = evaluateTop20(history, marketMap, alertState, selectedDimension);
  alertState = result.alertState;
  watchPool = updateWatchPool(history, marketMap, watchPool, blacklist);

  const keepAfterPool = collectKeepSymbols(
    { watchPool: [...watchPool] },
    marketMap,
    extraKeep,
  ).keep;
  const backfill = await backfillKeepPricesInHistory(
    history,
    keepAfterPool,
    Number(CONFIG.GH_BACKFILL_MS) || 6 * 60 * 60 * 1000,
  );
  if (backfill && backfill.windowStartMiss > 0) {
    console.warn(
      `backfill still missing ${backfill.windowStartMiss} keep prices on current 4h window-start snap`,
    );
  }

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

  const resultSummary = {
    storage: 'github-slim',
    updatedAt: new Date().toISOString(),
    snapshots: history.length,
    events: events.length,
    watchPool: watchPool.size,
    bytes: encodedSize,
    githubSlim: null,
  };

  // 主路径：GitHub 热库（含紧凑 r[]）。
  try {
    const slimState = buildGithubSlimState(nextState, marketMap, extraKeep);
    const slimBytes = Buffer.byteLength(JSON.stringify(slimState), 'utf8');
    console.log(
      `Prepared GitHub slim · ${(slimBytes / 1024).toFixed(1)}KB · snaps=${slimState.history.length} · keep≈${slimState.slim && slimState.slim.keepCount} · rankList=${!!(slimState.slim && slimState.slim.hasRankList)}`,
    );
    const written = await writeGithubSlimState(slimState);
    resultSummary.githubSlim = {
      path: CONFIG.DATA_PATH,
      bytes: written.bytes,
      snapshots: slimState.history.length,
      keepCount: slimState.slim && slimState.slim.keepCount,
      hasRankList: !!(slimState.slim && slimState.slim.hasRankList),
    };
    console.log(
      `Updated GitHub slim ${CONFIG.DATA_PATH} | bytes=${written.bytes} | snaps=${slimState.history.length}`,
    );
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    resultSummary.githubSlim = { error: message };
    console.warn(`GitHub slim write failed: ${message}`);
    throw error;
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
