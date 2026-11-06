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
 * 企微默认每轮最多推 5 只（SEND_MAX），间隔 SEND_GAP_MS。
 */

const { loadJson, saveJson, sendWecomText, sendWecomImage, fetchBinanceTickers } =
  require('./github-wecom');
const { fetchKlines, renderCandlesPng } = require('./kline-chart');

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
/** 单轮最多推企微几只；默认 5（防 45009）。0=不限。只限企微，不影响网页 notices。 */
const SEND_MAX = Math.max(
  0,
  Number(
    process.env.BALANCE_ALERT_SEND_MAX === undefined ||
      process.env.BALANCE_ALERT_SEND_MAX === ''
      ? 5
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
  // 同币保留「第一次进通知页」时间；重复命中只更新 at，不覆盖 firstSeenAt。
  const firstBySymbol = {};
  filtered.forEach((item) => {
    const symbol = String(item.symbol || '')
      .trim()
      .toUpperCase();
    if (!symbol) return;
    const at = Number(item.at) || 0;
    const first = Number(item.firstSeenAt) || at;
    if (!(first > 0)) return;
    if (!firstBySymbol[symbol] || first < firstBySymbol[symbol]) {
      firstBySymbol[symbol] = first;
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
      });
    });
  return out;
}

function noticeItemsFingerprint(list) {
  return (Array.isArray(list) ? list : [])
    .map(
      (item) =>
        `${item && item.id}:${(item && item.kinds) || []}:${item && item.at}:${item && item.firstSeenAt}`,
    )
    .join('|');
}

async function appendBalanceNotices(rows, now, noticesPath) {
  const path = String(noticesPath || NOTICES_PATH).trim() || NOTICES_PATH;
  const file = await loadJson(path);
  const prev = (file && file.data) || {};
  const prevItems = Array.isArray(prev.items) ? prev.items : [];
  const incoming = Array.isArray(rows) ? rows : [];
  const merged = trimBalanceNotices([...incoming, ...prevItems], now);
  const changed =
    incoming.length > 0 ||
    noticeItemsFingerprint(merged) !== noticeItemsFingerprint(prevItems);
  if (!changed) return merged.length;
  await saveJson(
    path,
    {
      updatedAt: now,
      readAt: Number(prev.readAt) || 0,
      items: merged,
    },
    file && file.sha,
    incoming.length
      ? `Balance/straight notices +${incoming.length}`
      : 'Balance notices prune',
  );
  return merged.length;
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

function patternTitle(kinds) {
  return (Array.isArray(kinds) ? kinds : []).join('·') || '天平';
}

function sleep(ms) {
  const n = Number(ms) || 0;
  if (n <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, n));
}

/** 企微每批推送前的时间戳，如 =====12:30=====（北京时间）。 */
function formatWecomBatchStamp(ms) {
  const ts = Number(ms) || Date.now();
  const text = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(ts));
  return `=====${text}=====`;
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
  const wecomRows =
    SEND_MAX > 0 ? wecomCandidates.slice(0, SEND_MAX) : wecomCandidates;
  result.wecomQueued = wecomRows.length;
  result.queued = wecomRows.length;
  result.wecomDeferred = Math.max(
    0,
    wecomCandidates.length - wecomRows.length,
  );

  // 先写网页列表；失败则本轮不推企微、不写冷却，下轮重试。
  let noticesWritten = false;
  if (noticeRows.length) {
    try {
      const payload = noticeRows.map((row) => {
        const { _hit, ...rest } = row;
        return rest;
      });
      result.notices = await appendBalanceNotices(payload, now, noticesPath);
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

  // 企微：仅窗上涨 + 单轮 SEND_MAX。成功才写 lastSentAt；45009 停止本轮剩余。
  // 本轮若有新 notices 且落盘失败，连带跳过企微，避免「企微有、列表没有」。
  const canWecom = !noticeRows.length || noticesWritten;
  if (canWecom) {
    let batchHeaderSent = false;
    for (let i = 0; i < wecomRows.length; i += 1) {
      const row = wecomRows[i];
      const hit = row._hit;
      const { pin, candles, verdict } = hit;
      const title = patternTitle(verdict.kinds);
      const prev = state.bySymbol[pin.symbol] || {};

      if (!webhook) {
        state.bySymbol[pin.symbol] = {
          pinnedAt: pin.pinnedAt,
          lastSentAt: now,
          lastNoticeAt: Number(prev.lastNoticeAt) || 0,
          pinPrice: pin.pinPrice,
          kinds: verdict.kinds,
        };
        stateDirty = true;
        continue;
      }

      try {
        if (!batchHeaderSent) {
          const header = formatWecomBatchStamp(now);
          await sendWecomText(header, webhook);
          batchHeaderSent = true;
          result.batchHeader = header;
          if (SEND_GAP_MS > 0) await sleep(SEND_GAP_MS);
        }
        const text = `${row.label} · ${title}`;
        await sendWecomText(text, webhook);
        const painted = renderCandlesPng(candles, {
          title: `${row.label} ${title}`,
          pinPrice: pin.pinPrice,
          autoPin: true,
          height: 280,
        });
        await sendWecomImage(painted, webhook);
        result.sent += 1;
        state.bySymbol[pin.symbol] = {
          pinnedAt: pin.pinnedAt,
          lastSentAt: now,
          lastNoticeAt: Number(prev.lastNoticeAt) || 0,
          pinPrice: pin.pinPrice,
          kinds: verdict.kinds,
        };
        stateDirty = true;
      } catch (error) {
        result.errors.push(
          `send:${pin.symbol}:${error && error.message ? error.message : error}`,
        );
        // 限流：本轮剩余改下轮再推，避免连打 + 误写冷却漏推。
        if (isWecomRateLimited(error)) {
          result.wecomDeferred += wecomRows.length - i;
          break;
        }
      }
      if (i + 1 < wecomRows.length && SEND_GAP_MS > 0) {
        await sleep(SEND_GAP_MS);
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
