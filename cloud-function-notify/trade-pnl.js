'use strict';

/**
 * 分笔仓位账（FIFO）+ 已实现盈亏片段。
 * 纯函数：不读写 GitHub；由 holdings / sell-tasks / 页面调用。
 */

const TRADE_PNL_PATH = process.env.TRADE_PNL_PATH || 'watch-trade-pnl.json';

function normalizeSymbol(raw) {
  let key = String(raw || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '');
  if (!key || key === 'USDT') return '';
  if (!key.endsWith('USDT')) key += 'USDT';
  return key;
}

function newLotId(symbol, at) {
  const ts = Number(at) || Date.now();
  return `${symbol}:${ts}:${Math.random().toString(36).slice(2, 8)}`;
}

function cloneLotsMap(raw) {
  const out = {};
  const src = raw && typeof raw === 'object' ? raw : {};
  Object.keys(src).forEach((key) => {
    const symbol = normalizeSymbol(key);
    if (!symbol) return;
    const list = Array.isArray(src[key]) ? src[key] : [];
    const lots = [];
    list.forEach((row) => {
      if (!row || typeof row !== 'object') return;
      const qty = Number(row.qty);
      const price = Number(row.price);
      if (!(qty > 0) || !(price > 0)) return;
      lots.push({
        id: String(row.id || newLotId(symbol, row.at)),
        qty,
        price,
        at: Number(row.at) || 0,
        source: String(row.source || 'manual'),
      });
    });
    lots.sort((a, b) => (a.at || 0) - (b.at || 0));
    if (lots.length) out[symbol] = lots;
  });
  return out;
}

/** 数量加权均价；无仓返回 null。 */
function lotsVwap(lots) {
  let qty = 0;
  let cost = 0;
  (Array.isArray(lots) ? lots : []).forEach((lot) => {
    const q = Number(lot && lot.qty);
    const p = Number(lot && lot.price);
    if (!(q > 0) || !(p > 0)) return;
    qty += q;
    cost += q * p;
  });
  if (!(qty > 0)) return null;
  return cost / qty;
}

function lotsTotalQty(lots) {
  return (Array.isArray(lots) ? lots : []).reduce((sum, lot) => {
    const q = Number(lot && lot.qty);
    return sum + (q > 0 ? q : 0);
  }, 0);
}

function unrealizedPnl(lots, spot) {
  const px = Number(spot);
  if (!(px > 0)) return null;
  let usdt = 0;
  let any = false;
  (Array.isArray(lots) ? lots : []).forEach((lot) => {
    const q = Number(lot && lot.qty);
    const p = Number(lot && lot.price);
    if (!(q > 0) || !(p > 0)) return;
    any = true;
    usdt += (px - p) * q;
  });
  return any ? { usdt, pct: null } : null;
}

/**
 * 从旧 entryPrices + 余额迁移出单笔 lot（仅当该币尚无 lots）。
 */
function migrateEntryLotsFromPrices(holdings) {
  const data = holdings && typeof holdings === 'object' ? holdings : {};
  const entryLots = cloneLotsMap(data.entryLots);
  const entryPrices =
    data.entryPrices && typeof data.entryPrices === 'object'
      ? data.entryPrices
      : {};
  const balances =
    data.balances && typeof data.balances === 'object' ? data.balances : {};
  Object.keys(entryPrices).forEach((key) => {
    const symbol = normalizeSymbol(key);
    if (!symbol || (entryLots[symbol] && entryLots[symbol].length)) return;
    const row = entryPrices[key];
    const price =
      row && typeof row === 'object' ? Number(row.price) : Number(row);
    if (!(price > 0)) return;
    const asset = symbol.replace(/USDT$/i, '');
    const bal = balances[asset] || {};
    const qty = (Number(bal.free) || 0) + (Number(bal.locked) || 0);
    if (!(qty > 0)) return;
    entryLots[symbol] = [
      {
        id: newLotId(
          symbol,
          row && typeof row === 'object' ? row.at : Date.now(),
        ),
        qty,
        price,
        at:
          row && typeof row === 'object' && Number(row.at) > 0
            ? Number(row.at)
            : Date.now(),
        source:
          row && typeof row === 'object' && row.source
            ? String(row.source)
            : 'migrate',
      },
    ];
  });
  return entryLots;
}

function syncEntryPriceFromLots(entryPrices, symbol, lots, at, source) {
  const next = { ...(entryPrices || {}) };
  const vwap = lotsVwap(lots);
  if (!(vwap > 0)) {
    delete next[symbol];
    return next;
  }
  next[symbol] = {
    price: vwap,
    at: Number(at) || Date.now(),
    source: String(source || 'lots-vwap'),
  };
  return next;
}

/**
 * lots 数量大于真实余额时，按 FIFO 从最旧 lot 裁掉多余量（只裁不补）。
 * 阈值：超额 > 0.5% 或超额名义 > 1 USDT。
 *
 * lot.at >= balances[asset].at 视为买入后余额未 sync 的 pending，不计入 excess、不裁。
 * 无 bal.at 时整币跳过。
 */
function reconcileLotsToBalance(entryLots, balances, entryPrices) {
  const bals = balances && typeof balances === 'object' ? balances : {};
  let prices =
    entryPrices && typeof entryPrices === 'object' ? { ...entryPrices } : {};
  const next = cloneLotsMap(entryLots);
  const EXCESS_PCT = 0.005;
  const EXCESS_NOTIONAL_USDT = 1;
  Object.keys(next).forEach((symbol) => {
    const key = normalizeSymbol(symbol);
    if (!key || key === 'USDT') return;
    const list = Array.isArray(next[symbol])
      ? next[symbol].map((lot) => ({ ...lot }))
      : [];
    const lotsQty = lotsTotalQty(list);
    if (!(lotsQty > 0)) {
      delete next[symbol];
      prices = syncEntryPriceFromLots(
        prices,
        key,
        [],
        Date.now(),
        'lots-reconcile',
      );
      return;
    }
    const asset = key.replace(/USDT$/i, '');
    const bal = bals[asset] || {};
    const balAt = Number(bal.at) || 0;
    if (!(balAt > 0)) return;
    const balanceQty = (Number(bal.free) || 0) + (Number(bal.locked) || 0);
    const aged = [];
    list.forEach((lot) => {
      const lotAt = Number(lot && lot.at) || 0;
      const q = Number(lot && lot.qty) || 0;
      if (!(q > 0)) return;
      if (lotAt >= balAt) return;
      aged.push(lot);
    });
    const agedQty = lotsTotalQty(aged);
    const excess = agedQty - Math.max(0, balanceQty);
    if (!(excess > 0)) return;
    const vwap =
      lotsVwap(list) || (prices[key] && Number(prices[key].price)) || 0;
    const excessPct = excess / Math.max(agedQty, 1e-12);
    const excessNotional = vwap > 0 ? excess * vwap : Infinity;
    if (excessPct <= EXCESS_PCT && !(excessNotional > EXCESS_NOTIONAL_USDT)) {
      return;
    }
    let remain = excess;
    const trimmedAged = [];
    for (let i = 0; i < aged.length; i += 1) {
      const lot = aged[i];
      const q = Number(lot && lot.qty) || 0;
      if (!(q > 0)) continue;
      if (!(remain > 0)) {
        trimmedAged.push(lot);
        continue;
      }
      if (q <= remain + 1e-12) {
        remain -= q;
        continue;
      }
      trimmedAged.push({ ...lot, qty: q - remain });
      remain = 0;
    }
    const pendingLots = list.filter(
      (lot) => (Number(lot && lot.at) || 0) >= balAt,
    );
    const trimmed = trimmedAged.concat(pendingLots);
    trimmed.sort((a, b) => (a.at || 0) - (b.at || 0));
    if (trimmed.length) next[symbol] = trimmed;
    else delete next[symbol];
    prices = syncEntryPriceFromLots(
      prices,
      key,
      trimmed,
      Date.now(),
      'lots-reconcile',
    );
  });
  return { entryLots: next, entryPrices: prices };
}

/**
 * @returns {{ holdings: object, lot: object }}
 */
function addBuyLot(holdings, options) {
  const opts = options || {};
  const symbol = normalizeSymbol(opts.symbol);
  const qty = Number(opts.qty);
  const price = Number(opts.price);
  const at = Number(opts.at) || Date.now();
  const source = String(opts.source || 'buy');
  if (!symbol || !(qty > 0) || !(price > 0)) {
    return { holdings, lot: null, error: 'bad-args' };
  }
  const base = holdings && typeof holdings === 'object' ? { ...holdings } : {};
  const entryLots = cloneLotsMap(base.entryLots);
  const list = Array.isArray(entryLots[symbol]) ? entryLots[symbol].slice() : [];
  const lot = {
    id: String(opts.id || newLotId(symbol, at)),
    qty,
    price,
    at,
    source,
  };
  list.push(lot);
  list.sort((a, b) => (a.at || 0) - (b.at || 0));
  entryLots[symbol] = list;
  const entryPrices = syncEntryPriceFromLots(
    base.entryPrices,
    symbol,
    list,
    at,
    source,
  );
  const symbols = Array.isArray(base.symbols) ? base.symbols.slice() : [];
  if (!symbols.includes(symbol)) symbols.push(symbol);
  const stopCancel =
    base.stopCancel && typeof base.stopCancel === 'object'
      ? { ...base.stopCancel }
      : {};
  if (stopCancel[symbol]) delete stopCancel[symbol];
  return {
    holdings: {
      ...base,
      symbols,
      entryLots,
      entryPrices,
      stopCancel,
      updatedAt: at,
    },
    lot,
    error: null,
  };
}

/**
 * FIFO 卖出：扣减最旧 lot，产出已实现片段。
 * fee 按卖出数量比例摊到各片段。
 * @returns {{ holdings, realizedEntries, vwap }}
 */
function consumeSellFifo(holdings, options) {
  const opts = options || {};
  const symbol = normalizeSymbol(opts.symbol);
  let remain = Number(opts.qty);
  const sellPrice = Number(opts.sellPrice);
  const feeTotal = Number(opts.fee) || 0;
  const at = Number(opts.at) || Date.now();
  const source = String(opts.source || 'sell');
  if (!symbol || !(remain > 0) || !(sellPrice > 0)) {
    return {
      holdings,
      realizedEntries: [],
      vwap: null,
      error: 'bad-args',
    };
  }
  const base = holdings && typeof holdings === 'object' ? { ...holdings } : {};
  const entryLots = cloneLotsMap(base.entryLots);
  let list = Array.isArray(entryLots[symbol]) ? entryLots[symbol].slice() : [];
  // 无 lots 时用 entryPrices 合成一笔，避免漏记
  if (!list.length) {
    const row =
      base.entryPrices && typeof base.entryPrices === 'object'
        ? base.entryPrices[symbol]
        : null;
    const price = row && Number(row.price);
    if (price > 0) {
      list = [
        {
          id: newLotId(symbol, row.at || at),
          qty: remain,
          price,
          at: Number(row.at) || at,
          source: String((row && row.source) || 'entry'),
        },
      ];
    }
  }
  const sellQtyTotal = remain;
  const realizedEntries = [];
  const nextLots = [];
  for (let i = 0; i < list.length; i += 1) {
    const lot = list[i];
    if (!(remain > 0)) {
      nextLots.push(lot);
      continue;
    }
    const lotQty = Number(lot.qty);
    if (!(lotQty > 0)) continue;
    const take = Math.min(lotQty, remain);
    const feeSlice =
      sellQtyTotal > 0 ? (feeTotal * take) / sellQtyTotal : 0;
    const pnl = (sellPrice - lot.price) * take - feeSlice;
    realizedEntries.push({
      id: `${symbol}:${at}:${lot.id}:${Math.random().toString(36).slice(2, 6)}`,
      symbol,
      label: symbol.replace(/USDT$/i, ''),
      side: 'sell',
      quantity: take,
      buyPrice: lot.price,
      sellPrice,
      fee: feeSlice,
      pnl,
      at,
      source,
      lotId: lot.id,
    });
    remain -= take;
    const left = lotQty - take;
    if (left > 1e-12) {
      nextLots.push({ ...lot, qty: left });
    }
  }
  if (nextLots.length) entryLots[symbol] = nextLots;
  else delete entryLots[symbol];
  const entryPrices = syncEntryPriceFromLots(
    base.entryPrices,
    symbol,
    nextLots,
    at,
    'lots-vwap',
  );
  return {
    holdings: {
      ...base,
      entryLots,
      entryPrices,
      updatedAt: at,
    },
    realizedEntries,
    vwap: lotsVwap(nextLots),
    error: null,
  };
}

/** 手填成本：该币收成单笔 lot（覆盖）。 */
function replaceLotsWithSingle(holdings, options) {
  const opts = options || {};
  const symbol = normalizeSymbol(opts.symbol);
  const price = Number(opts.price);
  const at = Number(opts.at) || Date.now();
  const source = String(opts.source || 'manual');
  if (!symbol || !(price > 0)) {
    return { holdings, error: 'bad-args' };
  }
  const base = holdings && typeof holdings === 'object' ? { ...holdings } : {};
  const entryLots = cloneLotsMap(base.entryLots);
  const asset = symbol.replace(/USDT$/i, '');
  const bal =
    base.balances && typeof base.balances === 'object'
      ? base.balances[asset]
      : null;
  let qty = Number(opts.qty);
  if (!(qty > 0)) {
    qty =
      (Number(bal && bal.free) || 0) + (Number(bal && bal.locked) || 0);
  }
  if (!(qty > 0)) {
    // 无余额也允许先记成本：用 1 作为占位不合适；保留 0 则清 lots
    delete entryLots[symbol];
    const entryPrices = { ...(base.entryPrices || {}) };
    entryPrices[symbol] = { price, at, source };
    const stopCancel = { ...(base.stopCancel || {}) };
    if (stopCancel[symbol]) delete stopCancel[symbol];
    return {
      holdings: {
        ...base,
        entryLots,
        entryPrices,
        stopCancel,
        updatedAt: at,
      },
      error: null,
    };
  }
  entryLots[symbol] = [
    {
      id: newLotId(symbol, at),
      qty,
      price,
      at,
      source,
    },
  ];
  const entryPrices = syncEntryPriceFromLots(
    base.entryPrices,
    symbol,
    entryLots[symbol],
    at,
    source,
  );
  const stopCancel = { ...(base.stopCancel || {}) };
  if (stopCancel[symbol]) delete stopCancel[symbol];
  const symbols = Array.isArray(base.symbols) ? base.symbols.slice() : [];
  if (!symbols.includes(symbol)) symbols.push(symbol);
  return {
    holdings: {
      ...base,
      symbols,
      entryLots,
      entryPrices,
      stopCancel,
      updatedAt: at,
    },
    error: null,
  };
}

function clearSymbolLots(holdings, symbol) {
  const key = normalizeSymbol(symbol);
  if (!key) return holdings;
  const base = holdings && typeof holdings === 'object' ? { ...holdings } : {};
  const entryLots = cloneLotsMap(base.entryLots);
  delete entryLots[key];
  const entryPrices = { ...(base.entryPrices || {}) };
  delete entryPrices[key];
  return { ...base, entryLots, entryPrices };
}

function normalizeRealizedRow(row) {
  if (!row || typeof row !== 'object') return null;
  const symbol = normalizeSymbol(row.symbol);
  if (!symbol) return null;
  const pnl = Number(row.pnl);
  if (!Number.isFinite(pnl)) return null;
  const at = Number(row.at) || 0;
  const id = String(row.id || `${symbol}:${at}:${pnl}`);
  return {
    id,
    symbol,
    label: String(row.label || symbol.replace(/USDT$/i, '')),
    side: String(row.side || 'sell'),
    quantity: Number(row.quantity) || 0,
    buyPrice: Number(row.buyPrice) || 0,
    sellPrice: Number(row.sellPrice) || 0,
    fee: Number(row.fee) || 0,
    pnl,
    at,
    source: String(row.source || 'manual'),
    ...(row.lotId ? { lotId: String(row.lotId) } : {}),
  };
}

function normalizeTradePnlState(raw) {
  const data = raw && typeof raw === 'object' ? raw : {};
  const seen = new Set();
  const entries = [];
  (Array.isArray(data.entries) ? data.entries : []).forEach((row) => {
    const next = normalizeRealizedRow(row);
    if (!next || seen.has(next.id)) return;
    seen.add(next.id);
    entries.push(next);
  });
  entries.sort((a, b) => b.at - a.at);
  // holdings 已扣、流水未落时暂存，供重试 / 审计（不自动入 entries）
  const pending = [];
  const pendingSeen = new Set();
  (Array.isArray(data.pending) ? data.pending : []).forEach((row) => {
    const next = normalizeRealizedRow(row);
    if (!next || pendingSeen.has(next.id) || seen.has(next.id)) return;
    pendingSeen.add(next.id);
    pending.push({
      ...next,
      pendingAt: Number(row.pendingAt) || next.at || Date.now(),
      pendingReason: String(row.pendingReason || 'pnl-save-failed'),
    });
  });
  pending.sort((a, b) => b.pendingAt - a.pendingAt);
  return {
    entries,
    pending,
    updatedAt: Number(data.updatedAt) || 0,
  };
}

module.exports = {
  TRADE_PNL_PATH,
  normalizeSymbol,
  newLotId,
  cloneLotsMap,
  lotsVwap,
  lotsTotalQty,
  unrealizedPnl,
  migrateEntryLotsFromPrices,
  syncEntryPriceFromLots,
  reconcileLotsToBalance,
  addBuyLot,
  consumeSellFifo,
  replaceLotsWithSingle,
  clearSymbolLots,
  normalizeTradePnlState,
};
