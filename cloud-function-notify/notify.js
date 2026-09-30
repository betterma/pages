'use strict';

const {
  loadJson,
  saveJson,
  fetchBinanceTickers,
  sendWecomText,
  sendWecomMarkdown,
  sendWecomImage,
} = require('./github-wecom');
const { buildTopChartsCollage, fetchKlines } = require('./kline-chart');
const { runAutoPin, savePinsFile, normalizePinList } = require('./auto-pin');

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
  // Keep WeCom auto-pin one-liner (optional). Page is the primary surface.
  AUTO_PIN_WECOM:
    String(process.env.AUTO_PIN_WECOM === undefined ? '1' : process.env.AUTO_PIN_WECOM) !==
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

async function main() {
  if (!CONFIG.WECOM_WEBHOOK_PINS && !CONFIG.WECOM_WEBHOOK_POSITIONS) {
    throw new Error(
      'Missing WECOM_WEBHOOK_PINS / WECOM_WEBHOOK_POSITIONS (or WECOM_WEBHOOK_URL)',
    );
  }

  console.log(
    'webhook routing',
    JSON.stringify({
      pins: CONFIG.WECOM_WEBHOOK_PINS
        ? webhookKeyHint(CONFIG.WECOM_WEBHOOK_PINS)
        : null,
      positions: CONFIG.WECOM_WEBHOOK_POSITIONS
        ? webhookKeyHint(CONFIG.WECOM_WEBHOOK_POSITIONS)
        : null,
      sameTarget: WEBHOOKS.sameTarget,
      legacyUsedForPins: WEBHOOKS.legacyUsedForPins,
      legacyUsedForPositions: WEBHOOKS.legacyUsedForPositions,
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

  let autoPinned = [];
  let autoRewarmed = [];
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
    autoRewarmed = autoResult.rewarmed || [];
    if (autoResult.pinsChanged) {
      const parts = [];
      if (autoPinned.length) parts.push(`new ${autoPinned.length}`);
      if (autoRewarmed.length) parts.push(`rewarm ${autoRewarmed.length}`);
      const saved = await savePinsFile(
        pinsFile,
        pins,
        `Auto-pin zone edge: ${parts.join(', ') || 'update'}`,
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

  async function sendAutoPinWecom() {
    if (!CONFIG.AUTO_PIN_WECOM || !CONFIG.WECOM_WEBHOOK_PINS) return null;
    const lines = [];
    if (autoPinned.length) {
      const names = autoPinned
        .slice(0, 12)
        .map((symbol) => labelOf(symbol))
        .join(' · ');
      const more =
        autoPinned.length > 12 ? ` …+${autoPinned.length - 12}` : '';
      lines.push(`【新自动盯】${autoPinned.length}\n${names}${more}`);
    }
    if (autoRewarmed.length) {
      const names = autoRewarmed
        .slice(0, 12)
        .map((symbol) => labelOf(symbol))
        .join(' · ');
      const more =
        autoRewarmed.length > 12 ? ` …+${autoRewarmed.length - 12}` : '';
      lines.push(`【回暖】${autoRewarmed.length}\n${names}${more}`);
    }
    if (!lines.length) return null;
    await sendWecomText(
      `${lines.join('\n')}\n（网页「日志 / 置顶」可看）`,
      CONFIG.WECOM_WEBHOOK_PINS,
    );
    return `auto-pin:${autoPinned.length}+rewarm:${autoRewarmed.length}`;
  }

  if (!pins.length && !positions.length) {
    // Still persist rising zone snap / events so seeding works with empty pins.
    try {
      const tag = await sendAutoPinWecom();
      if (tag) console.log('auto-pin wecom', tag);
    } catch (error) {
      console.warn('auto-pin wecom failed', error.message || error);
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
    console.log('notify skip: empty pins and positions after auto-pin');
    return {
      ok: true,
      skipped: true,
      reason: 'empty',
      autoPinned,
      autoRewarmed,
    };
  }

  const symbols = [
    ...new Set([
      ...pins.map((item) => item.symbol),
      ...positions.map((item) => item.symbol),
    ]),
  ];
  const tickers = await fetchBinanceTickers(symbols);

  // Build + send positions first. Pin momentum/charts can timeout or hit WeCom
  // rate limits when many pins are up; those must not block the 5m position push.
  const { text: positionText, nextDropAlerts } = buildPositionReport(
    positions,
    tickers,
    dropAlerts,
    now,
  );

  const sent = [];
  const sendErrors = [];

  if (autoPinned.length || autoRewarmed.length) {
    try {
      const tag = await sendAutoPinWecom();
      if (tag) sent.push(tag);
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      sendErrors.push(`auto-pin:${message}`);
      console.warn('auto-pin wecom failed', message);
    }
  }

  if (positionText) {
    if (!CONFIG.WECOM_WEBHOOK_POSITIONS) {
      console.warn('position report skipped: missing WECOM_WEBHOOK_POSITIONS');
    } else {
      try {
        await sendWecomText(positionText, CONFIG.WECOM_WEBHOOK_POSITIONS);
        sent.push('positions');
      } catch (error) {
        const message = error && error.message ? error.message : String(error);
        sendErrors.push(`positions:${message}`);
        console.warn('position report failed', message);
      }
    }
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

  let chartSymbols = [];
  const momentumHits = pinRows
    .filter((row) => row.streak5 || row.heat15)
    .map((row) => ({
      symbol: row.symbol,
      streak5: row.streak5,
      heat15: row.heat15,
    }));
  if (pinText) {
    if (!CONFIG.WECOM_WEBHOOK_PINS) {
      console.warn('pin report skipped: missing WECOM_WEBHOOK_PINS');
    } else {
      try {
        await sendWecomMarkdown(pinText, CONFIG.WECOM_WEBHOOK_PINS);
        sent.push('pins');
      } catch (error) {
        const message = error && error.message ? error.message : String(error);
        sendErrors.push(`pins:${message}`);
        console.warn('pin report failed', message);
      }
      try {
        chartSymbols = await sendTopPinCharts(
          pinRows,
          CONFIG.WECOM_WEBHOOK_PINS,
        );
        if (chartSymbols.length) sent.push(`charts:${chartSymbols.length}`);
      } catch (error) {
        const message = error && error.message ? error.message : String(error);
        sendErrors.push(`charts:${message}`);
        console.warn('pin charts failed', message);
      }
    }
  }

  // Only advance last-pin prices when pin markdown actually went out.
  const nextPinPrices = sent.includes('pins')
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
  const lastPinNotify =
    pinText && sent.includes('pins')
      ? {
          at: now,
          markdown: pinText,
          symbols: pinRows.map((row) => row.symbol),
        }
      : prevNotify;
  const lastPositionNotify =
    positionText && sent.includes('positions')
      ? {
          at: now,
          text: positionText,
          symbols: positions.map((item) => item.symbol),
        }
      : prevPositionNotify;
  // Persist drop-alert cooldowns only after a successful position send, so a
  // failed push can retry the same alerts next cycle.
  const dropAlertsToSave = sent.includes('positions')
    ? nextDropAlerts
    : dropAlerts;
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
    autoRewarmed.length
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

  console.log(
    'notify done',
    JSON.stringify({
      pins: pins.length,
      positions: positions.length,
      sent,
      charts: chartSymbols,
      momentum: momentumHits,
      dropsArmed: Object.keys(dropAlertsToSave).length,
      autoPinned,
      autoRewarmed,
      sendErrors,
    }),
  );

  return {
    ok: true,
    pins: pins.length,
    positions: positions.length,
    sent,
    charts: chartSymbols,
    momentum: momentumHits,
    autoPinned,
    autoRewarmed,
    sendErrors,
  };
}

module.exports = {
  main,
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
