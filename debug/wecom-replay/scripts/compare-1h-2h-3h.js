"use strict";

const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const archive = JSON.parse(
  fs.readFileSync(
    path.join(root, "wecom-notify-archive-from-2026-09-24.json"),
    "utf8",
  ),
);
const winnersMeta = JSON.parse(
  fs.readFileSync(path.join(root, "wecom-pin-gain-gt25.json"), "utf8"),
);

const WINNERS = new Set(winnersMeta.winners.map((w) => w.symbol));
const peakAt = new Map();
for (const w of winnersMeta.winners) {
  const hit = archive.items.find((x) => x.time === w.peakTime);
  peakAt.set(w.symbol, hit ? hit.at : null);
}

function parseNotify(markdown) {
  const text = String(markdown || "").replace(/\r/g, "");
  const cut = text.search(
    /\n<font color="comment">----------<\/font>\s*\n\s*\n<font color="info">5m<\/font>/i,
  );
  const body = cut >= 0 ? text.slice(0, cut) : text;
  const chunks = body
    .split(/<font color="comment">----------<\/font>/i)
    .map((c) => c.trim())
    .filter(Boolean);
  const rows = [];
  for (const chunk of chunks) {
    const lines = chunk
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !/^\d{1,2}:\d{2}:\d{2}$/.test(l));
    let nameIdx = -1;
    for (let i = 0; i < lines.length; i += 1) {
      if (/【[+\-]?\d/.test(lines[i + 1] || "")) {
        nameIdx = i;
        break;
      }
    }
    if (nameIdx < 0 || nameIdx + 3 >= lines.length) continue;
    const label = /^([A-Za-z0-9]+)/.exec(
      lines[nameIdx].replace(/<[^>]+>/g, "").trim(),
    )?.[1];
    const pinPct = /【([+\-]?\d+(?:\.\d+)?)%】/.exec(lines[nameIdx + 1]);
    const cur = /^([0-9.]+)/.exec(lines[nameIdx + 3]);
    if (!label || !pinPct || !cur) continue;
    rows.push({
      symbol: `${label}USDT`,
      pinChange: Number(pinPct[1]),
      current: Number(cur[1]),
    });
  }
  return rows;
}

const series = new Map();
for (const item of archive.items) {
  for (const row of parseNotify(item.markdown)) {
    if (!series.has(row.symbol)) series.set(row.symbol, []);
    series.get(row.symbol).push({
      at: item.at,
      pinChange: row.pinChange,
      current: row.current,
    });
  }
}
for (const pts of series.values()) pts.sort((a, b) => a.at - b.at);

function changeLookback(points, index, hours) {
  const cur = points[index];
  const target = cur.at - hours * 3600 * 1000;
  const tol = 12 * 60 * 1000;
  let best = null;
  let bestDiff = Infinity;
  for (let j = index - 1; j >= 0; j -= 1) {
    const diff = Math.abs(points[j].at - target);
    if (points[j].at < target - tol) break;
    if (diff < bestDiff) {
      bestDiff = diff;
      best = points[j];
    }
  }
  if (!best || best.current <= 0 || bestDiff > tol) return null;
  return ((cur.current - best.current) / best.current) * 100;
}

function avg(xs) {
  const a = xs.filter(Number.isFinite);
  return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
}
function med(xs) {
  const a = xs.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function pack(values) {
  const xs = values.filter(Number.isFinite);
  return {
    n: xs.length,
    avg: avg(xs) != null ? Number(avg(xs).toFixed(2)) : null,
    med: med(xs) != null ? Number(med(xs).toFixed(2)) : null,
    shareGt2:
      xs.length > 0
        ? Number(((xs.filter((v) => v >= 2).length / xs.length) * 100).toFixed(1))
        : null,
  };
}

const HORIZONS = [1, 2, 3];
const result = {};

for (const h of HORIZONS) {
  const winClimb = [];
  const otherClimb = [];
  const perWinnerAvg = [];

  for (const [symbol, points] of series) {
    const isWinner = WINNERS.has(symbol);
    const peak = peakAt.get(symbol);
    const vals = [];

    for (let i = 0; i < points.length; i += 1) {
      const c = changeLookback(points, i, h);
      if (c == null) continue;
      const p = points[i];

      if (isWinner) {
        const start = points.findIndex((x) => x.pinChange >= 5);
        const inClimb =
          start >= 0 &&
          p.at >= points[start].at &&
          (!peak || p.at <= peak);
        if (inClimb) {
          winClimb.push(c);
          vals.push(c);
        }
      } else if (p.pinChange >= 5 && p.pinChange < 25) {
        otherClimb.push(c);
      }
    }

    if (isWinner && vals.length) {
      perWinnerAvg.push({
        symbol,
        avg: avg(vals),
        beatOtherMed: avg(vals) > (med(otherClimb) || 0),
      });
    }
  }

  const w = pack(winClimb);
  const o = pack(otherClimb);
  const sepAvg = w.avg != null && o.avg != null ? w.avg - o.avg : null;
  const sepMed = w.med != null && o.med != null ? w.med - o.med : null;
  // normalize separation by horizon length → "per hour edge"
  const sepAvgPerHour = sepAvg != null ? sepAvg / h : null;

  result[`${h}h`] = {
    winnersClimb: w,
    othersClimb5to25: o,
    separationAvg: sepAvg != null ? Number(sepAvg.toFixed(2)) : null,
    separationMed: sepMed != null ? Number(sepMed.toFixed(2)) : null,
    separationAvgPerHour:
      sepAvgPerHour != null ? Number(sepAvgPerHour.toFixed(2)) : null,
    winnersBeatingOtherMed: `${perWinnerAvg.filter((x) => x.beatOtherMed).length}/${perWinnerAvg.length}`,
  };
}

console.log(JSON.stringify(result, null, 2));
fs.writeFileSync(
  path.join(root, "wecom-horizon-compare.json"),
  JSON.stringify(result, null, 2),
);
