'use strict';

/**
 * 每日 0:00（Asia/Shanghai）：非置顶钉子批量「便签现价」。
 * 由 notify 定时触发；状态写入 watch-nail-daily-reset.json，供页面 2h 内提示。
 */

const { loadJson, saveJson, fetchBinancePrices } = require('./github-wecom');

const NAILS_PATH = process.env.NAILS_PATH || 'watch-nails.json';
const STATE_PATH =
  process.env.NAIL_DAILY_RESET_PATH || 'watch-nail-daily-reset.json';
const TZ = process.env.NAIL_DAILY_RESET_TZ || 'Asia/Shanghai';
const ENABLED = !/^(0|false|off|no)$/i.test(
  String(process.env.NAIL_DAILY_RESET_ENABLED || '1'),
);
const PROMPT_WINDOW_MS = Number(
  process.env.NAIL_DAILY_RESET_PROMPT_MS || 2 * 60 * 60 * 1000,
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
      if (!symbol) return null;
      if (!/USDT$/.test(symbol)) symbol += 'USDT';
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
    /** 重置前 2h 提示：值为「已关闭的那次 upcomingResetAt」 */
    prePromptDismissedAt: Number(data.prePromptDismissedAt) || 0,
    /** 重置后「完毕」提示：值为「已关闭的那次 resetAt」 */
    postPromptDismissedAt: postDismissed,
    promptWindowMs: Number(data.promptWindowMs) || PROMPT_WINDOW_MS,
    tz: String(data.tz || TZ),
    updatedAt: Number(data.updatedAt) || 0,
  };
}

/**
 * @param {{ now?: number }} [options]
 */
async function runNailDailyReset(options) {
  const now = Number(options && options.now) || Date.now();
  const result = {
    skipped: true,
    reason: 'init',
    resetDay: '',
    resetAt: 0,
    updatedCount: 0,
    skippedPinned: 0,
    skippedNoPrice: 0,
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

  const stateFile = await loadJson(STATE_PATH);
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
      const nailsFile = await loadJson(NAILS_PATH);
      const prevNails = normalizeNailList(nailsFile && nailsFile.data);
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
        };
        await saveJson(
          STATE_PATH,
          emptyState,
          stateFile && stateFile.sha,
          `Nail daily reset ${today} empty`,
        );
        result.skipped = false;
        result.reason = 'no-nails';
        return result;
      }

      const targets = prevNails.filter((item) => !item.pinned);
      const pinnedCount = prevNails.length - targets.length;
      const symbols = targets.map((item) => item.symbol);
      const prices = symbols.length ? await fetchBinancePrices(symbols) : {};

      let updatedCount = 0;
      let skippedNoPrice = 0;
      const nextNails = prevNails.map((item) => {
        if (item.pinned) return item;
        const price = Number(prices[item.symbol]);
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

      const browseMaskAt = Number(
        nailsFile && nailsFile.data && nailsFile.data.browseMaskAt,
      );
      const browseRevealed = Array.isArray(
        nailsFile && nailsFile.data && nailsFile.data.browseRevealed,
      )
        ? nailsFile.data.browseRevealed
        : [];
      const dismissedNails = Array.isArray(
        nailsFile && nailsFile.data && nailsFile.data.dismissedNails,
      )
        ? nailsFile.data.dismissedNails
        : [];

      await saveJson(
        NAILS_PATH,
        {
          nails: nextNails.map((item, order) => ({ ...item, order })),
          nailsUpdatedAt: now,
          updatedAt: Date.now(),
          browseMaskAt: Number.isFinite(browseMaskAt) ? browseMaskAt : 0,
          browseRevealed,
          dismissedNails,
        },
        nailsFile && nailsFile.sha,
        `Daily nail note-price ${today} +${updatedCount}`,
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
      };
      // 状态文件可能被并发改写；失败不回滚钉子（已写入）。
      try {
        const freshState = await loadJson(STATE_PATH);
        await saveJson(
          STATE_PATH,
          nextState,
          freshState && freshState.sha,
          `Nail daily reset state ${today}`,
        );
      } catch (error) {
        console.warn(
          'save nail daily reset state failed',
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
  throw lastError || new Error('nail daily reset failed');
}

module.exports = {
  runNailDailyReset,
  dayKeyInTz,
  startOfDayMsInTz,
  normalizeState,
  PROMPT_WINDOW_MS,
  TZ,
};
