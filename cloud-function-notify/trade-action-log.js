'use strict';

const { loadJson, saveJson } = require('./github-wecom');

const ACTION_LOG_PATH = process.env.ACTION_LOG_PATH || 'watch-action-log.json';
const ACTION_LOG_MAX = Number(process.env.ACTION_LOG_MAX || 10000);
const ACTION_LOG_TTL_MS = Number(
  process.env.ACTION_LOG_TTL_MS || 7 * 24 * 60 * 60 * 1000,
);

function normalizeEntry(item) {
  if (!item || typeof item !== 'object') return null;
  const kind = String(item.kind || '').trim();
  const symbols = [
    ...new Set(
      (Array.isArray(item.symbols) ? item.symbols : [])
        .map((symbol) => String(symbol || '').trim().toUpperCase())
        .filter(Boolean),
    ),
  ].sort();
  if (!kind || !symbols.length) return null;
  const entry = { at: Number(item.at) || Date.now(), kind, symbols };
  const price = Number(item.price);
  if (Number.isFinite(price) && price > 0) entry.price = price;
  const qty = Number(item.qty);
  if (Number.isFinite(qty) && qty > 0) entry.qty = qty;
  return entry;
}

function entryKey(entry) {
  const symbols = (Array.isArray(entry && entry.symbols) ? entry.symbols : [])
    .map((symbol) => String(symbol || '').trim().toUpperCase())
    .filter(Boolean)
    .sort();
  const kind = String((entry && entry.kind) || '').trim();
  if (!kind || !symbols.length) return '';
  const price =
    Number.isFinite(entry.price) && entry.price > 0 ? String(entry.price) : '';
  return `${Number(entry.at) || 0}|${kind}|${symbols.join(',')}|${price}`;
}

async function appendTradeActionLog(kind, symbol, price, qty) {
  const incoming = normalizeEntry({
    at: Date.now(),
    kind,
    symbols: [symbol],
    price,
    qty,
  });
  if (!incoming) return;
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const file = await loadJson(ACTION_LOG_PATH);
      const prev = Array.isArray(file.data && file.data.entries)
        ? file.data.entries
        : [];
      const seen = new Set();
      const entries = [];
      const now = Date.now();
      for (const item of [incoming, ...prev]) {
        const entry = normalizeEntry(item);
        if (!entry) continue;
        if (now - (Number(entry.at) || 0) > ACTION_LOG_TTL_MS) continue;
        const key = entryKey(entry);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        entries.push(entry);
      }
      const kept = entries.slice(0, ACTION_LOG_MAX);
      await saveJson(
        ACTION_LOG_PATH,
        { entries: kept, updatedAt: Date.now() },
        file.sha,
        `Spot ${kind} ${String(symbol).replace(/USDT$/i, '')}`,
      );
      return;
    } catch (error) {
      lastError = error;
      const message = error && error.message ? error.message : String(error);
      if (!/409|conflict|sha/i.test(message)) break;
    }
  }
  console.warn(
    'appendTradeActionLog failed',
    lastError && lastError.message ? lastError.message : lastError,
  );
}

module.exports = {
  appendTradeActionLog,
};
