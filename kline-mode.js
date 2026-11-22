/**
 * Binance 观察池档案（现货 crypto）。
 * 路径集中在此，供 kline.html 读取。
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
      NAILS_PATH: "watch-nails.json",
      POSITIONS_PATH: "watch-positions.json",
      PRICE_ALERTS_PATH: "watch-price-alerts.json",
      NOTIFY_STATE_PATH: "watch-notify-state.json",
      NOTES_RANK_PREFS_PATH: "watch-notes-rank-prefs.json",
      HOME_PREFS_PATH: "watch-home-prefs.json",
      NAIL_GREEN_NOTICES_PATH: "watch-nail-green-notices.json",
      NAIL_DAILY_RESET_PATH: "watch-nail-daily-reset.json",
      HOLDINGS_PATH: "watch-holdings.json",
      SELL_TASKS_PATH: "watch-sell-tasks.json",
      BUY_TASKS_PATH: "watch-buy-tasks.json",
    },
  };

  const PROFILES = { crypto: CRYPTO };

  function resolveMode() {
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
