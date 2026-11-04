/**
 * Binance 观察池档案：crypto（普通现货）/ bstock（代币化美股）。
 * kline.html 与 bstock-kline.html 共用；路径与宇宙过滤都从这里取。
 */
(function (root) {
  "use strict";

  const CRYPTO = {
    id: "crypto",
    title: "观察池 K 线",
    titleNotes: "观察池 K 线 · 记一笔",
    label: "币安现货",
    universe: "crypto",
    paths: {
      GITHUB_PATH: "watch-data.json",
      FAVORITES_PATH: "watch-favorites.json",
      BLACKLIST_PATH: "watch-blacklist.json",
      PINS_PATH: "watch-pins.json",
      MOM_NOTES_PATH: "watch-mom-notes.json",
      ACTION_LOG_PATH: "watch-action-log.json",
      CARD_EGGS_PATH: "watch-card-eggs.json",
      BREAK_HIGH_PATH: "watch-break-high.json",
      NAILS_PATH: "watch-nails.json",
      POSITIONS_PATH: "watch-positions.json",
      PRICE_ALERTS_PATH: "watch-price-alerts.json",
      NOTIFY_STATE_PATH: "watch-notify-state.json",
      NOTES_RANK_PREFS_PATH: "watch-notes-rank-prefs.json",
      HOME_PREFS_PATH: "watch-home-prefs.json",
      NAIL_GREEN_NOTICES_PATH: "watch-nail-green-notices.json",
      NAIL_DAILY_RESET_PATH: "watch-nail-daily-reset.json",
      // 持仓/买卖任务跟真实币安账户走同一份，页面侧再按宇宙过滤展示。
      HOLDINGS_PATH: "watch-holdings.json",
      SELL_TASKS_PATH: "watch-sell-tasks.json",
      BUY_TASKS_PATH: "watch-buy-tasks.json",
    },
  };

  const BSTOCK = {
    id: "bstock",
    title: "bStock 观察池 K 线",
    titleNotes: "bStock 观察池 · 记一笔",
    label: "bStock",
    universe: "bstock",
    paths: {
      GITHUB_PATH: "watch-bstock-data.json",
      FAVORITES_PATH: "watch-bstock-favorites.json",
      BLACKLIST_PATH: "watch-bstock-blacklist.json",
      PINS_PATH: "watch-bstock-pins.json",
      MOM_NOTES_PATH: "watch-bstock-mom-notes.json",
      ACTION_LOG_PATH: "watch-bstock-action-log.json",
      CARD_EGGS_PATH: "watch-bstock-card-eggs.json",
      BREAK_HIGH_PATH: "watch-bstock-break-high.json",
      NAILS_PATH: "watch-bstock-nails.json",
      POSITIONS_PATH: "watch-bstock-positions.json",
      PRICE_ALERTS_PATH: "watch-bstock-price-alerts.json",
      NOTIFY_STATE_PATH: "watch-bstock-notify-state.json",
      NOTES_RANK_PREFS_PATH: "watch-bstock-notes-rank-prefs.json",
      HOME_PREFS_PATH: "watch-bstock-home-prefs.json",
      NAIL_GREEN_NOTICES_PATH: "watch-bstock-nail-green-notices.json",
      NAIL_DAILY_RESET_PATH: "watch-bstock-nail-daily-reset.json",
      HOLDINGS_PATH: "watch-holdings.json",
      SELL_TASKS_PATH: "watch-sell-tasks.json",
      BUY_TASKS_PATH: "watch-buy-tasks.json",
    },
  };

  const PROFILES = { crypto: CRYPTO, bstock: BSTOCK };

  function resolveMode() {
    try {
      if (root.KLINE_MODE === "bstock" || root.KLINE_MODE === "crypto") {
        return root.KLINE_MODE;
      }
    } catch (_) {
      /* ignore */
    }
    try {
      const path = String(
        (root.location && root.location.pathname) || "",
      ).toLowerCase();
      if (path.indexOf("bstock-kline") >= 0) return "bstock";
      const q = new URLSearchParams(
        (root.location && root.location.search) || "",
      );
      const mode = String(q.get("mode") || "").toLowerCase();
      if (mode === "bstock") return "bstock";
    } catch (_) {
      /* ignore */
    }
    return "crypto";
  }

  function getProfile(mode) {
    return PROFILES[mode] || CRYPTO;
  }

  root.KlineMode = {
    PROFILES,
    resolveMode,
    getProfile,
  };
})(typeof window !== "undefined" ? window : globalThis);
