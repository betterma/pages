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
    const nameLine = lines[nameIdx].replace(/<[^>]+>/g, "").trim();
    const label = /^([A-Za-z0-9]+)/.exec(nameLine)?.[1];
    const pinPct = /【([+\-]?\d+(?:\.\d+)?)%】/.exec(lines[nameIdx + 1]);
    const pinPrice = Number(lines[nameIdx + 2]);
    const cur = /^([0-9.]+)/.exec(lines[nameIdx + 3]);
    if (!label || !pinPct || !Number.isFinite(pinPrice) || !cur) continue;
    rows.push({
      symbol: `${label}USDT`,
      label,
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
      time: item.time,
      pinChange: row.pinChange,
      current: row.current,
    });
  }
}
for (const pts of series.values()) pts.sort((a, b) => a.at - b.at);

const HOUR = 60 * 60 * 1000;
const TOL = 12 * 60 * 1000; // accept ~48–72m lookback if exact 1h missing

function change1h(points, index) {
  const cur = points[index];
  const target = cur.at - HOUR;
  // nearest sample within TOL of 1h ago
  let best = null;
  let bestDiff = Infinity;
  for (let j = index - 1; j >= 0; j -= 1) {
    const diff = Math.abs(points[j].at - target);
    if (points[j].at < target - TOL) break;
    if (diff < bestDiff) {
      bestDiff = diff;
      best = points[j];
    }
  }
  if (!best || !Number.isFinite(best.current) || best.current <= 0) return null;
  if (bestDiff > TOL) return null;
  return ((cur.current - best.current) / best.current) * 100;
}

function avg(nums) {
  const xs = nums.filter((n) => Number.isFinite(n));
  if (!xs.length) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function med(nums) {
  const xs = nums.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const m = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[m] : (xs[m - 1] + xs[m]) / 2;
}

/**
 * Validation windows for winners:
 * - climb: from first time pinChange>=5% until peak (the "going up" phase)
 * - prePeak1h: last 1 hour before peak
 * For others: all samples where we can compute 1h change
 */
const winnerRows = [];
const otherClimbLike = []; // others when pinChange between 5 and 25 (similar "climbing but not exploded")
const otherAll = [];

for (const [symbol, points] of series) {
  const isWinner = WINNERS.has(symbol);
  const peak = peakAt.get(symbol);

  for (let i = 0; i < points.length; i += 1) {
    const c1 = change1h(points, i);
    if (c1 == null) continue;
    const p = points[i];

    if (isWinner) {
      const startClimb = points.findIndex((x) => x.pinChange >= 5);
      const inClimb =
        startClimb >= 0 &&
        p.at >= points[startClimb].at &&
        (!peak || p.at <= peak);
      const inPrePeak1h = peak && p.at <= peak && p.at >= peak - HOUR;
      if (inClimb) {
        winnerRows.push({
          symbol,
          phase: "climb",
          c1,
          pinChange: p.pinChange,
          time: p.time,
        });
      }
      if (inPrePeak1h) {
        winnerRows.push({
          symbol,
          phase: "prePeak1h",
          c1,
          pinChange: p.pinChange,
          time: p.time,
        });
      }
    } else {
      otherAll.push(c1);
      if (p.pinChange >= 5 && p.pinChange < 25) otherClimbLike.push(c1);
    }
  }
}

function pack(label, values) {
  return {
    label,
    n: values.filter((v) => Number.isFinite(v)).length,
    avg: avg(values) != null ? Number(avg(values).toFixed(2)) : null,
    med: med(values) != null ? Number(med(values).toFixed(2)) : null,
    sharePos:
      values.length > 0
        ? Number(
            (
              (values.filter((v) => v > 0).length / values.length) *
              100
            ).toFixed(1),
          )
        : null,
    shareGt2:
      values.length > 0
        ? Number(
            (
              (values.filter((v) => v >= 2).length / values.length) *
              100
            ).toFixed(1),
          )
        : null,
  };
}

const byWinnerClimb = new Map();
const byWinnerPre = new Map();
for (const row of winnerRows) {
  const map = row.phase === "climb" ? byWinnerClimb : byWinnerPre;
  if (!map.has(row.symbol)) map.set(row.symbol, []);
  map.get(row.symbol).push(row.c1);
}

const perWinner = winnersMeta.winners.map((w) => {
  const climb = byWinnerClimb.get(w.symbol) || [];
  const pre = byWinnerPre.get(w.symbol) || [];
  // best 1h change observed during climb
  const bestClimb = climb.length ? Math.max(...climb) : null;
  const avgClimb = avg(climb);
  const avgPre = avg(pre);
  return {
    label: w.label,
    maxPin: w.maxPinChangePercent,
    peakTime: w.peakTime,
    climbSamples: climb.length,
    avg1hDuringClimb: avgClimb != null ? Number(avgClimb.toFixed(2)) : null,
    best1hDuringClimb: bestClimb != null ? Number(bestClimb.toFixed(2)) : null,
    avg1hInHourBeforePeak: avgPre != null ? Number(avgPre.toFixed(2)) : null,
    // Did climb-phase average 1h beat "other climbing" median?
    beatOthersClimbMed: avgClimb != null && avgClimb > (med(otherClimbLike) || 0),
  };
});

const summary = {
  method:
    "Approx 1h % change from notify archive: current vs nearest same-symbol price ~1h earlier (±12m).",
  groups: {
    winnersDuringClimb: pack(
      "赢家：盯幅≥5% 到见顶（往上爬的阶段）",
      winnerRows.filter((r) => r.phase === "climb").map((r) => r.c1),
    ),
    winnersHourBeforePeak: pack(
      "赢家：见顶前 1 小时",
      winnerRows.filter((r) => r.phase === "prePeak1h").map((r) => r.c1),
    ),
    othersClimbing5to25: pack(
      "其他：盯幅在 +5%~+25%（也在爬但没到大肉）",
      otherClimbLike,
    ),
    othersAll: pack("其他：全部可算 1h 的快照", otherAll),
  },
  perWinner,
};

fs.writeFileSync(
  path.join(root, "wecom-1h-momentum-validation.json"),
  JSON.stringify(summary, null, 2),
  "utf8",
);

const lines = [];
lines.push("验证：近1小时涨幅 是否在大肉币「往上爬」时更强");
lines.push("");
for (const g of Object.values(summary.groups)) {
  lines.push(
    `${g.label}: n=${g.n} 平均=${g.avg}% 中位=${g.med}% 正收益占比=${g.sharePos}% ≥+2%占比=${g.shareGt2}%`,
  );
}
lines.push("");
lines.push("各赢家（爬升阶段）");
for (const w of perWinner) {
  lines.push(
    `${w.label.padEnd(12)} max盯幅=${w.maxPin}%  爬升期近1h均=${w.avg1hDuringClimb}%  爬升期最好近1h=${w.best1hDuringClimb}%  见顶前1h均=${w.avg1hInHourBeforePeak}%  强过「其他爬升」中位? ${w.beatOthersClimbMed ? "是" : "否"}`,
  );
}
console.log(lines.join("\n"));
