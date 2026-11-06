'use strict';

/**
 * 天平 / 直拉（自动盯）：
 * - 天平：盯后曾影线跌破 pinPrice（low），现价 > 跌破 K 最低收盘
 * - 直拉：盯后实体从未跌破 pin（min(open,close)；下影不算），现价 > 盯价
 * 可同时命中 → 一条「天平·直拉」。
 * 网页 notices：形态命中即落盘（不要求当前 4h 窗上涨）。
 * 企微：形态命中且当前 4h 窗上涨才推。
 * 冷却：lastNoticeAt / lastSentAt 各管网页与企微，默认各 30 分钟；
 * 未窗上涨时不写 lastSentAt，下轮继续查，窗翻红后再推企微。
 * 默认每轮检查全部企微冷却到期的自动盯（CHECK_MAX=0）；
 * 企微默认窗上涨命中全计入一批摘要（SEND_MAX=0）：只发时间戳+数量。
 */

const { loadJson, saveJson, sendWecomText, fetchBinanceTickers } =
  require('./github-wecom');
const { fetchKlines } = require('./kline-chart');

const STATE_PATH =
  process.env.BALANCE_ALERT_PATH || 'watch-balance-alert.json';
const NOTICES_PATH =
  process.env.BALANCE_NOTICES_PATH || 'watch-balance-notices.json';
const NAILS_PATH = process.env.NAILS_PATH || 'watch-nails.json';
const PINS_PATH = process.env.PINS_PATH || 'watch-pins.json';
const INTERVAL = process.env.BALANCE_ALERT_INTERVAL || '4h';
const LIMIT = Math.max(12, Number(process.env.BALANCE_ALERT_LIMIT || 18));
const NOTICES_TTL_MS = 24 * 60 * 60 * 1000;
const DURATION_MS = {
  '15m': 15 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '2h': 2 * 60 * 60 * 1000,
  '4h': 4 * 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000,
};
const CONCURRENCY = Math.max(
  1,
  Number(process.env.BALANCE_ALERT_CONCURRENCY || 8),
);
/** 单轮最多推企微几只；默认 0=窗上涨命中全推。只限企微，不影响网页 notices。 */
const SEND_MAX = Math.max(
  0,
  Number(
    process.env.BALANCE_ALERT_SEND_MAX === undefined ||
      process.env.BALANCE_ALERT_SEND_MAX === ''
      ? 0
      : process.env.BALANCE_ALERT_SEND_MAX,
  ),
);
/** 两只企微之间的间隔（默认 800ms），减轻文+图连打触发限流。 */
const SEND_GAP_MS = Math.max(
  0,
  Number(
    process.env.BALANCE_ALERT_SEND_GAP_MS === undefined ||
      process.env.BALANCE_ALERT_SEND_GAP_MS === ''
      ? 800
      : process.env.BALANCE_ALERT_SEND_GAP_MS,
  ),
);
/** 单轮最多拉 K 检查几只；默认 0=冷却到期全查。>0 时用 checkCursor 轮询切片。 */
const CHECK_MAX = Math.max(
  0,
  Number(
    process.env.BALANCE_ALERT_CHECK_MAX === undefined ||
      process.env.BALANCE_ALERT_CHECK_MAX === ''
      ? 0
      : process.env.BALANCE_ALERT_CHECK_MAX,
  ),
);
/** 同一币两次企微最短间隔（默认 30 分钟）。 */
const COOLDOWN_MS = Math.max(
  0,
  Number(
    process.env.BALANCE_ALERT_COOLDOWN_MS === undefined ||
      process.env.BALANCE_ALERT_COOLDOWN_MS === ''
      ? 30 * 60 * 1000
      : process.env.BALANCE_ALERT_COOLDOWN_MS,
  ),
);
const AUTO_SOURCES = new Set(['auto-rising', 'auto-cloud', 'auto-rewarm']);

function enabled() {
  return (
    String(
      process.env.BALANCE_ALERT === undefined ? '1' : process.env.BALANCE_ALERT,
    ) !== '0'
  );
}

function resolveWebhook() {
  return (
    String(process.env.WECOM_WEBHOOK_PINS || '').trim() ||
    String(process.env.WECOM_WEBHOOK_POSITIONS || '').trim() ||
    String(process.env.WECOM_WEBHOOK_URL || '').trim()
  );
}

function labelOf(symbol) {
  return String(symbol || '').replace(/USDT$/i, '');
}

function parseAlertPrice(note) {
  const text = String(note || '').trim();
  if (!text) return null;
  const match = text.match(/(\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function currentWindowOpen(now) {
  const durationMs = DURATION_MS[INTERVAL] || DURATION_MS['4h'];
  const ts = Number(now) || Date.now();
  return Math.floor(ts / durationMs) * durationMs;
}

function notePriceBySymbol(nailsRaw) {
  const list = Array.isArray(nailsRaw)
    ? nailsRaw
    : Array.isArray(nailsRaw && nailsRaw.nails)
      ? nailsRaw.nails
      : [];
  const map = {};
  list.forEach((item) => {
    if (!item || typeof item !== 'object') return;
    const symbol = String(item.symbol || '')
      .trim()
      .toUpperCase();
    if (!symbol) return;
    const price = parseAlertPrice(item.note);
    if (!(Number.isFinite(price) && price > 0)) return;
    map[symbol] = {
      alertPrice: price,
      noteAt: Number(item.noteAt) || 0,
    };
  });
  return map;
}

function trimBalanceNotices(list, now) {
  const cutoff = (Number(now) || Date.now()) - NOTICES_TTL_MS;
  const filtered = (Array.isArray(list) ? list : []).filter(
    (item) => item && Number(item.at) >= cutoff,
  );
  // 同币：保留最早 firstSeenAt；保留最大 batchAt（避免普通 notices 写入冲掉企微批次）。
  const firstBySymbol = {};
  const batchBySymbol = {};
  filtered.forEach((item) => {
    const symbol = String(item.symbol || '')
      .trim()
      .toUpperCase();
    if (!symbol) return;
    const at = Number(item.at) || 0;
    const first = Number(item.firstSeenAt) || at;
    if (first > 0 && (!firstBySymbol[symbol] || first < firstBySymbol[symbol])) {
      firstBySymbol[symbol] = first;
    }
    const bat = Number(item.batchAt) || 0;
    if (bat > 0 && (!batchBySymbol[symbol] || bat > batchBySymbol[symbol])) {
      batchBySymbol[symbol] = bat;
    }
  });
  const seen = new Set();
  const out = [];
  filtered
    .sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0))
    .forEach((item) => {
      const symbol = String(item.symbol || '')
        .trim()
        .toUpperCase();
      if (!symbol || seen.has(symbol)) return;
      seen.add(symbol);
      const kinds = Array.isArray(item.kinds)
        ? item.kinds.map(String).filter(Boolean)
        : [];
      const pinPrice = Number(item.pinPrice);
      const at = Number(item.at) || 0;
      const openTime = Number(item.openTime) || currentWindowOpen(at);
      if (!(at > 0) || !(Number.isFinite(pinPrice) && pinPrice > 0)) return;
      const alertPrice = Number(item.alertPrice);
      const notifyPrice = Number(item.notifyPrice);
      const firstSeenAt = firstBySymbol[symbol] || at;
      out.push({
        id: item.id || `${symbol}:${openTime}:${at}`,
        symbol,
        label: item.label
          ? String(item.label).trim().slice(0, 32)
          : labelOf(symbol),
        kinds: kinds.length ? kinds : ['天平'],
        at,
        firstSeenAt,
        openTime,
        pinPrice,
        pinnedAt: Number(item.pinnedAt) || 0,
        alertPrice:
          Number.isFinite(alertPrice) && alertPrice > 0 ? alertPrice : 0,
        notifyPrice:
          Number.isFinite(notifyPrice) && notifyPrice > 0 ? notifyPrice : 0,
        noteAt: Number(item.noteAt) || 0,
        interval: item.interval ? String(item.interval) : INTERVAL,
        windowUp: !!item.windowUp,
        batchAt: batchBySymbol[symbol] || Number(item.batchAt) || 0,
      });
    });
  return out;
}

/** 按 item.batchAt 重建批次；空批次不出现（币被新批次带走即消失）。 */
function rebuildBalanceBatches(items, now) {
  const cutoff = (Number(now) || Date.now()) - NOTICES_TTL_MS;
  const byAt = {};
  (Array.isArray(items) ? items : []).forEach((item) => {
    if (!item || !item.symbol) return;
    const bat = Number(item.batchAt) || 0;
    if (!(bat >= cutoff)) return;
    const symbol = String(item.symbol).trim().toUpperCase();
    if (!symbol) return;
    if (!byAt[bat]) byAt[bat] = [];
    if (!byAt[bat].includes(symbol)) byAt[bat].push(symbol);
  });
  return Object.keys(byAt)
    .map((key) => Number(key))
    .filter((at) => at > 0)
    .sort((a, b) => b - a)
    .map((at) => ({
      at,
      count: byAt[at].length,
      symbols: byAt[at].slice().sort(),
    }))
    .filter((row) => row.count > 0);
}

function noticeItemsFingerprint(list) {
  return (Array.isArray(list) ? list : [])
    .map(
      (item) =>
        `${item && item.id}:${(item && item.kinds) || []}:${item && item.at}:${item && item.firstSeenAt}:${item && item.batchAt}`,
    )
    .join('|');
}

function batchesFingerprint(list) {
  return (Array.isArray(list) ? list : [])
    .map((row) => `${row && row.at}:${(row && row.symbols) || []}`)
    .join('|');
}

/**
 * 写入通知 items；可选把 batchSymbols 标到 batchAt（企微摘要批次）。
 * 同币只会留在最新 batchAt；旧批次符号被掏空后不再出现。
 */
async function appendBalanceNotices(rows, now, noticesPath, batchOpts) {
  const path = String(noticesPath || NOTICES_PATH).trim() || NOTICES_PATH;
  const file = await loadJson(path);
  const prev = (file && file.data) || {};
  const prevItems = Array.isArray(prev.items) ? prev.items : [];
  const prevBatches = Array.isArray(prev.batches) ? prev.batches : [];
  const incoming = Array.isArray(rows) ? rows : [];
  let merged = trimBalanceNotices([...incoming, ...prevItems], now);
  const batchAt = Number(batchOpts && batchOpts.batchAt) || 0;
  const batchSymbols = Array.isArray(batchOpts && batchOpts.symbols)
    ? batchOpts.symbols
        .map((s) => String(s || '').trim().toUpperCase())
        .filter(Boolean)
    : [];
  if (batchAt > 0 && batchSymbols.length) {
    const want = new Set(batchSymbols);
    const have = new Set(merged.map((item) => item.symbol));
    merged = merged.map((item) => {
      if (!want.has(item.symbol)) return item;
      return {
        ...item,
        batchAt,
        windowUp: true,
        at: Math.max(Number(item.at) || 0, batchAt),
      };
    });
    // 批次里有、items 尚无的：用 incoming 补一条（通常 wecom 行已在 incoming）。
    incoming.forEach((row) => {
      const symbol = String((row && row.symbol) || '')
        .trim()
        .toUpperCase();
      if (!symbol || !want.has(symbol) || have.has(symbol)) return;
      have.add(symbol);
      merged.push({
        ...row,
        symbol,
        batchAt,
        windowUp: true,
        at: Math.max(Number(row.at) || 0, batchAt),
      });
    });
    merged = trimBalanceNotices(merged, now);
  }
  const batches = rebuildBalanceBatches(merged, now);
  const changed =
    incoming.length > 0 ||
    batchSymbols.length > 0 ||
    noticeItemsFingerprint(merged) !== noticeItemsFingerprint(prevItems) ||
    batchesFingerprint(batches) !== batchesFingerprint(prevBatches);
  if (!changed) {
    return { notices: merged.length, batches: batches.length };
  }
  await saveJson(
    path,
    {
      updatedAt: now,
      readAt: Number(prev.readAt) || 0,
      items: merged,
      batches,
    },
    file && file.sha,
    batchSymbols.length
      ? `Balance batch ${batchSymbols.length}@${batchAt}`
      : incoming.length
        ? `Balance/straight notices +${incoming.length}`
        : 'Balance notices prune',
  );
  return { notices: merged.length, batches: batches.length };
}

function findCandleIndexAt(candles, timestamp) {
  const at = Number(timestamp);
  if (!Array.isArray(candles) || !candles.length) return -1;
  if (!Number.isFinite(at) || at <= 0) return -1;
  if (at < candles[0].time) return 0;
  if (at >= candles[candles.length - 1].time) return candles.length - 1;
  for (let i = 0; i < candles.length; i += 1) {
    const start = candles[i].time;
    const end =
      i + 1 < candles.length
        ? candles[i + 1].time
        : Number.POSITIVE_INFINITY;
    if (at >= start && at < end) return i;
  }
  return -1;
}

function normalizePins(raw) {
  const list = Array.isArray(raw)
    ? raw
    : raw && Array.isArray(raw.pins)
      ? raw.pins
      : [];
  return list
    .map((item) => {
      if (!item || !item.symbol) return null;
      const symbol = String(item.symbol).trim().toUpperCase();
      if (!symbol.endsWith('USDT')) return null;
      const source = String(item.source || '');
      if (!AUTO_SOURCES.has(source)) return null;
      const pinPrice = Number(item.pinPrice);
      const pinnedAt = Number(item.pinnedAt) || 0;
      if (!(Number.isFinite(pinPrice) && pinPrice > 0 && pinnedAt > 0)) {
        return null;
      }
      return { symbol, pinPrice, pinnedAt, source };
    })
    .filter(Boolean);
}

function normalizeState(data) {
  const bySymbol =
    data && data.bySymbol && typeof data.bySymbol === 'object'
      ? data.bySymbol
      : {};
  const out = {};
  Object.keys(bySymbol).forEach((key) => {
    const row = bySymbol[key];
    if (!row || typeof row !== 'object') return;
    out[String(key).toUpperCase()] = {
      pinnedAt: Number(row.pinnedAt) || 0,
      lastSentAt: Number(row.lastSentAt) || 0,
      lastNoticeAt: Number(row.lastNoticeAt) || 0,
      pinPrice: Number(row.pinPrice) || 0,
      kinds: Array.isArray(row.kinds) ? row.kinds.map(String) : [],
    };
  });
  return {
    bySymbol: out,
    checkCursor: Number(data && data.checkCursor) || 0,
  };
}

/**
 * 现价相对正在形成的 4h 窗开盘是否上涨（企微门槛；网页 notices 不要求）。
 */
function isCurrentWindowUp(candles, livePrice) {
  if (!Array.isArray(candles) || !candles.length) return false;
  const forming = candles[candles.length - 1];
  const open = Number(forming && forming.open);
  if (!(Number.isFinite(open) && open > 0)) return false;
  const lastClose = Number(forming && forming.close);
  const live = Number(livePrice);
  const px =
    Number.isFinite(live) && live > 0
      ? live
      : Number.isFinite(lastClose) && lastClose > 0
        ? lastClose
        : NaN;
  if (!(Number.isFinite(px) && px > 0)) return false;
  return px > open;
}

function pinLiveContext(candles, pin, livePrice) {
  if (!pin || !Array.isArray(candles) || !candles.length) return null;
  const line = Number(pin.pinPrice);
  if (!(Number.isFinite(line) && line > 0)) return null;
  const live = Number(livePrice);
  const lastClose = Number(
    candles[candles.length - 1] && candles[candles.length - 1].close,
  );
  const px =
    Number.isFinite(live) && live > 0
      ? live
      : Number.isFinite(lastClose) && lastClose > 0
        ? lastClose
        : NaN;
  if (!(Number.isFinite(px) && px > 0)) return null;
  const pinIdx = findCandleIndexAt(candles, pin.pinnedAt);
  const lastIdx = candles.length - 1;
  if (pinIdx < 0 || lastIdx <= pinIdx) return null;
  return {
    line,
    px,
    pinIdx,
    lastIdx,
    windowUp: isCurrentWindowUp(candles, px),
  };
}

/**
 * 天平：盯后影线跌破 + 现价收回高于跌破 K 最低收盘（不要求当前窗上涨）。
 */
function evaluateBalance(candles, pin, livePrice) {
  const ctx = pinLiveContext(candles, pin, livePrice);
  if (!ctx) return null;
  let minDipClose = Infinity;
  let dipped = false;
  for (let i = ctx.pinIdx + 1; i <= ctx.lastIdx; i += 1) {
    const bar = candles[i];
    const low = Number(bar && bar.low);
    if (!(Number.isFinite(low) && low < ctx.line)) continue;
    dipped = true;
    const close = Number(bar && bar.close);
    if (Number.isFinite(close) && close < minDipClose) minDipClose = close;
  }
  if (!dipped || !(Number.isFinite(minDipClose) && minDipClose < Infinity)) {
    return null;
  }
  if (!(ctx.px > minDipClose)) return null;
  return {
    livePrice: ctx.px,
    minDipClose,
    pinIdx: ctx.pinIdx,
    lastIdx: ctx.lastIdx,
    windowUp: !!ctx.windowUp,
  };
}

/**
 * 直拉：盯后实体从未跌破 pin（下影不算）+ 现价 > 盯价（不要求当前窗上涨）。
 */
function evaluateStraight(candles, pin, livePrice) {
  const ctx = pinLiveContext(candles, pin, livePrice);
  if (!ctx) return null;
  if (!(ctx.px > ctx.line)) return null;
  for (let i = ctx.pinIdx + 1; i <= ctx.lastIdx; i += 1) {
    const bar = candles[i];
    const open = Number(bar && bar.open);
    const close = Number(bar && bar.close);
    if (!Number.isFinite(open) || !Number.isFinite(close)) continue;
    if (Math.min(open, close) < ctx.line) return null;
  }
  return {
    livePrice: ctx.px,
    pinIdx: ctx.pinIdx,
    lastIdx: ctx.lastIdx,
    windowUp: !!ctx.windowUp,
  };
}

/**
 * @returns {{
 *   balance: object|null,
 *   straight: object|null,
 *   kinds: string[],
 *   livePrice: number,
 *   windowUp: boolean,
 * }|null}
 */
function evaluatePatterns(candles, pin, livePrice) {
  const balance = evaluateBalance(candles, pin, livePrice);
  const straight = evaluateStraight(candles, pin, livePrice);
  if (!balance && !straight) return null;
  const kinds = [];
  if (balance) kinds.push('天平');
  if (straight) kinds.push('直拉');
  const windowUp = !!(
    (balance && balance.windowUp) ||
    (straight && straight.windowUp)
  );
  return {
    balance,
    straight,
    kinds,
    livePrice: (balance && balance.livePrice) || (straight && straight.livePrice),
    windowUp,
  };
}

function sleep(ms) {
  const n = Number(ms) || 0;
  if (n <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, n));
}

/** 企微/网页批次戳，如 ======20.27======（北京时间，点分隔）。 */
function formatWecomBatchStamp(ms) {
  const ts = Number(ms) || Date.now();
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(ts));
  const hour = (parts.find((p) => p.type === 'hour') || {}).value || '00';
  const minute = (parts.find((p) => p.type === 'minute') || {}).value || '00';
  return `======${hour}.${minute}======`;
}

function formatWecomBatchSummary(ms, count) {
  const n = Math.max(0, Number(count) || 0);
  return `${formatWecomBatchStamp(ms)}\n${n}个`;
}

function isWecomRateLimited(error) {
  const msg = String(
    (error && error.message) || error || '',
  );
  return msg.includes('45009') || /too many requests/i.test(msg);
}

async function mapPool(items, concurrency, worker) {
  const list = Array.isArray(items) ? items : [];
  const out = new Array(list.length);
  let cursor = 0;
  const runners = Array.from(
    { length: Math.min(concurrency, Math.max(1, list.length)) },
    async () => {
      while (cursor < list.length) {
        const i = cursor;
        cursor += 1;
        out[i] = await worker(list[i], i);
      }
    },
  );
  await Promise.all(runners);
  return out;
}

async function runBalanceAlerts(options) {
  const opts = options || {};
  const now = Number(opts.now) || Date.now();
  const pinsPath = String(opts.pinsPath || PINS_PATH).trim() || PINS_PATH;
  const statePath = String(opts.statePath || STATE_PATH).trim() || STATE_PATH;
  const noticesPath =
    String(opts.noticesPath || NOTICES_PATH).trim() || NOTICES_PATH;
  const nailsPath = String(opts.nailsPath || NAILS_PATH).trim() || NAILS_PATH;
  const pushEnabled = opts.push !== false;
  const webhook = pushEnabled
    ? String(opts.webhook || resolveWebhook() || '').trim()
    : '';
  const result = {
    skipped: false,
    reason: null,
    checked: 0,
    hits: 0,
    sent: 0,
    notices: 0,
    wecomDue: 0,
    wecomQueued: 0,
    wecomDeferred: 0,
    skippedWecomWindow: 0,
    symbols: [],
    kinds: [],
    errors: [],
    push: pushEnabled && !!webhook,
    checkMax: CHECK_MAX,
    sendMax: SEND_MAX,
    cooldownMs: COOLDOWN_MS,
  };

  if (!enabled()) {
    result.skipped = true;
    result.reason = 'disabled';
    return result;
  }
  if (pushEnabled && !webhook) {
    console.warn('balance-alert: no WeCom webhook — detect only');
  }

  const pinsInput = Array.isArray(opts.pins) ? opts.pins : null;
  let pinsFile = null;
  let pins;
  if (pinsInput) {
    pins = normalizePins(pinsInput);
  } else {
    pinsFile = await loadJson(pinsPath);
    pins = normalizePins(pinsFile && pinsFile.data);
  }
  if (!pins.length) {
    result.skipped = true;
    result.reason = 'no-auto-pins';
    result.autoPins = 0;
    return result;
  }
  result.autoPins = pins.length;

  let noteMap = {};
  try {
    const nailsFile = await loadJson(nailsPath);
    noteMap = notePriceBySymbol(nailsFile && nailsFile.data);
  } catch (error) {
    console.warn(
      'balance-alert: load nails for note price failed',
      error && error.message ? error.message : error,
    );
  }

  const stateFile = await loadJson(statePath);
  let state = normalizeState(stateFile && stateFile.data);
  let stateDirty = false;

  const due = pins.filter((pin) => {
    const prev = state.bySymbol[pin.symbol];
    if (!prev) return true;
    const lastSentAt = Number(prev.lastSentAt) || 0;
    if (!(lastSentAt > 0)) return true;
    if (COOLDOWN_MS <= 0) return true;
    return now - lastSentAt >= COOLDOWN_MS;
  });
  // 稳定序 + 可选轮询切片（仅 CHECK_MAX>0 时）。
  due.sort((a, b) =>
    String(a.symbol || '').localeCompare(String(b.symbol || '')),
  );
  let cursor = Number(state.checkCursor) || 0;
  if (cursor < 0 || cursor >= due.length) cursor = 0;
  let pending = due;
  if (CHECK_MAX > 0 && due.length > CHECK_MAX) {
    pending = [];
    for (let i = 0; i < CHECK_MAX; i += 1) {
      pending.push(due[(cursor + i) % due.length]);
    }
    state.checkCursor = (cursor + CHECK_MAX) % due.length;
    stateDirty = true;
  } else {
    state.checkCursor = 0;
  }
  result.due = due.length;
  result.checked = pending.length;
  result.checkCursor = state.checkCursor;
  result.skippedFetch = pins.length - due.length;
  result.cooldownMs = COOLDOWN_MS;
  if (!pending.length) {
    result.skipped = true;
    result.reason = 'cooldown';
    return result;
  }

  let tickers = opts.tickers && typeof opts.tickers === 'object' ? opts.tickers : null;
  if (!tickers) {
    try {
      tickers = await fetchBinanceTickers(pending.map((p) => p.symbol));
    } catch (error) {
      result.errors.push(
        `tickers:${error && error.message ? error.message : error}`,
      );
      tickers = {};
    }
  }

  const evaluated = await mapPool(pending, CONCURRENCY, async (pin) => {
    try {
      const candles = await fetchKlines(pin.symbol, INTERVAL, LIMIT);
      const live =
        tickers && tickers[pin.symbol] && Number(tickers[pin.symbol].price);
      const verdict = evaluatePatterns(candles, pin, live);
      if (!verdict) return null;
      return { pin, candles, verdict };
    } catch (error) {
      result.errors.push(
        `${pin.symbol}:${error && error.message ? error.message : error}`,
      );
      return null;
    }
  });

  const matched = evaluated.filter(Boolean);
  result.hits = matched.length;
  result.hitKinds = matched.map((row) => ({
    symbol: row.pin.symbol,
    kinds: row.verdict.kinds,
    windowUp: !!(row.verdict && row.verdict.windowUp),
  }));

  const noticeRows = [];
  const wecomCandidates = [];
  for (const hit of matched) {
    const { pin, candles, verdict } = hit;
    const label = labelOf(pin.symbol);
    const forming = candles && candles[candles.length - 1];
    const openTime = Number(forming && forming.time) || currentWindowOpen(now);
    const note = noteMap[pin.symbol] || {};
    const livePrice = Number(verdict.livePrice) || 0;
    const windowUp = !!verdict.windowUp;
    result.symbols.push(pin.symbol);
    result.kinds.push({
      symbol: pin.symbol,
      kinds: verdict.kinds,
      windowUp,
    });
    const prev = state.bySymbol[pin.symbol] || {};
    const lastNoticeAt = Number(prev.lastNoticeAt) || 0;
    const noticeDue =
      !(lastNoticeAt > 0) ||
      COOLDOWN_MS <= 0 ||
      now - lastNoticeAt >= COOLDOWN_MS;
    const row = {
      id: `${pin.symbol}:${openTime}:${now}`,
      symbol: pin.symbol,
      label,
      kinds: verdict.kinds,
      at: now,
      // trim 时与历史同币取最早；重复命中不会覆盖。
      firstSeenAt: now,
      openTime,
      pinPrice: pin.pinPrice,
      pinnedAt: pin.pinnedAt,
      alertPrice: Number(note.alertPrice) || 0,
      notifyPrice: livePrice,
      noteAt: Number(note.noteAt) || 0,
      interval: INTERVAL,
      windowUp,
      _hit: hit,
    };
    if (noticeDue) noticeRows.push(row);
    if (windowUp) wecomCandidates.push(row);
    else result.skippedWecomWindow += 1;
  }
  result.wecomDue = wecomCandidates.length;
  // 限推时优先：从未发过企微 → 冷却更久 → 首次进通知更早；避免字母序永远卡住 ONE 等。
  wecomCandidates.sort((a, b) => {
    const sa = state.bySymbol[a.symbol] || {};
    const sb = state.bySymbol[b.symbol] || {};
    const sentA = Number(sa.lastSentAt) || 0;
    const sentB = Number(sb.lastSentAt) || 0;
    const neverA = sentA > 0 ? 1 : 0;
    const neverB = sentB > 0 ? 1 : 0;
    if (neverA !== neverB) return neverA - neverB;
    if (sentA !== sentB) return sentA - sentB;
    const firstA = Number(a.firstSeenAt) || Number(a.at) || 0;
    const firstB = Number(b.firstSeenAt) || Number(b.at) || 0;
    if (firstA !== firstB) return firstA - firstB;
    return String(a.symbol || '').localeCompare(String(b.symbol || ''));
  });
  const wecomRows =
    SEND_MAX > 0 ? wecomCandidates.slice(0, SEND_MAX) : wecomCandidates;
  result.wecomQueued = wecomRows.length;
  result.queued = wecomRows.length;
  result.wecomDeferred = Math.max(
    0,
    wecomCandidates.length - wecomRows.length,
  );

  // 先落网页列表（形态命中）；失败则本轮不推企微。
  let noticesWritten = !noticeRows.length;
  if (noticeRows.length) {
    try {
      const payload = noticeRows.map((row) => {
        const { _hit, ...rest } = row;
        return rest;
      });
      const saved = await appendBalanceNotices(payload, now, noticesPath);
      result.notices = Number(saved && saved.notices) || payload.length;
      noticesWritten = true;
      for (const row of noticeRows) {
        const prev = state.bySymbol[row.symbol] || {};
        state.bySymbol[row.symbol] = {
          pinnedAt: row.pinnedAt,
          lastSentAt: Number(prev.lastSentAt) || 0,
          lastNoticeAt: now,
          pinPrice: row.pinPrice,
          kinds: row.kinds,
        };
        stateDirty = true;
      }
    } catch (error) {
      result.errors.push(
        `notices:${error && error.message ? error.message : error}`,
      );
    }
  }

  // 企微：只发「======20.27======\nN个」；详情看网页批次。
  // 顺序：先发企微 → 再写 batchAt → 最后写 lastSentAt。
  // 若摘要已发出但网页落盘失败，不写冷却，下轮可补批次（可能多一条企微摘要）。
  const canWecom = noticesWritten && wecomRows.length > 0;
  if (canWecom) {
    const batchSymbols = wecomRows.map((row) => row.symbol);
    const summary = formatWecomBatchSummary(now, batchSymbols.length);
    result.batchHeader = formatWecomBatchStamp(now);
    result.wecomQueued = batchSymbols.length;
    const payload = wecomRows.map((row) => {
      const { _hit, ...rest } = row;
      return rest;
    });

    const markBatchLocal = () => {
      for (const row of wecomRows) {
        const prev = state.bySymbol[row.symbol] || {};
        state.bySymbol[row.symbol] = {
          pinnedAt: row.pinnedAt,
          lastSentAt: now,
          lastNoticeAt: Number(prev.lastNoticeAt) || 0,
          pinPrice: row.pinPrice,
          kinds: row.kinds,
        };
        stateDirty = true;
      }
    };

    const persistBatch = async () => {
      await appendBalanceNotices(payload, now, noticesPath, {
        batchAt: now,
        symbols: batchSymbols,
      });
    };

    if (!webhook) {
      try {
        await persistBatch();
        markBatchLocal();
        result.sent = batchSymbols.length;
      } catch (error) {
        result.errors.push(
          `batch-notices:${error && error.message ? error.message : error}`,
        );
      }
    } else {
      let wecomSent = false;
      try {
        await sendWecomText(summary, webhook);
        wecomSent = true;
      } catch (error) {
        result.errors.push(
          `send:batch:${error && error.message ? error.message : error}`,
        );
        if (isWecomRateLimited(error)) {
          result.wecomDeferred += batchSymbols.length;
        }
      }
      if (wecomSent) {
        try {
          await persistBatch();
          markBatchLocal();
          result.sent = batchSymbols.length;
        } catch (error) {
          result.errors.push(
            `batch-notices:${error && error.message ? error.message : error}`,
          );
        }
      }
    }
  }

  const keep = new Set(pins.map((p) => p.symbol));
  Object.keys(state.bySymbol).forEach((key) => {
    if (!keep.has(key)) {
      delete state.bySymbol[key];
      stateDirty = true;
    }
  });

  if (stateDirty || result.sent || noticeRows.length) {
    await saveJson(
      statePath,
      {
        bySymbol: state.bySymbol,
        checkCursor: Number(state.checkCursor) || 0,
        updatedAt: now,
      },
      stateFile && stateFile.sha,
      result.sent
        ? `Balance/straight alert x${result.sent}`
        : noticeRows.length
          ? `Balance/straight notices +${noticeRows.length}`
          : 'Balance alert state',
    );
  }

  return result;
}

module.exports = {
  runBalanceAlerts,
  evaluateBalance,
  evaluateStraight,
  evaluatePatterns,
  isCurrentWindowUp,
  normalizePins,
};
