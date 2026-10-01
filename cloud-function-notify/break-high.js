'use strict';

/**
 * Cloud break-high (破点高): pin/note baselines, 10-min gate, WeCom list + charts.
 * Mirrors kline.html logic; state lives in watch-break-high.json.
 */

const { loadJson, saveJson } = require('./github-wecom');

const CONFIG = {
  BREAK_HIGH_PATH: process.env.BREAK_HIGH_PATH || 'watch-break-high.json',
  MOM_NOTES_PATH: process.env.MOM_NOTES_PATH || 'watch-mom-notes.json',
  BREAK_HIGH_COOLDOWN_MS: Number(
    process.env.BREAK_HIGH_COOLDOWN_MS || 10 * 60 * 1000,
  ),
  BREAK_HIGH_CHART_MAX: Number(process.env.BREAK_HIGH_CHART_MAX || 12),
};

function labelOf(symbol) {
  return String(symbol || '').replace(/USDT$/i, '');
}

function emptyBreakHigh() {
  return { bases: {}, lastCheckAt: 0, hits: [] };
}

function normalizeBreakHighBase(item) {
  if (!item || typeof item !== 'object') return null;
  const base = Number(item.base);
  if (!Number.isFinite(base) || base <= 0) return null;
  return {
    base,
    at: Number(item.at) || 0,
    noteAt: Number(item.noteAt) || 0,
    pinAt: Number(item.pinAt) || 0,
  };
}

function normalizeBreakHighHit(item) {
  if (!item || typeof item !== 'object') return null;
  const symbol = String(item.symbol || '')
    .trim()
    .toUpperCase();
  if (!symbol) return null;
  const base = Number(item.base);
  const price = Number(item.price);
  if (!Number.isFinite(base) || base <= 0) return null;
  if (!Number.isFinite(price) || price <= 0) return null;
  return {
    symbol,
    label: item.label ? String(item.label) : labelOf(symbol),
    base,
    price,
    at: Number(item.at) || 0,
    source: item.source ? String(item.source) : null,
  };
}

function normalizeBreakHigh(raw) {
  const empty = emptyBreakHigh();
  if (!raw || typeof raw !== 'object') return empty;
  const bases = {};
  const rawBases =
    raw.bases && typeof raw.bases === 'object' && !Array.isArray(raw.bases)
      ? raw.bases
      : {};
  for (const [key, value] of Object.entries(rawBases)) {
    const symbol = String(key || '')
      .trim()
      .toUpperCase();
    const normalized = normalizeBreakHighBase(value);
    if (!symbol || !normalized) continue;
    bases[symbol] = normalized;
  }
  const hits = Array.isArray(raw.hits)
    ? raw.hits.map(normalizeBreakHighHit).filter(Boolean)
    : [];
  return {
    bases,
    lastCheckAt: Number(raw.lastCheckAt) || 0,
    hits,
  };
}

function normalizeMomNotes(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const symbol = String(item.symbol || '')
        .trim()
        .toUpperCase();
      if (!symbol) return null;
      const price = Number(item.price);
      return {
        symbol,
        at: Number(item.at) || 0,
        price: Number.isFinite(price) && price > 0 ? price : null,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.at - a.at);
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

function listBreakHighUniverse(pins, notes, blacklist) {
  const blocked = blacklist instanceof Set ? blacklist : new Set();
  const set = new Set();
  for (const item of pins || []) {
    const symbol = item && item.symbol;
    if (symbol && !blocked.has(symbol)) set.add(symbol);
  }
  for (const note of notes || []) {
    const symbol = note && note.symbol;
    if (symbol && !blocked.has(symbol)) set.add(symbol);
  }
  return [...set];
}

function naturalBreakBase(symbol, pinsBySymbol, notes) {
  const note = latestNoteForSymbol(notes, symbol);
  if (note && Number.isFinite(note.price) && note.price > 0) {
    return {
      base: note.price,
      noteAt: Number(note.at) || 0,
      pinAt: 0,
      source: 'note',
    };
  }
  const pin = pinsBySymbol.get(String(symbol).toUpperCase());
  const pinPrice = Number(pin && pin.pinPrice);
  if (pin && Number.isFinite(pinPrice) && pinPrice > 0) {
    return {
      base: pinPrice,
      noteAt: 0,
      pinAt: Number(pin.pinnedAt) || 0,
      source: 'pin',
    };
  }
  return null;
}

function resolveBreakBase(symbol, stored, pinsBySymbol, notes) {
  const natural = naturalBreakBase(symbol, pinsBySymbol, notes);
  if (!natural) return null;
  if (!stored || !Number.isFinite(Number(stored.base))) return natural;
  if (natural.noteAt > (Number(stored.noteAt) || 0)) return natural;
  if (!natural.noteAt && natural.pinAt > (Number(stored.pinAt) || 0)) {
    return natural;
  }
  return {
    base: Number(stored.base),
    noteAt: Number(stored.noteAt) || natural.noteAt || 0,
    pinAt: Number(stored.pinAt) || natural.pinAt || 0,
    source: 'stored',
  };
}

function formatPrice(value) {
  if (!Number.isFinite(value)) return '--';
  if (value >= 1000) return value.toFixed(2);
  if (value >= 1) return value.toFixed(4);
  if (value >= 0.01) return value.toFixed(5);
  return Number(value).toPrecision(4);
}

function formatPercent(value) {
  if (!Number.isFinite(value)) return '--';
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`;
}

function buildBreakHighReport(hits, now) {
  const time = new Date(now).toLocaleTimeString('zh-CN', { hour12: false });
  if (!hits.length) {
    return `【破点高】${time}\n无符合条件`;
  }
  const lines = [`【破点高】${time} · ${hits.length}`, ''];
  hits.forEach((hit) => {
    const pct =
      Number.isFinite(hit.base) && hit.base > 0
        ? ((hit.price - hit.base) / hit.base) * 100
        : null;
    lines.push(
      `<font color="info">${labelOf(hit.symbol)}</font> ${formatPercent(pct)}`,
    );
    lines.push(`${formatPrice(hit.base)} → ${formatPrice(hit.price)}`);
    lines.push('<font color="comment">----------</font>');
    lines.push('');
  });
  return lines.join('\n').trimEnd();
}

/**
 * Run break-high check if cooldown elapsed.
 */
async function evaluateBreakHigh(options) {
  const pins = options.pins || [];
  const notes = options.notes || [];
  const tickers = options.tickers || {};
  const blacklist = options.blacklist || new Set();
  const force = !!options.force;
  const now = Number(options.now) || Date.now();

  const file = await loadJson(CONFIG.BREAK_HIGH_PATH);
  const prev = normalizeBreakHigh(file.data);
  const last = Number(prev.lastCheckAt) || 0;
  if (!force && last > 0 && now - last < CONFIG.BREAK_HIGH_COOLDOWN_MS) {
    return {
      skipped: true,
      hits: prev.hits || [],
      text: null,
      chartRows: [],
      state: prev,
      sha: file.sha,
    };
  }

  const pinsBySymbol = pinMapFromList(pins);
  const universe = listBreakHighUniverse(pins, notes, blacklist);
  const nextBases = { ...(prev.bases || {}) };
  const hits = [];
  let priced = 0;

  for (const symbol of universe) {
    const ticker = tickers[symbol] || {};
    const current = Number(ticker.price);
    if (!Number.isFinite(current) || current <= 0) continue;
    priced += 1;
    const resolved = resolveBreakBase(
      symbol,
      nextBases[symbol],
      pinsBySymbol,
      notes,
    );
    if (!resolved || !Number.isFinite(resolved.base) || resolved.base <= 0) {
      continue;
    }
    const base = resolved.base;
    if (current > base) {
      hits.push({
        symbol,
        label: labelOf(symbol),
        base,
        price: current,
        at: now,
        source: resolved.source,
      });
      nextBases[symbol] = {
        base: current,
        at: now,
        noteAt: resolved.noteAt || 0,
        pinAt: resolved.pinAt || 0,
      };
    } else if (!nextBases[symbol]) {
      nextBases[symbol] = {
        base,
        at: now,
        noteAt: resolved.noteAt || 0,
        pinAt: resolved.pinAt || 0,
      };
    }
  }

  if (!priced && universe.length) {
    return {
      skipped: true,
      hits: prev.hits || [],
      text: null,
      chartRows: [],
      state: prev,
      sha: file.sha,
    };
  }

  const keep = new Set(universe);
  for (const key of Object.keys(nextBases)) {
    if (!keep.has(key)) delete nextBases[key];
  }

  const state = {
    bases: nextBases,
    lastCheckAt: now,
    hits,
  };
  const text = buildBreakHighReport(hits, now);
  const chartRows = hits.map((hit) => ({
    symbol: hit.symbol,
    pinPrice: hit.base,
    current: hit.price,
    change:
      Number.isFinite(hit.base) && hit.base > 0
        ? ((hit.price - hit.base) / hit.base) * 100
        : null,
    change24h: Number((tickers[hit.symbol] || {}).change24h),
    streak5: false,
    heat15: false,
    priceUpVsLast: true,
  }));

  return {
    skipped: false,
    hits,
    text,
    chartRows,
    state,
    sha: file.sha,
  };
}

async function persistBreakHigh(state, sha, message) {
  const next = {
    ...normalizeBreakHigh(state),
    updatedAt: Date.now(),
  };
  await saveJson(
    CONFIG.BREAK_HIGH_PATH,
    next,
    sha,
    message || 'Update break-high',
  );
  return next;
}

async function loadMomNotes() {
  const file = await loadJson(CONFIG.MOM_NOTES_PATH);
  return normalizeMomNotes(file.data && file.data.notes);
}

module.exports = {
  CONFIG,
  emptyBreakHigh,
  normalizeBreakHigh,
  normalizeMomNotes,
  listBreakHighUniverse,
  evaluateBreakHigh,
  persistBreakHigh,
  loadMomNotes,
  buildBreakHighReport,
};
