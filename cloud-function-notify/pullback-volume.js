'use strict';

/**
 * 回踩观察 / 回踩放量（仅自动盯池）：
 * 启动大实体 → 回踩 → 缩量观察 → 放量阳线确认。
 * 写入 watch-balance-notices.json（kinds），不推企微。
 */

const { requestRaw, loadJson, saveJson } = require('./github-wecom');
const { appendBalanceNotices, normalizePins } = require('./balance-alert');

const STATE_PATH =
  process.env.PULLBACK_VOLUME_PATH || 'watch-pullback-volume.json';
const NOTICES_PATH =
  process.env.BALANCE_NOTICES_PATH || 'watch-balance-notices.json';
const NAILS_PATH = process.env.NAILS_PATH || 'watch-nails.json';
const INTERVAL = process.env.PULLBACK_VOLUME_INTERVAL || '4h';
const LIMIT = Math.max(18, Number(process.env.PULLBACK_VOLUME_LIMIT || 24));
const WINDOW_BARS = Math.max(12, Number(process.env.PULLBACK_VOLUME_WINDOW || 18));
const DURATION_MS = 4 * 60 * 60 * 1000;
const CONCURRENCY = Math.max(
  1,
  Number(process.env.PULLBACK_VOLUME_CONCURRENCY || 6),
);
const CHECK_MAX = Math.max(
  0,
  Number(
    process.env.PULLBACK_VOLUME_CHECK_MAX === undefined ||
      process.env.PULLBACK_VOLUME_CHECK_MAX === ''
      ? 24
      : process.env.PULLBACK_VOLUME_CHECK_MAX,
  ),
);
/** 同币同 tier 最短再进通知间隔（默认 4h = 一根）。 */
const COOLDOWN_MS = Math.max(
  0,
  Number(
    process.env.PULLBACK_VOLUME_COOLDOWN_MS === undefined ||
      process.env.PULLBACK_VOLUME_COOLDOWN_MS === ''
      ? 4 * 60 * 60 * 1000
      : process.env.PULLBACK_VOLUME_COOLDOWN_MS,
  ),
);

const BODY_MIN = Number(process.env.PULLBACK_BODY_MIN || 0.05);
const RANGE_MIN = Number(process.env.PULLBACK_RANGE_MIN || 0.08);
const VOL_SPIKE = Number(process.env.PULLBACK_VOL_SPIKE || 3);
const WATCH_VOL_MAX = Number(process.env.PULLBACK_WATCH_VOL_MAX || 0.08);
const DRY_VOL_MAX = Number(process.env.PULLBACK_DRY_VOL_MAX || 0.03);
const CONFIRM_VOL_SPIKE = Number(process.env.PULLBACK_CONFIRM_VOL_SPIKE || 3);
const CONFIRM_BODY_MIN = Number(process.env.PULLBACK_CONFIRM_BODY_MIN || 0.02);
const PULLBACK_CLOSE_FRAC = Number(
  process.env.PULLBACK_CLOSE_FRAC || 0.97,
);
const WATCH_BODY_FLOOR = Number(process.env.PULLBACK_WATCH_BODY_FLOOR || -0.02);

const KIND_WATCH = '回踩观察';
const KIND_CONFIRM = '回踩放量';

function enabled() {
  return (
    String(
      process.env.PULLBACK_VOLUME === undefined
        ? '1'
        : process.env.PULLBACK_VOLUME,
    ) !== '0'
  );
}

function labelOf(symbol) {
  return String(symbol || '').replace(/USDT$/i, '');
}

function currentWindowOpen(now) {
  const ts = Number(now) || Date.now();
  return Math.floor(ts / DURATION_MS) * DURATION_MS;
}

function parseAlertPrice(note) {
  const text = String(note || '').trim();
  if (!text) return null;
  const match = text.match(/(\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function notePriceBySymbol(nailsRaw) {
  const list = Array.isArray(nailsRaw)
    ? nailsRaw
    : Array.isArray(nailsRaw && nailsRaw.nails)
      ? nailsRaw.nails
      : [];
  const map = {};
  list.forEach((item) => {
    if (!item || !item.symbol) return;
    const symbol = String(item.symbol).trim().toUpperCase();
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

function bodyPct(bar) {
  const o = Number(bar && bar.o);
  const c = Number(bar && bar.c);
  if (!(Number.isFinite(o) && o > 0 && Number.isFinite(c))) return NaN;
  return (c - o) / o;
}

function rangePct(bar) {
  const o = Number(bar && bar.o);
  const h = Number(bar && bar.h);
  const l = Number(bar && bar.l);
  if (
    !(Number.isFinite(o) && o > 0 && Number.isFinite(h) && Number.isFinite(l))
  ) {
    return NaN;
  }
  return (h - l) / o;
}

function mean(nums) {
  const list = (Array.isArray(nums) ? nums : []).filter((n) =>
    Number.isFinite(n),
  );
  if (!list.length) return NaN;
  return list.reduce((a, b) => a + b, 0) / list.length;
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
      vol: Number(row[5]),
      closeTime: Number(row[6]),
    }))
    .filter(
      (c) =>
        Number.isFinite(c.ot) &&
        c.ot > 0 &&
        Number.isFinite(c.o) &&
        Number.isFinite(c.c) &&
        Number.isFinite(c.vol),
    );
}

async function fetchVolumeKlines(symbol, limit) {
  const key = String(symbol || '')
    .trim()
    .toUpperCase();
  const n = Math.max(WINDOW_BARS + 2, Math.floor(Number(limit) || LIMIT));
  if (!key) return [];
  const query = `symbol=${encodeURIComponent(key)}&interval=${INTERVAL}&limit=${n}`;
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
    console.warn(
      'pullback-volume klines failed',
      key,
      lastError.message || lastError,
    );
  }
  return [];
}

/** 只用已收盘 K（closeTime < now）。 */
function closedBars(candles, now) {
  const ts = Number(now) || Date.now();
  const list = Array.isArray(candles) ? candles : [];
  const closed = list.filter((c) => {
    const ct = Number(c.closeTime);
    if (Number.isFinite(ct) && ct > 0) return ct < ts;
    return true;
  });
  // 无 closeTime 时丢掉最后一根，避免把未收盘当确认。
  if (
    closed.length &&
    closed.length === list.length &&
    !Number.isFinite(Number(list[list.length - 1].closeTime))
  ) {
    return closed.slice(0, -1);
  }
  return closed;
}

/**
 * 在 endIdx 之前的窗内找最近启动 K。
 * @returns {{ idx: number, vol: number, high: number, low: number, close: number, open: number, ot: number } | null}
 */
function findImpulse(bars, endIdx) {
  if (!Array.isArray(bars) || endIdx <= 0) return null;
  const start = Math.max(0, endIdx - WINDOW_BARS);
  const window = bars.slice(start, endIdx);
  if (window.length < 3) return null;
  const vols = window.map((b) => Number(b.vol) || 0);
  const maxVol = Math.max(...vols);
  const avgVol = mean(vols);
  for (let i = endIdx - 1; i >= start; i -= 1) {
    const b = bars[i];
    const bp = bodyPct(b);
    const rp = rangePct(b);
    const vol = Number(b.vol) || 0;
    if (!(bp >= BODY_MIN)) continue;
    if (!(rp >= RANGE_MIN)) continue;
    if (!(vol >= maxVol - 1e-12 || (Number.isFinite(avgVol) && vol >= avgVol * VOL_SPIKE))) {
      continue;
    }
    return {
      idx: i,
      vol,
      high: Number(b.h),
      low: Number(b.l),
      close: Number(b.c),
      open: Number(b.o),
      ot: Number(b.ot) || 0,
    };
  }
  return null;
}

function findPullbackLow(bars, impulse, beforeIdx) {
  if (!impulse || !(beforeIdx > impulse.idx)) return null;
  const mid = Math.min(Number(impulse.open), Number(impulse.close));
  const closeGate = Number(impulse.close) * PULLBACK_CLOSE_FRAC;
  let pullLow = Infinity;
  let found = false;
  for (let i = impulse.idx + 1; i < beforeIdx; i += 1) {
    const low = Number(bars[i].l);
    if (!Number.isFinite(low)) continue;
    const hit =
      (Number.isFinite(mid) && low <= mid) ||
      (Number.isFinite(closeGate) && low <= closeGate);
    if (!hit) continue;
    found = true;
    if (low < pullLow) pullLow = low;
  }
  if (!found || !(pullLow < Infinity)) return null;
  // 失控：回踩后收盘仍明显低于 impulse.low 且未收回 —— 软拒
  const impulseLow = Number(impulse.low);
  if (Number.isFinite(impulseLow) && pullLow < impulseLow * 0.995) {
    let recovered = false;
    for (let i = impulse.idx + 1; i < beforeIdx; i += 1) {
      const c = Number(bars[i].c);
      if (Number.isFinite(c) && c >= impulseLow) {
        recovered = true;
        break;
      }
    }
    if (!recovered) return null;
  }
  return pullLow;
}

function hadWatchOrDry(bars, impulse, beforeIdx) {
  if (!impulse || !(beforeIdx > impulse.idx + 1)) return false;
  const pullLow = findPullbackLow(bars, impulse, beforeIdx);
  if (!(Number.isFinite(pullLow) && pullLow > 0)) return false;
  for (let i = impulse.idx + 1; i < beforeIdx; i += 1) {
    const b = bars[i];
    const vol = Number(b.vol) || 0;
    const ratio = impulse.vol > 0 ? vol / impulse.vol : Infinity;
    const bp = bodyPct(b);
    const c = Number(b.c);
    if (!(c > pullLow)) continue;
    if (ratio <= DRY_VOL_MAX) return true;
    if (ratio <= WATCH_VOL_MAX && Number.isFinite(bp) && bp > WATCH_BODY_FLOOR) {
      return true;
    }
  }
  return false;
}

/**
 * @returns {{ tier: 'watch'|'confirm'|'', kinds: string[], impulseOt: number, openTime: number, meta: object } | null}
 */
function evaluatePullbackVolume(candles, now) {
  const bars = closedBars(candles, now);
  if (bars.length < 6) return null;
  const curIdx = bars.length - 1;
  const cur = bars[curIdx];
  const openTime = Number(cur.ot) || currentWindowOpen(now);
  const impulse = findImpulse(bars, curIdx);
  if (!impulse) return null;
  // 启动 K 至少要隔 1 根，避免把当前大阳当确认又当启动。
  if (curIdx - impulse.idx < 2) return null;

  const pullLow = findPullbackLow(bars, impulse, curIdx);
  if (!(Number.isFinite(pullLow) && pullLow > 0)) return null;

  const curVol = Number(cur.vol) || 0;
  const curBp = bodyPct(cur);
  const curClose = Number(cur.c);
  const curOpen = Number(cur.o);
  const volRatio = impulse.vol > 0 ? curVol / impulse.vol : Infinity;

  const prev2 = [
    Number(bars[curIdx - 1] && bars[curIdx - 1].vol),
    Number(bars[curIdx - 2] && bars[curIdx - 2].vol),
  ];
  const prevMean = mean(prev2);
  const confirmReady =
    hadWatchOrDry(bars, impulse, curIdx) &&
    Number.isFinite(prevMean) &&
    prevMean > 0 &&
    curVol > prevMean * CONFIRM_VOL_SPIKE &&
    Number.isFinite(curBp) &&
    curBp >= CONFIRM_BODY_MIN &&
    Number.isFinite(curClose) &&
    Number.isFinite(curOpen) &&
    curClose > curOpen &&
    curClose > pullLow;

  if (confirmReady) {
    return {
      tier: 'confirm',
      kinds: [KIND_CONFIRM],
      impulseOt: impulse.ot,
      openTime,
      meta: {
        volRatio,
        bodyPct: curBp,
        pullLow,
        prevMean,
        impulseVol: impulse.vol,
        curVol,
      },
    };
  }

  const watchReady =
    volRatio <= WATCH_VOL_MAX &&
    Number.isFinite(curClose) &&
    curClose > pullLow &&
    Number.isFinite(curBp) &&
    curBp > WATCH_BODY_FLOOR;

  if (watchReady) {
    return {
      tier: 'watch',
      kinds: [KIND_WATCH],
      impulseOt: impulse.ot,
      openTime,
      meta: {
        volRatio,
        bodyPct: curBp,
        pullLow,
        impulseVol: impulse.vol,
        curVol,
      },
    };
  }
  return null;
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
      lastWatchAt: Number(row.lastWatchAt) || 0,
      lastConfirmAt: Number(row.lastConfirmAt) || 0,
      watchOpenTime: Number(row.watchOpenTime) || 0,
      confirmOpenTime: Number(row.confirmOpenTime) || 0,
      impulseOt: Number(row.impulseOt) || 0,
      pinPrice: Number(row.pinPrice) || 0,
      pinnedAt: Number(row.pinnedAt) || 0,
    };
  });
  return {
    bySymbol: out,
    checkCursor: Number(data && data.checkCursor) || 0,
  };
}

function dueForTier(lastAt, now) {
  if (!(Number(lastAt) > 0)) return true;
  if (COOLDOWN_MS <= 0) return true;
  return now - Number(lastAt) >= COOLDOWN_MS;
}

async function mapPool(items, concurrency, worker) {
  const list = Array.isArray(items) ? items : [];
  const limit = Math.max(1, Number(concurrency) || 1);
  const out = new Array(list.length);
  let cursor = 0;
  async function run() {
    while (cursor < list.length) {
      const i = cursor;
      cursor += 1;
      out[i] = await worker(list[i], i);
    }
  }
  const runners = [];
  for (let i = 0; i < Math.min(limit, list.length); i += 1) {
    runners.push(run());
  }
  await Promise.all(runners);
  return out;
}

/**
 * @param {{ pins?: object[], now?: number, noticesPath?: string, statePath?: string }} opts
 */
async function runPullbackVolumeDetect(opts) {
  const options = opts || {};
  const now = Number(options.now) || Date.now();
  const result = {
    skipped: false,
    reason: null,
    checked: 0,
    hits: 0,
    watch: 0,
    confirm: 0,
    notices: 0,
    symbols: [],
    kinds: [],
    errors: [],
  };

  if (!enabled()) {
    result.skipped = true;
    result.reason = 'disabled';
    return result;
  }

  const statePath = options.statePath || STATE_PATH;
  const noticesPath = options.noticesPath || NOTICES_PATH;
  let pins = normalizePins(options.pins);
  if (!pins.length) {
    try {
      const pinsFile = await loadJson(
        options.pinsPath || process.env.PINS_PATH || 'watch-pins.json',
      );
      pins = normalizePins(pinsFile && pinsFile.data);
    } catch (error) {
      result.errors.push(
        `pins:${error && error.message ? error.message : error}`,
      );
    }
  }
  if (!pins.length) {
    result.skipped = true;
    result.reason = 'no-auto-pins';
    return result;
  }

  let stateFile;
  try {
    stateFile = await loadJson(statePath);
  } catch (error) {
    stateFile = { data: null, sha: null };
  }
  const state = normalizeState(stateFile && stateFile.data);

  const pending = pins.filter((pin) => {
    const prev = state.bySymbol[pin.symbol] || {};
    return (
      dueForTier(prev.lastWatchAt, now) || dueForTier(prev.lastConfirmAt, now)
    );
  });

  let slice = pending;
  if (CHECK_MAX > 0 && pending.length > CHECK_MAX) {
    const cursor = Number(state.checkCursor) || 0;
    const start = cursor % pending.length;
    slice = [];
    for (let i = 0; i < CHECK_MAX; i += 1) {
      slice.push(pending[(start + i) % pending.length]);
    }
    state.checkCursor = (start + CHECK_MAX) % pending.length;
  } else {
    state.checkCursor = 0;
  }
  result.checked = slice.length;
  if (!slice.length) {
    result.skipped = true;
    result.reason = 'cooldown';
    return result;
  }

  let noteMap = {};
  try {
    const nailsFile = await loadJson(NAILS_PATH);
    noteMap = notePriceBySymbol(nailsFile && nailsFile.data);
  } catch (_) {
    noteMap = {};
  }

  const evaluated = await mapPool(slice, CONCURRENCY, async (pin) => {
    try {
      const candles = await fetchVolumeKlines(pin.symbol, LIMIT);
      const verdict = evaluatePullbackVolume(candles, now);
      if (!verdict) return null;
      return { pin, verdict };
    } catch (error) {
      result.errors.push(
        `${pin.symbol}:${error && error.message ? error.message : error}`,
      );
      return null;
    }
  });

  const noticeRows = [];
  let stateDirty = false;
  for (const hit of evaluated.filter(Boolean)) {
    const { pin, verdict } = hit;
    const prev = state.bySymbol[pin.symbol] || {};
    const isConfirm = verdict.tier === 'confirm';
    const isWatch = verdict.tier === 'watch';
    if (isConfirm && !dueForTier(prev.lastConfirmAt, now)) continue;
    if (isWatch && !dueForTier(prev.lastWatchAt, now)) continue;
    // 同窗已写过同 tier 则跳过（冷却外的重复扫）。
    if (
      isConfirm &&
      Number(prev.confirmOpenTime) === Number(verdict.openTime) &&
      Number(prev.confirmOpenTime) > 0
    ) {
      continue;
    }
    if (
      isWatch &&
      Number(prev.watchOpenTime) === Number(verdict.openTime) &&
      Number(prev.watchOpenTime) > 0
    ) {
      continue;
    }

    if (isConfirm) result.confirm += 1;
    if (isWatch) result.watch += 1;
    result.hits += 1;
    result.symbols.push(pin.symbol);
    result.kinds.push({ symbol: pin.symbol, kinds: verdict.kinds, tier: verdict.tier });

    const note = noteMap[pin.symbol] || {};
    noticeRows.push({
      id: `${pin.symbol}:${verdict.openTime}:${now}:${verdict.tier}`,
      symbol: pin.symbol,
      label: labelOf(pin.symbol),
      kinds: verdict.kinds.slice(),
      at: now,
      firstSeenAt: now,
      openTime: verdict.openTime,
      pinPrice: pin.pinPrice,
      pinnedAt: pin.pinnedAt,
      alertPrice: Number(note.alertPrice) || 0,
      notifyPrice: 0,
      noteAt: Number(note.noteAt) || 0,
      interval: INTERVAL,
      windowUp: false,
      batchAt: 0,
    });

    state.bySymbol[pin.symbol] = {
      ...prev,
      pinPrice: pin.pinPrice,
      pinnedAt: pin.pinnedAt,
      impulseOt: verdict.impulseOt || prev.impulseOt || 0,
      lastWatchAt: isWatch ? now : Number(prev.lastWatchAt) || 0,
      lastConfirmAt: isConfirm ? now : Number(prev.lastConfirmAt) || 0,
      watchOpenTime: isWatch
        ? verdict.openTime
        : Number(prev.watchOpenTime) || 0,
      confirmOpenTime: isConfirm
        ? verdict.openTime
        : Number(prev.confirmOpenTime) || 0,
    };
    stateDirty = true;
  }

  if (noticeRows.length) {
    try {
      const saved = await appendBalanceNotices(noticeRows, now, noticesPath);
      result.notices = Number(saved && saved.notices) || noticeRows.length;
    } catch (error) {
      result.errors.push(
        `notices:${error && error.message ? error.message : error}`,
      );
    }
  }

  if (stateDirty || CHECK_MAX > 0) {
    try {
      await saveJson(
        statePath,
        {
          bySymbol: state.bySymbol,
          checkCursor: Number(state.checkCursor) || 0,
          updatedAt: now,
        },
        stateFile && stateFile.sha,
        noticeRows.length
          ? `Pullback volume +${noticeRows.length}`
          : 'Pullback volume state',
      );
    } catch (error) {
      result.errors.push(
        `state:${error && error.message ? error.message : error}`,
      );
    }
  }

  return result;
}

module.exports = {
  runPullbackVolumeDetect,
  evaluatePullbackVolume,
  findImpulse,
  closedBars,
  KIND_WATCH,
  KIND_CONFIRM,
};
