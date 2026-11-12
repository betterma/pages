'use strict';

const {
  loadJson,
  saveJson,
  fetchBinanceTickers,
  sendWecomText,
  sendWecomImage,
  sendPushPlus,
} = require('./github-wecom');
const { buildTopChartsCollage, fetchKlines } = require('./kline-chart');
const { runAutoPin, savePinsFile, normalizePinList } = require('./auto-pin');
const {
  evaluateBreakHigh,
  persistBreakHigh,
  loadMomNotes,
  listBreakHighUniverse,
} = require('./break-high');

let runNotesRankSnap = async () => ({
  skipped: true,
  reason: 'module-missing',
});
try {
  // 必须与 notes-rank-snap.js 整包上传；缺文件时不拖垮自动盯。
  runNotesRankSnap = require('./notes-rank-snap').runNotesRankSnap;
} catch (error) {
  console.warn(
    'notes-rank-snap module missing — 请整包上传 cloud-function-notify',
    error && error.message ? error.message : error,
  );
}

let runNailGreenAlerts = async () => ({
  skipped: true,
  reason: 'module-missing',
});
try {
  runNailGreenAlerts = require('./nail-green-alert').runNailGreenAlerts;
} catch (error) {
  console.warn(
    'nail-green-alert module missing — 请整包上传 cloud-function-notify',
    error && error.message ? error.message : error,
  );
}

let runBalanceAlerts = async () => ({
  skipped: true,
  reason: 'module-missing',
});
try {
  runBalanceAlerts = require('./balance-alert').runBalanceAlerts;
} catch (error) {
  console.warn(
    'balance-alert module missing — 请整包上传 cloud-function-notify',
    error && error.message ? error.message : error,
  );
}

let pruneStaleAutoPinNails = async () => ({
  skipped: true,
  reason: 'module-missing',
  removed: [],
});
try {
  pruneStaleAutoPinNails =
    require('./prune-stale-auto-pin-nails').pruneStaleAutoPinNails;
} catch (error) {
  console.warn(
    'prune-stale-auto-pin-nails module missing — 请整包上传 cloud-function-notify',
    error && error.message ? error.message : error,
  );
}

let runNailDailyReset = async () => ({
  skipped: true,
  reason: 'module-missing',
});
try {
  runNailDailyReset = require('./nail-daily-reset').runNailDailyReset;
} catch (error) {
  console.warn(
    'nail-daily-reset module missing — 请整包上传 cloud-function-notify',
    error && error.message ? error.message : error,
  );
}

let runHoldingsSync = async () => ({
  skipped: true,
  reason: 'module-missing',
});
try {
  runHoldingsSync = require('./holdings').runHoldingsSync;
} catch (error) {
  console.warn(
    'holdings module missing — 请整包上传 cloud-function-notify',
    error && error.message ? error.message : error,
  );
}

let runSellTasks = async () => ({
  skipped: true,
  reason: 'module-missing',
});
try {
  runSellTasks = require('./sell-tasks').runSellTasks;
} catch (error) {
  console.warn(
    'sell-tasks module missing — 请整包上传 cloud-function-notify',
    error && error.message ? error.message : error,
  );
}

let runBuyTasks = async () => ({
  skipped: true,
  reason: 'module-missing',
});
try {
  runBuyTasks = require('./buy-tasks').runBuyTasks;
} catch (error) {
  console.warn(
    'buy-tasks module missing — 请整包上传 cloud-function-notify',
    error && error.message ? error.message : error,
  );
}

function webhookKeyHint(url) {
  try {
    const key = new URL(String(url || '')).searchParams.get('key') || '';
    if (!key) return 'no-key';
    return `${key.slice(0, 4)}…${key.slice(-4)}`;
  } catch (error) {
    return 'invalid-url';
  }
}

function resolveWebhooks() {
  const legacy = String(process.env.WECOM_WEBHOOK_URL || '').trim();
  const pins = String(process.env.WECOM_WEBHOOK_PINS || '').trim();
  const positions = String(process.env.WECOM_WEBHOOK_POSITIONS || '').trim();

  // Explicit vars win. Legacy URL is only used when the specific var is empty.
  const pinsUrl = pins || legacy;
  const positionsUrl = positions || legacy;

  return {
    pinsUrl,
    positionsUrl,
    legacyUsedForPins: !pins && !!legacy,
    legacyUsedForPositions: !positions && !!legacy,
    sameTarget: !!(pinsUrl && positionsUrl && pinsUrl === positionsUrl),
  };
}

const WEBHOOKS = resolveWebhooks();

const CONFIG = {
  PINS_PATH: process.env.PINS_PATH || 'watch-pins.json',
  POSITIONS_PATH: process.env.POSITIONS_PATH || 'watch-positions.json',
  NOTIFY_STATE_PATH: process.env.NOTIFY_STATE_PATH || 'watch-notify-state.json',
  /** 定时检测心跳 / 进度（网页通知页健康度入口只读这份）。 */
  NOTIFY_HEALTH_PATH:
    process.env.NOTIFY_HEALTH_PATH || 'watch-notify-health.json',
  ACTION_LOG_PATH: process.env.ACTION_LOG_PATH || 'watch-action-log.json',
  ACTION_LOG_MAX: Number(process.env.ACTION_LOG_MAX || 10000),
  ACTION_LOG_TTL_MS: Number(
    process.env.ACTION_LOG_TTL_MS || 7 * 24 * 60 * 60 * 1000,
  ),
  ACTION_LOG_RANK_TTL_MS: Number(
    process.env.ACTION_LOG_RANK_TTL_MS || 24 * 60 * 60 * 1000,
  ),
  MOM_NOTES_PATH: process.env.MOM_NOTES_PATH || 'watch-mom-notes.json',
  MOM_NOTES_MAX: Number(process.env.MOM_NOTES_MAX || 200),
  NAILS_PATH: process.env.NAILS_PATH || 'watch-nails.json',
  PRICE_ALERTS_PATH: process.env.PRICE_ALERTS_PATH || 'watch-price-alerts.json',
  PRICE_ALERT_SEND_MAX: Number(process.env.PRICE_ALERT_SEND_MAX || 10),
  PRICE_ALERT_SEND_GAP_MS: Number(
    process.env.PRICE_ALERT_SEND_GAP_MS || 60 * 1000,
  ),
  // 仅页面提醒：默认关闭企微/微信推送，只落盘 hitAt 给网页用。
  // 想恢复推送：云函数环境变量 PRICE_ALERTS_PUSH=true。
  PRICE_ALERTS_PUSH: String(process.env.PRICE_ALERTS_PUSH || '').toLowerCase() === 'true',
  WECOM_WEBHOOK_PINS: WEBHOOKS.pinsUrl,
  WECOM_WEBHOOK_POSITIONS: WEBHOOKS.positionsUrl,
  DROP_THRESHOLD: Number(process.env.DROP_THRESHOLD || 0.05),
  DROP_COOLDOWN_MS: Number(
    process.env.DROP_COOLDOWN_MS || 2 * 60 * 60 * 1000,
  ),
  // Cap WeCom pin text list (sorted by pin-change). Keeps markdown ~1–2 msgs.
  PIN_NOTIFY_MAX: Number(process.env.PIN_NOTIFY_MAX || 20),
  // 0 = follow PIN_CHART_MAX; set e.g. 3 to only take top N charts.
  PIN_CHART_TOP: Number(
    process.env.PIN_CHART_TOP === undefined || process.env.PIN_CHART_TOP === ''
      ? 0
      : process.env.PIN_CHART_TOP,
  ),
  // Collage hard cap (phone-readable; also bounds Binance kline fan-out).
  PIN_CHART_MAX: Number(process.env.PIN_CHART_MAX || 12),
  // Align pin notify with kline.html: require current K-line window gain (default 4h).
  PIN_WINDOW_INTERVAL: process.env.PIN_WINDOW_INTERVAL || '4h',
  // Skip duplicate runs if another invoke already sent within this window.
  NOTIFY_DEBOUNCE_MS: Number(process.env.NOTIFY_DEBOUNCE_MS || 90 * 1000),
  // Parallel symbol fetches for 5m/15m momentum (each symbol = 2 kline calls).
  MOMENTUM_CONCURRENCY: Number(process.env.MOMENTUM_CONCURRENCY || 5),
  PUSHPLUS_TOKEN: String(process.env.PUSHPLUS_TOKEN || '').trim(),
  // 新自动盯默认不再推送；天平命中才发企微（见 balance-alert）。
  AUTO_PIN_PUSHPLUS:
    String(process.env.AUTO_PIN_PUSHPLUS === undefined ? '0' : process.env.AUTO_PIN_PUSHPLUS) !==
    '0',
  AUTO_PIN_WECOM:
    String(process.env.AUTO_PIN_WECOM === undefined ? '0' : process.env.AUTO_PIN_WECOM) !==
    '0',
};

function labelOf(symbol) {
  return String(symbol || '').replace(/USDT$/i, '');
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

function changeFrom(base, current) {
  if (!Number.isFinite(base) || !Number.isFinite(current) || base === 0) {
    return null;
  }
  return ((current - base) / base) * 100;
}

function normalizePins(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      if (!item || !item.symbol) return null;
      const symbol = String(item.symbol).trim().toUpperCase();
      const pinPrice = Number(item.pinPrice);
      const pinnedAt = Number(item.pinnedAt) || 0;
      if (!symbol) return null;
      return {
        symbol,
        pinPrice: Number.isFinite(pinPrice) ? pinPrice : null,
        pinnedAt,
        expiresAt: Number(item.expiresAt) || 0,
      };
    })
    .filter(Boolean);
}

function normalizePositions(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      if (!item || !item.symbol) return null;
      const symbol = String(item.symbol).trim().toUpperCase();
      const buyPrice = Number(item.buyPrice);
      if (!symbol || !Number.isFinite(buyPrice) || buyPrice <= 0) return null;
      return {
        symbol,
        buyPrice,
        boughtAt: Number(item.boughtAt) || 0,
      };
    })
    .filter(Boolean);
}

function listPinCandidateRows(pins, tickers) {
  return pins
    .map((item) => {
      const ticker = tickers[item.symbol] || {};
      const current = ticker.price;
      const change = changeFrom(item.pinPrice, current);
      return {
        ...item,
        current,
        change,
        change24h: ticker.change24h,
        streak5: false,
        heat15: false,
        windowChange: null,
        windowUp: false,
      };
    })
    .filter(
      (row) =>
        Number.isFinite(row.current) && Number.isFinite(row.pinPrice),
    )
    .sort((a, b) => {
      const upA = Number.isFinite(a.change) && a.change > 0 ? 1 : 0;
      const upB = Number.isFinite(b.change) && b.change > 0 ? 1 : 0;
      if (upA !== upB) return upB - upA;
      if (
        Number.isFinite(a.change) &&
        Number.isFinite(b.change) &&
        b.change !== a.change
      ) {
        return b.change - a.change;
      }
      return b.pinnedAt - a.pinnedAt;
    });
}

/** @deprecated use listPinCandidateRows + window filter */
function listPinUpRows(pins, tickers) {
  return listPinCandidateRows(pins, tickers).filter(
    (row) => Number.isFinite(row.change) && row.change > 0,
  );
}

/**
 * Same idea as kline.html hasWindowGain for 4h:
 * current price vs open of the forming window candle.
 */
async function attachPinWindowGain(rows) {
  if (!rows.length) return rows;
  const interval = CONFIG.PIN_WINDOW_INTERVAL || '4h';
  await mapPool(rows, CONFIG.MOMENTUM_CONCURRENCY, async (row) => {
    try {
      const candles = await fetchKlines(row.symbol, interval, 2);
      const forming = candles && candles[candles.length - 1];
      const open = Number(forming && forming.open);
      const windowChange = changeFrom(open, row.current);
      row.windowChange = windowChange;
      row.windowUp = Number.isFinite(windowChange) && windowChange > 0;
    } catch (error) {
      console.warn(
        `window gain failed ${row.symbol}`,
        error && error.message ? error.message : error,
      );
      row.windowChange = null;
      row.windowUp = false;
    }
    return row;
  });
  return rows;
}

function filterPinWindowUp(rows) {
  return (rows || []).filter((row) => row && row.windowUp);
}

/** Keep old name as alias for window-up filter (page/notify aligned). */
function filterPinDoubleUp(rows) {
  return filterPinWindowUp(rows);
}

/** Drop the still-forming candle; keep closed bar closes only. */
function closedCloses(candles) {
  if (!Array.isArray(candles) || candles.length < 2) return [];
  return candles
    .slice(0, -1)
    .map((bar) => Number(bar && bar.close))
    .filter((value) => Number.isFinite(value));
}

/** Last N bars vs previous close: true when close > prev close. */
function lastBarRises(closes, bars) {
  const need = bars + 1;
  if (!Array.isArray(closes) || closes.length < need) return [];
  const slice = closes.slice(-need);
  const rises = [];
  for (let i = 1; i < slice.length; i += 1) {
    rises.push(slice[i] > slice[i - 1]);
  }
  return rises;
}

function momentumFromCloses(closes5, closes15) {
  const rises5 = lastBarRises(closes5, 3);
  const rises15 = lastBarRises(closes15, 3);
  return {
    streak5: rises5.length === 3 && rises5.every(Boolean),
    heat15: rises15.length === 3 && rises15.filter(Boolean).length >= 2,
  };
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

async function attachPinMomentum(rows) {
  if (!rows.length) return rows;
  await mapPool(rows, CONFIG.MOMENTUM_CONCURRENCY, async (row) => {
    try {
      const [candles5, candles15] = await Promise.all([
        fetchKlines(row.symbol, '5m', 5),
        fetchKlines(row.symbol, '15m', 5),
      ]);
      const flags = momentumFromCloses(
        closedCloses(candles5),
        closedCloses(candles15),
      );
      row.streak5 = flags.streak5;
      row.heat15 = flags.heat15;
    } catch (error) {
      console.warn(
        `momentum failed ${row.symbol}`,
        error && error.message ? error.message : error,
      );
      row.streak5 = false;
      row.heat15 = false;
    }
    return row;
  });
  return rows;
}

function formatPinNameLine(row) {
  const day = Number.isFinite(row.change24h)
    ? formatPercent(row.change24h)
    : '--';
  const name = labelOf(row.symbol);
  // WeCom: info=green, warning=orange.
  // 5m three-up → green; 15m 2/3 alone → orange; both → green (name only).
  let coloredName = name;
  if (row.streak5) {
    coloredName = `<font color="info">${name}</font>`;
  } else if (row.heat15) {
    coloredName = `<font color="warning">${name}</font>`;
  }

  return `${coloredName} ${day}`;
}

function attachPriceVsLast(rows, lastPinPrices) {
  const prev = lastPinPrices || {};
  rows.forEach((row) => {
    const last = Number(prev[row.symbol]);
    row.priceUpVsLast =
      Number.isFinite(last) &&
      Number.isFinite(row.current) &&
      row.current > last;
  });
  return rows;
}

function nextLastPinPrices(lastPinPrices, rows) {
  const next = { ...(lastPinPrices || {}) };
  (rows || []).forEach((row) => {
    if (row && row.symbol && Number.isFinite(row.current)) {
      next[row.symbol] = row.current;
    }
  });
  return next;
}

function buildPinReport(rows, meta) {
  if (!rows.length) return null;

  const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const totalUp = Number(meta && meta.totalUp);
  const capped = Number.isFinite(totalUp) && totalUp > rows.length;
  const blocks = [
    capped ? `${time} · 推送 ${rows.length}/${totalUp}` : `${time} · ${rows.length}`,
    '',
  ];

  rows.forEach((row, index) => {
    const currentText = formatPrice(row.current);
    // @@@ = rose vs last pin message price ("小老鼠")
    const currentLine = row.priceUpVsLast
      ? `${currentText}@@@`
      : currentText;
    blocks.push(formatPinNameLine(row));
    blocks.push(`【${formatPercent(row.change)}】`);
    blocks.push(formatPrice(row.pinPrice));
    blocks.push(currentLine);
    if (index < rows.length - 1) {
      blocks.push('<font color="comment">----------</font>');
      blocks.push('');
    } else {
      blocks.push('');
    }
  });

  const streak5Names = rows
    .filter((row) => row.streak5)
    .map((row) => labelOf(row.symbol));
  if (streak5Names.length) {
    blocks.push('<font color="comment">----------</font>');
    blocks.push('');
    blocks.push('<font color="info">5m</font>');
    streak5Names.forEach((name) => {
      blocks.push(`<font color="info">${name}</font>`);
    });
  }

  return blocks.join('\n').trimEnd();
}

function limitPinNotifyRows(rows) {
  const max = Math.max(1, Number(CONFIG.PIN_NOTIFY_MAX) || 20);
  if (!rows.length || rows.length <= max) {
    return { rows, totalUp: rows.length, truncated: false };
  }
  console.warn(`pin notify truncated ${rows.length} -> ${max} (PIN_NOTIFY_MAX)`);
  return {
    rows: rows.slice(0, max),
    totalUp: rows.length,
    truncated: true,
  };
}

async function sendTopPinCharts(rows, webhook) {
  if (!rows.length || !webhook) return [];
  const configured = CONFIG.PIN_CHART_TOP;
  const hardMax = Math.max(1, CONFIG.PIN_CHART_MAX || 12);
  const limit =
    Number.isFinite(configured) && configured > 0
      ? Math.min(configured, hardMax)
      : hardMax;
  const top = rows.slice(0, limit);
  if (rows.length > top.length) {
    console.warn(
      `pin collage truncated ${rows.length} -> ${top.length} (PIN_CHART_MAX=${hardMax})`,
    );
  }
  try {
    // Slightly shorter panels when many charts, keeps WeCom image manageable.
    const panelHeight = top.length >= 12 ? 200 : top.length >= 7 ? 240 : 320;
    const collage = await buildTopChartsCollage(top, { height: panelHeight });
    if (!collage) return [];
    await sendWecomImage(collage, webhook);
    return top.map((row) => row.symbol);
  } catch (error) {
    console.warn('pin collage failed', error.message || error);
    return [];
  }
}

function buildPositionReport(positions, tickers, dropAlerts, now) {
  if (!positions.length) return { text: null, nextDropAlerts: dropAlerts || {} };

  const threshold = Number.isFinite(CONFIG.DROP_THRESHOLD)
    ? CONFIG.DROP_THRESHOLD
    : 0.05;
  const cooldown = Number.isFinite(CONFIG.DROP_COOLDOWN_MS)
    ? CONFIG.DROP_COOLDOWN_MS
    : 2 * 60 * 60 * 1000;
  const nextDropAlerts = { ...(dropAlerts || {}) };
  const drops = [];

  const rows = positions.map((item) => {
    const ticker = tickers[item.symbol] || {};
    const current = ticker.price;
    const change = changeFrom(item.buyPrice, current);
    return {
      ...item,
      current,
      change,
      change24h: ticker.change24h,
    };
  });

  rows.forEach((item) => {
    if (Number.isFinite(item.change) && item.change <= -threshold * 100) {
      const lastAt = Number(nextDropAlerts[item.symbol]) || 0;
      if (!lastAt || now - lastAt >= cooldown) {
        drops.push(
          `${labelOf(item.symbol)} 跌破买入价${(threshold * 100).toFixed(0)}%（${formatPercent(item.change)}）`,
        );
        nextDropAlerts[item.symbol] = now;
      }
    }
  });

  const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const blocks = [`【持仓】${time} · ${rows.length}`, ''];

  rows.forEach((row) => {
    const name = labelOf(row.symbol);
    if (!Number.isFinite(row.current)) {
      blocks.push(`${name} --`);
      blocks.push(`买 ${formatPrice(row.buyPrice)} · 现价缺失`);
      blocks.push('');
      return;
    }
    const day = Number.isFinite(row.change24h)
      ? `24h ${formatPercent(row.change24h)}`
      : '24h --';
    blocks.push(`${name} 买${formatPercent(row.change)} · ${day}`);
    blocks.push(
      `${formatPrice(row.buyPrice)} → ${formatPrice(row.current)}`,
    );
    blocks.push('');
  });

  if (drops.length) {
    blocks.push('跌破告警');
    drops.forEach((line) => blocks.push(line));
  }

  return { text: blocks.join('\n').trimEnd(), nextDropAlerts };
}

async function tryAcquireNotifyLock(stateFile, now) {
  const data = (stateFile && stateFile.data) || {};
  const lastAt = Number(data.lastNotifyAt) || 0;
  if (lastAt && now - lastAt < CONFIG.NOTIFY_DEBOUNCE_MS) {
    return {
      acquired: false,
      reason: 'debounce',
      lastAt,
      ageMs: now - lastAt,
    };
  }

  const nextData = {
    dropAlerts: data.dropAlerts || {},
    lastPinPrices: data.lastPinPrices || {},
    lastPinNotify: data.lastPinNotify || null,
    lastPositionNotify: data.lastPositionNotify || null,
    risingSnap: Array.isArray(data.risingSnap) ? data.risingSnap : [],
    risingSnapSeeded: !!data.risingSnapSeeded,
    risingZoneSnap: Array.isArray(data.risingZoneSnap)
      ? data.risingZoneSnap
      : [],
    risingZoneSnapSeeded: !!data.risingZoneSnapSeeded,
    autoPinEvents: Array.isArray(data.autoPinEvents) ? data.autoPinEvents : [],
    lastNotifyAt: now,
    updatedAt: now,
  };

  try {
    await saveJson(
      CONFIG.NOTIFY_STATE_PATH,
      nextData,
      stateFile && stateFile.sha,
      'Acquire watch notify lock',
    );
    const refreshed = await loadJson(CONFIG.NOTIFY_STATE_PATH);
    return {
      acquired: true,
      stateFile: refreshed,
      dropAlerts: nextData.dropAlerts,
      lastPinPrices: nextData.lastPinPrices,
    };
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    if (/409|conflict|sha/i.test(message)) {
      return { acquired: false, reason: 'conflict', error: message };
    }
    throw error;
  }
}

const ACTION_LOG_PRIORITY_KINDS = new Set([
  'buy',
  'sell',
  'sell-stop',
  'mom-note',
  'period-low-exit',
]);
const ACTION_LOG_RANK_KINDS = new Set(['rank-new', 'rank-up']);

function actionLogKey(entry) {
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

/** Keep last 7 days (rank-* 1 day); if over max, prefer trade/note rows. */
function trimActionLogEntries(list) {
  const now = Date.now();
  const max = CONFIG.ACTION_LOG_MAX;
  const fresh = (Array.isArray(list) ? list : [])
    .filter((entry) => {
      const at = Number(entry && entry.at) || 0;
      const ttl = ACTION_LOG_RANK_KINDS.has(String(entry && entry.kind || ''))
        ? CONFIG.ACTION_LOG_RANK_TTL_MS
        : CONFIG.ACTION_LOG_TTL_MS;
      return at >= now - ttl;
    })
    .sort((a, b) => (b.at || 0) - (a.at || 0));
  if (fresh.length <= max) return fresh;
  const priority = [];
  const rest = [];
  for (const entry of fresh) {
    if (ACTION_LOG_PRIORITY_KINDS.has(String(entry.kind || ''))) {
      priority.push(entry);
    } else {
      rest.push(entry);
    }
  }
  if (priority.length >= max) return priority.slice(0, max);
  return [...priority, ...rest.slice(0, max - priority.length)].sort(
    (a, b) => (b.at || 0) - (a.at || 0),
  );
}

function normalizeActionLogEntry(item) {
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
  return entry;
}

function pinPriceOf(pins, symbol) {
  const key = String(symbol || '')
    .trim()
    .toUpperCase();
  const row = (pins || []).find(
    (item) => item && String(item.symbol || '').toUpperCase() === key,
  );
  const price = Number(row && row.pinPrice);
  return Number.isFinite(price) && price > 0 ? price : null;
}

function buildAutoPinMomNote(symbol, now, pins) {
  const key = String(symbol || '')
    .trim()
    .toUpperCase();
  if (!key) return null;
  return {
    id: `${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    at: now,
    symbol: key,
    label: labelOf(key),
    status: 'auto-pin',
    statusLabel: '自动盯',
    change2h: null,
    change1h: null,
    delta: null,
    price: pinPriceOf(pins, key),
  };
}


function formatNailNotePrice(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || !(n > 0)) return '';
  if (n >= 1000) return n.toFixed(2);
  if (n >= 1) return n.toFixed(4);
  if (n >= 0.01) return n.toFixed(5);
  return n.toPrecision(4);
}

const AUTO_PIN_NAIL_SOURCES = new Set([
  'auto-cloud',
  'auto-rising',
  'auto-rewarm',
]);

function isAutoPinSource(source) {
  return AUTO_PIN_NAIL_SOURCES.has(String(source || '').trim());
}

/**
 * 本轮新自动盯 → 写/刷新钉子便签；并补齐「已自动盯、钉子页却没有」的旧漏钉。
 * 补漏尊重 dismissedNails（用户删过的不补）；新自动盯会清掉 dismissed 再钉入。
 * 便签价优先现价（tickers），没有才回退 pinPrice。
 */
async function saveAutoPinNails(now, newcomers, pins, options) {
  const opts = options && typeof options === 'object' ? options : {};
  const nailsPath = opts.nailsPath || CONFIG.NAILS_PATH;
  // options.priceBySymbol；或兼容旧调用把 ticker map 直接当第 4 参。
  let priceBySymbol =
    opts.priceBySymbol && typeof opts.priceBySymbol === 'object'
      ? opts.priceBySymbol
      : null;
  if (
    !priceBySymbol &&
    !opts.nailsPath &&
    Object.keys(opts).some((key) => /USDT$/i.test(key))
  ) {
    priceBySymbol = opts;
  }
  const forceSet = new Set(
    (newcomers || [])
      .map((symbol) => String(symbol || '').trim().toUpperCase())
      .filter(Boolean),
  );
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const file = await loadJson(nailsPath);
    const prev = Array.isArray(file.data && file.data.nails) ? file.data.nails : [];
    const bySymbol = new Map();
    prev.forEach((item) => {
      const key = String((item && item.symbol) || '')
        .trim()
        .toUpperCase();
      if (key) bySymbol.set(key, item);
    });
    const dismissed = new Set(
      (Array.isArray(file.data && file.data.dismissedNails)
        ? file.data.dismissedNails
        : []
      )
        .map((symbol) => String(symbol || '').trim().toUpperCase())
        .filter(Boolean),
    );
    const backfillSet = new Set();
    (pins || []).forEach((row) => {
      if (!row || !isAutoPinSource(row.source)) return;
      const key = String(row.symbol || '')
        .trim()
        .toUpperCase();
      if (!key || bySymbol.has(key) || dismissed.has(key)) return;
      backfillSet.add(key);
    });
    const symbols = [
      ...new Set([...forceSet, ...backfillSet]),
    ];
    if (!symbols.length) return [];

    let prices = priceBySymbol && typeof priceBySymbol === 'object'
      ? priceBySymbol
      : null;
    if (!prices) {
      try {
        prices = await fetchBinanceTickers(symbols);
      } catch (error) {
        console.warn(
          'auto-pin nails price fetch failed',
          error && error.message ? error.message : error,
        );
        prices = {};
      }
    }

    const added = [];
    const updated = [];
    for (const symbol of symbols) {
      const force = forceSet.has(symbol);
      if (force) {
        // 新自动盯：清掉「曾手动删钉」标记，允许重新钉入。
        dismissed.delete(symbol);
      } else if (dismissed.has(symbol) || bySymbol.has(symbol)) {
        continue;
      }
      const live = prices && prices[symbol] && Number(prices[symbol].price);
      const price =
        Number.isFinite(live) && live > 0 ? live : pinPriceOf(pins, symbol);
      const note = formatNailNotePrice(price);
      const existing = bySymbol.get(symbol) || null;
      if (existing) {
        if (!force) continue;
        updated.push({
          ...existing,
          symbol,
          label: existing.label || labelOf(symbol),
          note,
          noteAt: note ? now : 0,
          exitedAt: 0,
          at: now,
        });
      } else {
        added.push({
          id: now.toString(36) + Math.random().toString(36).slice(2, 6),
          at: now,
          symbol,
          label: labelOf(symbol),
          note,
          noteAt: note ? now : 0,
          exitedAt: 0,
          pinned: false,
          pinnedAt: 0,
          order: 0,
        });
      }
    }
    if (!added.length && !updated.length) return [];
    const updatedMap = new Map(updated.map((item) => [item.symbol, item]));
    const rest = prev.map((item) => {
      const key = String((item && item.symbol) || '')
        .trim()
        .toUpperCase();
      return updatedMap.get(key) || item;
    });
    const addedKeys = new Set(added.map((row) => row.symbol));
    const restWithoutDup = rest.filter((item) => {
      const key = String((item && item.symbol) || '')
        .trim()
        .toUpperCase();
      return !addedKeys.has(key);
    });
    const nails = [...added, ...restWithoutDup].map((item, order) => ({
      ...item,
      order,
    }));
    const browseMaskAt = Number(file.data && file.data.browseMaskAt) || 0;
    const browseRevealed = Array.isArray(file.data && file.data.browseRevealed)
      ? file.data.browseRevealed
      : [];
    const backfillCount = added.filter((row) => !forceSet.has(row.symbol)).length;
    try {
      await saveJson(
        nailsPath,
        {
          nails,
          nailsUpdatedAt: now,
          updatedAt: Date.now(),
          browseMaskAt,
          browseRevealed,
          dismissedNails: [...dismissed],
        },
        file.sha,
        'Auto-pin nails +' +
          added.length +
          ' ~' +
          updated.length +
          (backfillCount ? ' backfill ' + backfillCount : ''),
      );
      return [...added, ...updated];
    } catch (error) {
      lastError = error;
      const message = error && error.message ? error.message : String(error);
      if (!/409|conflict|sha/i.test(message)) break;
    }
  }
  console.warn(
    'save auto-pin nails failed',
    lastError && lastError.message ? lastError.message : lastError,
  );
  return [];
}

async function saveAutoPinMomNotes(now, newcomers, pins, options) {
  const opts = options || {};
  const momNotesPath = opts.momNotesPath || CONFIG.MOM_NOTES_PATH;
  const symbols = (newcomers || [])
    .map((symbol) => String(symbol || '').trim().toUpperCase())
    .filter(Boolean);
  if (!symbols.length) return [];
  const added = symbols
    .map((symbol) => buildAutoPinMomNote(symbol, now, pins))
    .filter(Boolean);
  if (!added.length) return [];
  const drop = new Set(symbols);
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const file = await loadJson(momNotesPath);
    const prev = Array.isArray(file.data && file.data.notes)
      ? file.data.notes
      : [];
    const kept = prev.filter((note) => {
      const key = String(note && note.symbol || '')
        .trim()
        .toUpperCase();
      return key && !drop.has(key);
    });
    const notes = [...added, ...kept].slice(0, CONFIG.MOM_NOTES_MAX);
    try {
      await saveJson(
        momNotesPath,
        {
          notes,
          notesUpdatedAt: now,
          updatedAt: Date.now(),
        },
        file.sha,
        `Auto-pin mom notes ${added.length}`,
      );
      return added;
    } catch (error) {
      lastError = error;
      const message = error && error.message ? error.message : String(error);
      if (!/409|conflict|sha/i.test(message)) break;
    }
  }
  console.warn(
    'save auto-pin mom notes failed',
    lastError && lastError.message ? lastError.message : lastError,
  );
  return [];
}

/** Merge incoming action-log rows onto GitHub (conflict-retry). */
async function appendActionLogEntries(incoming, message, options) {
  const batch = Array.isArray(incoming) ? incoming : [];
  if (!batch.length) return;
  const actionLogPath =
    (options && options.actionLogPath) || CONFIG.ACTION_LOG_PATH;
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const file = await loadJson(actionLogPath);
    const prev = Array.isArray(file.data && file.data.entries)
      ? file.data.entries
      : [];
    const seen = new Set();
    const entries = [];
    for (const item of [...batch, ...prev]) {
      const entry = normalizeActionLogEntry(item);
      if (!entry) continue;
      const key = actionLogKey(entry);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      entries.push(entry);
    }
    const kept = trimActionLogEntries(entries);
    try {
      await saveJson(
        actionLogPath,
        {
          entries: kept,
          updatedAt: Date.now(),
        },
        file.sha,
        message || `Action log +${batch.length}`,
      );
      return;
    } catch (error) {
      lastError = error;
      const messageText = error && error.message ? error.message : String(error);
      if (!/409|conflict|sha/i.test(messageText)) break;
    }
  }
  console.warn(
    'append action log failed',
    lastError && lastError.message ? lastError.message : lastError,
  );
}

/** Same batches as WeCom: webpage 日志 follows cloud edges, not page refresh. */
async function appendAutoPinActionLog(now, newcomers, dropped, momNotes, options) {
  const incoming = [];
  if (newcomers.length) {
    incoming.push({
      at: now,
      kind: 'auto-pin',
      symbols: newcomers.map((symbol) => String(symbol).toUpperCase()),
    });
  }
  for (const note of momNotes || []) {
    if (!note || !note.symbol) continue;
    const entry = {
      at: Number(note.at) || now,
      kind: 'mom-note',
      symbols: [String(note.symbol).toUpperCase()],
    };
    const price = Number(note.price);
    if (Number.isFinite(price) && price > 0) entry.price = price;
    incoming.push(entry);
  }
  if (dropped && dropped.length) {
    incoming.push({
      at: now,
      kind: 'zone-drop',
      symbols: dropped.map((symbol) => String(symbol).toUpperCase()),
    });
  }
  if (!incoming.length) return;
  await appendActionLogEntries(
    incoming,
    `Action log auto-pin ${incoming.length}`,
    options,
  );
}

function normalizePriceAlerts(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const symbol = String(item.symbol || '')
      .trim()
      .toUpperCase();
    const target = Number(item.target);
    if (!symbol || !Number.isFinite(target) || target <= 0) continue;
    const direction = item.direction === 'below' ? 'below' : 'above';
    const sentCount = Math.max(0, Math.floor(Number(item.sentCount) || 0));
    out.push({
      id:
        String(item.id || '').trim() ||
        `${symbol}-${direction}-${Math.round(target * 1e8)}`,
      symbol,
      target,
      direction,
      createdAt: Number(item.createdAt) || 0,
      hitAt: Number(item.hitAt) > 0 ? Number(item.hitAt) : null,
      sentCount,
      lastSentAt: Number(item.lastSentAt) > 0 ? Number(item.lastSentAt) : 0,
      active: item.active === false ? false : sentCount < CONFIG.PRICE_ALERT_SEND_MAX,
    });
  }
  return out;
}

function priceAlertHit(alert, price) {
  if (!alert || !Number.isFinite(price)) return false;
  if (alert.direction === 'below') return price <= alert.target;
  return price >= alert.target;
}

/** 只看页面提醒时，命中记录保留多久（与网页通知 24h 窗口一致）。 */
const PRICE_ALERT_PAGE_RETAIN_MS = 24 * 60 * 60 * 1000;

/**
 * @param {number} now
 * @param {string} [alertsPath]
 * @param {{ push?: boolean }} [options]
 *   push=false：只落盘 hit（供网页），不发企微/微信。bstock 必须关推送。
 */
async function processPriceAlerts(now, alertsPath, options) {
  const path = alertsPath || CONFIG.PRICE_ALERTS_PATH;
  const pushEnabled = !(options && options.push === false);
  const file = await loadJson(path);
  const alerts = normalizePriceAlerts(
    file && file.data && Array.isArray(file.data.alerts) ? file.data.alerts : [],
  );
  const active = alerts.filter((item) => item.active);
  if (!active.length) {
    return { sent: 0, hit: 0, checked: 0, path, push: pushEnabled };
  }

  const symbols = [...new Set(active.map((item) => item.symbol))];
  const tickers = await fetchBinanceTickers(symbols);
  let changed = false;
  let sent = 0;
  let hit = 0;

  for (const alert of alerts) {
    if (!alert.active) continue;
    const row = tickers[alert.symbol];
    const price = row && Number(row.price);
    if (!Number.isFinite(price)) continue;
    if (!alert.hitAt && priceAlertHit(alert, price)) {
      alert.hitAt = now;
      changed = true;
      hit += 1;
    }
    if (!alert.hitAt) continue;

    // bStock / 仅页面提醒：只记触发，不发企微/微信，也不走 sentCount 推送配额。
    if (!pushEnabled) {
      // 网页只展示近 24h 命中；更早的自动归档，避免提醒长期占位、挡住重新设置。
      if (now - alert.hitAt > PRICE_ALERT_PAGE_RETAIN_MS) {
        alert.active = false;
        changed = true;
      }
      continue;
    }

    if (alert.sentCount >= CONFIG.PRICE_ALERT_SEND_MAX) {
      alert.active = false;
      changed = true;
      continue;
    }
    if (now - (alert.lastSentAt || 0) < CONFIG.PRICE_ALERT_SEND_GAP_MS) continue;

    const n = alert.sentCount + 1;
    const dirLabel = alert.direction === 'below' ? '跌破' : '达到';
    const title = `价格预警 ${labelOf(alert.symbol)} (${n}/${CONFIG.PRICE_ALERT_SEND_MAX})`;
    const content = [
      `${labelOf(alert.symbol)} ${dirLabel} ${formatPrice(alert.target)}`,
      `现价 ${formatPrice(price)}`,
      `预警 ${n}/${CONFIG.PRICE_ALERT_SEND_MAX} · 间隔约 1 分钟`,
    ].join('\n');

    try {
      if (CONFIG.PUSHPLUS_TOKEN) {
        await sendPushPlus({
          token: CONFIG.PUSHPLUS_TOKEN,
          title,
          content,
        });
      } else if (CONFIG.WECOM_WEBHOOK_POSITIONS) {
        await sendWecomText(content, CONFIG.WECOM_WEBHOOK_POSITIONS);
      } else {
        console.warn('price alert skip send: no PUSHPLUS_TOKEN / WeCom webhook');
        break;
      }
      alert.sentCount = n;
      alert.lastSentAt = now;
      if (alert.sentCount >= CONFIG.PRICE_ALERT_SEND_MAX) alert.active = false;
      changed = true;
      sent += 1;
    } catch (error) {
      console.warn(
        'price alert send failed',
        alert.symbol,
        error && error.message ? error.message : error,
      );
    }
  }

  if (changed) {
    await saveJson(
      path,
      {
        alerts: alerts.map((item) => ({
          id: item.id,
          symbol: item.symbol,
          target: item.target,
          direction: item.direction,
          createdAt: item.createdAt,
          hitAt: item.hitAt,
          sentCount: item.sentCount,
          lastSentAt: item.lastSentAt,
          active: !!item.active,
        })),
        alertsUpdatedAt: now,
        updatedAt: now,
      },
      file.sha,
      pushEnabled
        ? `Price alerts sent ${sent}`
        : `Price alerts hit ${hit} (no push)`,
    );
  }

  return { sent, hit, checked: active.length, path, push: pushEnabled };
}

/**
 * bStock 页读 watch-bstock-notify-state：补写盯/仓浮窗，保留 auto-pin 的 zone snap。
 * 只写 GitHub 供网页；不发企微/微信。不跑破点高 / 记一笔排行 / 钉子绿。
 */
async function updateBstockPageNotify(now) {
  const { AUTO_PIN_PROFILES } = require('./auto-pin');
  const profile = AUTO_PIN_PROFILES.bstock;
  const positionsPath =
    profile.POSITIONS_PATH || 'watch-bstock-positions.json';

  let pinsFile = { data: null, sha: null };
  let positionsFile = { data: null, sha: null };
  let stateFile = { data: null, sha: null };
  try {
    [pinsFile, positionsFile, stateFile] = await Promise.all([
      loadJson(profile.PINS_PATH),
      loadJson(positionsPath),
      loadJson(profile.NOTIFY_STATE_PATH),
    ]);
  } catch (error) {
    console.warn(
      'bstock page-notify load failed',
      error && error.message ? error.message : error,
    );
    return { skipped: true, reason: 'load-failed' };
  }

  const pins = normalizePinList(
    (pinsFile.data && pinsFile.data.pins) ||
      (Array.isArray(pinsFile.data) ? pinsFile.data : []),
  );
  const positions = normalizePositions(
    positionsFile.data && positionsFile.data.positions,
  );
  const state = (stateFile && stateFile.data) || {};
  const lastPinPrices =
    state.lastPinPrices && typeof state.lastPinPrices === 'object'
      ? state.lastPinPrices
      : {};
  const dropAlerts =
    state.dropAlerts && typeof state.dropAlerts === 'object'
      ? state.dropAlerts
      : {};

  const symbols = [
    ...new Set([
      ...pins.map((item) => item.symbol),
      ...positions.map((item) => item.symbol),
    ]),
  ];
  const tickers = symbols.length ? await fetchBinanceTickers(symbols) : {};

  const { text: positionText, nextDropAlerts } = buildPositionReport(
    positions,
    tickers,
    dropAlerts,
    now,
  );

  let pinRows = listPinCandidateRows(pins, tickers);
  if (pinRows.length) {
    await attachPinWindowGain(pinRows);
    pinRows = filterPinWindowUp(pinRows);
  }
  const pinCap = limitPinNotifyRows(pinRows);
  pinRows = pinCap.rows;
  if (pinRows.length) {
    await attachPinMomentum(pinRows);
    attachPriceVsLast(pinRows, lastPinPrices);
  }
  const pinText = pinRows.length
    ? buildPinReport(pinRows, { totalUp: pinCap.totalUp })
    : null;

  const nextPinPrices = pinText
    ? nextLastPinPrices(lastPinPrices, pinRows)
    : lastPinPrices;
  const prevNotify =
    state.lastPinNotify && typeof state.lastPinNotify === 'object'
      ? state.lastPinNotify
      : null;
  const prevPositionNotify =
    state.lastPositionNotify && typeof state.lastPositionNotify === 'object'
      ? state.lastPositionNotify
      : null;
  const lastPinNotify = pinText
    ? {
        at: now,
        markdown: pinText,
        symbols: pinRows.map((row) => row.symbol),
      }
    : prevNotify;
  const lastPositionNotify = positionText
    ? {
        at: now,
        text: positionText,
        symbols: positions.map((item) => item.symbol),
      }
    : null;
  const dropAlertsToSave = positionText ? nextDropAlerts : dropAlerts;

  const changed =
    JSON.stringify(dropAlertsToSave) !== JSON.stringify(dropAlerts) ||
    JSON.stringify(nextPinPrices) !== JSON.stringify(lastPinPrices) ||
    JSON.stringify(lastPinNotify) !== JSON.stringify(prevNotify) ||
    JSON.stringify(lastPositionNotify) !== JSON.stringify(prevPositionNotify);

  if (!changed) {
    return {
      skipped: true,
      reason: 'unchanged',
      pins: pins.length,
      positions: positions.length,
    };
  }

  // 重新读 sha，避免与前面 auto-pin zone 写入撞车。
  let freshSha = stateFile.sha;
  let risingZoneSnap = Array.isArray(state.risingZoneSnap)
    ? state.risingZoneSnap
    : [];
  let risingZoneSnapSeeded = !!state.risingZoneSnapSeeded;
  let autoPinEvents = Array.isArray(state.autoPinEvents)
    ? state.autoPinEvents
    : [];
  try {
    const fresh = await loadJson(profile.NOTIFY_STATE_PATH);
    freshSha = fresh.sha;
    const data = fresh.data || {};
    if (Array.isArray(data.risingZoneSnap)) risingZoneSnap = data.risingZoneSnap;
    risingZoneSnapSeeded = !!data.risingZoneSnapSeeded;
    if (Array.isArray(data.autoPinEvents)) autoPinEvents = data.autoPinEvents;
  } catch (_) {
    /* keep prior */
  }

  await saveJson(
    profile.NOTIFY_STATE_PATH,
    {
      ...(state && typeof state === 'object' ? state : {}),
      dropAlerts: dropAlertsToSave,
      lastPinPrices: nextPinPrices,
      lastPinNotify,
      lastPositionNotify,
      risingZoneSnap,
      risingZoneSnapSeeded,
      autoPinEvents,
      updatedAt: Date.now(),
    },
    freshSha,
    'bStock page pin/position notify',
  );

  return {
    ok: true,
    pins: pins.length,
    positions: positions.length,
    pinText: !!pinText,
    positionText: !!positionText,
  };
}

/** bStock 侧定时维护：日切 / 染绿 notices / 盯仓浮窗。不发企微微信。 */
async function runBstockSideMaintenance(now) {
  const out = {
    nailDailyReset: { skipped: true, reason: 'not-run' },
    nailGreenAlert: {
      skipped: true,
      reason: 'not-run',
      sent: 0,
      symbols: [],
    },
    pageNotify: { skipped: true, reason: 'not-run' },
  };
  const { AUTO_PIN_PROFILES } = require('./auto-pin');
  const bp = AUTO_PIN_PROFILES.bstock;
  try {
    out.nailDailyReset = await runNailDailyReset({
      now,
      nailsPath: bp.NAILS_PATH,
      statePath: bp.NAIL_DAILY_RESET_PATH,
    });
    console.log(
      'bstock nail-daily-reset',
      JSON.stringify(out.nailDailyReset),
    );
  } catch (error) {
    console.warn(
      'bstock nail-daily-reset failed',
      error && error.message ? error.message : error,
    );
  }
  try {
    out.nailGreenAlert = await runNailGreenAlerts({
      now,
      nailsPath: bp.NAILS_PATH,
      statePath: bp.NAIL_GREEN_ALERT_PATH,
      noticesPath: bp.NAIL_GREEN_NOTICES_PATH,
      push: false,
      webhook: '',
    });
    console.log(
      'bstock nail-green-alert',
      JSON.stringify(out.nailGreenAlert),
    );
  } catch (error) {
    console.warn(
      'bstock nail-green-alert failed',
      error && error.message ? error.message : error,
    );
  }
  try {
    out.pageNotify = await updateBstockPageNotify(now);
    console.log('bstock page-notify', JSON.stringify(out.pageNotify));
  } catch (error) {
    console.warn(
      'bstock page-notify failed',
      error && error.message ? error.message : error,
    );
    out.pageNotify = {
      skipped: true,
      reason: error && error.message ? error.message : 'error',
    };
  }
  return out;
}

function summarizeBalanceHealth(result) {
  const r = result && typeof result === 'object' ? result : {};
  const errors = Array.isArray(r.errors) ? r.errors.map(String) : [];
  const due = Number(r.due) || 0;
  const cool = Number(r.skippedFetch) || 0;
  const autoPins =
    Number(r.autoPins) > 0
      ? Number(r.autoPins)
      : due + cool > 0
        ? due + cool
        : 0;
  return {
    skipped: !!r.skipped,
    reason: r.reason != null ? String(r.reason) : null,
    autoPins,
    due,
    checked: Number(r.checked) || 0,
    hits: Number(r.hits) || 0,
    sent: Number(r.sent) || 0,
    wecomDue: Number(r.wecomDue) || 0,
    wecomQueued: Number(r.wecomQueued) || 0,
    wecomDeferred: Number(r.wecomDeferred) || 0,
    skippedWecomWindow: Number(r.skippedWecomWindow) || 0,
    checkMax: Number(r.checkMax) || 0,
    sendMax: Number(r.sendMax) || 0,
    checkCursor: Number(r.checkCursor) || 0,
    cooldownMs: Number(r.cooldownMs) || 0,
    cooldownSkipped: cool,
    errorCount: errors.length,
    errors: errors.slice(0, 5),
  };
}

function summarizeNailGreenHealth(result) {
  const r = result && typeof result === 'object' ? result : {};
  const errors = Array.isArray(r.errors) ? r.errors.map(String) : [];
  return {
    skipped: !!r.skipped,
    reason: r.reason != null ? String(r.reason) : null,
    nails: Number(r.nails) || 0,
    pending: Number(r.pending) || 0,
    checked: Number(r.checked) || 0,
    hits: Number(r.hits) || 0,
    sent: Number(r.sent) || 0,
    checkMax: Number(r.checkMax) || 0,
    checkCursor: Number(r.checkCursor) || 0,
    bucketSkipped: Number(r.skippedFetch) || 0,
    errorCount: errors.length,
    errors: errors.slice(0, 5),
  };
}

function summarizeStaleNailHealth(result) {
  const r = result && typeof result === 'object' ? result : {};
  const removed = Array.isArray(r.removed) ? r.removed : [];
  return {
    skipped: !!r.skipped,
    reason: r.reason != null ? String(r.reason) : null,
    checked: Number(r.checked) || 0,
    candidate: Number(r.candidate) || 0,
    removed: removed.length,
  };
}

/**
 * 每轮定时写心跳，供网页「健康度」判断是否停摆 / 本轮是否扫完。
 * 与业务状态分离，避免 notify-state 条件保存时漏掉心跳。
 */
async function saveNotifyDetectorHealth(payload) {
  const path =
    String(CONFIG.NOTIFY_HEALTH_PATH || '').trim() ||
    'watch-notify-health.json';
  const body =
    payload && typeof payload === 'object'
      ? payload
      : { ok: false, error: 'empty-payload', lastRunAt: Date.now() };
  let sha;
  try {
    const prev = await loadJson(path);
    sha = prev && prev.sha;
  } catch (error) {
    /* 首写或文件不存在 */
  }
  await saveJson(path, body, sha, 'Notify detector health');
  return body;
}

async function main(event, context) {
  // 缺 token/webhook 时降级关闭推送，避免整轮 notify 直接抛死（控制台只见「执行失败」）。
  if (CONFIG.AUTO_PIN_PUSHPLUS && !CONFIG.PUSHPLUS_TOKEN) {
    console.warn(
      'AUTO_PIN_PUSHPLUS=1 but PUSHPLUS_TOKEN missing — disable auto-pin PushPlus',
    );
    CONFIG.AUTO_PIN_PUSHPLUS = false;
  }
  if (CONFIG.AUTO_PIN_WECOM && !CONFIG.WECOM_WEBHOOK_POSITIONS) {
    console.warn(
      'AUTO_PIN_WECOM=1 but WECOM_WEBHOOK_POSITIONS missing — disable auto-pin WeCom',
    );
    CONFIG.AUTO_PIN_WECOM = false;
  }

  console.log(
    'webhook routing',
    JSON.stringify({
      pushplus: CONFIG.PUSHPLUS_TOKEN
        ? webhookKeyHint(`https://x/?key=${CONFIG.PUSHPLUS_TOKEN}`)
        : null,
      autoPinPushplus: CONFIG.AUTO_PIN_PUSHPLUS,
      autoPinWecom: CONFIG.AUTO_PIN_WECOM,
      pins: CONFIG.WECOM_WEBHOOK_PINS
        ? webhookKeyHint(CONFIG.WECOM_WEBHOOK_PINS)
        : null,
      positions: CONFIG.WECOM_WEBHOOK_POSITIONS
        ? webhookKeyHint(CONFIG.WECOM_WEBHOOK_POSITIONS)
        : null,
    }),
  );
  if (WEBHOOKS.sameTarget) {
    console.warn(
      'pins/positions share the same webhook URL — dual-group split will not work',
    );
  }

  const [pinsFileRaw, positionsFile, stateFile] = await Promise.all([
    loadJson(CONFIG.PINS_PATH),
    loadJson(CONFIG.POSITIONS_PATH),
    loadJson(CONFIG.NOTIFY_STATE_PATH),
  ]);
  let pinsFile = pinsFileRaw;

  const now = Date.now();
  const lock = await tryAcquireNotifyLock(stateFile, now);
  if (!lock.acquired) {
    console.log('notify skip: duplicate invoke', JSON.stringify(lock));
    return { ok: true, skipped: true, reason: lock.reason, lock };
  }

  let activeStateFile = lock.stateFile || stateFile;
  let pins = normalizePinList(
    (pinsFile.data && pinsFile.data.pins) || pinsFile.data,
  );
  // Prefer notify normalizePins alias if list empty from odd shapes.
  if (!pins.length) {
    pins = normalizePins(pinsFile.data && pinsFile.data.pins);
  }
  const positions = normalizePositions(
    positionsFile.data && positionsFile.data.positions,
  );
  let dropAlerts = lock.dropAlerts || {};
  let lastPinPrices = lock.lastPinPrices || {};
  const stateData = (activeStateFile && activeStateFile.data) || {};
  let risingZoneSnap = Array.isArray(stateData.risingZoneSnap)
    ? stateData.risingZoneSnap
    : [];
  let risingZoneSnapSeeded = !!stateData.risingZoneSnapSeeded;
  let autoPinEvents = Array.isArray(stateData.autoPinEvents)
    ? stateData.autoPinEvents
    : [];

  let priceAlertStats = { sent: 0, hit: 0, checked: 0 };
  let bstockPriceAlertStats = { sent: 0, hit: 0, checked: 0 };
  try {
    // 现货价格提醒：默认「仅页面提醒」——只写 hitAt 供网页通知，不推企微/微信。
    priceAlertStats = await processPriceAlerts(now, CONFIG.PRICE_ALERTS_PATH, {
      push: CONFIG.PRICE_ALERTS_PUSH,
    });
    if (priceAlertStats.sent || priceAlertStats.hit) {
      console.log('price alerts', JSON.stringify(priceAlertStats));
    }
  } catch (error) {
    console.warn(
      'price alerts failed',
      error && error.message ? error.message : error,
    );
  }
  try {
    const { AUTO_PIN_PROFILES } = require('./auto-pin');
    const bstockAlertsPath =
      (AUTO_PIN_PROFILES.bstock &&
        AUTO_PIN_PROFILES.bstock.PRICE_ALERTS_PATH) ||
      'watch-bstock-price-alerts.json';
    // bStock：只落盘触发态给网页，禁止企微/微信推送。
    bstockPriceAlertStats = await processPriceAlerts(now, bstockAlertsPath, {
      push: false,
    });
    if (bstockPriceAlertStats.hit) {
      console.log('bstock price alerts', JSON.stringify(bstockPriceAlertStats));
    }
  } catch (error) {
    console.warn(
      'bstock price alerts failed',
      error && error.message ? error.message : error,
    );
  }

  let autoPinned = [];
  let autoDropped = [];
  try {
    const autoResult = await runAutoPin({
      pins,
      risingZoneSnap,
      risingZoneSnapSeeded,
      autoPinEvents,
      now,
    });
    pins = autoResult.pins;
    risingZoneSnap = autoResult.risingSnap;
    risingZoneSnapSeeded = autoResult.risingSnapSeeded;
    autoPinEvents = autoResult.autoPinEvents;
    autoPinned = autoResult.newcomers || [];
    autoDropped = autoResult.dropped || [];
    if (autoResult.pinsChanged) {
      const saved = await savePinsFile(
        pinsFile,
        pins,
        `Auto-pin top30/pool (edge+catch-up): new ${autoPinned.length}`,
      );
      pins = saved.pins;
      // Refresh sha for later state writes only — pins file sha not reused below.
      try {
        pinsFile = await loadJson(CONFIG.PINS_PATH);
      } catch (error) {
        console.warn('reload pins after auto-pin failed', error.message || error);
      }
    }
  } catch (error) {
    console.warn('auto-pin failed', error.message || error);
  }

  // bStock 独立自动盯：与现货同表现（钉子/记一笔/日志），独立 JSON；不发企微/微信；不跑破点高。
  let bstockAutoPinned = [];
  let bstockAutoDropped = [];
  let bstockPins = [];
  let bstockAutoPinMomNotes = [];
  let bstockAutoPinNails = [];
  try {
    const { applyAutoPinProfile, AUTO_PIN_PROFILES } = require('./auto-pin');
    const bstockProfile = AUTO_PIN_PROFILES.bstock;
    applyAutoPinProfile('bstock');
    let bstockPinsFile = { data: null, sha: null };
    try {
      bstockPinsFile = await loadJson(bstockProfile.PINS_PATH);
    } catch (error) {
      console.warn('bstock pins load failed', error.message || error);
    }
    let bstockNotifyFile = { data: null, sha: null };
    try {
      bstockNotifyFile = await loadJson(bstockProfile.NOTIFY_STATE_PATH);
    } catch (error) {
      console.warn('bstock notify-state load failed', error.message || error);
    }
    const bstockState = bstockNotifyFile.data || {};
    const bstockPinsIn = normalizePinList(
      (bstockPinsFile.data && bstockPinsFile.data.pins) ||
        (Array.isArray(bstockPinsFile.data) ? bstockPinsFile.data : []),
    );
    const bstockResult = await runAutoPin({
      profile: 'bstock',
      pins: bstockPinsIn,
      risingZoneSnap: Array.isArray(bstockState.risingZoneSnap)
        ? bstockState.risingZoneSnap
        : [],
      risingZoneSnapSeeded: !!bstockState.risingZoneSnapSeeded,
      autoPinEvents: Array.isArray(bstockState.autoPinEvents)
        ? bstockState.autoPinEvents
        : [],
      now,
    });
    bstockPins = bstockResult.pins || bstockPinsIn;
    bstockAutoPinned = bstockResult.newcomers || [];
    bstockAutoDropped = bstockResult.dropped || [];
    if (bstockResult.pinsChanged) {
      const saved = await savePinsFile(
        bstockPinsFile,
        bstockPins,
        `bStock auto-pin: new ${bstockAutoPinned.length}`,
      );
      bstockPins = saved.pins;
    }
    const prevSnap = Array.isArray(bstockState.risingZoneSnap)
      ? bstockState.risingZoneSnap
      : [];
    const nextSnap = Array.isArray(bstockResult.risingSnap)
      ? bstockResult.risingSnap
      : [];
    const snapChanged =
      JSON.stringify(prevSnap) !== JSON.stringify(nextSnap) ||
      !!bstockState.risingZoneSnapSeeded !==
        !!bstockResult.risingSnapSeeded ||
      JSON.stringify(bstockState.autoPinEvents || []) !==
        JSON.stringify(bstockResult.autoPinEvents || []);
    // 无变化不写 GitHub，避免每轮定时刷 Pages 部署。
    if (snapChanged || bstockResult.pinsChanged || !bstockNotifyFile.sha) {
      const nextBstockState = {
        ...(bstockState && typeof bstockState === 'object' ? bstockState : {}),
        risingZoneSnap: nextSnap,
        risingZoneSnapSeeded: bstockResult.risingSnapSeeded,
        autoPinEvents: bstockResult.autoPinEvents,
        updatedAt: Date.now(),
      };
      await saveJson(
        bstockProfile.NOTIFY_STATE_PATH,
        nextBstockState,
        bstockNotifyFile.sha,
        'bStock auto-pin zone snap',
      );
    }

    const bstockPaths = {
      nailsPath: bstockProfile.NAILS_PATH,
      momNotesPath: bstockProfile.MOM_NOTES_PATH,
      actionLogPath: bstockProfile.ACTION_LOG_PATH,
    };
    if (bstockAutoPinned.length) {
      try {
        bstockAutoPinMomNotes = await saveAutoPinMomNotes(
          now,
          bstockAutoPinned,
          bstockPins,
          bstockPaths,
        );
      } catch (error) {
        console.warn(
          'bstock auto-pin mom notes failed',
          error && error.message ? error.message : error,
        );
        bstockAutoPinMomNotes = [];
      }
    }
    try {
      bstockAutoPinNails = await saveAutoPinNails(
        now,
        bstockAutoPinned,
        bstockPins,
        bstockPaths,
      );
      if (bstockAutoPinNails.length) {
        console.log(
          'bstock auto-pin nails',
          JSON.stringify({
            count: bstockAutoPinNails.length,
            newcomers: bstockAutoPinned.length,
            sample: bstockAutoPinNails.slice(0, 12).map((row) => row.symbol),
          }),
        );
      }
    } catch (error) {
      console.warn(
        'bstock auto-pin nails failed',
        error && error.message ? error.message : error,
      );
      bstockAutoPinNails = [];
    }
    const bstockRemain =
      context && typeof context.getRemainingTimeInMillis === 'function'
        ? context.getRemainingTimeInMillis()
        : null;
    if (bstockRemain != null && bstockRemain < 25000) {
      console.warn(
        'bstock prune-stale-auto-pin-nails skip: low remaining ms',
        bstockRemain,
      );
    } else {
      try {
        try {
          bstockPinsFile = await loadJson(bstockProfile.PINS_PATH);
        } catch (_) {
          /* keep prior */
        }
        const bstockPrune = await pruneStaleAutoPinNails({
          now,
          pins: bstockPins,
          pinsFile: bstockPinsFile,
          nailsPath: bstockProfile.NAILS_PATH,
          pinsPath: bstockProfile.PINS_PATH,
        });
        if (Array.isArray(bstockPrune.pins)) {
          bstockPins = bstockPrune.pins;
        }
        if (bstockPrune.removed && bstockPrune.removed.length) {
          console.log(
            'bstock prune-stale-auto-pin-nails',
            JSON.stringify({
              removed: bstockPrune.removed.length,
              sample: bstockPrune.removed.slice(0, 12),
              checked: bstockPrune.checked,
            }),
          );
        }
      } catch (error) {
        console.warn(
          'bstock prune-stale-auto-pin-nails failed',
          error && error.message ? error.message : error,
        );
      }
    }
    if (bstockAutoPinned.length || bstockAutoDropped.length) {
      try {
        await appendAutoPinActionLog(
          now,
          bstockAutoPinned,
          bstockAutoDropped,
          bstockAutoPinMomNotes,
          bstockPaths,
        );
      } catch (error) {
        console.warn(
          'bstock auto-pin action log failed',
          error && error.message ? error.message : error,
        );
      }
    }

    applyAutoPinProfile('crypto');
  } catch (error) {
    console.warn(
      'bstock auto-pin failed',
      error && error.message ? error.message : error,
    );
    try {
      const { applyAutoPinProfile } = require('./auto-pin');
      applyAutoPinProfile('crypto');
    } catch (_) {
      /* ignore */
    }
  }

  // 必须在现货「空仓早退」之前跑，否则 bstock 日切/染绿/浮窗会被跳过。
  let bstockSide = {
    nailDailyReset: { skipped: true, reason: 'not-run' },
    nailGreenAlert: {
      skipped: true,
      reason: 'not-run',
      sent: 0,
      symbols: [],
    },
    pageNotify: { skipped: true, reason: 'not-run' },
  };
  try {
    bstockSide = await runBstockSideMaintenance(now);
  } catch (error) {
    console.warn(
      'bstock side maintenance failed',
      error && error.message ? error.message : error,
    );
  }

  let autoPinMomNotes = [];
  let autoPinNails = [];
  if (autoPinned.length) {
    try {
      autoPinMomNotes = await saveAutoPinMomNotes(now, autoPinned, pins);
    } catch (error) {
      console.warn(
        'auto-pin mom notes failed',
        error && error.message ? error.message : error,
      );
      autoPinMomNotes = [];
    }
  }
  // 本轮新自动盯写钉子；并补齐已自动盯却漏钉的旧数据（用户删过的仍不补）。
  try {
    autoPinNails = await saveAutoPinNails(now, autoPinned, pins);
    if (autoPinNails.length) {
      console.log(
        'auto-pin nails',
        JSON.stringify({
          count: autoPinNails.length,
          newcomers: autoPinned.length,
          sample: autoPinNails.slice(0, 12).map((row) => row.symbol),
        }),
      );
    }
  } catch (error) {
    console.warn(
      'auto-pin nails failed',
      error && error.message ? error.message : error,
    );
    autoPinNails = [];
  }

  // 盯点已落在 18 根 4h 最旧前 1/3 → 离钉并清自动盯（置顶除外）。
  let staleNailPrune = {
    skipped: true,
    reason: 'not-run',
    removed: [],
  };
  const pruneRemain =
    context && typeof context.getRemainingTimeInMillis === 'function'
      ? context.getRemainingTimeInMillis()
      : null;
  if (pruneRemain != null && pruneRemain < 25000) {
    staleNailPrune = {
      skipped: true,
      reason: 'low-remaining',
      remainingMs: pruneRemain,
      removed: [],
    };
    console.warn(
      'prune-stale-auto-pin-nails skip: low remaining ms',
      pruneRemain,
    );
  } else {
    try {
      try {
        pinsFile = await loadJson(CONFIG.PINS_PATH);
      } catch (_) {
        /* keep prior pinsFile */
      }
      staleNailPrune = await pruneStaleAutoPinNails({
        now,
        pins,
        pinsFile,
        nailsPath: CONFIG.NAILS_PATH,
        pinsPath: CONFIG.PINS_PATH,
      });
      if (Array.isArray(staleNailPrune.pins)) {
        pins = staleNailPrune.pins;
      }
      if (staleNailPrune.removed && staleNailPrune.removed.length) {
        console.log(
          'prune-stale-auto-pin-nails',
          JSON.stringify({
            removed: staleNailPrune.removed.length,
            sample: staleNailPrune.removed.slice(0, 12),
            checked: staleNailPrune.checked,
          }),
        );
      }
    } catch (error) {
      console.warn(
        'prune-stale-auto-pin-nails failed',
        error && error.message ? error.message : error,
      );
      staleNailPrune = {
        skipped: true,
        reason: 'error',
        removed: [],
        error: error && error.message ? error.message : String(error),
      };
    }
  }

  function buildAutoPinAlert() {
    const lines = [];
    const titleBits = [];
    if (autoPinned.length) {
      const names = autoPinned
        .slice(0, 12)
        .map((symbol) => labelOf(symbol))
        .join(' · ');
      const more =
        autoPinned.length > 12 ? ` …+${autoPinned.length - 12}` : '';
      lines.push(`【新自动盯】${autoPinned.length}\n${names}${more}`);
      titleBits.push(
        `新盯 ${autoPinned
          .slice(0, 6)
          .map((symbol) => labelOf(symbol))
          .join(' ')}`,
      );
    }
    if (!lines.length) return null;
    const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    return {
      title: titleBits.join(' · ') || `边沿 ${time}`,
      content: `【边沿提醒】${time}\n${lines.join('\n')}\n（网页「日志 / 置顶」可看）`,
      tag: `auto-pin:${autoPinned.length}`,
    };
  }

  async function sendAutoPinAlert() {
    // 产品改为：自动盯本身不推；仅天平新命中推企微。
    if (!CONFIG.AUTO_PIN_PUSHPLUS && !CONFIG.AUTO_PIN_WECOM) return null;
    const alert = buildAutoPinAlert();
    if (!alert) return null;
    const sentTags = [];
    if (CONFIG.AUTO_PIN_PUSHPLUS) {
      await sendPushPlus({
        token: CONFIG.PUSHPLUS_TOKEN,
        title: alert.title,
        content: alert.content,
      });
      sentTags.push(`pushplus:${alert.tag}`);
    }
    if (CONFIG.AUTO_PIN_WECOM && CONFIG.WECOM_WEBHOOK_POSITIONS) {
      await sendWecomText(alert.content, CONFIG.WECOM_WEBHOOK_POSITIONS);
      sentTags.push(`wecom:${alert.tag}`);
    }
    if (!sentTags.length) return null;
    return sentTags.join(',');
  }

  let momNotes = [];
  try {
    momNotes = await loadMomNotes();
  } catch (error) {
    console.warn('load mom notes failed', error.message || error);
    momNotes = [];
  }

  // 首绿落盘 / 天平企微：不依赖持仓与记一笔，空仓早退前也要跑。
  let nailGreenAlert = { skipped: true, reason: 'not-run', sent: 0, symbols: [] };
  try {
    nailGreenAlert = await runNailGreenAlerts({
      now,
      push: false,
    });
    console.log('nail-green-alert', JSON.stringify(nailGreenAlert));
  } catch (error) {
    console.warn(
      'nail-green-alert failed',
      error && error.message ? error.message : error,
    );
    nailGreenAlert = {
      skipped: true,
      reason: 'error',
      errors: [error && error.message ? error.message : String(error)],
      checked: 0,
      hits: 0,
      sent: 0,
    };
  }

  let balanceAlert = { skipped: true, reason: 'not-run', sent: 0, symbols: [] };
  try {
    balanceAlert = await runBalanceAlerts({
      now,
      pins,
      webhook: CONFIG.WECOM_WEBHOOK_PINS || CONFIG.WECOM_WEBHOOK_POSITIONS,
    });
    console.log('balance-alert', JSON.stringify(balanceAlert));
  } catch (error) {
    console.warn(
      'balance-alert failed',
      error && error.message ? error.message : error,
    );
    balanceAlert = {
      skipped: true,
      reason: 'error',
      errors: [error && error.message ? error.message : String(error)],
      checked: 0,
      hits: 0,
      sent: 0,
    };
  }

  // 检测段一结束就写心跳：后面业务再崩，网页仍能看到「本轮已跑过」。
  try {
    const balanceHealth = summarizeBalanceHealth(balanceAlert);
    const nailGreenHealth = summarizeNailGreenHealth(nailGreenAlert);
    const healthBody = {
      updatedAt: Date.now(),
      lastRunAt: now,
      ok: true,
      error: null,
      durationMs: Date.now() - now,
      // 自动盯口径：天平候选池（auto-*），不是全部 pins。
      autoPins: Number(balanceHealth.autoPins) || 0,
      balance: balanceHealth,
      nailGreen: nailGreenHealth,
      staleNailPrune: summarizeStaleNailHealth(staleNailPrune),
    };
    const failBits = [];
    const softBits = [];
    if (nailGreenAlert && nailGreenAlert.reason === 'error') {
      failBits.push(
        String(
          (nailGreenAlert.errors && nailGreenAlert.errors[0]) || 'nail-green',
        ),
      );
    }
    if (balanceAlert && balanceAlert.reason === 'error') {
      failBits.push(
        String((balanceAlert.errors && balanceAlert.errors[0]) || 'balance'),
      );
    }
    // 模块缺失 / 显式关闭：心跳在，但检测没真正跑——标坏，避免「绿灯却从不查」。
    ['module-missing', 'disabled'].forEach((bad) => {
      if (balanceHealth.reason === bad) failBits.push(`balance:${bad}`);
      if (nailGreenHealth.reason === bad) failBits.push(`nail-green:${bad}`);
    });
    if (balanceHealth.errorCount > 0) {
      softBits.push(
        `balance×${balanceHealth.errorCount}:${balanceHealth.errors[0] || 'err'}`,
      );
    }
    if (nailGreenHealth.errorCount > 0) {
      softBits.push(
        `nail-green×${nailGreenHealth.errorCount}:${nailGreenHealth.errors[0] || 'err'}`,
      );
    }
    if (failBits.length) {
      healthBody.ok = false;
      healthBody.error = failBits.concat(softBits).join(' · ');
    } else if (softBits.length) {
      // 软错误：本轮跑过但有拉 K / 推送失败，标 degraded（网页按非 ok 告警）。
      healthBody.ok = false;
      healthBody.degraded = true;
      healthBody.error = softBits.join(' · ');
    }
    await saveNotifyDetectorHealth(healthBody);
    console.log('notify-health', JSON.stringify(healthBody));
  } catch (error) {
    console.warn(
      'notify-health save failed',
      error && error.message ? error.message : error,
    );
  }

  if (!pins.length && !positions.length && !momNotes.length) {
    // Still persist rising zone snap / events so seeding works with empty pins.
    try {
      await appendAutoPinActionLog(
        now,
        autoPinned,
        autoDropped,
        autoPinMomNotes,
      );
    } catch (error) {
      console.warn('auto-pin action log failed', error.message || error);
    }
    try {
      const tag = await sendAutoPinAlert();
      if (tag) console.log('auto-pin alert', tag);
    } catch (error) {
      console.warn('auto-pin alert failed', error.message || error);
    }
    await saveJson(
      CONFIG.NOTIFY_STATE_PATH,
      {
        dropAlerts,
        lastPinPrices,
        lastPinNotify: stateData.lastPinNotify || null,
        lastPositionNotify: stateData.lastPositionNotify || null,
        risingSnap: stateData.risingSnap || [],
        risingSnapSeeded: !!stateData.risingSnapSeeded,
        risingZoneSnap,
        risingZoneSnapSeeded,
        autoPinEvents,
        lastNotifyAt: now,
        updatedAt: Date.now(),
      },
      activeStateFile.sha,
      'Update watch notify state (auto-pin only)',
    );
    console.log('notify skip: empty pins, positions, and notes after auto-pin');
    return {
      ok: true,
      skipped: true,
      reason: 'empty',
      autoPinned,
      autoDropped,
      bstockAutoPinned,
      bstockSide,
      nailGreenAlert,
      balanceAlert,
      staleNailPrune: {
        skipped: !!(staleNailPrune && staleNailPrune.skipped),
        reason: (staleNailPrune && staleNailPrune.reason) || null,
        checked: Number(staleNailPrune && staleNailPrune.checked) || 0,
        candidate: Number(staleNailPrune && staleNailPrune.candidate) || 0,
        removed: Array.isArray(staleNailPrune && staleNailPrune.removed)
          ? staleNailPrune.removed
          : [],
      },
    };
  }

  const symbols = [
    ...new Set([
      ...pins.map((item) => item.symbol),
      ...positions.map((item) => item.symbol),
      ...listBreakHighUniverse(pins, momNotes, new Set()),
    ]),
  ];
  const tickers = await fetchBinanceTickers(symbols);

  const sent = [];
  const sendErrors = [];

  // 边沿日志先落盘，避免排序快照耗时/失败影响捕捉记录。
  if (autoPinned.length || autoDropped.length) {
    try {
      await appendAutoPinActionLog(
        now,
        autoPinned,
        autoDropped,
        autoPinMomNotes,
      );
    } catch (error) {
      console.warn('auto-pin action log failed', error.message || error);
    }
  }

  let notesRankSnap = null;
  try {
    notesRankSnap = await runNotesRankSnap({
      pins,
      notes: momNotes,
      tickers,
      now,
      appendActionLog: appendActionLogEntries,
    });
    console.log('notes-rank snap', JSON.stringify(notesRankSnap));
  } catch (error) {
    console.warn(
      'notes-rank snap failed',
      error && error.message ? error.message : error,
    );
  }

  // Build + send positions first. Pin momentum/charts can timeout or hit WeCom
  // rate limits when many pins are up; those must not block the 5m position push.
  const { text: positionText, nextDropAlerts } = buildPositionReport(
    positions,
    tickers,
    dropAlerts,
    now,
  );
  if (autoPinned.length) {
    try {
      const tag = await sendAutoPinAlert();
      if (tag) sent.push(tag);
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      sendErrors.push(`auto-pin:${message}`);
      console.warn('auto-pin alert failed', message);
    }
  }

  // 持仓：只写网页 lastPositionNotify，不再发企微（持仓群改发自动盯）。
  if (positionText) {
    sent.push('positions-page');
  }

  let pinRows = listPinCandidateRows(pins, tickers);
  if (pinRows.length) {
    await attachPinWindowGain(pinRows);
    pinRows = filterPinWindowUp(pinRows);
  }
  // Cap before momentum/charts so a large pin set cannot blow the time budget.
  const pinCap = limitPinNotifyRows(pinRows);
  pinRows = pinCap.rows;
  if (pinRows.length) {
    await attachPinMomentum(pinRows);
    attachPriceVsLast(pinRows, lastPinPrices);
  }
  const pinText = pinRows.length
    ? buildPinReport(pinRows, { totalUp: pinCap.totalUp })
    : null;

  // 盯一下：只写网页 lastPinNotify，不再发企微 / 拼图。
  const momentumHits = pinRows
    .filter((row) => row.streak5 || row.heat15)
    .map((row) => ({
      symbol: row.symbol,
      streak5: row.streak5,
      heat15: row.heat15,
    }));
  if (pinText) {
    sent.push('pins-page');
  }

  // 破点高：只写 GitHub 供网页「动态」浮窗，不再发企微。
  let chartSymbols = [];
  let breakHighHits = [];
  let breakHighSkipped = true;
  try {
    const breakResult = await evaluateBreakHigh({
      pins,
      notes: momNotes,
      tickers,
      now,
    });
    breakHighSkipped = !!breakResult.skipped;
    breakHighHits = breakResult.hits || [];
    if (!breakResult.skipped) {
      try {
        await persistBreakHigh(
          breakResult.state,
          breakResult.sha,
          breakHighHits.length
            ? `Break-high ${breakHighHits.length}`
            : 'Break-high check',
        );
        sent.push(
          breakHighHits.length
            ? `break-high-page:${breakHighHits.length}`
            : 'break-high-page:empty',
        );
      } catch (error) {
        const message = error && error.message ? error.message : String(error);
        sendErrors.push(`break-high-save:${message}`);
        console.warn('persist break-high failed', message);
      }
    } else {
      console.log('break-high skipped: cooldown');
    }
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    sendErrors.push(`break-high:${message}`);
    console.warn('break-high failed', message);
  }

  let nailDailyReset = { skipped: true, reason: 'not-run' };
  try {
    nailDailyReset = await runNailDailyReset({ now });
    if (!nailDailyReset.skipped && nailDailyReset.reason === 'ok') {
      sent.push(`nail-daily-reset:${nailDailyReset.updatedCount || 0}`);
    }
    console.log('nail-daily-reset', JSON.stringify(nailDailyReset));
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    sendErrors.push(`nail-daily-reset:${message}`);
    console.warn('nail-daily-reset failed', message);
  }

  let holdings = { skipped: true, reason: 'not-run' };
  try {
    holdings = await runHoldingsSync({ now, context: context || null });
    if (!holdings.skipped && holdings.reason === 'ok') {
      sent.push(`holdings:${holdings.updated || 0}`);
    }
    console.log('holdings', JSON.stringify(holdings));
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    sendErrors.push(`holdings:${message}`);
    console.warn('holdings failed', message);
  }

  let sellTasks = { skipped: true, reason: 'not-run' };
  try {
    sellTasks = await runSellTasks({ now, context: context || null });
    if (!sellTasks.skipped && sellTasks.reason === 'ok') {
      if (sellTasks.live && sellTasks.placed) {
        sent.push(`sell-live:${sellTasks.placed}`);
      } else if (sellTasks.dryRun) {
        sent.push(`sell-dry:${sellTasks.dryRun}`);
      }
      if (sellTasks.filled) sent.push(`sell-fill:${sellTasks.filled}`);
    }
    console.log('sell-tasks', JSON.stringify(sellTasks));
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    sendErrors.push(`sell-tasks:${message}`);
    console.warn('sell-tasks failed', message);
  }

  let buyTasks = { skipped: true, reason: 'not-run' };
  try {
    buyTasks = await runBuyTasks({ now, context: context || null });
    if (!buyTasks.skipped && buyTasks.reason === 'ok') {
      if (buyTasks.live && buyTasks.placed) {
        sent.push(`buy-live:${buyTasks.placed}`);
      } else if (buyTasks.dryRun) {
        sent.push(`buy-dry:${buyTasks.dryRun}`);
      }
      if (buyTasks.filled) sent.push(`buy-fill:${buyTasks.filled}`);
    }
    console.log('buy-tasks', JSON.stringify(buyTasks));
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    sendErrors.push(`buy-tasks:${message}`);
    console.warn('buy-tasks failed', message);
  }

  // nailGreenAlert / balanceAlert 已在空仓早退前跑过；此处只汇总到 sent。
  if (nailGreenAlert && nailGreenAlert.hits) {
    sent.push(`nail-green-page:${nailGreenAlert.hits}`);
  }
  if (nailGreenAlert && nailGreenAlert.errors && nailGreenAlert.errors.length) {
    sendErrors.push(...nailGreenAlert.errors.slice(0, 5));
  }
  if (balanceAlert && balanceAlert.sent) {
    sent.push(`balance/straight:${balanceAlert.sent}`);
  }
  if (balanceAlert && balanceAlert.errors && balanceAlert.errors.length) {
    sendErrors.push(...balanceAlert.errors.slice(0, 5));
  }

  // 网页盯一下文案更新即推进 lastPinPrices（@@@ 相对上次网页公布价）。
  const nextPinPrices = pinText
    ? nextLastPinPrices(lastPinPrices, pinRows)
    : lastPinPrices;
  const prevNotify =
    (activeStateFile &&
      activeStateFile.data &&
      activeStateFile.data.lastPinNotify) ||
    null;
  const prevPositionNotify =
    (activeStateFile &&
      activeStateFile.data &&
      activeStateFile.data.lastPositionNotify) ||
    null;
  const lastPinNotify = pinText
    ? {
        at: now,
        markdown: pinText,
        symbols: pinRows.map((row) => row.symbol),
      }
    : prevNotify;
  // 无持仓时清空，避免网页企微 tab 一直显示上次文案。
  const lastPositionNotify = positionText
    ? {
        at: now,
        text: positionText,
        symbols: positions.map((item) => item.symbol),
      }
    : null;
  // 网页持仓文案更新时同步推进跌破冷却（不再依赖企微发送成功）。
  const dropAlertsToSave = positionText ? nextDropAlerts : dropAlerts;
  const stateChanged =
    JSON.stringify(dropAlertsToSave) !== JSON.stringify(dropAlerts) ||
    JSON.stringify(nextPinPrices) !== JSON.stringify(lastPinPrices) ||
    JSON.stringify(lastPinNotify) !== JSON.stringify(prevNotify) ||
    JSON.stringify(lastPositionNotify) !== JSON.stringify(prevPositionNotify) ||
    JSON.stringify(risingZoneSnap) !==
      JSON.stringify(stateData.risingZoneSnap || []) ||
    risingZoneSnapSeeded !== !!stateData.risingZoneSnapSeeded ||
    JSON.stringify(autoPinEvents) !==
      JSON.stringify(stateData.autoPinEvents || []);
  if (
    stateChanged ||
    sent.length ||
    sendErrors.length ||
    autoPinned.length ||
    autoDropped.length
  ) {
    await saveJson(
      CONFIG.NOTIFY_STATE_PATH,
      {
        dropAlerts: dropAlertsToSave,
        lastPinPrices: nextPinPrices,
        lastPinNotify,
        lastPositionNotify,
        risingSnap: stateData.risingSnap || [],
        risingSnapSeeded: !!stateData.risingSnapSeeded,
        risingZoneSnap,
        risingZoneSnapSeeded,
        autoPinEvents,
        lastNotifyAt: now,
        updatedAt: Date.now(),
      },
      activeStateFile.sha,
      'Update watch notify state',
    );
  }

  // 返回/日志不要带整表 pins，否则控制台会被撑爆。
  const staleNailPruneSummary = {
    skipped: !!(staleNailPrune && staleNailPrune.skipped),
    reason: (staleNailPrune && staleNailPrune.reason) || null,
    checked: Number(staleNailPrune && staleNailPrune.checked) || 0,
    candidate: Number(staleNailPrune && staleNailPrune.candidate) || 0,
    removed: Array.isArray(staleNailPrune && staleNailPrune.removed)
      ? staleNailPrune.removed
      : [],
    errors: Array.isArray(staleNailPrune && staleNailPrune.errors)
      ? staleNailPrune.errors.slice(0, 5)
      : [],
  };

  console.log(
    'notify done',
    JSON.stringify({
      pins: pins.length,
      positions: positions.length,
      notes: momNotes.length,
      sent,
      charts: chartSymbols,
      momentum: momentumHits,
      breakHighSkipped,
      breakHighHits: breakHighHits.map((hit) => hit.symbol),
      dropsArmed: Object.keys(dropAlertsToSave).length,
      autoPinned,
      autoDropped,
      notesRankSnap,
      nailDailyReset,
      holdings,
      sellTasks,
      buyTasks,
      nailGreenAlert,
      balanceAlert,
      staleNailPrune: staleNailPruneSummary,
      bstockAutoPinned,
      bstockAutoDropped,
      bstockAutoPinNails: bstockAutoPinNails.length,
      bstockAutoPinMomNotes: bstockAutoPinMomNotes.length,
      bstockPriceAlertStats,
      bstockSide,
      sendErrors,
    }),
  );

  return {
    ok: true,
    pins: pins.length,
    positions: positions.length,
    notes: momNotes.length,
    sent,
    charts: chartSymbols,
    momentum: momentumHits,
    breakHighSkipped,
    breakHighHits: breakHighHits.map((hit) => hit.symbol),
    autoPinned,
    autoDropped,
    notesRankSnap,
    nailDailyReset,
    holdings,
    sellTasks,
    buyTasks,
    nailGreenAlert,
    balanceAlert,
    staleNailPrune: staleNailPruneSummary,
    bstockAutoPinned,
    bstockAutoDropped,
    bstockPriceAlertStats,
    bstockSide,
    sendErrors,
  };
}

module.exports = {
  main,
  handler: main,
  buildPinReport,
  buildPositionReport,
  listPinUpRows,
  listPinCandidateRows,
  limitPinNotifyRows,
  attachPinMomentum,
  attachPinWindowGain,
  filterPinDoubleUp,
  filterPinWindowUp,
  attachPriceVsLast,
  momentumFromCloses,
  closedCloses,
  lastBarRises,
};
