'use strict';

/**
 * 自动盯钉子过期清退：
 * 当前 18 根 4h 图中，若自动盯 pinnedAt 落在最旧前 1/3（含已滚出左缘），
 * 则从钉子页移除，并清掉对应自动盯 pin（置顶钉子除外）。
 * 回前 30 时会再自动盯 → 再进钉子。
 */

const { loadJson, saveJson } = require('./github-wecom');
const { fetchKlines } = require('./kline-chart');
const { normalizePinList } = require('./auto-pin');

const NAILS_PATH = process.env.NAILS_PATH || 'watch-nails.json';
const PINS_PATH = process.env.PINS_PATH || 'watch-pins.json';
const INTERVAL = process.env.STALE_NAIL_INTERVAL || '4h';
const LIMIT = Math.max(12, Number(process.env.STALE_NAIL_LIMIT || 18));
const CONCURRENCY = Math.max(
  1,
  Number(process.env.STALE_NAIL_CONCURRENCY || 4),
);
/** 单轮最多拉 K 检查几只；默认 12，避免与天平/染绿叠超时。0=候选全查。 */
const CHECK_MAX = Math.max(
  0,
  Number(
    process.env.STALE_NAIL_CHECK_MAX === undefined ||
      process.env.STALE_NAIL_CHECK_MAX === ''
      ? 12
      : process.env.STALE_NAIL_CHECK_MAX,
  ),
);
const AUTO_SOURCES = new Set(['auto-rising', 'auto-cloud', 'auto-rewarm']);

function enabled() {
  return (
    String(
      process.env.STALE_AUTO_PIN_NAILS === undefined
        ? '1'
        : process.env.STALE_AUTO_PIN_NAILS,
    ) !== '0'
  );
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

function isAutoPinSource(source) {
  return AUTO_SOURCES.has(String(source || '').trim());
}

function isUserPinnedNail(nail) {
  return !!(nail && (nail.pinned === true || Number(nail.pinnedAt) > 0));
}

/** pinIdx 落在最旧前 1/3（含滚出左缘→0）则过期。 */
function isPinInOldestThird(candles, pinnedAt) {
  if (!Array.isArray(candles) || !candles.length) return false;
  const pinnedAtMs = Number(pinnedAt) || 0;
  if (!(pinnedAtMs > 0)) return false;
  const pinIdx = findCandleIndexAt(candles, pinnedAtMs);
  if (pinIdx < 0) return false;
  const cutoff = Math.floor(candles.length / 3);
  return pinIdx < cutoff;
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

/**
 * @param {{
 *   now?: number,
 *   pins?: object[],
 *   pinsFile?: { data?: object, sha?: string },
 *   nailsPath?: string,
 *   pinsPath?: string,
 * }} [options]
 */
async function pruneStaleAutoPinNails(options) {
  const opts = options || {};
  const now = Number(opts.now) || Date.now();
  const nailsPath = String(opts.nailsPath || NAILS_PATH).trim() || NAILS_PATH;
  const pinsPath = String(opts.pinsPath || PINS_PATH).trim() || PINS_PATH;
  const result = {
    skipped: false,
    reason: null,
    checked: 0,
    removed: [],
    errors: [],
    pins: null,
  };

  if (!enabled()) {
    result.skipped = true;
    result.reason = 'disabled';
    return result;
  }

  let pins = normalizePinList(
    Array.isArray(opts.pins)
      ? opts.pins
      : (opts.pinsFile &&
          opts.pinsFile.data &&
          (opts.pinsFile.data.pins || opts.pinsFile.data)) ||
          [],
  );
  let pinsFile = opts.pinsFile || null;
  if (!Array.isArray(opts.pins) && !pinsFile) {
    pinsFile = await loadJson(pinsPath);
    pins = normalizePinList(
      (pinsFile.data && pinsFile.data.pins) ||
        (Array.isArray(pinsFile.data) ? pinsFile.data : []),
    );
  }

  const autoPinBySymbol = new Map();
  pins.forEach((row) => {
    if (!row || !isAutoPinSource(row.source)) return;
    const key = String(row.symbol || '')
      .trim()
      .toUpperCase();
    if (!key) return;
    autoPinBySymbol.set(key, row);
  });
  if (!autoPinBySymbol.size) {
    result.skipped = true;
    result.reason = 'no-auto-pins';
    result.pins = pins;
    return result;
  }

  const nailsFile = await loadJson(nailsPath);
  const nails = Array.isArray(nailsFile.data && nailsFile.data.nails)
    ? nailsFile.data.nails
    : [];
  if (!nails.length) {
    result.skipped = true;
    result.reason = 'no-nails';
    result.pins = pins;
    return result;
  }

  const candidates = [];
  nails.forEach((nail) => {
    if (!nail) return;
    if (isUserPinnedNail(nail)) return;
    const key = String(nail.symbol || '')
      .trim()
      .toUpperCase();
    if (!key || !autoPinBySymbol.has(key)) return;
    candidates.push({ nail, pin: autoPinBySymbol.get(key), symbol: key });
  });
  if (!candidates.length) {
    result.skipped = true;
    result.reason = 'no-candidates';
    result.pins = pins;
    return result;
  }

  // 优先更早盯上的，单轮限量避免超时。
  candidates.sort(
    (a, b) => (Number(a.pin.pinnedAt) || 0) - (Number(b.pin.pinnedAt) || 0),
  );
  const toCheck =
    CHECK_MAX > 0 && candidates.length > CHECK_MAX
      ? candidates.slice(0, CHECK_MAX)
      : candidates;
  result.checked = toCheck.length;
  result.candidate = candidates.length;

  const evaluated = await mapPool(toCheck, CONCURRENCY, async (row) => {
    try {
      const candles = await fetchKlines(row.symbol, INTERVAL, LIMIT);
      if (!isPinInOldestThird(candles, row.pin.pinnedAt)) return null;
      return row.symbol;
    } catch (error) {
      result.errors.push(
        `${row.symbol}:${error && error.message ? error.message : error}`,
      );
      return null;
    }
  });

  const stale = new Set(evaluated.filter(Boolean));
  if (!stale.size) {
    result.reason = 'none-stale';
    result.pins = pins;
    return result;
  }

  const nextNails = nails.filter((nail) => {
    const key = String((nail && nail.symbol) || '')
      .trim()
      .toUpperCase();
    return !stale.has(key);
  });
  const nextPins = pins.filter((row) => {
    const key = String((row && row.symbol) || '')
      .trim()
      .toUpperCase();
    if (!stale.has(key)) return true;
    // 只清自动盯；手动盯保留（理论上候选不会含手动）。
    return !isAutoPinSource(row && row.source);
  });

  const dismissed = new Set(
    (Array.isArray(nailsFile.data && nailsFile.data.dismissedNails)
      ? nailsFile.data.dismissedNails
      : []
    )
      .map((symbol) => String(symbol || '').trim().toUpperCase())
      .filter(Boolean),
  );
  // 不加入 dismissed：清 pin 后 backfill 不会钉回；回前 30 新自动盯可再进。

  const browseMaskAt = Number(nailsFile.data && nailsFile.data.browseMaskAt) || 0;
  const browseRevealed = Array.isArray(nailsFile.data && nailsFile.data.browseRevealed)
    ? nailsFile.data.browseRevealed
    : [];

  await saveJson(
    nailsPath,
    {
      nails: nextNails.map((item, order) => ({ ...item, order })),
      nailsUpdatedAt: now,
      updatedAt: Date.now(),
      browseMaskAt,
      browseRevealed,
      dismissedNails: [...dismissed],
    },
    nailsFile.sha,
    `Prune stale auto-pin nails -${stale.size}`,
  );

  if (!pinsFile || !pinsFile.sha) {
    pinsFile = await loadJson(pinsPath);
  }
  await saveJson(
    pinsPath,
    {
      pins: normalizePinList(nextPins),
      pinsUpdatedAt: Date.now(),
    },
    pinsFile && pinsFile.sha,
    `Prune stale auto-pin pins -${stale.size}`,
  );

  result.removed = [...stale];
  result.pins = nextPins;
  return result;
}

module.exports = {
  pruneStaleAutoPinNails,
  isPinInOldestThird,
  findCandleIndexAt,
};
