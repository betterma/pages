// ==UserScript==
// @name         kline 通知页提醒
// @namespace    https://github.com/betterma/pages
// @version      1.1.0
// @description  轮询 watch-balance-notices.json；新企微批次时桌面通知（切去视频站也可）
// @author       betterma
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_notification
// @grant        GM_openInTab
// @connect      raw.githubusercontent.com
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  const REPO = "betterma/pages";
  const NOTICES_PATH = "watch-balance-notices.json";
  const POLL_MS = 75 * 1000;
  const OPEN_URL = "https://www.zhangyixuan.space/pages/kline.html";
  /** 固定 browsing context 名：已开的 kline 标签认领后，点通知可 focus 复用 */
  const WINDOW_NAME = "pages_kline_balance_notify";
  const STORE_LAST_BATCH = "klineBalanceNotify.lastBatchAt";
  const STORE_LAST_POLL = "klineBalanceNotify.lastPollAt";
  const LOG = "[kline-balance-notify]";

  function isKlinePage() {
    try {
      const path = String(location.pathname || "");
      if (!/\/kline\.html$/i.test(path)) return false;
      // 不要认领 OKX 子页
      if (/\/okx\/kline\.html$/i.test(path)) return false;
      return true;
    } catch (_) {
      return false;
    }
  }

  function claimKlineWindowName() {
    if (!isKlinePage()) return;
    try {
      window.name = WINDOW_NAME;
      console.log(LOG, "claimed window.name for reuse");
    } catch (_) {}
  }

  /**
   * 优先切到已打开的 kline（同名窗）；没有才新开。
   * 跨站只能 focus，不会读 URL，因而也不会强制刷新已开页。
   */
  function openOrFocusKline() {
    let w = null;
    try {
      w = window.open("", WINDOW_NAME);
    } catch (_) {
      w = null;
    }
    if (w && !w.closed) {
      try {
        const href = String((w.location && w.location.href) || "");
        if (!href || href === "about:blank") {
          w.location.href = OPEN_URL;
        }
        w.focus();
        return;
      } catch (_) {
        try {
          w.focus();
        } catch (__) {}
        return;
      }
    }
    try {
      window.open(OPEN_URL, WINDOW_NAME);
    } catch (_) {
      try {
        GM_openInTab(OPEN_URL, { active: true, insert: true });
      } catch (__) {
        window.open(OPEN_URL, "_blank");
      }
    }
  }

  function noticesUrl() {
    return (
      "https://raw.githubusercontent.com/" +
      REPO +
      "/main/" +
      NOTICES_PATH +
      "?t=" +
      Date.now()
    );
  }

  /** 与云函数 / 网页一致：======HH.mm======（本地时区；页面也用本地钟） */
  function formatBatchStamp(ms) {
    const n = Number(ms);
    if (!Number.isFinite(n) || n <= 0) return "======--.--======";
    const d = new Date(n);
    const pad = (v) => String(v).padStart(2, "0");
    return "======" + pad(d.getHours()) + "." + pad(d.getMinutes()) + "======";
  }

  function latestBatch(data) {
    const batches = data && Array.isArray(data.batches) ? data.batches : [];
    if (batches.length) {
      let best = null;
      for (let i = 0; i < batches.length; i++) {
        const row = batches[i];
        const at = Number(row && row.at) || 0;
        if (!(at > 0)) continue;
        if (!best || at > best.at) {
          best = {
            at,
            count: Math.max(0, Number(row.count) || 0),
            symbols: Array.isArray(row.symbols) ? row.symbols : [],
          };
        }
      }
      if (best) {
        if (!(best.count > 0) && best.symbols.length) {
          best.count = best.symbols.length;
        }
        return best;
      }
    }
    const items = data && Array.isArray(data.items) ? data.items : [];
    let maxAt = 0;
    const symbols = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const bat = Number(item && item.batchAt) || 0;
      if (!(bat > 0)) continue;
      if (bat > maxAt) {
        maxAt = bat;
        symbols.length = 0;
      }
      if (bat === maxAt && item && item.symbol) {
        const sym = String(item.symbol).trim().toUpperCase();
        if (sym && symbols.indexOf(sym) < 0) symbols.push(sym);
      }
    }
    if (!(maxAt > 0)) return null;
    return { at: maxAt, count: symbols.length, symbols };
  }

  function fetchNotices() {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "GET",
        url: noticesUrl(),
        timeout: 20000,
        onload(res) {
          if (res.status < 200 || res.status >= 300) {
            reject(new Error("HTTP " + res.status));
            return;
          }
          try {
            resolve(JSON.parse(res.responseText));
          } catch (err) {
            reject(err);
          }
        },
        onerror() {
          reject(new Error("network error"));
        },
        ontimeout() {
          reject(new Error("timeout"));
        },
      });
    });
  }

  function notifyBatch(batch) {
    const n = Math.max(0, Number(batch.count) || 0);
    const stamp = formatBatchStamp(batch.at);
    const title = "通知页 · " + n + "个";
    const text = stamp + (n ? "\n" + n + "个" : "");
    try {
      GM_notification({
        title,
        text,
        timeout: 0,
        onclick() {
          openOrFocusKline();
        },
      });
    } catch (err) {
      console.warn(LOG, "GM_notification failed", err);
    }
  }

  async function pollOnce() {
    const now = Date.now();
    const lastPoll = Number(GM_getValue(STORE_LAST_POLL, 0)) || 0;
    if (lastPoll > 0 && now - lastPoll < POLL_MS - 2000) {
      return;
    }
    GM_setValue(STORE_LAST_POLL, now);

    let data;
    try {
      data = await fetchNotices();
    } catch (err) {
      console.warn(LOG, "fetch failed", err && err.message ? err.message : err);
      return;
    }

    const batch = latestBatch(data);
    const maxAt = batch ? Number(batch.at) || 0 : 0;
    const prevRaw = GM_getValue(STORE_LAST_BATCH, null);
    const seeded = prevRaw !== null && prevRaw !== undefined && prevRaw !== "";
    const prev = seeded ? Number(prevRaw) || 0 : null;

    if (!seeded) {
      GM_setValue(STORE_LAST_BATCH, maxAt);
      console.log(LOG, "seed lastBatchAt=" + maxAt + " (silent)");
      return;
    }

    if (!(maxAt > prev)) {
      return;
    }

    // 先落水位再弹，减轻多标签重复通知。
    GM_setValue(STORE_LAST_BATCH, maxAt);
    console.log(LOG, "new batch", maxAt, "count=" + (batch && batch.count));
    notifyBatch(batch || { at: maxAt, count: 0, symbols: [] });
  }

  function start() {
    claimKlineWindowName();
    pollOnce();
    window.setInterval(pollOnce, POLL_MS);
  }

  start();
})();
