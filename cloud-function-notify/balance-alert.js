'use strict';

/**
 * 天平推送：自动盯 pin 后曾跌破 pinPrice（low），且现价高于跌破 K 最低收盘 → 企微文字 + 4h 图。
 * 同一币 1 小时内不重复推；满 1 小时仍符合天平可再推。
 */

const { loadJson, saveJson, sendWecomText, sendWecomImage, fetchBinanceTickers } =
  require('./github-wecom');
const { fetchKlines, renderCandlesPng } = require('./kline-chart');

const STATE_PATH =
  process.env.BALANCE_ALERT_PATH || 'watch-balance-alert.json';
const PINS_PATH = process.env.PINS_PATH || 'watch-pins.json';
const INTERVAL = process.env.BALANCE_ALERT_INTERVAL || '4h';
const LIMIT = Math.max(12, Number(process.env.BALANCE_ALERT_LIMIT || 18));
const CONCURRENCY = Math.max(
  1,
  Number(process.env.BALANCE_ALERT_CONCURRENCY || 6),
);
/** 单轮最多推几只（默认 5）；0=不限制。首轮全量命中时避免企微连发超时。 */
const SEND_MAX = Math.max(
  0,
  Number(
    process.env.BALANCE_ALERT_SEND_MAX === undefined ||
      process.env.BALANCE_ALERT_SEND_MAX === ''
      ? 5
      : process.env.BALANCE_ALERT_SEND_MAX,
  ),
);
/** 单轮最多拉 K 检查几只（默认 24）；0=冷却到期的全查。 */
const CHECK_MAX = Math.max(
  0,
  Number(
    process.env.BALANCE_ALERT_CHECK_MAX === undefined ||
      process.env.BALANCE_ALERT_CHECK_MAX === ''
      ? 24
      : process.env.BALANCE_ALERT_CHECK_MAX,
  ),
);
/** 同一币两次天平企微最短间隔（默认 1 小时）。 */
const COOLDOWN_MS = Math.max(
  0,
  Number(
    process.env.BALANCE_ALERT_COOLDOWN_MS === undefined ||
      process.env.BALANCE_ALERT_COOLDOWN_MS === ''
      ? 60 * 60 * 1000
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
      pinPrice: Number(row.pinPrice) || 0,
    };
  });
  return { bySymbol: out };
}

/**
 * 与网页通知页天平同口径：
 * 盯后到当前窗（含）存在 low < pinPrice；现价 > 跌破 K 最低收盘。
 */
function evaluateBalance(candles, pin, livePrice) {
  if (!pin || !Array.isArray(candles) || !candles.length) return null;
  const line = Number(pin.pinPrice);
  if (!(Number.isFinite(line) && line > 0)) return null;
  const live = Number(livePrice);
  const lastClose = Number(candles[candles.length - 1] && candles[candles.length - 1].close);
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
  let minDipClose = Infinity;
  let dipped = false;
  for (let i = pinIdx + 1; i <= lastIdx; i += 1) {
    const bar = candles[i];
    const low = Number(bar && bar.low);
    if (!(Number.isFinite(low) && low < line)) continue;
    dipped = true;
    const close = Number(bar && bar.close);
    if (Number.isFinite(close) && close < minDipClose) minDipClose = close;
  }
  if (!dipped || !(Number.isFinite(minDipClose) && minDipClose < Infinity)) {
    return null;
  }
  if (!(px > minDipClose)) return null;
  return { livePrice: px, minDipClose, pinIdx, lastIdx };
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
    symbols: [],
    errors: [],
    push: pushEnabled && !!webhook,
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
    return result;
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
  // 优先更早盯上的，避免总扫同一批新币。
  due.sort((a, b) => (a.pinnedAt || 0) - (b.pinnedAt || 0));
  const pending =
    CHECK_MAX > 0 && due.length > CHECK_MAX ? due.slice(0, CHECK_MAX) : due;
  result.due = due.length;
  result.checked = pending.length;
  result.skippedFetch = pins.length - due.length;
  result.cooldownMs = COOLDOWN_MS;
  if (!pending.length) {
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
      const verdict = evaluateBalance(candles, pin, live);
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
  const hits = SEND_MAX > 0 ? matched.slice(0, SEND_MAX) : matched;
  result.hits = matched.length;
  result.queued = hits.length;

  for (const hit of hits) {
    const { pin, candles } = hit;
    const label = labelOf(pin.symbol);
    result.symbols.push(pin.symbol);

    if (!webhook) {
      // 无 webhook：只记命中，不进入冷却（下次仍可推）。
      continue;
    }
    try {
      const text = `${label} · 天平`;
      await sendWecomText(text, webhook);
      const painted = renderCandlesPng(candles, {
        title: `${label} 天平`,
        pinPrice: pin.pinPrice,
        height: 280,
      });
      await sendWecomImage(painted, webhook);
      // 仅发送成功才开 1h 冷却，失败则下轮可重试。
      state.bySymbol[pin.symbol] = {
        pinnedAt: pin.pinnedAt,
        lastSentAt: now,
        pinPrice: pin.pinPrice,
      };
      stateDirty = true;
      result.sent += 1;
    } catch (error) {
      result.errors.push(
        `send:${pin.symbol}:${error && error.message ? error.message : error}`,
      );
    }
  }

  // 清理已不在自动盯列表的状态。
  const keep = new Set(pins.map((p) => p.symbol));
  Object.keys(state.bySymbol).forEach((key) => {
    if (!keep.has(key)) {
      delete state.bySymbol[key];
      stateDirty = true;
    }
  });

  if (stateDirty || result.sent) {
    await saveJson(
      statePath,
      {
        bySymbol: state.bySymbol,
        updatedAt: now,
      },
      stateFile && stateFile.sha,
      result.sent
        ? `Balance alert x${result.sent}`
        : 'Balance alert state',
    );
  }

  return result;
}

module.exports = {
  runBalanceAlerts,
  evaluateBalance,
  normalizePins,
};
