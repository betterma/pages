'use strict';

/**
 * Notes-rank snapshots + 排序动态 (rank-new / rank-up).
 * Runs inside the cloud timer — does not depend on an open browser tab.
 * Sort keys come from watch-notes-rank-prefs.json (shared with the page).
 */

const { loadJson, saveJson } = require('./github-wecom');
const { fetchKlines } = require('./kline-chart');
const { loadBlacklistSet } = require('./auto-pin');
const {
  listBreakHighUniverse,
  loadMomNotes,
  normalizeMomNotes,
} = require('./break-high');

const CONFIG = {
  NOTES_RANK_SNAPS_PATH:
    process.env.NOTES_RANK_SNAPS_PATH || 'watch-notes-rank-snaps.json',
  NOTES_RANK_PREFS_PATH:
    process.env.NOTES_RANK_PREFS_PATH || 'watch-notes-rank-prefs.json',
  NOTES_RANK_SNAPS_TTL_MS: Number(
    process.env.NOTES_RANK_SNAPS_TTL_MS || 24 * 60 * 60 * 1000,
  ),
  NOTES_RANK_SNAPS_MAX: Number(process.env.NOTES_RANK_SNAPS_MAX || 48),
  NOTES_RANK_SNAP_INTERVAL_MS: Number(
    process.env.NOTES_RANK_SNAP_INTERVAL_MS || 30 * 60 * 1000,
  ),
  NOTES_RANK_SNAP_ENABLED:
    String(
      process.env.NOTES_RANK_SNAP_ENABLED === undefined
        ? '1'
        : process.env.NOTES_RANK_SNAP_ENABLED,
    ) !== '0',
  NOTES_RANK_KLINE_TOP: Number(process.env.NOTES_RANK_KLINE_TOP || 10),
  NOTES_RANK_KLINE_LIMIT: Number(process.env.NOTES_RANK_KLINE_LIMIT || 24),
  NOTES_RANK_SNAP_CONCURRENCY: Number(
    process.env.NOTES_RANK_SNAP_CONCURRENCY ||
      process.env.MOMENTUM_CONCURRENCY ||
      5,
  ),
};

const NOTES_RANK_SORT_KEYS = new Set([
  'change2h',
  'change1h',
  'change24h',
  'noteAt',
  'gain',
]);

const NOTES_RANK_PREFS_DEFAULT = {
  keys: ['change2h', 'noteAt', 'change1h'],
  last: 'change2h',
};

function changeFrom(base, current) {
  if (!Number.isFinite(base) || !Number.isFinite(current) || base === 0) {
    return null;
  }
  return ((current - base) / base) * 100;
}

function normalizeNotesRankSortKey(key) {
  const raw = String(key || '').trim();
  return NOTES_RANK_SORT_KEYS.has(raw) ? raw : NOTES_RANK_PREFS_DEFAULT.last;
}

function uniqueNotesRankSortKeys(keys) {
  const seen = new Set();
  const list = [];
  for (const raw of keys || []) {
    const key = normalizeNotesRankSortKey(raw);
    if (seen.has(key)) continue;
    seen.add(key);
    list.push(key);
  }
  return list.length ? list : NOTES_RANK_PREFS_DEFAULT.keys.slice();
}

function normalizeNotesRankPrefs(raw) {
  const base = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const keys = uniqueNotesRankSortKeys(
    Array.isArray(base.keys) ? base.keys : NOTES_RANK_PREFS_DEFAULT.keys,
  );
  let last = normalizeNotesRankSortKey(
    base.last || NOTES_RANK_PREFS_DEFAULT.last,
  );
  if (!keys.includes(last)) last = keys[keys.length - 1];
  return { keys, last };
}

async function loadNotesRankPrefs() {
  try {
    const file = await loadJson(CONFIG.NOTES_RANK_PREFS_PATH);
    if (file && file.data) return normalizeNotesRankPrefs(file.data);
  } catch (error) {
    console.warn(
      'notes-rank prefs load failed',
      error && error.message ? error.message : error,
    );
  }
  return normalizeNotesRankPrefs(NOTES_RANK_PREFS_DEFAULT);
}

function latestNoteForSymbol(notes, symbol) {
  const key = String(symbol || '')
    .trim()
    .toUpperCase();
  for (const note of notes || []) {
    if (note && note.symbol === key) return note;
  }
  return null;
}

function pinMapFromList(pins) {
  const map = new Map();
  for (const item of pins || []) {
    if (!item || !item.symbol) continue;
    map.set(String(item.symbol).toUpperCase(), item);
  }
  return map;
}

function normalizeNotesRankSnap(item) {
  if (!item || typeof item !== 'object') return null;
  const at = Number(item.at) || 0;
  const symbols = [
    ...new Set(
      (Array.isArray(item.symbols) ? item.symbols : [])
        .map((symbol) => String(symbol || '').trim().toUpperCase())
        .filter(Boolean),
    ),
  ];
  if (!at || !symbols.length) return null;
  return { at, symbols };
}

function normalizeNotesRankSnaps(raw) {
  const cutoff = Date.now() - CONFIG.NOTES_RANK_SNAPS_TTL_MS;
  if (!Array.isArray(raw)) return [];
  return raw
    .map(normalizeNotesRankSnap)
    .filter((item) => item && item.at >= cutoff)
    .sort((a, b) => (b.at || 0) - (a.at || 0))
    .slice(0, CONFIG.NOTES_RANK_SNAPS_MAX);
}

function appendNotesRankSnap(list, symbols, at) {
  const ts = Number(at) || Date.now();
  const nextSymbols = [
    ...new Set(
      (symbols || [])
        .map((symbol) => String(symbol || '').trim().toUpperCase())
        .filter(Boolean),
    ),
  ];
  if (!nextSymbols.length) return normalizeNotesRankSnaps(list);
  return normalizeNotesRankSnaps([
    { at: ts, symbols: nextSymbols },
    ...(list || []),
  ]);
}

function compareNotesRankSnaps(prev, curr) {
  const prevSymbols = Array.isArray(prev && prev.symbols) ? prev.symbols : [];
  const currSymbols = Array.isArray(curr && curr.symbols) ? curr.symbols : [];
  const prevRank = new Map();
  prevSymbols.forEach((symbol, index) => {
    const key = String(symbol || '')
      .trim()
      .toUpperCase();
    if (key && !prevRank.has(key)) prevRank.set(key, index + 1);
  });
  const currRank = new Map();
  currSymbols.forEach((symbol, index) => {
    const key = String(symbol || '')
      .trim()
      .toUpperCase();
    if (key && !currRank.has(key)) currRank.set(key, index + 1);
  });
  const added = [];
  const advanced = [];
  for (const [symbol, rank] of currRank) {
    if (!prevRank.has(symbol)) {
      added.push(symbol);
      continue;
    }
    const before = prevRank.get(symbol);
    if (Number.isFinite(before) && rank < before) advanced.push(symbol);
  }
  return { added, advanced };
}

function notesRankGain(symbol, pinsBySymbol, notes, tickers) {
  const key = String(symbol || '')
    .trim()
    .toUpperCase();
  const current = Number(tickers && tickers[key] && tickers[key].price);
  if (!Number.isFinite(current) || current <= 0) return null;
  const note = latestNoteForSymbol(notes, key);
  if (note && Number.isFinite(note.price) && note.price > 0) {
    return changeFrom(note.price, current);
  }
  const pin = pinsBySymbol.get(key);
  const pinPrice = Number(pin && pin.pinPrice);
  if (Number.isFinite(pinPrice) && pinPrice > 0) {
    return changeFrom(pinPrice, current);
  }
  return null;
}

function closedCloses(candles) {
  if (!Array.isArray(candles) || candles.length < 2) return [];
  return candles
    .slice(0, -1)
    .map((bar) => Number(bar && bar.close))
    .filter((value) => Number.isFinite(value));
}

function changeAtClosedEnd(closes, bars, endIndex, livePrice) {
  if (!Array.isArray(closes) || bars < 1) return null;
  if (endIndex < 0 || endIndex >= closes.length) return null;
  const pastIndex = endIndex + 1 - bars;
  if (pastIndex < 0 || pastIndex > endIndex) return null;
  const past = closes[pastIndex];
  const now = Number.isFinite(livePrice) ? livePrice : closes[endIndex];
  if (!Number.isFinite(past) || past === 0 || !Number.isFinite(now)) {
    return null;
  }
  return ((now - past) / past) * 100;
}

function changeOverHours(candles, hours, currentPrice) {
  const closes = closedCloses(candles);
  const bars = Math.max(1, Math.round(Number(hours) * 4));
  if (!closes.length) return null;
  return changeAtClosedEnd(closes, bars, closes.length - 1, currentPrice);
}

async function mapPool(items, concurrency, mapper) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return [];
  const limit = Math.max(1, Math.min(concurrency || 5, list.length));
  const results = new Array(list.length);
  let cursor = 0;
  async function worker() {
    while (cursor < list.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(list[index], index);
    }
  }
  await Promise.all(Array.from({ length: limit }, () => worker()));
  return results;
}

async function loadHourScores(symbols, tickers) {
  const scores = new Map();
  const list = [...new Set((symbols || []).filter(Boolean))];
  await mapPool(list, CONFIG.NOTES_RANK_SNAP_CONCURRENCY, async (symbol) => {
    const key = String(symbol).toUpperCase();
    try {
      const candles = await fetchKlines(
        key,
        '15m',
        CONFIG.NOTES_RANK_KLINE_LIMIT,
      );
      const price = Number(tickers && tickers[key] && tickers[key].price);
      scores.set(key, {
        change1h: changeOverHours(candles, 1, price),
        change2h: changeOverHours(candles, 2, price),
      });
    } catch (error) {
      console.warn(
        `notes-rank hour score failed ${key}`,
        error && error.message ? error.message : error,
      );
      scores.set(key, { change1h: null, change2h: null });
    }
  });
  return scores;
}

function notesRankValueField(key) {
  return key === 'noteAt' ? 'nameAt' : key;
}

function compareNotesRankByKey(a, b, key) {
  const field = notesRankValueField(key);
  const va = Number.isFinite(a[field]) ? a[field] : -Infinity;
  const vb = Number.isFinite(b[field]) ? b[field] : -Infinity;
  if (vb !== va) return vb - va;
  return (Number(b.nameAt) || 0) - (Number(a.nameAt) || 0);
}

function notesRankTopSymbolSet(rows, key, limit) {
  const field = notesRankValueField(key);
  const ranked = (rows || [])
    .slice()
    .filter((row) => Number.isFinite(row[field]))
    .sort((a, b) => compareNotesRankByKey(a, b, key));
  const set = new Set();
  for (const row of ranked) {
    if (set.size >= limit) break;
    set.add(row.symbol);
  }
  return set;
}

function sortNotesRankRows(rows, prefs) {
  const source = rows || [];
  const keys = uniqueNotesRankSortKeys(prefs && prefs.keys);
  let primary = normalizeNotesRankSortKey(prefs && prefs.last);
  if (!keys.includes(primary)) primary = keys[keys.length - 1];
  const topSets = keys.map((key) =>
    notesRankTopSymbolSet(source, key, CONFIG.NOTES_RANK_KLINE_TOP),
  );
  const decorated = source.map((row) => {
    let hitCount = 0;
    for (const set of topSets) {
      if (set.has(row.symbol)) hitCount += 1;
    }
    return { ...row, hitCount };
  });
  return decorated.sort((a, b) => {
    const hit = (Number(b.hitCount) || 0) - (Number(a.hitCount) || 0);
    if (hit) return hit;
    return compareNotesRankByKey(a, b, primary);
  });
}

async function buildRankedSymbols(universe, pins, notes, tickers, prefs) {
  const pinsBySymbol = pinMapFromList(pins);
  const keys = uniqueNotesRankSortKeys(prefs && prefs.keys);
  const needHours = keys.some((key) => key === 'change1h' || key === 'change2h');
  const hourScores = needHours
    ? await loadHourScores(universe, tickers)
    : new Map();

  const rows = (universe || []).map((symbol) => {
    const key = String(symbol || '')
      .trim()
      .toUpperCase();
    const ticker = (tickers && tickers[key]) || {};
    const change24h = Number(ticker.change24h);
    const hour = hourScores.get(key) || {};
    const note = latestNoteForSymbol(notes, key);
    const pin = pinsBySymbol.get(key);
    const noteAt = Number(note && note.at) || 0;
    const pinAt = Number(pin && pin.pinnedAt) || 0;
    return {
      symbol: key,
      change24h: Number.isFinite(change24h) ? change24h : null,
      change1h: Number.isFinite(hour.change1h) ? hour.change1h : null,
      change2h: Number.isFinite(hour.change2h) ? hour.change2h : null,
      gain: notesRankGain(key, pinsBySymbol, notes, tickers),
      nameAt: noteAt || pinAt,
    };
  });
  return sortNotesRankRows(rows, prefs)
    .map((row) => row.symbol)
    .filter(Boolean);
}

/**
 * @param {object} options
 * @param {Array} options.pins
 * @param {Array} [options.notes] mom notes (optional; loaded if omitted)
 * @param {object} options.tickers binance ticker map
 * @param {number} options.now
 * @param {function} options.appendActionLog async (entries, message) => void
 */
async function runNotesRankSnap(options) {
  if (!CONFIG.NOTES_RANK_SNAP_ENABLED) {
    return { skipped: true, reason: 'disabled' };
  }
  const now = Number(options && options.now) || Date.now();
  const pins = Array.isArray(options && options.pins) ? options.pins : [];
  let notes = Array.isArray(options && options.notes) ? options.notes : null;
  if (!notes) {
    try {
      notes = await loadMomNotes();
    } catch (error) {
      console.warn(
        'notes-rank snap load mom notes failed',
        error && error.message ? error.message : error,
      );
      notes = [];
    }
  } else {
    notes = normalizeMomNotes(notes);
  }

  let blacklist = new Set();
  try {
    blacklist = await loadBlacklistSet();
  } catch (error) {
    console.warn(
      'notes-rank snap blacklist failed',
      error && error.message ? error.message : error,
    );
  }

  const universe = listBreakHighUniverse(pins, notes, blacklist);
  if (!universe.length) {
    return { skipped: true, reason: 'empty-universe' };
  }

  const prefs = await loadNotesRankPrefs();
  const tickers = (options && options.tickers) || {};
  const rankedSymbols = await buildRankedSymbols(
    universe,
    pins,
    notes,
    tickers,
    prefs,
  );
  if (!rankedSymbols.length) {
    return { skipped: true, reason: 'empty-ranked' };
  }

  let file = { data: null, sha: null };
  let snaps = [];
  try {
    file = await loadJson(CONFIG.NOTES_RANK_SNAPS_PATH);
    snaps = normalizeNotesRankSnaps(file.data && file.data.snaps);
  } catch (error) {
    console.warn(
      'notes-rank snap load failed',
      error && error.message ? error.message : error,
    );
  }

  const latest = snaps[0] || null;
  if (
    latest &&
    now - Number(latest.at || 0) < CONFIG.NOTES_RANK_SNAP_INTERVAL_MS - 30 * 1000
  ) {
    return {
      skipped: true,
      reason: 'interval',
      lastAt: latest.at,
      symbols: latest.symbols && latest.symbols.length,
      prefs,
    };
  }

  const curr = { at: now, symbols: rankedSymbols };
  // First snap only seeds history — do not flood 排序动态 as all "new".
  const delta = latest
    ? compareNotesRankSnaps(latest, curr)
    : { added: [], advanced: [] };

  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      if (attempt > 0) {
        file = await loadJson(CONFIG.NOTES_RANK_SNAPS_PATH);
        snaps = normalizeNotesRankSnaps(file.data && file.data.snaps);
        const again = snaps[0] || null;
        if (
          again &&
          now - Number(again.at || 0) <
            CONFIG.NOTES_RANK_SNAP_INTERVAL_MS - 30 * 1000
        ) {
          return {
            skipped: true,
            reason: 'interval-race',
            lastAt: again.at,
            prefs,
          };
        }
      }
      const nextSnaps = appendNotesRankSnap(snaps, rankedSymbols, now);
      await saveJson(
        CONFIG.NOTES_RANK_SNAPS_PATH,
        {
          snaps: nextSnaps,
          snapsUpdatedAt: now,
          updatedAt: Date.now(),
        },
        file.sha,
        `Notes-rank snap ${rankedSymbols.length}`,
      );
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
      const message = error && error.message ? error.message : String(error);
      if (!/409|conflict|sha/i.test(message)) break;
    }
  }
  if (lastError) {
    console.warn(
      'notes-rank snap save failed',
      lastError && lastError.message ? lastError.message : lastError,
    );
    return { ok: false, error: String(lastError.message || lastError), prefs };
  }

  const incoming = [];
  if (delta.added && delta.added.length) {
    incoming.push({
      at: now,
      kind: 'rank-new',
      symbols: delta.added.slice(),
    });
  }
  if (delta.advanced && delta.advanced.length) {
    incoming.push({
      at: now,
      kind: 'rank-up',
      symbols: delta.advanced.slice(),
    });
  }
  if (incoming.length && typeof options.appendActionLog === 'function') {
    try {
      await options.appendActionLog(
        incoming,
        `Notes-rank delta +${incoming.length}`,
      );
    } catch (error) {
      console.warn(
        'notes-rank action log failed',
        error && error.message ? error.message : error,
      );
    }
  }

  return {
    ok: true,
    symbols: rankedSymbols.length,
    added: (delta.added && delta.added.length) || 0,
    advanced: (delta.advanced && delta.advanced.length) || 0,
    first: !latest,
    prefs,
  };
}

module.exports = {
  CONFIG,
  runNotesRankSnap,
  compareNotesRankSnaps,
  buildRankedSymbols,
  normalizeNotesRankSnaps,
  appendNotesRankSnap,
  normalizeNotesRankPrefs,
  NOTES_RANK_PREFS_DEFAULT,
};
