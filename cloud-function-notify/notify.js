'use strict';

const {
  loadJson,
  saveJson,
  fetchBinancePrices,
  sendWecomMarkdown,
} = require('./github-wecom');

const CONFIG = {
  PINS_PATH: process.env.PINS_PATH || 'watch-pins.json',
  POSITIONS_PATH: process.env.POSITIONS_PATH || 'watch-positions.json',
  NOTIFY_STATE_PATH: process.env.NOTIFY_STATE_PATH || 'watch-notify-state.json',
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

function colorPercent(change) {
  const text = formatPercent(change);
  if (!Number.isFinite(change) || change === 0) {
    return `<font color="comment">${text}</font>`;
  }
  if (change > 0) return `<font color="info">${text}</font>`;
  return `<font color="warning">${text}</font>`;
}

function padName(name) {
  const raw = String(name || '');
  return `\`${raw.padEnd(6, ' ')}\``;
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
    .sort((a, b) => {
      const hasA = Number.isFinite(a.change);
      const hasB = Number.isFinite(b.change);
      if (hasA && hasB && b.change !== a.change) return b.change - a.change;
      if (hasA !== hasB) return hasA ? -1 : 1;
      return b.pinnedAt - a.pinnedAt;
    });

  if (!rows.length) return null;

  let up = 0;
  let down = 0;
  let flat = 0;
  rows.forEach((row) => {
    if (!Number.isFinite(row.change) || row.change === 0) flat += 1;
    else if (row.change > 0) up += 1;
    else down += 1;
  });

  const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const lines = [
    `### 盯一下`,
    `>${time} · 共${rows.length} · <font color="info">涨${up}</font> / <font color="warning">跌${down}</font> / <font color="comment">平${flat}</font>`,
    `>`,
  ];

  rows.forEach((row) => {
    const name = padName(labelOf(row.symbol));
    if (!Number.isFinite(row.current) || !Number.isFinite(row.pinPrice)) {
      lines.push(
        `>${name} 盯${formatPrice(row.pinPrice)} <font color="comment">现价缺失</font>`,
      );
      return;
    }
    lines.push(
      `>${name} \`${formatPrice(row.pinPrice)} → ${formatPrice(row.current)}\` ${colorPercent(row.change)}`,
    );
  });

  return lines.join('\n');
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
    if (
      Number.isFinite(item.change) &&
      item.change <= -threshold * 100
    ) {
      const lastAt = Number(nextDropAlerts[item.symbol]) || 0;
      if (!lastAt || now - lastAt >= cooldown) {
        drops.push(
          `**${labelOf(item.symbol)}** 跌破${(threshold * 100).toFixed(0)}%（${formatPercent(item.change)}）`,
        );
        nextDropAlerts[item.symbol] = now;
      }
    }
  });

  const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const lines = [
    `### 持仓`,
    `>${time} · 共${rows.length}`,
    `>`,
  ];

  rows.forEach((row) => {
    const name = padName(labelOf(row.symbol));
    if (!Number.isFinite(row.current)) {
      lines.push(
        `>${name} 买\`${formatPrice(row.buyPrice)}\` <font color="comment">现价缺失</font>`,
      );
      return;
    }
    lines.push(
      `>${name} 买\`${formatPrice(row.buyPrice)}\` 现\`${formatPrice(row.current)}\` ${colorPercent(row.change)}`,
    );
  });

  if (drops.length) {
    lines.push(`>`);
    lines.push(`>**⚠️ 跌破告警**`);
    drops.forEach((line) => lines.push(`>${line}`));
  }

  return { text: lines.join('\n'), nextDropAlerts };
}

async function main() {
  if (!process.env.WECOM_WEBHOOK_URL) {
    throw new Error('Missing WECOM_WEBHOOK_URL');
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
    await sendWecomMarkdown(pinText);
    sent.push('pins');
  }
  if (positionText) {
    await sendWecomMarkdown(positionText);
    sent.push('positions');
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
