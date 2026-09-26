"use strict";

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const since = process.argv[2] || "2026-09-24 04:00:00";
const cutoff = new Date("2026-09-24T04:00:00+08:00").getTime();
const outDir = path.resolve(__dirname, "..");
const repoRoot = path.resolve(__dirname, "../..");

const hashes = execSync(
  `git log --format=%H --since="${since}" --grep="Update watch notify state" -- watch-notify-state.json`,
  { encoding: "utf8", maxBuffer: 50 * 1024 * 1024, cwd: repoRoot },
)
  .trim()
  .split(/\r?\n/)
  .filter(Boolean);

console.log("commits", hashes.length);

const byAt = new Map();
let errors = 0;

for (const hash of hashes) {
  try {
    const raw = execSync(`git show ${hash}:watch-notify-state.json`, {
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const data = JSON.parse(raw);
    const notify = data && data.lastPinNotify;
    if (!notify || !notify.markdown) continue;
    const at = Number(notify.at) || 0;
    if (!at || byAt.has(at)) continue;
    byAt.set(at, {
      at,
      commit: hash,
      symbols: Array.isArray(notify.symbols) ? notify.symbols : [],
      markdown: String(notify.markdown),
    });
  } catch (error) {
    errors += 1;
  }
}

const filtered = [...byAt.values()]
  .filter((item) => item.at >= cutoff)
  .sort((a, b) => a.at - b.at);

const out = {
  source: "git history of watch-notify-state.json → lastPinNotify",
  since,
  cutoffIso: new Date(cutoff).toISOString(),
  note:
    "Text/markdown only; chart images are not stored. Covers pin-watch WeCom markdown snapshots (not position-drop text alerts). Deduped by lastPinNotify.at.",
  count: filtered.length,
  items: filtered.map((item) => ({
    at: item.at,
    time: new Date(item.at).toLocaleString("zh-CN", {
      hour12: false,
      timeZone: "Asia/Shanghai",
    }),
    commit: item.commit,
    symbols: item.symbols,
    markdown: item.markdown,
  })),
};

const jsonPath = path.join(outDir, "wecom-notify-archive-from-2026-09-24.json");
const txtPath = path.join(outDir, "wecom-notify-archive-from-2026-09-24.txt");
fs.writeFileSync(jsonPath, JSON.stringify(out, null, 2), "utf8");

const stripWecomFont = (text) =>
  String(text || "")
    .replace(/<font\s+color="(?:info|warning|comment)">/gi, "")
    .replace(/<\/font>/gi, "");

const lines = [];
for (const item of out.items) {
  lines.push(`======== ${item.time} (${item.at}) ========`);
  lines.push(stripWecomFont(item.markdown));
  lines.push("");
}
fs.writeFileSync(txtPath, lines.join("\n"), "utf8");

console.log("unique notifies", filtered.length, "errors", errors);
if (filtered.length) {
  console.log(
    "first",
    new Date(filtered[0].at).toLocaleString("zh-CN", {
      hour12: false,
      timeZone: "Asia/Shanghai",
    }),
  );
  console.log(
    "last",
    new Date(filtered[filtered.length - 1].at).toLocaleString("zh-CN", {
      hour12: false,
      timeZone: "Asia/Shanghai",
    }),
  );
}
console.log("wrote", jsonPath);
console.log("wrote", txtPath);
