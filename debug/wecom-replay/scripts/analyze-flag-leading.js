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

const WINNER_SET = new Set(winnersMeta.winners.map((w) => w.symbol));
const PEAK_AT = new Map(
  winnersMeta.winners.map((w) => {
    const item = archive.items.find((x) => x.time === w.peakTime);
    return [w.symbol, item ? item.at : null];
  }),
);

/** Parse one notify markdown into per-coin rows with 5m / @@@ flags. */
function parseNotify(markdown) {
  const text = String(markdown || "").replace(/\r/g, "");
  // Cut trailing 5m summary section (names only, already captured via info color).
  const cut = text.search(/\n<font color="comment">----------<\/font>\s*\n\s*\n<font color="info">5m<\/font>/i);
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

    // Find name line (may include font tags)
    let nameIdx = -1;
    for (let i = 0; i < lines.length; i += 1) {
      if (/【[+\-]?\d/.test(lines[i + 1] || "")) {
        nameIdx = i;
        break;
      }
    }
    if (nameIdx < 0 || nameIdx + 3 >= lines.length) continue;

    const nameLine = lines[nameIdx];
    const pctLine = lines[nameIdx + 1];
    const pinLine = lines[nameIdx + 2];
    const curLine = lines[nameIdx + 3];

    const info = /<font color="info">([A-Za-z0-9]+)<\/font>/i.exec(nameLine);
    const warn = /<font color="warning">([A-Za-z0-9]+)<\/font>/i.exec(nameLine);
    const plain = /^([A-Za-z0-9]+)\b/.exec(
      nameLine.replace(/<[^>]+>/g, "").trim(),
    );
    const label = (info && info[1]) || (warn && warn[1]) || (plain && plain[1]);
    if (!label) continue;

    const pinPct = /【([+\-]?\d+(?:\.\d+)?)%】/.exec(pctLine);
    const pinPrice = Number(pinLine);
    const cur = /^([0-9.]+)(@{3})?$/.exec(curLine);
    if (!pinPct || !Number.isFinite(pinPrice) || !cur) continue;

    rows.push({
      label,
      symbol: `${label}USDT`,
      pinChange: Number(pinPct[1]),
      pinPrice,
      current: Number(cur[1]),
      is5m: !!info, // WeCom green name = 5m three-up (streak5)
      is15mOnly: !!warn && !info,
      isAt: !!cur[2],
    });
  }
  return rows;
}

// symbol -> [{ at, time, pinChange, is5m, isAt, ... }]
const series = new Map();

for (const item of archive.items) {
  for (const row of parseNotify(item.markdown)) {
    if (!series.has(row.symbol)) series.set(row.symbol, []);
    series.get(row.symbol).push({
      at: item.at,
      time: item.time,
      pinChange: row.pinChange,
      is5m: row.is5m,
      isAt: row.isAt,
      is15mOnly: row.is15mOnly,
      pinPrice: row.pinPrice,
      current: row.current,
    });
  }
}

function summarizeWindow(points) {
  if (!points.length) {
    return {
      samples: 0,
      hours: 0,
      count5m: 0,
      countAt: 0,
      countEither: 0,
      dens5m: null,
      densAt: null,
      densEither: null,
      rate5mPerHour: null,
      rateAtPerHour: null,
    };
  }
  const samples = points.length;
  const hours = Math.max(
    (points[points.length - 1].at - points[0].at) / 3600000,
    samples * (5 / 60), // notify cadence fallback
  );
  const count5m = points.filter((p) => p.is5m).length;
  const countAt = points.filter((p) => p.isAt).length;
  const countEither = points.filter((p) => p.is5m || p.isAt).length;
  return {
    samples,
    hours: Number(hours.toFixed(2)),
    count5m,
    countAt,
    countEither,
    dens5m: Number((count5m / samples).toFixed(3)),
    densAt: Number((countAt / samples).toFixed(3)),
    densEither: Number((countEither / samples).toFixed(3)),
    rate5mPerHour: Number((count5m / hours).toFixed(3)),
    rateAtPerHour: Number((countAt / hours).toFixed(3)),
  };
}

/** Early window: from first sample until pinChange first reaches `untilPct` (exclusive of that bar's after — include bars with pinChange < untilPct). */
function earlyWindow(points, untilPct) {
  const idx = points.findIndex((p) => p.pinChange >= untilPct);
  if (idx < 0) return points.slice(); // never reached — whole series as "early/all"
  return points.slice(0, Math.max(idx, 1)); // at least first bar; bars before crossing
}

function beforePeak(points, peakAt) {
  if (!peakAt) return points.slice();
  return points.filter((p) => p.at <= peakAt);
}

function avgField(list, key) {
  const vals = list.map((x) => x[key]).filter((v) => v != null && Number.isFinite(v));
  if (!vals.length) return null;
  return Number((vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(3));
}

function medianField(list, key) {
  const vals = list
    .map((x) => x[key])
    .filter((v) => v != null && Number.isFinite(v))
    .sort((a, b) => a - b);
  if (!vals.length) return null;
  const mid = Math.floor(vals.length / 2);
  return vals.length % 2
    ? vals[mid]
    : Number(((vals[mid - 1] + vals[mid]) / 2).toFixed(3));
}

const EARLY_PCT = 10; // 「明显涨幅」初期：盯幅还没到 +10%

const perSymbol = [];
for (const [symbol, points] of series) {
  points.sort((a, b) => a.at - b.at);
  const isWinner = WINNER_SET.has(symbol);
  const maxPin = Math.max(...points.map((p) => p.pinChange));
  const early = earlyWindow(points, EARLY_PCT);
  const toPeak = isWinner
    ? beforePeak(points, PEAK_AT.get(symbol))
    : points.slice();

  const earlyStats = summarizeWindow(early);
  const toPeakStats = summarizeWindow(toPeak);
  const allStats = summarizeWindow(points);

  perSymbol.push({
    symbol,
    label: symbol.replace(/USDT$/i, ""),
    isWinner,
    maxPinChange: Number(maxPin.toFixed(2)),
    earlyUntilPct: EARLY_PCT,
    early: earlyStats,
    toPeakOrAll: toPeakStats,
    all: allStats,
    firstTime: points[0].time,
    peakTime: isWinner
      ? (winnersMeta.winners.find((w) => w.symbol === symbol) || {}).peakTime
      : null,
  });
}

const winners = perSymbol.filter((s) => s.isWinner).sort((a, b) => b.maxPinChange - a.maxPinChange);
const others = perSymbol.filter((s) => !s.isWinner);

function groupRollup(list, windowKey) {
  const rows = list.map((s) => s[windowKey]);
  return {
    n: list.length,
    avgSamples: avgField(rows, "samples"),
    avgCount5m: avgField(rows, "count5m"),
    avgCountAt: avgField(rows, "countAt"),
    avgDens5m: avgField(rows, "dens5m"),
    avgDensAt: avgField(rows, "densAt"),
    avgDensEither: avgField(rows, "densEither"),
    medDens5m: medianField(rows, "dens5m"),
    medDensAt: medianField(rows, "densAt"),
    medDensEither: medianField(rows, "densEither"),
    avgRate5mPerHour: avgField(rows, "rate5mPerHour"),
    avgRateAtPerHour: avgField(rows, "rateAtPerHour"),
  };
}

const report = {
  question:
    "Do ≥25% pin-gain winners show more 5m / @@@ flags before or in early stage of the run?",
  definitions: {
    is5m: 'WeCom name color=info (5m three-up / streak5)',
    isAt: "current price line ends with @@@ (above last notify price)",
    earlyWindow: `samples from first notify appearance until pinChange first reaches +${EARLY_PCT}% (bars still < ${EARLY_PCT}%)`,
    toPeakWindow: "winners: first appearance → peak 【盯幅】 time; others: all samples",
    density: "flag hits / samples in that window (0~1)",
    ratePerHour: "flag hits / elapsed hours in window",
  },
  groupCompare: {
    early: {
      winners: groupRollup(winners, "early"),
      others: groupRollup(others, "early"),
    },
    toPeakOrAll: {
      winners: groupRollup(winners, "toPeakOrAll"),
      others: groupRollup(others, "toPeakOrAll"),
    },
    all: {
      winners: groupRollup(winners, "all"),
      others: groupRollup(others, "all"),
    },
  },
  winnersDetail: winners.map((w) => ({
    label: w.label,
    maxPinChange: w.maxPinChange,
    firstTime: w.firstTime,
    peakTime: w.peakTime,
    early: w.early,
    toPeak: w.toPeakOrAll,
  })),
  othersTopByEarlyEitherDensity: others
    .slice()
    .sort(
      (a, b) =>
        (b.early.densEither || 0) - (a.early.densEither || 0) ||
        b.maxPinChange - a.maxPinChange,
    )
    .slice(0, 15)
    .map((o) => ({
      label: o.label,
      maxPinChange: o.maxPinChange,
      early: o.early,
    })),
};

const outJson = path.join(root, "wecom-flag-leading-analysis.json");
fs.writeFileSync(outJson, JSON.stringify(report, null, 2), "utf8");

const lines = [];
lines.push("复盘：爆发前/初期的 5m 与 @@@ 密度（赢家 ≥25% vs 其他）");
lines.push("");
lines.push(
  `口径：5m = 企微绿名(info)；@@@ = 现价行后缀；初期 = 盯幅首次达到 +${EARLY_PCT}% 之前`,
);
lines.push("");

function printGroup(title, g) {
  lines.push(`## ${title}`);
  lines.push(
    `赢家 n=${g.winners.n} | 平均密度 5m=${g.winners.avgDens5m} @@@=${g.winners.avgDensAt} 任一=${g.winners.avgDensEither} | 中位密度 5m=${g.winners.medDens5m} @@@=${g.winners.medDensAt}`,
  );
  lines.push(
    `其他 n=${g.others.n} | 平均密度 5m=${g.others.avgDens5m} @@@=${g.others.avgDensAt} 任一=${g.others.avgDensEither} | 中位密度 5m=${g.others.medDens5m} @@@=${g.others.medDensAt}`,
  );
  lines.push(
    `赢家平均次数 5m=${g.winners.avgCount5m} @@@=${g.winners.avgCountAt}（样本均 ${g.winners.avgSamples}）`,
  );
  lines.push(
    `其他平均次数 5m=${g.others.avgCount5m} @@@=${g.others.avgCountAt}（样本均 ${g.others.avgSamples}）`,
  );
  lines.push(
    `每小时频率：赢家 5m=${g.winners.avgRate5mPerHour} @@@=${g.winners.avgRateAtPerHour} ｜ 其他 5m=${g.others.avgRate5mPerHour} @@@=${g.others.avgRateAtPerHour}`,
  );
  lines.push("");
}

printGroup("窗口A：初期（盯幅 < +10%）", report.groupCompare.early);
printGroup("窗口B：赢家到见顶 / 其他全程", report.groupCompare.toPeakOrAll);
printGroup("窗口C：全程", report.groupCompare.all);

lines.push("## 7 个赢家 · 初期明细");
for (const w of report.winnersDetail) {
  const e = w.early;
  lines.push(
    `${w.label.padEnd(12)} max=${String(w.maxPinChange).padStart(6)}%  early样本=${String(e.samples).padStart(3)}  5m=${e.count5m}(dens ${e.dens5m})  @@@=${e.countAt}(dens ${e.densAt})  任一 dens=${e.densEither}  ${w.firstTime} → peak ${w.peakTime}`,
  );
}
lines.push("");
lines.push("## 其他币里「初期任一密度」最高的 15 个（对照：密度高但没到 +25%）");
for (const o of report.othersTopByEarlyEitherDensity) {
  const e = o.early;
  lines.push(
    `${o.label.padEnd(12)} max=${String(o.maxPinChange).padStart(6)}%  early样本=${String(e.samples).padStart(3)}  5m dens=${e.dens5m}  @@@ dens=${e.densAt}  任一=${e.densEither}`,
  );
}

const outTxt = path.join(root, "wecom-flag-leading-analysis.txt");
fs.writeFileSync(outTxt, lines.join("\n"), "utf8");
console.log(lines.join("\n"));
console.log("\nwrote", outTxt);
