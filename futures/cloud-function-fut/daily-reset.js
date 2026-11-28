'use strict';

/**
 * 合约每日 0:00（Asia/Shanghai）：非置顶 fut-nails 批量「便签现价」。
 * 由 fut-timer 定时触发；状态写入 futures/fut-nail-daily-reset.json，供页面 2h 内提示。
 * 对齐现货 cloud-function-notify/nail-daily-reset.js；只读写 futures/。
 */

const { loadJson, saveJson } = require('./github');
const { fetchFutTickers } = require('./binance-fapi');

const NAILS_PATH = process.env.FUT_NAILS_PATH || 'futures/fut-nails.json';
const STATE_PATH =
  process.env.FUT_NAIL_DAILY_RESET_PATH || 'futures/fut-nail-daily-reset.json';
const TZ = process.env.FUT_NAIL_DAILY_RESET_TZ || 'Asia/Shanghai';
const ENABLED = !/^(0|false|off|no)$/i.test(
  String(process.env.FUT_NAIL_DAILY_RESET_ENABLED || '1'),
);
const PROMPT_WINDOW_MS = Number(
  process.env.FUT_NAIL_DAILY_RESET_PROMPT_MS || 2 * 60 * 60 * 1000,
);

function zonedParts(ms, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = {};
  for (const part of dtf.formatToParts(new Date(ms))) {
    if (part.type !== 'literal') parts[part.type] = part.value;
  }
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

function dayKeyInTz(ms, timeZone) {
  const p = zonedParts(ms, timeZone);
  const pad = (n) => String(n).padStart(2, '0');
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** 某上海日历日 00:00 对应的 UTC ms。 */
function startOfDayMsInTz(dayKey, timeZone) {
  const match = String(dayKey || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return 0;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  let utc = Date.UTC(year, month - 1, day, 0, 0, 0);
  for (let i = 0; i < 4; i += 1) {
    const asZone = zonedParts(utc, timeZone);
    const asUtc = Date.UTC(
      asZone.year,
      asZone.month - 1,
      asZone.day,
      asZone.hour,
      asZone.minute,
      asZone.second,
    );
    const wanted = Date.UTC(year, month - 1, day, 0, 0, 0);
    utc += wanted - asUtc;
  }
  return utc;
}

function formatNotePrice(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || !(n > 0)) return '';
  if (n >= 1000) return n.toFixed(2);
  if (n >= 1) return n.toFixed(4);
  if (n >= 0.01) return n.toFixed(5);
  return n.toPrecision(4);
}

function normalizeNailList(raw) {
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
      return { ...item, symbol };
    })
    .filter(Boolean);
}

function normalizeState(raw) {
  const data = raw && typeof raw === 'object' ? raw : {};
  const postDismissed =
    Number(data.postPromptDismissedAt) ||
    Number(data.promptDismissedAt) ||
    0;
  return {
    resetDay: String(data.resetDay || '').trim(),
    resetAt: Number(data.resetAt) || 0,
    updatedCount: Number(data.updatedCount) || 0,
    skippedPinned: Number(data.skippedPinned) || 0,
    skippedNoPrice: Number(data.skippedNoPrice) || 0,
    prePromptDismissedAt: Number(data.prePromptDismissedAt) || 0,
    postPromptDismissedAt: postDismissed,
    promptWindowMs: Number(data.promptWindowMs) || PROMPT_WINDOW_MS,
    tz: String(data.tz || TZ),
    updatedAt: Number(data.updatedAt) || 0,
    market: 'usdt-perp',
  };
}

/**
 * @param {{ now?: number, nailsPath?: string, statePath?: string }} [options]
 */
async function runFutNailDailyReset(options) {
  const now = Number(options && options.now) || Date.now();
  const nailsPath =
    String((options && options.nailsPath) || NAILS_PATH).trim() || NAILS_PATH;
  const statePath =
    String((options && options.statePath) || STATE_PATH).trim() || STATE_PATH;
  const result = {
    skipped: true,
    reason: 'init',
    resetDay: '',
    resetAt: 0,
    updatedCount: 0,
    skippedPinned: 0,
    skippedNoPrice: 0,
    path: nailsPath,
  };

  if (!ENABLED) {
    result.reason = 'disabled';
    return result;
  }

  const today = dayKeyInTz(now, TZ);
  const resetAt = startOfDayMsInTz(today, TZ);
  result.resetDay = today;
  result.resetAt = resetAt;

  if (!(resetAt > 0) || now < resetAt) {
    result.reason = 'before-midnight';
    return result;
  }

  const stateFile = await loadJson(statePath);
  const prev = normalizeState(stateFile && stateFile.data);
  if (prev.resetDay === today && prev.resetAt >= resetAt) {
    result.skipped = true;
    result.reason = 'already-today';
    result.updatedCount = prev.updatedCount;
    result.skippedPinned = prev.skippedPinned;
    result.skippedNoPrice = prev.skippedNoPrice;
    return result;
  }

  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const nailsFile = await loadJson(nailsPath);
      const prevNails = normalizeNailList(nailsFile && nailsFile.data);
      const alwaysWatch = Array.isArray(
        nailsFile && nailsFile.data && nailsFile.data.alwaysWatch,
      )
        ? nailsFile.data.alwaysWatch
        : [];
      const alwaysWatchAt = Number(
        nailsFile && nailsFile.data && nailsFile.data.alwaysWatchAt,
      );
      const dismissedNails = Array.isArray(
        nailsFile && nailsFile.data && nailsFile.data.dismissedNails,
      )
        ? nailsFile.data.dismissedNails
        : [];

      if (!prevNails.length) {
        const emptyState = {
          resetDay: today,
          resetAt,
          updatedCount: 0,
          skippedPinned: 0,
          skippedNoPrice: 0,
          prePromptDismissedAt: Number(prev.prePromptDismissedAt) || 0,
          postPromptDismissedAt: 0,
          promptWindowMs: PROMPT_WINDOW_MS,
          tz: TZ,
          updatedAt: Date.now(),
          market: 'usdt-perp',
        };
        await saveJson(
          statePath,
          emptyState,
          stateFile && stateFile.sha,
          `Fut nail daily reset ${today} empty`,
        );
        result.skipped = false;
        result.reason = 'no-nails';
        return result;
      }

      const targets = prevNails.filter((item) => !item.pinned);
      const pinnedCount = prevNails.length - targets.length;
      const tickers = targets.length ? await fetchFutTickers() : {};

      let updatedCount = 0;
      let skippedNoPrice = 0;
      const nextNails = prevNails.map((item) => {
        if (item.pinned) return item;
        const live = tickers[item.symbol];
        const price = Number(live && live.price);
        const note = formatNotePrice(price);
        if (!note) {
          skippedNoPrice += 1;
          return item;
        }
        updatedCount += 1;
        return {
          ...item,
          note,
          noteAt: now,
        };
      });

      await saveJson(
        nailsPath,
        {
          nails: nextNails.map((item, order) => ({ ...item, order })),
          alwaysWatch,
          alwaysWatchAt: Number.isFinite(alwaysWatchAt) ? alwaysWatchAt : 0,
          dismissedNails,
          updatedAt: Date.now(),
          market: 'usdt-perp',
        },
        nailsFile && nailsFile.sha,
        `Fut daily nail note-price ${today} +${updatedCount}`,
      );

      const nextState = {
        resetDay: today,
        resetAt,
        updatedCount,
        skippedPinned: pinnedCount,
        skippedNoPrice,
        prePromptDismissedAt: Number(prev.prePromptDismissedAt) || 0,
        postPromptDismissedAt: 0,
        promptWindowMs: PROMPT_WINDOW_MS,
        tz: TZ,
        updatedAt: Date.now(),
        market: 'usdt-perp',
      };
      try {
        const freshState = await loadJson(statePath);
        await saveJson(
          statePath,
          nextState,
          freshState && freshState.sha,
          `Fut nail daily reset state ${today}`,
        );
      } catch (error) {
        console.warn(
          'save fut nail daily reset state failed',
          error && error.message ? error.message : error,
        );
      }

      result.skipped = false;
      result.reason = 'ok';
      result.updatedCount = updatedCount;
      result.skippedPinned = pinnedCount;
      result.skippedNoPrice = skippedNoPrice;
      return result;
    } catch (error) {
      lastError = error;
      const message = error && error.message ? error.message : String(error);
      if (!/409|conflict|sha/i.test(message)) break;
    }
  }

  result.reason = 'failed';
  result.error =
    lastError && lastError.message ? lastError.message : String(lastError);
  throw lastError || new Error('fut nail daily reset failed');
}

module.exports = {
  runFutNailDailyReset,
  dayKeyInTz,
  startOfDayMsInTz,
  normalizeState,
  PROMPT_WINDOW_MS,
  TZ,
};
