'use strict';

const {
  loadJson,
  saveJson,
  fetchBinancePrices,
  sendWecomText,
} = require('./github-wecom');

const CONFIG = {
  PINS_PATH: process.env.PINS_PATH || 'watch-pins.json',
  POSITIONS_PATH: process.env.POSITIONS_PATH || 'watch-positions.json',
  NOTIFY_STATE_PATH: process.env.NOTIFY_STATE_PATH || 'watch-notify-state.json',
  // Pin report → WECOM_WEBHOOK_PINS (fallback: WECOM_WEBHOOK_URL)
  // Position / drop alert → WECOM_WEBHOOK_POSITIONS (fallback: WECOM_WEBHOOK_URL)
  WECOM_WEBHOOK_PINS:
    process.env.WECOM_WEBHOOK_PINS || process.env.WECOM_WEBHOOK_URL || '',
  WECOM_WEBHOOK_POSITIONS:
    process.env.WECOM_WEBHOOK_POSITIONS || process.env.WECOM_WEBHOOK_URL || '',
  DROP_THRESHOLD: Number(process.env.DROP_THRESHOLD || 0.05),
  DROP_COOLDOWN_MS: Number(
    process.env.DROP_COOLDOWN_MS || 2 * 60 * 60 * 1000,
  ),
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

function buildPinReport(pins, prices) {
  const rows = pins
    .map((item) => {
      const current = prices[item.symbol];
      const change = changeFrom(item.pinPrice, current);
      return { ...item, current, change };
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

  if (!rows.length) return null;

  const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const blocks = [
    `【盯一下】${time} · 上涨 ${rows.length}`,
    '',
  ];

  rows.forEach((row) => {
    blocks.push(`${labelOf(row.symbol)} ${formatPercent(row.change)}`);
    blocks.push(
      `${formatPrice(row.pinPrice)} → ${formatPrice(row.current)}`,
    );
    blocks.push('');
  });

  return blocks.join('\n').trimEnd();
}

function buildPositionReport(positions, prices, dropAlerts, now) {
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
    const current = prices[item.symbol];
    const change = changeFrom(item.buyPrice, current);
    return { ...item, current, change };
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
    blocks.push(`${name} ${formatPercent(row.change)}`);
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

async function main() {
  if (!CONFIG.WECOM_WEBHOOK_PINS && !CONFIG.WECOM_WEBHOOK_POSITIONS) {
    throw new Error(
      'Missing WECOM_WEBHOOK_PINS / WECOM_WEBHOOK_POSITIONS (or WECOM_WEBHOOK_URL)',
    );
  }

  const [pinsFile, positionsFile, stateFile] = await Promise.all([
    loadJson(CONFIG.PINS_PATH),
    loadJson(CONFIG.POSITIONS_PATH),
    loadJson(CONFIG.NOTIFY_STATE_PATH),
  ]);

  const pins = normalizePins(pinsFile.data && pinsFile.data.pins);
  const positions = normalizePositions(
    positionsFile.data && positionsFile.data.positions,
  );
  const dropAlerts =
    (stateFile.data && stateFile.data.dropAlerts) || {};

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
  const prices = await fetchBinancePrices(symbols);
  const now = Date.now();

  const pinText = buildPinReport(pins, prices);
  const { text: positionText, nextDropAlerts } = buildPositionReport(
    positions,
    prices,
    dropAlerts,
    now,
  );

  const sent = [];
  if (pinText) {
    if (!CONFIG.WECOM_WEBHOOK_PINS) {
      console.warn('pin report skipped: missing WECOM_WEBHOOK_PINS');
    } else {
      await sendWecomText(pinText, CONFIG.WECOM_WEBHOOK_PINS);
      sent.push('pins');
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
        updatedAt: now,
      },
      stateFile.sha,
      'Update watch notify drop alert cooldown',
    );
  }

  console.log(
    'notify done',
    JSON.stringify({
      pins: pins.length,
      positions: positions.length,
      sent,
      dropsArmed: Object.keys(nextDropAlerts).length,
    }),
  );

  return {
    ok: true,
    pins: pins.length,
    positions: positions.length,
    sent,
  };
}

module.exports = { main, buildPinReport, buildPositionReport };
