'use strict';

/**
 * Shared mom-notes helpers for notes-rank (and similar).
 * Extracted from the removed break-high module.
 */

const { loadJson } = require('./github-wecom');

const MOM_NOTES_PATH = process.env.MOM_NOTES_PATH || 'watch-mom-notes.json';

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

async function loadMomNotes() {
  const file = await loadJson(MOM_NOTES_PATH);
  return normalizeMomNotes(file.data && file.data.notes);
}

/** Pins ∪ mom-notes symbols, minus blacklist. */
function listNotesPinUniverse(pins, notes, blacklist) {
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

module.exports = {
  normalizeMomNotes,
  loadMomNotes,
  listNotesPinUniverse,
  /** @deprecated alias kept for call sites that used break-high name */
  listBreakHighUniverse: listNotesPinUniverse,
};
