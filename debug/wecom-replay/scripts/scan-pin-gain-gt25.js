"use strict";

const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const archivePath = path.join(
  root,
  "wecom-notify-archive-from-2026-09-24.json",
);
const outJson = path.join(root, "wecom-pin-gain-gt25.json");
const outTxt = path.join(root, "wecom-pin-gain-gt25.txt");

const THRESHOLD = 25; // percent

function stripFont(text) {
  return String(text || "")
    .replace(/<font\s+color="[^"]*">/gi, "")
    .replace(/<\/font>/gi, "");
}

function parseBlocks(markdown) {
  const text = stripFont(markdown).replace(/\r/g, "");
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && line !== "----------");

  // Drop leading HH:MM:SS clock line.
  if (lines[0] && /^\d{1,2}:\d{2}:\d{2}$/.test(lines[0])) {
    lines.shift();
  }

  // Trailing "5m" momentum section — stop before it.
  const fiveIdx = lines.findIndex((line) => line === "5m");
  const body = fiveIdx >= 0 ? lines.slice(0, fiveIdx) : lines;

  const rows = [];
  for (let i = 0; i + 3 < body.length; ) {
    const nameLine = body[i];
    const pctLine = body[i + 1];
    const pinLine = body[i + 2];
    const curLine = body[i + 3];

    const nameMatch = nameLine.match(/^([A-Za-z0-9]+)(?:\s+([+\-]?\d+(?:\.\d+)?%))?/);
    const pinPctMatch = pctLine.match(/^【([+\-]?\d+(?:\.\d+)?)%】$/);
    const pinPrice = Number(pinLine);
    const curMatch = curLine.match(/^([0-9.]+)(@{3})?$/);

    if (!nameMatch || !pinPctMatch || !Number.isFinite(pinPrice) || !curMatch) {
      // Resync: advance one line.
      i += 1;
      continue;
    }

    const label = nameMatch[1];
    const change24h = nameMatch[2] ? Number(nameMatch[2].replace("%", "")) : null;
    const pinChange = Number(pinPctMatch[1]);
    const current = Number(curMatch[1]);
    const priceUpVsLast = !!curMatch[2];

    rows.push({
      label,
      symbol: `${label}USDT`,
      change24h: Number.isFinite(change24h) ? change24h : null,
      pinChange,
      pinPrice,
      current,
      priceUpVsLast,
    });
    i += 4;
  }
  return rows;
}

const archive = JSON.parse(fs.readFileSync(archivePath, "utf8"));
const bySymbol = new Map();

for (const item of archive.items || []) {
  const rows = parseBlocks(item.markdown);
  for (const row of rows) {
    let stats = bySymbol.get(row.symbol);
    if (!stats) {
      stats = {
        symbol: row.symbol,
        label: row.label,
        samples: 0,
        maxPinChange: -Infinity,
        maxAt: null,
        maxTime: null,
        maxPinPrice: null,
        maxCurrent: null,
        firstAt: item.at,
        firstTime: item.time,
        firstPinPrice: row.pinPrice,
        lastAt: item.at,
        lastTime: item.time,
        lastPinPrice: row.pinPrice,
        lastCurrent: row.current,
        lastPinChange: row.pinChange,
      };
      bySymbol.set(row.symbol, stats);
    }
    stats.samples += 1;
    stats.lastAt = item.at;
    stats.lastTime = item.time;
    stats.lastPinPrice = row.pinPrice;
    stats.lastCurrent = row.current;
    stats.lastPinChange = row.pinChange;
    if (row.pinChange > stats.maxPinChange) {
      stats.maxPinChange = row.pinChange;
      stats.maxAt = item.at;
      stats.maxTime = item.time;
      stats.maxPinPrice = row.pinPrice;
      stats.maxCurrent = row.current;
    }
  }
}

const winners = [...bySymbol.values()]
  .filter((item) => Number.isFinite(item.maxPinChange) && item.maxPinChange >= THRESHOLD)
  .sort((a, b) => b.maxPinChange - a.maxPinChange);

const summary = {
  source: archivePath,
  method:
    "From each WeCom pin notify snapshot, parse 【pinChange%】 = (current-pinPrice)/pinPrice. Per symbol take max 【】 over 2026-09-24 04:00 → archive end. Threshold >= 25%.",
  caveats: [
    "Only moments when the coin was in pin-window-up notify list (not continuous ticks).",
    "If pin was renewed, pinPrice resets; max is best observed vs the then-current pinPrice.",
    "Images ignored; position alerts not included.",
  ],
  thresholdPercent: THRESHOLD,
  symbolUniverse: bySymbol.size,
  winnerCount: winners.length,
  winners: winners.map((item, index) => ({
    rank: index + 1,
    symbol: item.symbol,
    label: item.label,
    maxPinChangePercent: Number(item.maxPinChange.toFixed(2)),
    peakTime: item.maxTime,
    peakPinPrice: item.maxPinPrice,
    peakCurrent: item.maxCurrent,
    samplesInArchive: item.samples,
    firstSeen: item.firstTime,
    lastSeen: item.lastTime,
  })),
};

fs.writeFileSync(outJson, JSON.stringify(summary, null, 2), "utf8");

const lines = [];
lines.push(
  `盯住后最高涨幅 ≥ ${THRESHOLD}%（基于企微归档快照里的【盯幅】）`,
);
lines.push(`样本币种数：${bySymbol.size} · 达标：${winners.length}`);
lines.push("");
lines.push(
  "排名 | 币种 | 最高盯幅 | 出现时刻 | 当时盯住价 → 现价 | 归档出现次数",
);
lines.push("-".repeat(72));
for (const item of summary.winners) {
  lines.push(
    `${String(item.rank).padStart(2, " ")} | ${item.label.padEnd(14, " ")} | ${String(item.maxPinChangePercent).padStart(7, " ")}% | ${item.peakTime} | ${item.peakPinPrice} → ${item.peakCurrent} | ${item.samplesInArchive}`,
  );
}
fs.writeFileSync(outTxt, lines.join("\n"), "utf8");

console.log(JSON.stringify({
  universe: bySymbol.size,
  winners: winners.length,
  top10: summary.winners.slice(0, 10),
}, null, 2));
console.log("wrote", outTxt);
