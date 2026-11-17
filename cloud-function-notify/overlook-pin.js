'use strict';

/**
 * 俯瞰类（overlook）：自动盯价高于「渲染窗前方」全部 4h K 线最高价。
 *
 * 口径（与页面默认「近3天 · 4h」≈18 根一致）：
 * - 取盯价所在那根 4h K（openTime ≤ pinnedAt < openTime+4h）
 * - 前方 = 该根之前、同一 18 根窗内的最多 17 根
 * - overPct = pinPrice / max(prior.high) - 1
 * - 俯瞰：overPct > 0；强俯瞰：overPct >= OVERLOOK_STRONG_PCT（默认 5）
 *
 * 本模块只负责分类与度量，不写盘、不推企微。
 * 落盘 / 通知应在 notify 定时任务里调用后写入 watch-overlook.json（或 pin 附加字段）。
 */

const { requestRaw } = require('./github-wecom');

const OVERLOOK_CLASS = 'overlook';
const OVERLOOK_INTERVAL = '4h';
const OVERLOOK_WINDOW_BARS = 18;
const OVERLOOK_DURATION_MS = 4 * 60 * 60 * 1000;
/** 强俯瞰阈值：2026-11 BREV 样本中 ≥5% 仅筛出爆发单；弱俯瞰(0~2%)噪声大。 */
const OVERLOOK_STRONG_PCT = Number(process.env.OVERLOOK_STRONG_PCT || 5);
const OVERLOOK_STATE_PATH =
  process.env.OVERLOOK_STATE_PATH || 'watch-overlook.json';

/**
 * @typedef {object} OverlookCandle
 * @property {number} ot  open time ms
 * @property {number} o
 * @property {number} h
 * @property {number} l
 * @property {number} c
 */

/**
 * @typedef {object} OverlookMeasure
 * @property {string} classId  'overlook' | ''
 * @property {boolean} overlooks  pinPrice > priorHigh
 * @property {boolean} strong  overlooks && overPct >= STRONG
 * @property {string} tier  'strong' | 'weak' | 'none'
 * @property {number} overPct
 * @property {number} priorHigh
 * @property {number} priorCount
 * @property {number} pinIdx
 * @property {number} openVsPriorPct  当前根开盘相对 priorHigh
 * @property {number} pinVsOpenPct   盯价相对当前根开盘
 */

function finitePos(n) {
  const x = Number(n);
  return Number.isFinite(x) && x > 0 ? x : NaN;
}

/**
 * 在已对齐的 candles（按时间升序）上度量俯瞰。
 * @param {OverlookCandle[]} candles
 * @param {number} pinPrice
 * @param {number} pinnedAt
 * @param {{ windowBars?: number, strongPct?: number }} [opts]
 * @returns {OverlookMeasure}
 */
function measureOverlook(candles, pinPrice, pinnedAt, opts) {
  const empty = {
    classId: '',
    overlooks: false,
    strong: false,
    tier: 'none',
    overPct: NaN,
    priorHigh: NaN,
    priorCount: 0,
    pinIdx: -1,
    openVsPriorPct: NaN,
    pinVsOpenPct: NaN,
  };
  const list = Array.isArray(candles) ? candles : [];
  const pin = finitePos(pinPrice);
  const at = Number(pinnedAt) || 0;
  if (!list.length || !Number.isFinite(pin) || !(at > 0)) return empty;

  const windowBars = Math.max(
    2,
    Math.floor(Number(opts && opts.windowBars) || OVERLOOK_WINDOW_BARS),
  );
  const strongPct = Number(opts && opts.strongPct);
  const strongThreshold = Number.isFinite(strongPct)
    ? strongPct
    : OVERLOOK_STRONG_PCT;

  let pinIdx = -1;
  for (let i = 0; i < list.length; i += 1) {
    const ot = Number(list[i].ot) || 0;
    if (at >= ot && at < ot + OVERLOOK_DURATION_MS) {
      pinIdx = i;
      break;
    }
  }
  if (pinIdx < 0) {
    const last = list[list.length - 1];
    if (last && at >= Number(last.ot)) pinIdx = list.length - 1;
  }
  if (pinIdx < 0) return empty;

  const start = Math.max(0, pinIdx - (windowBars - 1));
  const priorEnd = pinIdx - 1;
  let priorHigh = NaN;
  let priorCount = 0;
  if (priorEnd >= start) {
    let maxH = -Infinity;
    for (let i = start; i <= priorEnd; i += 1) {
      const h = Number(list[i].h);
      if (Number.isFinite(h) && h > maxH) maxH = h;
      priorCount += 1;
    }
    if (maxH > -Infinity) priorHigh = maxH;
  }

  const overPct =
    priorCount > 0 && Number.isFinite(priorHigh) && priorHigh > 0
      ? (pin / priorHigh - 1) * 100
      : NaN;
  const overlooks =
    priorCount > 0 && Number.isFinite(priorHigh) && pin > priorHigh;
  const strong =
    overlooks && Number.isFinite(overPct) && overPct >= strongThreshold;
  const open = finitePos(list[pinIdx].o);
  const openVsPriorPct =
    Number.isFinite(open) && Number.isFinite(priorHigh) && priorHigh > 0
      ? (open / priorHigh - 1) * 100
      : NaN;
  const pinVsOpenPct =
    Number.isFinite(open) && open > 0 ? (pin / open - 1) * 100 : NaN;

  return {
    classId: overlooks ? OVERLOOK_CLASS : '',
    overlooks,
    strong,
    tier: strong ? 'strong' : overlooks ? 'weak' : 'none',
    overPct,
    priorHigh,
    priorCount,
    pinIdx,
    openVsPriorPct,
    pinVsOpenPct,
  };
}

function parseKlineRows(rows) {
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row) => ({
      ot: Number(row[0]),
      o: Number(row[1]),
      h: Number(row[2]),
      l: Number(row[3]),
      c: Number(row[4]),
    }))
    .filter((c) => Number.isFinite(c.ot) && c.ot > 0);
}

async function fetchOverlookKlines(symbol, pinnedAt, limit) {
  const key = String(symbol || '')
    .trim()
    .toUpperCase();
  const at = Number(pinnedAt) || 0;
  const n = Math.max(OVERLOOK_WINDOW_BARS + 2, Math.floor(Number(limit) || 24));
  if (!key || !(at > 0)) return [];
  const endTime = at + OVERLOOK_DURATION_MS - 1;
  const query = `symbol=${encodeURIComponent(key)}&interval=${OVERLOOK_INTERVAL}&limit=${n}&endTime=${endTime}`;
  const endpoints = [
    `https://data-api.binance.vision/api/v3/klines?${query}`,
    `https://api.binance.com/api/v3/klines?${query}`,
  ];
  let lastError = null;
  for (const url of endpoints) {
    try {
      const response = await requestRaw(url, { method: 'GET', timeout: 20000 });
      if (!response.ok) {
        lastError = new Error(`klines HTTP ${response.status}`);
        continue;
      }
      const rows = JSON.parse(await response.text());
      const candles = parseKlineRows(rows);
      if (candles.length) return candles;
      lastError = new Error('klines empty');
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) {
    console.warn('overlook-pin klines failed', key, lastError.message || lastError);
  }
  return [];
}

/**
 * 拉取盯时窗口 K 线并分类。
 * @returns {Promise<OverlookMeasure & { symbol: string, pinPrice: number, pinnedAt: number }>}
 */
async function evaluateOverlookPin(symbol, pinPrice, pinnedAt, opts) {
  const key = String(symbol || '')
    .trim()
    .toUpperCase();
  const pin = finitePos(pinPrice);
  const at = Number(pinnedAt) || 0;
  const candles = await fetchOverlookKlines(key, at, opts && opts.limit);
  const measure = measureOverlook(candles, pin, at, opts);
  return {
    symbol: key,
    pinPrice: pin,
    pinnedAt: at,
    ...measure,
  };
}

/** 供落盘 / 通知用的精简行。 */
function toOverlookRecord(evalRow, detectedAt) {
  if (!evalRow || !evalRow.overlooks) return null;
  return {
    symbol: evalRow.symbol,
    class: OVERLOOK_CLASS,
    tier: evalRow.tier,
    pinnedAt: evalRow.pinnedAt,
    pinPrice: evalRow.pinPrice,
    priorHigh: evalRow.priorHigh,
    overPct: evalRow.overPct,
    openVsPriorPct: evalRow.openVsPriorPct,
    pinVsOpenPct: evalRow.pinVsOpenPct,
    detectedAt: Number(detectedAt) || Date.now(),
  };
}

const OVERLOOK_TTL_MS = Number(
  process.env.OVERLOOK_TTL_MS || 24 * 60 * 60 * 1000,
);
/** 每轮最多评估几只未分类的近时自动盯，避免打满 K 线限速。 */
const OVERLOOK_CHECK_MAX = Number(process.env.OVERLOOK_CHECK_MAX || 8);
const OVERLOOK_LOOKBACK_MS = Number(
  process.env.OVERLOOK_LOOKBACK_MS || 2 * 60 * 60 * 1000,
);
const AUTO_PIN_SOURCES = new Set(['auto-rising', 'auto-cloud', 'auto-rewarm']);

function itemKey(symbol, pinnedAt) {
  return `${String(symbol || '')
    .trim()
    .toUpperCase()}@${Number(pinnedAt) || 0}`;
}

function normalizeOverlookState(raw) {
  const items = Array.isArray(raw && raw.items) ? raw.items : [];
  const cleaned = [];
  const seen = new Set();
  for (const row of items) {
    if (!row || typeof row !== 'object') continue;
    const symbol = String(row.symbol || '')
      .trim()
      .toUpperCase();
    const pinnedAt = Number(row.pinnedAt) || 0;
    const pinPrice = Number(row.pinPrice);
    if (!symbol || !(pinnedAt > 0) || !(Number.isFinite(pinPrice) && pinPrice > 0)) {
      continue;
    }
    const key = itemKey(symbol, pinnedAt);
    if (seen.has(key)) continue;
    seen.add(key);
    const overPct = Number(row.overPct);
    const tier =
      row.tier === 'strong' || row.tier === 'weak'
        ? row.tier
        : Number.isFinite(overPct) && overPct >= OVERLOOK_STRONG_PCT
          ? 'strong'
          : 'weak';
    cleaned.push({
      symbol,
      class: OVERLOOK_CLASS,
      tier,
      pinnedAt,
      pinPrice,
      priorHigh: Number(row.priorHigh) || 0,
      overPct: Number.isFinite(overPct) ? overPct : 0,
      openVsPriorPct: Number(row.openVsPriorPct),
      pinVsOpenPct: Number(row.pinVsOpenPct),
      detectedAt: Number(row.detectedAt) || pinnedAt,
    });
  }
  cleaned.sort((a, b) => (b.detectedAt || 0) - (a.detectedAt || 0));
  return {
    updatedAt: Number(raw && raw.updatedAt) || 0,
    items: cleaned,
  };
}

function trimOverlookItems(items, now) {
  const cutoff = (Number(now) || Date.now()) - OVERLOOK_TTL_MS;
  return (items || []).filter((row) => (Number(row.detectedAt) || 0) >= cutoff);
}

/**
 * 对新近自动盯做俯瞰分类并写入 watch-overlook.json。
 * 只落盘，不推企微（网页置顶摘要条消费）。
 *
 * @param {{ pins?: object[], newcomers?: string[], now?: number, path?: string, loadJson?: Function, saveJson?: Function }} opts
 */
async function runOverlookDetect(opts) {
  const options = opts || {};
  const now = Number(options.now) || Date.now();
  const path = options.path || OVERLOOK_STATE_PATH;
  const loadJson = options.loadJson;
  const saveJson = options.saveJson;
  const result = {
    skipped: false,
    checked: 0,
    hits: 0,
    strong: 0,
    weak: 0,
    added: [],
    reason: null,
  };
  if (typeof loadJson !== 'function' || typeof saveJson !== 'function') {
    result.skipped = true;
    result.reason = 'missing-io';
    return result;
  }

  let file;
  try {
    file = await loadJson(path);
  } catch (error) {
    result.skipped = true;
    result.reason = 'load-failed';
    result.error = error && error.message ? error.message : String(error);
    return result;
  }
  const state = normalizeOverlookState(file && file.data);
  const known = new Set(
    state.items.map((row) => itemKey(row.symbol, row.pinnedAt)),
  );

  const pinList = Array.isArray(options.pins) ? options.pins : [];
  const newcomerSet = new Set(
    (Array.isArray(options.newcomers) ? options.newcomers : [])
      .map((s) =>
        String(s || '')
          .trim()
          .toUpperCase(),
      )
      .filter(Boolean),
  );
  const lookback = now - OVERLOOK_LOOKBACK_MS;
  const candidates = [];
  const seenSym = new Set();
  for (const item of pinList) {
    if (!item || !item.symbol) continue;
    const symbol = String(item.symbol)
      .trim()
      .toUpperCase();
    const source = String(item.source || '');
    const pinnedAt = Number(item.pinnedAt) || 0;
    const pinPrice = Number(item.pinPrice);
    if (!symbol || !AUTO_PIN_SOURCES.has(source)) continue;
    if (!(pinnedAt >= lookback)) continue;
    if (!(Number.isFinite(pinPrice) && pinPrice > 0)) continue;
    if (known.has(itemKey(symbol, pinnedAt))) continue;
    if (seenSym.has(symbol)) continue;
    seenSym.add(symbol);
    candidates.push({
      symbol,
      pinPrice,
      pinnedAt,
      priority: newcomerSet.has(symbol) ? 0 : 1,
    });
  }
  candidates.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return b.pinnedAt - a.pinnedAt;
  });
  const batch = candidates.slice(0, Math.max(0, OVERLOOK_CHECK_MAX));
  if (!batch.length) {
    const trimmed = trimOverlookItems(state.items, now);
    if (trimmed.length !== state.items.length) {
      const next = { updatedAt: now, items: trimmed };
      await saveJson(path, next, file && file.sha, 'Trim overlook TTL');
      result.reason = 'trimmed-only';
      result.items = trimmed.length;
      return result;
    }
    result.skipped = true;
    result.reason = 'nothing-to-check';
    return result;
  }

  const added = [];
  for (const row of batch) {
    result.checked += 1;
    try {
      const measured = await evaluateOverlookPin(
        row.symbol,
        row.pinPrice,
        row.pinnedAt,
      );
      const rec = toOverlookRecord(measured, now);
      if (!rec) continue;
      result.hits += 1;
      if (rec.tier === 'strong') result.strong += 1;
      else result.weak += 1;
      added.push(rec);
      result.added.push(rec.symbol);
    } catch (error) {
      console.warn(
        'overlook evaluate failed',
        row.symbol,
        error && error.message ? error.message : error,
      );
    }
  }

  const merged = trimOverlookItems([...added, ...state.items], now);
  // de-dupe by symbol@pinnedAt keeping newest detectedAt
  const map = new Map();
  for (const row of merged) {
    const key = itemKey(row.symbol, row.pinnedAt);
    const prev = map.get(key);
    if (!prev || (row.detectedAt || 0) >= (prev.detectedAt || 0)) {
      map.set(key, row);
    }
  }
  const nextItems = [...map.values()].sort(
    (a, b) => (b.detectedAt || 0) - (a.detectedAt || 0),
  );
  const changed =
    added.length > 0 ||
    nextItems.length !== state.items.length ||
    JSON.stringify(nextItems) !== JSON.stringify(state.items);
  if (!changed) {
    result.reason = 'unchanged';
    return result;
  }
  const next = { updatedAt: now, items: nextItems };
  await saveJson(
    path,
    next,
    file && file.sha,
    added.length
      ? `Overlook detect: +${added.length} (strong ${result.strong})`
      : 'Update overlook state',
  );
  result.items = nextItems.length;
  return result;
}

module.exports = {
  OVERLOOK_CLASS,
  OVERLOOK_INTERVAL,
  OVERLOOK_WINDOW_BARS,
  OVERLOOK_DURATION_MS,
  OVERLOOK_STRONG_PCT,
  OVERLOOK_STATE_PATH,
  OVERLOOK_TTL_MS,
  measureOverlook,
  evaluateOverlookPin,
  fetchOverlookKlines,
  toOverlookRecord,
  normalizeOverlookState,
  runOverlookDetect,
};
