'use strict';

/**
 * 钉子荧光绿：首根染绿 + 续绿/断绿再绿 → 企微文字 + 染绿 4h 图。
 * 站在 Date.now() 拉当前 4h K，回看 noteAt 之后的窗口；
 * 同一根 K（同一 openTime）只推一次。
 */

const { loadJson, saveJson, sendWecomText, sendWecomImage } = require('./github-wecom');
const { fetchKlines, renderCandlesPng } = require('./kline-chart');

const STATE_PATH =
  process.env.NAIL_GREEN_ALERT_PATH || 'watch-nail-green-alert.json';
const NOTICES_PATH =
  process.env.NAIL_GREEN_NOTICES_PATH || 'watch-nail-green-notices.json';
const NAILS_PATH = process.env.NAILS_PATH || 'watch-nails.json';
const INTERVAL = process.env.NAIL_GREEN_INTERVAL || '4h';
const LIMIT = Math.max(12, Number(process.env.NAIL_GREEN_LIMIT || 42));
const NOTICES_TTL_MS = 24 * 60 * 60 * 1000;
const DURATION_MS = {
  '15m': 15 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '2h': 2 * 60 * 60 * 1000,
  '4h': 4 * 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000,
};
const DOWN_STREAK = 4;
const NO_NEW_HIGH = 4;
/** 单轮最多推送条数；0=不限制（命中即写 notices / 发企微）。 */
const SEND_MAX = Math.max(0, Number(process.env.NAIL_GREEN_SEND_MAX || 0));
const CONCURRENCY = Math.max(1, Number(process.env.NAIL_GREEN_CONCURRENCY || 8));
/** 单轮最多检查多少个尚未对本根报过的钉子；0=本轮全查（更及时）。 */
const CHECK_MAX = Math.max(
  0,
  Number(
    process.env.NAIL_GREEN_CHECK_MAX === undefined ||
      process.env.NAIL_GREEN_CHECK_MAX === ''
      ? 0
      : process.env.NAIL_GREEN_CHECK_MAX,
  ),
);

function enabled() {
  return (
    String(
      process.env.NAIL_GREEN_ALERT === undefined
        ? '1'
        : process.env.NAIL_GREEN_ALERT,
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

/** Binance K 线开盘时间（UTC 对齐）。 */
function candleOpenTimeAt(now, interval) {
  const dur = DURATION_MS[interval] || DURATION_MS['4h'];
  const t = Number(now) || Date.now();
  if (!Number.isFinite(dur) || dur <= 0) return 0;
  return Math.floor(t / dur) * dur;
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

function candleIsClosed(candle, index, candles, durationMs, now) {
  if (index < candles.length - 1) return true;
  const openAt = Number(candle && candle.time);
  const dur = Number(durationMs);
  if (!Number.isFinite(openAt) || !Number.isFinite(dur) || dur <= 0) {
    return false;
  }
  return openAt + dur <= now;
}

/**
 * 与页面钉子抽屉同语义的荧光绿会话区间（云侧不做自动便签现价）。
 */
function nailAlertGreenActiveRange(candles, alertPrice, fromIndex, options) {
  const empty = { from: -1, until: -1 };
  if (!Array.isArray(candles) || !candles.length) return empty;
  if (!Number.isFinite(alertPrice) || alertPrice <= 0) return empty;
  const start = Math.max(0, Number(fromIndex) || 0);
  if (start >= candles.length) return empty;
  const now = Number(options && options.now) || Date.now();
  const durationMs =
    Number(options && options.durationMs) || DURATION_MS[INTERVAL] || 0;

  let active = false;
  let greenFrom = -1;
  let greenUntil = -1;
  let sessionHigh = NaN;
  let noNewHighCount = 0;
  let downStreak = 0;

  const clearSession = () => {
    active = false;
    greenFrom = -1;
    greenUntil = -1;
    sessionHigh = NaN;
    noNewHighCount = 0;
    downStreak = 0;
  };

  for (let i = start; i < candles.length; i += 1) {
    const candle = candles[i];
    if (!candle) continue;
    const open = Number(candle.open);
    const close = Number(candle.close);
    const high = Number(candle.high);
    if (!Number.isFinite(close) || !Number.isFinite(high)) continue;
    const closed = candleIsClosed(candle, i, candles, durationMs, now);

    if (!active) {
      if (high > alertPrice) {
        active = true;
        greenFrom = i;
        greenUntil = i + 1;
        sessionHigh = high;
        noNewHighCount = 0;
        downStreak = 0;
      }
      continue;
    }

    if (!closed) {
      greenUntil = i + 1;
      continue;
    }

    if (Number.isFinite(open) && close < open) downStreak += 1;
    else downStreak = 0;

    if (close < alertPrice) {
      clearSession();
      continue;
    }
    if (downStreak >= DOWN_STREAK) {
      clearSession();
      continue;
    }
    if (high > sessionHigh) {
      sessionHigh = high;
      noNewHighCount = 0;
    } else {
      noNewHighCount += 1;
      if (noNewHighCount >= NO_NEW_HIGH) {
        clearSession();
        continue;
      }
    }
    greenUntil = i + 1;
  }

  if (!active || greenFrom < 0 || greenUntil <= greenFrom) return empty;
  return { from: greenFrom, until: greenUntil };
}

function candleShowsGreen(candle, alertPrice, inRange) {
  if (!inRange || !candle) return false;
  const open = Number(candle.open);
  const close = Number(candle.close);
  const high = Number(candle.high);
  if (!Number.isFinite(close) || !Number.isFinite(high)) return false;
  if (!(close >= open)) return false;
  return high > alertPrice;
}

function normalizeNails(raw) {
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray(raw && raw.nails)
      ? raw.nails
      : [];
  return list
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      let symbol = String(item.symbol || '')
        .trim()
        .toUpperCase()
        .replace(/\s+/g, '');
      if (!symbol || !/USDT$/.test(symbol)) return null;
      const alertPrice = parseAlertPrice(item.note);
      if (!Number.isFinite(alertPrice) || alertPrice <= 0) return null;
      return {
        symbol,
        label: item.label
          ? String(item.label).trim()
          : labelOf(symbol),
        note: String(item.note || '').trim(),
        noteAt: Number(item.noteAt) || 0,
        alertPrice,
      };
    })
    .filter(Boolean);
}

function normalizeState(raw) {
  const bySymbol =
    raw && raw.bySymbol && typeof raw.bySymbol === 'object'
      ? raw.bySymbol
      : {};
  const next = {};
  Object.keys(bySymbol).forEach((key) => {
    const row = bySymbol[key];
    if (!row || typeof row !== 'object') return;
    const openTime = Number(row.lastNotifiedOpenTime);
    if (!Number.isFinite(openTime) || openTime <= 0) return;
    next[String(key).toUpperCase()] = {
      lastNotifiedOpenTime: openTime,
      lastNotifiedAt: Number(row.lastNotifiedAt) || 0,
    };
  });
  return {
    bySymbol: next,
    updatedAt: Number(raw && raw.updatedAt) || 0,
    checkCursor: Number(raw && raw.checkCursor) || 0,
  };
}

async function mapPool(items, limit, worker) {
  const list = Array.isArray(items) ? items : [];
  const out = new Array(list.length);
  let cursor = 0;
  const runners = Array.from(
    { length: Math.min(limit, Math.max(1, list.length)) },
    async () => {
      while (cursor < list.length) {
        const index = cursor;
        cursor += 1;
        out[index] = await worker(list[index], index);
      }
    },
  );
  await Promise.all(runners);
  return out;
}

function evaluateNail(candles, nail, now) {
  const alertPrice = nail.alertPrice;
  const fromIndex =
    nail.noteAt > 0 ? findCandleIndexAt(candles, nail.noteAt) : 0;
  if (fromIndex < 0 || !candles.length) {
    return { shouldNotify: false };
  }
  const durationMs = DURATION_MS[INTERVAL] || DURATION_MS['4h'];
  const range = nailAlertGreenActiveRange(candles, alertPrice, fromIndex, {
    now,
    durationMs,
  });
  const lastIndex = candles.length - 1;
  const current = candles[lastIndex];
  const openTime = Number(current && current.time);
  if (!Number.isFinite(openTime) || openTime <= 0) {
    return { shouldNotify: false, range };
  }

  const currentGreen = candleShowsGreen(
    current,
    alertPrice,
    range.from >= 0 && lastIndex >= range.from && lastIndex < range.until,
  );
  if (!currentGreen) {
    return {
      shouldNotify: false,
      range,
      openTime,
      currentGreen: false,
    };
  }

  let priorGreen = false;
  for (let i = fromIndex; i < lastIndex; i += 1) {
    // 回看：noteAt 之后、当前根之前是否已有过绿（用于文案区分首绿/续绿）。
    const c = candles[i];
    if (!c) continue;
    const up = Number(c.close) >= Number(c.open);
    if (up && Number(c.high) > alertPrice) {
      priorGreen = true;
      break;
    }
  }

  return {
    // 当前根已染绿即通知（含第一条绿）；同 openTime 去重在外层。
    shouldNotify: true,
    range,
    openTime,
    currentGreen: true,
    priorGreen,
    kind: priorGreen ? '续绿' : '首绿',
    alertPrice,
    // 通知时价格（当前 4h 收盘），页面红蓝相对此线，而非水位。
    notifyPrice: Number(current.close),
  };
}

async function runNailGreenAlerts(options) {
  const opts = options || {};
  const now = Number(opts.now) || Date.now();
  const webhook = String(opts.webhook || resolveWebhook() || '').trim();
  const result = {
    skipped: false,
    reason: null,
    checked: 0,
    hits: 0,
    sent: 0,
    symbols: [],
    errors: [],
  };

  if (!enabled()) {
    result.skipped = true;
    result.reason = 'disabled';
    return result;
  }
  // 无 webhook 仍可检查并写入页面 notices；企微发送跳过。
  if (!webhook) {
    console.warn('nail-green-alert: no WeCom webhook — notices only');
  }

  const [nailsFile, stateFile] = await Promise.all([
    loadJson(NAILS_PATH),
    loadJson(STATE_PATH),
  ]);
  const nails = normalizeNails(nailsFile && nailsFile.data);
  let state = normalizeState(stateFile && stateFile.data);
  let stateDirty = false;
  if (!nails.length) {
    result.skipped = true;
    result.reason = 'no-nails-with-price';
    return result;
  }

  const bucketOpen = candleOpenTimeAt(now, INTERVAL);
  // 本根 4h 已推过的不再拉 K（100 钉场景下显著减负）。
  const pending = nails.filter((nail) => {
    const prev = state.bySymbol[nail.symbol];
    return !(
      prev &&
      bucketOpen > 0 &&
      Number(prev.lastNotifiedOpenTime) === bucketOpen
    );
  });
  // 轮询切片：单轮最多 CHECK_MAX，避免一次 100 路 K 线打满超时。
  let cursor = Number(state.checkCursor) || 0;
  if (cursor < 0 || cursor >= pending.length) cursor = 0;
  let toCheck = pending;
  if (CHECK_MAX > 0 && pending.length > CHECK_MAX) {
    toCheck = [];
    for (let i = 0; i < CHECK_MAX; i += 1) {
      toCheck.push(pending[(cursor + i) % pending.length]);
    }
    state.checkCursor = (cursor + CHECK_MAX) % pending.length;
    stateDirty = true;
  } else {
    state.checkCursor = 0;
  }
  result.pending = pending.length;
  result.checked = toCheck.length;
  result.bucketOpen = bucketOpen;
  result.skippedFetch = nails.length - pending.length;

  const evaluated = await mapPool(toCheck, CONCURRENCY, async (nail) => {
    try {
      const candles = await fetchKlines(nail.symbol, INTERVAL, LIMIT);
      const verdict = evaluateNail(candles, nail, now);
      const prev = state.bySymbol[nail.symbol];
      const already =
        prev &&
        Number(prev.lastNotifiedOpenTime) === Number(verdict.openTime);
      if (!verdict.shouldNotify || already) {
        return null;
      }
      return { nail, candles, verdict };
    } catch (error) {
      result.errors.push(
        `${nail.symbol}:${error && error.message ? error.message : error}`,
      );
      return null;
    }
  });

  const matched = evaluated.filter(Boolean);
  const hits =
    SEND_MAX > 0 ? matched.slice(0, SEND_MAX) : matched;
  result.hits = matched.length;
  result.queued = hits.length;
  const noticeRows = [];

  for (const hit of hits) {
    const { nail, candles, verdict } = hit;
    const label = nail.label || labelOf(nail.symbol);
    const kind = verdict.kind || (verdict.priorGreen ? '续绿' : '首绿');
    const text = `${label} · ${kind}`;
    // 先落页面通知 + 去重状态，避免企微失败导致同根每轮重打 K / 重试刷屏。
    noticeRows.push({
      id: `${nail.symbol}:${verdict.openTime}:${now}`,
      symbol: nail.symbol,
      label,
      kind,
      at: now,
      openTime: verdict.openTime,
      alertPrice: verdict.alertPrice,
      notifyPrice: Number(verdict.notifyPrice) || 0,
      noteAt: Number(nail.noteAt) || 0,
      interval: INTERVAL,
    });
    state.bySymbol[nail.symbol] = {
      lastNotifiedOpenTime: verdict.openTime,
      lastNotifiedAt: now,
    };
    stateDirty = true;
    result.symbols.push(nail.symbol);

    if (!webhook) continue;
    try {
      await sendWecomText(text, webhook);

      const painted = renderCandlesPng(candles, {
        title: label,
        alertPrice: verdict.alertPrice,
        greenFrom: verdict.range.from,
        greenUntil: verdict.range.until,
        height: 280,
      });
      await sendWecomImage(painted, webhook);
      result.sent += 1;
    } catch (error) {
      result.errors.push(
        `send:${nail.symbol}:${error && error.message ? error.message : error}`,
      );
    }
  }

  // 清理已不在钉子列表里的状态。
  const keep = new Set(nails.map((n) => n.symbol));
  Object.keys(state.bySymbol).forEach((key) => {
    if (!keep.has(key)) {
      delete state.bySymbol[key];
      stateDirty = true;
    }
  });

  if (stateDirty || result.sent) {
    state.updatedAt = now;
    await saveJson(
      STATE_PATH,
      {
        bySymbol: state.bySymbol,
        checkCursor: Number(state.checkCursor) || 0,
        updatedAt: now,
      },
      stateFile && stateFile.sha,
      result.sent
        ? `Nail green alert x${result.sent}`
        : 'Nail green alert state',
    );
  }

  // 每轮都整理通知：进入新 4h 窗时清掉旧窗条目（无新命中也会写）。
  try {
    result.notices = await appendNailGreenNotices(noticeRows, now);
  } catch (error) {
    result.errors.push(
      `notices:${error && error.message ? error.message : error}`,
    );
    console.warn('append nail green notices failed', error);
  }

  return result;
}

/** 当前染绿周期窗口起点（与 K 线 openTime 对齐）。 */
function currentNailWindowOpen(now) {
  const durationMs = DURATION_MS[INTERVAL] || DURATION_MS['4h'];
  const ts = Number(now) || Date.now();
  return Math.floor(ts / durationMs) * durationMs;
}

function trimNoticeItems(list, now) {
  const currentOpen = currentNailWindowOpen(now);
  const cutoff = (Number(now) || Date.now()) - NOTICES_TTL_MS;
  const seen = new Set();
  const out = [];
  (Array.isArray(list) ? list : [])
    .filter((item) => {
      if (!item) return false;
      if (Number(item.at) < cutoff) return false;
      // 只保留「当前窗口」根上的通知；换窗即清旧窗。
      return Number(item.openTime) === currentOpen;
    })
    .sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0))
    .forEach((item) => {
      const symbol = String(item.symbol || '')
        .trim()
        .toUpperCase();
      const openTime = Number(item.openTime) || 0;
      if (!symbol || !openTime) return;
      // 同一币只留最新一条通知（列表已按 at 降序）。
      if (seen.has(symbol)) return;
      seen.add(symbol);
      const alertPrice = Number(item.alertPrice);
      const notifyPrice = Number(item.notifyPrice);
      const row = {
        id: item.id || `${symbol}:${openTime}:${Number(item.at) || 0}`,
        symbol,
        label: item.label
          ? String(item.label).trim().slice(0, 32)
          : labelOf(symbol),
        at: Number(item.at) || 0,
        openTime,
        alertPrice,
        notifyPrice:
          Number.isFinite(notifyPrice) && notifyPrice > 0 ? notifyPrice : 0,
        noteAt: Number(item.noteAt) || 0,
        interval: item.interval ? String(item.interval) : INTERVAL,
      };
      if (item.kind === '首绿' || item.kind === '续绿') row.kind = item.kind;
      out.push(row);
    });
  return out;
}

function noticeItemsFingerprint(list) {
  return (Array.isArray(list) ? list : [])
    .map((item) => `${item && item.id}:${item && item.openTime}`)
    .join('|');
}

async function appendNailGreenNotices(rows, now) {
  const file = await loadJson(NOTICES_PATH);
  const prev = (file && file.data) || {};
  const prevItems = Array.isArray(prev.items) ? prev.items : [];
  const incoming = Array.isArray(rows) ? rows : [];
  const merged = trimNoticeItems([...incoming, ...prevItems], now);
  const changed =
    incoming.length > 0 ||
    noticeItemsFingerprint(merged) !== noticeItemsFingerprint(prevItems);
  if (!changed) return merged.length;
  await saveJson(
    NOTICES_PATH,
    {
      updatedAt: now,
      readAt: Number(prev.readAt) || 0,
      items: merged,
      windowOpenTime: currentNailWindowOpen(now),
    },
    file && file.sha,
    incoming.length
      ? `Nail green notices +${incoming.length}`
      : 'Nail green notices prune window',
  );
  return merged.length;
}

module.exports = {
  runNailGreenAlerts,
  evaluateNail,
  nailAlertGreenActiveRange,
  parseAlertPrice,
  candleShowsGreen,
};
