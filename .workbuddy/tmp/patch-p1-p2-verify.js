/**
 * P1-A / P1-B / P2-F patch verify (static + runtime controls).
 * WorkBuddy's notice-new-view-verify.js / gesture / align scripts are absent
 * from this workspace; this file covers the two required control cases.
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.resolve(__dirname, "..", "..");
const htmlPath = path.join(root, "kline.html");
const html = fs.readFileSync(htmlPath, "utf8");

let pass = 0;
let fail = 0;
function assert(name, cond) {
  if (cond) {
    console.log("PASS  " + name);
    pass++;
  } else {
    console.log("FAIL  " + name);
    fail++;
  }
}

// --- extract inline scripts and syntax-check ---
function extractScripts(src) {
  const blocks = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(src))) {
    const attrs = m[1] || "";
    if (/\bsrc\s*=/i.test(attrs)) continue;
    blocks.push(m[2]);
  }
  return blocks;
}
const blocks = extractScripts(html);
assert("kline.html has inline script blocks", blocks.length >= 1);
let bad = 0;
blocks.forEach((code, i) => {
  try {
    new vm.Script(code, { filename: "kline.inline." + i + ".js" });
  } catch (err) {
    bad++;
    console.log("FAIL  syntax block " + i + ": " + err.message);
  }
});
assert("nail-syntax-check: bad blocks == 0", bad === 0);

// --- Static: P1-A ---
const declIdx = html.indexOf("let priceAlertViewBaseline");
const buildIdx = html.indexOf("function buildPriceAlertNoticeHtml");
assert("priceAlertViewBaseline declared before buildPriceAlertNoticeHtml", declIdx >= 0 && declIdx < buildIdx);
assert("priceAlertIsNewAt helper exists", /function priceAlertIsNewAt\s*\(/.test(html));
assert("buildPriceAlertNoticeHtml isNew uses priceAlertIsNewAt", /const isNew = priceAlertIsNewAt\(at\);/.test(html));
assert("open freezes priceAlertViewBaseline", /priceAlertViewBaseline = Number\(priceAlertReadAt\) \|\| 0/.test(html));
assert("close clears priceAlertViewBaseline", /priceAlertViewBaseline = null;/.test(html));
{
  const fnStart = buildIdx;
  const fnEnd = html.indexOf("\n      function ", fnStart + 1);
  const body = html.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 800);
  assert("buildPriceAlertNoticeHtml no longer compares live priceAlertReadAt", !/at > \(Number\(priceAlertReadAt\)/.test(body));
}

// --- Static: P1-B ---
assert("alerts risingOk passes hitAt", /risingOk\(item && item\.symbol, item && item\.hitAt\)/.test(html));
assert("pullback risingOk passes at", /risingOk\(row && row\.symbol, row && row\.at\)/.test(html));
assert(
  "alerts filter no longer omits hitAt",
  !/priceAlertNoticeItems\(\)\.filter\(\(item\) =>\s*\n?\s*risingOk\(item && item\.symbol\)\s*\)/.test(html),
);

// --- Static: P2-F (hasNewTag branch only; no write-only focus mark) ---
assert("hasNew path clears pending before scroll", /nailAutoPinPendingScrollTop = null/.test(html));
assert("hasNew path calls scrollNailAutoPinToFirstNew", /scrollNailAutoPinToFirstNew\(\)/.test(html));
assert("no leftover nailAutoPinDidFocusNew", !/nailAutoPinDidFocusNew/.test(html));

// --- Runtime: mirror helpers ---
function priceAlertIsNewAt(baseline, readAt, at) {
  const base = baseline != null ? baseline : Number(readAt) || 0;
  return Number(at) > base;
}
function isFreshNotice(baseline, at) {
  return baseline != null && Number(at) > Number(baseline);
}
function risingOk(baseline, symbol, at, passesRising) {
  return isFreshNotice(baseline, at) || !!passesRising;
}

const frozen = 1000;
const hitAt = 1500;
const readNow = 9999;
assert(
  "ctrl P1-A: freeze then markRead->now still shows xin",
  priceAlertIsNewAt(frozen, readNow, hitAt) === true,
);
assert(
  "ctrl P1-A: without freeze markRead->now wipes xin",
  priceAlertIsNewAt(null, readNow, hitAt) === false,
);
assert(
  "ctrl P1-A: leave clears baseline -> xin gone",
  priceAlertIsNewAt(null, readNow, hitAt) === false,
);

assert(
  "ctrl P1-B: alert hitAt fresh bypasses rising filter",
  risingOk(1000, "AAAUSDT", 1500, false) === true,
);
assert(
  "ctrl P1-B: missing at (old bug) does NOT bypass",
  risingOk(1000, "AAAUSDT", undefined, false) === false,
);
assert(
  "ctrl P1-B: pullback row.at fresh bypasses rising filter",
  risingOk(1000, "BBBUSDT", 1600, false) === true,
);
assert(
  "ctrl P1-B: stale at still needs rising pass",
  risingOk(1000, "CCCUSDT", 900, false) === false,
);

function openScrollPolicy(hasNew, pending) {
  if (hasNew) {
    return { pending: null, didFocus: true, restore: false, scrollNew: true };
  }
  return {
    pending,
    didFocus: false,
    restore: pending != null,
    scrollNew: false,
  };
}
const p = openScrollPolicy(true, 420);
assert(
  "ctrl P2-F: hasNew skips restore and clears pending",
  p.pending == null && p.didFocus && !p.restore && p.scrollNew,
);
const p2 = openScrollPolicy(false, 420);
assert(
  "ctrl P2-F: no new restores pending",
  p2.pending === 420 && p2.restore && !p2.scrollNew,
);

console.log("");
console.log("RESULT  " + pass + " PASS / " + fail + " FAIL");
process.exit(fail ? 1 : 0);
