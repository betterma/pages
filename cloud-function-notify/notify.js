'use strict';

const {
  loadJson,
  saveJson,
  fetchBinanceTickers,
  sendWecomText,
  sendWecomMarkdown,
  sendWecomImage,
} = require('./github-wecom');
const { buildTopChartsCollage } = require('./kline-chart');

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
  PIN_CHART_TOP: Number(process.env.PIN_CHART_TOP || 3),
  // Skip duplicate runs if another invoke already sent within this window.
  NOTIFY_DEBOUNCE_MS: Number(process.env.NOTIFY_DEBOUNCE_MS || 90 * 1000),
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

function listPinUpRows(pins, tickers) {
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
      };
    })
    .filter(
      (row) =>
        Number.isFinite(row.change) &&
        row.change > 0 &&
        Number.isFinite(row.current) &&
        Number.isFinite(row.pinPrice),
    )
    .sort((a, b) => {
      if (b.change !== a.change) return b.change - a.change;
      return b.pinnedAt - a.pinnedAt;
    });
}

function buildPinReport(pins, tickers) {
  const rows = listPinUpRows(pins, tickers);
  if (!rows.length) return null;

  const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const blocks = [time, ''];

  rows.forEach((row, index) => {
    const day = Number.isFinite(row.change24h)
      ? formatPercent(row.change24h)
      : '--';
    // WeCom markdown only has 3 colors; "comment" is gray / lighter.
    blocks.push(
      `${labelOf(row.symbol)}  <font color="comment">${day}</font>`,
    );
    blocks.push(
      `【${formatPercent(row.change)}】  ${formatPrice(row.pinPrice)}->${formatPrice(row.current)}`,
    );
    if (index < rows.length - 1) {
      blocks.push('<font color="comment">----------</font>');
      blocks.push('');
    } else {
      blocks.push('');
    }
  });

  return blocks.join('\n').trimEnd();
}

async function sendTopPinCharts(rows, webhook) {
  const topN = Math.max(0, CONFIG.PIN_CHART_TOP || 3);
  if (!topN || !rows.length || !webhook) return [];
  const top = rows.slice(0, topN);
  try {
    const collage = await buildTopChartsCollage(top);
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

  const [pinsFile, positionsFile, stateFile] = await Promise.all([
    loadJson(CONFIG.PINS_PATH),
    loadJson(CONFIG.POSITIONS_PATH),
    loadJson(CONFIG.NOTIFY_STATE_PATH),
  ]);

  const now = Date.now();
  const lock = await tryAcquireNotifyLock(stateFile, now);
  if (!lock.acquired) {
    console.log('notify skip: duplicate invoke', JSON.stringify(lock));
    return { ok: true, skipped: true, reason: lock.reason, lock };
  }

  let activeStateFile = lock.stateFile || stateFile;
  const pins = normalizePins(pinsFile.data && pinsFile.data.pins);
  const positions = normalizePositions(
    positionsFile.data && positionsFile.data.positions,
  );
  let dropAlerts = lock.dropAlerts || {};

  if (!pins.length && !positions.length) {
    console.log('notify skip: empty pins and positions');
    return { ok: true, skipped: true, reason: 'empty' };
  }

  const symbols = [
    ...new Set([
      ...pins.map((item) => item.symbol),
      ...positions.map((item) => item.symbol),
    ]),
  ];
  const tickers = await fetchBinanceTickers(symbols);

  const pinRows = listPinUpRows(pins, tickers);
  const pinText = pinRows.length ? buildPinReport(pins, tickers) : null;
  const { text: positionText, nextDropAlerts } = buildPositionReport(
    positions,
    tickers,
    dropAlerts,
    now,
  );

  const sent = [];
  let chartSymbols = [];
  if (pinText) {
    if (!CONFIG.WECOM_WEBHOOK_PINS) {
      console.warn('pin report skipped: missing WECOM_WEBHOOK_PINS');
    } else {
      await sendWecomMarkdown(pinText, CONFIG.WECOM_WEBHOOK_PINS);
      sent.push('pins');
      chartSymbols = await sendTopPinCharts(
        pinRows,
        CONFIG.WECOM_WEBHOOK_PINS,
      );
      if (chartSymbols.length) sent.push(`charts:${chartSymbols.length}`);
    }
  }
  if (positionText) {
    if (!CONFIG.WECOM_WEBHOOK_POSITIONS) {
      console.warn('position report skipped: missing WECOM_WEBHOOK_POSITIONS');
    } else {
      await sendWecomText(positionText, CONFIG.WECOM_WEBHOOK_POSITIONS);
      sent.push('positions');
    }
  }

  const stateChanged =
    JSON.stringify(nextDropAlerts) !== JSON.stringify(dropAlerts);
  if (stateChanged) {
    await saveJson(
      CONFIG.NOTIFY_STATE_PATH,
      {
        dropAlerts: nextDropAlerts,
        lastNotifyAt: now,
        updatedAt: Date.now(),
      },
      activeStateFile.sha,
      'Update watch notify drop alert cooldown',
    );
  }

  console.log(
    'notify done',
    JSON.stringify({
      pins: pins.length,
      positions: positions.length,
      sent,
      charts: chartSymbols,
      dropsArmed: Object.keys(nextDropAlerts).length,
    }),
  );

  return {
    ok: true,
    pins: pins.length,
    positions: positions.length,
    sent,
    charts: chartSymbols,
  };
}

module.exports = {
  main,
  buildPinReport,
  buildPositionReport,
  listPinUpRows,
};
