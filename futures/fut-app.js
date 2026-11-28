/* 合约三栏：置顶 / 自动盯 / 雷达 — UI 对齐现货钉子；数据仅 futures/* */
(function () {
  "use strict";

  const PATHS = {
    nails: "futures/fut-nails.json",
    autoPins: "futures/fut-auto-pins.json",
    pool: "futures/fut-watch-pool.json",
    state: "futures/fut-notify-state.json",
    prefs: "futures/fut-prefs.json",
    dailyReset: "futures/fut-nail-daily-reset.json",
  };
  const REL = {
    nails: "./fut-nails.json",
    autoPins: "./fut-auto-pins.json",
    pool: "./fut-watch-pool.json",
    state: "./fut-notify-state.json",
    prefs: "./fut-prefs.json",
    dailyReset: "./fut-nail-daily-reset.json",
  };
  const DAILY_RESET_PROMPT_MS = 2 * 60 * 60 * 1000;
  const DAILY_RESET_TZ = "Asia/Shanghai";
  const FAPI_HOSTS = [
    "https://fapi.binance.com",
    "https://fapi1.binance.com",
    "https://fapi2.binance.com",
    "https://fapi3.binance.com",
  ];
  const RADAR_TOP = 80;
  const KLINE_INTERVAL = "4h";
  /** 对齐钉子页默认 3d·4h ≈ 18 根 */
  const KLINE_LIMIT = 18;
  const SHOW_ALL_KEY = "fut_radar_show_all_klines";
  const RADAR_FIXED_KEY = "fut_radar_fixed_v1";
  const RADAR_GROUP_KEY = "fut_radar_group_on";
  const AUTO_PIN_SEEN_KEY = "fut_autopin_seen_v1";
  const AUTO_PIN_BADGE_MS = 24 * 60 * 60 * 1000;
  const SORT_KEY = "fut_pin_sort";
  const PINNED_ONLY_KEY = "fut_pinned_only";
  const AUTO_REFRESH_KEY = "fut_auto_refresh";
  const AUTO_REFRESH_MS = 15 * 1000;
  const LONG_PRESS_MS = 480;
  const ALWAYS_COLLAPSE_KEY = "fut_always_collapsed";
  const NOTE_TIME_MODE_KEY = "fut_nail_note_time_mode_v1";
  /* 对齐钉子页 drawKline 默认（normal 皮肤）：涨灰绿 / 跌灰褐，非行情红绿 */
  const KLINE_UP = "#8a9a96";
  const KLINE_DOWN = "#9a8e88";
  /* 对齐钉子页 NAIL_ALERT_GREEN：便签荧光绿 */
  const KLINE_ALERT_GREEN = "#3ecf8e";
  const KLINE_BAR_MS = 4 * 60 * 60 * 1000;
  const DOUBLE_TAP_MS = 300;
  let noteTimeMode = "original";
  let noteEditorSymbol = null;
  let noteEditorSaving = false;
  try {
    if (localStorage.getItem(NOTE_TIME_MODE_KEY) === "current") {
      noteTimeMode = "current";
    }
  } catch (_) {
    noteTimeMode = "original";
  }
  let futScrollPctHideTimer = 0;
  const ZOOM_ICON =
    '<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>';

  const state = {
    tab: "pin",
    nails: [],
    alwaysWatch: [],
    autoPins: [],
    pool: [],
    poolRank: 35,
    autoPinEvents: [],
    autoPinSeenAt: 0,
    marketMap: {},
    klineCache: {},
    showAllKlines: false,
    radarGroupOn: false,
    radarTickerAt: 0,
    sort: "noteGain",
    pinnedOnly: false,
    autoRefresh: false,
    saving: false,
    radarRows: [],
    radarRankMap: new Map(),
    autoRefreshTimer: 0,
    selectMode: false,
    selected: new Set(),
    floatSymbol: null,
    alwaysCollapsed: false,
    focusSymbol: null,
    /** pin | auto | radar — 决定焦点栏按钮 */
    focusScope: null,
    /** 跳转临时露出：{ symbol, guest }；guest=未在钉子，仅内存不写盘 */
    jumpReveal: null,
    addOpen: false,
    zoomSymbol: null,
    zoomLongRange: "week",
    zoomPaintToken: 0,
    refreshing: false,
    booting: true,
    dailyReset: null,
    dailyResetPromptKind: null,
    dailyResetPromptBusy: false,
    dailyResetCountdownTimer: 0,
  };

  function readLocalFlag(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (raw == null) return fallback;
      return raw;
    } catch (_) {
      return fallback;
    }
  }

  try {
    state.showAllKlines = readLocalFlag(SHOW_ALL_KEY, "0") === "1";
    state.radarGroupOn = readLocalFlag(RADAR_GROUP_KEY, "0") === "1";
    const sort = readLocalFlag(SORT_KEY, "noteGain");
    state.sort =
      sort === "order" || sort === "change24h" || sort === "noteGain"
        ? sort
        : "noteGain";
    state.pinnedOnly = readLocalFlag(PINNED_ONLY_KEY, "0") === "1";
    state.autoRefresh = readLocalFlag(AUTO_REFRESH_KEY, "0") === "1";
    state.alwaysCollapsed = readLocalFlag(ALWAYS_COLLAPSE_KEY, "0") === "1";
  } catch (_) {
    /* ignore */
  }

  function writeLocal(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch (_) {
      /* ignore */
    }
  }

  const $ = (id) => document.getElementById(id);

  function toast(msg) {
    const el = $("toast");
    if (!el) return;
    el.textContent = String(msg || "");
    el.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => {
      el.hidden = true;
    }, 2200);
  }

  function setSaving(on, text) {
    const el = $("futSaving");
    const label = $("futSavingText");
    if (label && text) label.textContent = String(text);
    if (el) el.hidden = !on;
    document.body.classList.toggle("is-fut-saving", !!on);
  }

  function setButtonLoading(btn, on, opts) {
    if (!btn) return;
    const keepDisabled = !!(opts && opts.keepDisabled);
    btn.classList.toggle("is-loading", !!on);
    if (on) {
      btn.setAttribute("aria-busy", "true");
      btn.disabled = true;
    } else {
      btn.removeAttribute("aria-busy");
      if (!keepDisabled) btn.disabled = false;
    }
  }

  function flashListRefresh() {
    const nodes = [
      $("pinList"),
      $("autoList"),
      $("radarTableWrap"),
    ].filter(Boolean);
    nodes.forEach((el) => {
      el.classList.remove("is-refreshing");
      // reflow so animation restarts
      void el.offsetWidth;
      el.classList.add("is-refreshing");
      clearTimeout(el._flashT);
      el._flashT = setTimeout(() => el.classList.remove("is-refreshing"), 600);
    });
  }

  function setRefreshingUi(on) {
    state.refreshing = !!on;
    const meta = $("futMeta");
    if (meta) meta.classList.toggle("is-busy", !!on);
    setButtonLoading($("refreshBtn"), on);
    setButtonLoading($("radarRefreshBtn"), on);
    setButtonLoading($("futFocusRefreshBtn"), on);
    if (on) setSaving(true, state.booting ? "加载中…" : "刷新中…");
    else if (!state.saving && !state.booting) setSaving(false);
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function labelOf(symbol) {
    return String(symbol || "").replace(/USDT$/i, "");
  }

  function symKey(symbol) {
    return String(symbol || "")
      .trim()
      .toUpperCase();
  }

  function fmtPct(n) {
    if (!Number.isFinite(n)) return "--";
    const sign = n > 0 ? "+" : "";
    return sign + n.toFixed(2) + "%";
  }

  function fmtPrice(n) {
    if (!Number.isFinite(n) || !(n > 0)) return "--";
    if (n >= 1000) return n.toFixed(2);
    if (n >= 1) return n.toFixed(4);
    if (n >= 0.01) return n.toFixed(5);
    return Number(n).toPrecision(4);
  }

  function fmtTime(ms) {
    const t = Number(ms) || 0;
    if (!(t > 0)) return "--";
    try {
      return new Date(t).toLocaleString("zh-CN", { hour12: false });
    } catch (_) {
      return "--";
    }
  }

  function fmtClock(ms) {
    const t = Number(ms) || 0;
    if (!(t > 0)) return "--";
    try {
      const d = new Date(t);
      const pad = (v) => String(v).padStart(2, "0");
      return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    } catch (_) {
      return "--";
    }
  }

  function pctClass(n) {
    if (!Number.isFinite(n) || n === 0) return "";
    return n > 0 ? "is-up" : "is-down";
  }

  function radarPctClass(n) {
    if (!Number.isFinite(n) || n === 0) return "";
    return n > 0 ? "fut-radar-up" : "fut-radar-down";
  }

  function normalizeRadarFixedList(raw) {
    const seen = new Set();
    const out = [];
    (Array.isArray(raw) ? raw : []).forEach((s) => {
      const key = symKey(s);
      if (!key || !/USDT$/.test(key) || seen.has(key)) return;
      seen.add(key);
      out.push(key);
    });
    return out;
  }

  let radarFixedState = { symbols: [], at: 0 };
  let radarFixedSyncing = false;

  function loadLocalRadarFixed() {
    try {
      const raw = JSON.parse(localStorage.getItem(RADAR_FIXED_KEY) || "null");
      if (raw && Array.isArray(raw.symbols)) {
        return {
          symbols: normalizeRadarFixedList(raw.symbols),
          at: Number(raw.at) || 0,
        };
      }
      if (Array.isArray(raw)) {
        return { symbols: normalizeRadarFixedList(raw), at: 0 };
      }
    } catch (_) {
      /* ignore */
    }
    return { symbols: [], at: 0 };
  }

  function setLocalRadarFixed(symbols, at) {
    radarFixedState = {
      symbols: normalizeRadarFixedList(symbols),
      at: Number(at) || Date.now(),
    };
    try {
      localStorage.setItem(RADAR_FIXED_KEY, JSON.stringify(radarFixedState));
    } catch (_) {
      /* ignore */
    }
    return radarFixedState.symbols.slice();
  }

  function getRadarFixedSymbols() {
    return radarFixedState.symbols.slice();
  }

  async function patchRadarFixedPrefs(symbols, at) {
    if (radarFixedSyncing) return;
    if (!window.FutStore || typeof window.FutStore.patchJson !== "function") {
      return;
    }
    radarFixedSyncing = true;
    try {
      await window.FutStore.patchJson(
        PATHS.prefs,
        (data) => {
          const cloudAt = Number(data && data.radarFixedAt) || 0;
          if (cloudAt >= at) return { data };
          return {
            data: {
              ...data,
              radarFixedSymbols: normalizeRadarFixedList(symbols),
              radarFixedAt: at,
              updatedAt: Date.now(),
              market: "usdt-perp",
            },
          };
        },
        `Fut radar fixed ${symbols.length}`,
      );
    } catch (error) {
      console.warn("patchRadarFixedPrefs failed", error);
    } finally {
      radarFixedSyncing = false;
    }
  }

  function mergeRadarFixedFromPrefs(prefsData) {
    const cloudSyms = normalizeRadarFixedList(
      prefsData && prefsData.radarFixedSymbols,
    );
    const cloudAt = Number(prefsData && prefsData.radarFixedAt) || 0;
    const local = loadLocalRadarFixed();
    if (cloudAt > local.at) {
      setLocalRadarFixed(cloudSyms, cloudAt);
      return;
    }
    if (local.at > cloudAt && local.symbols.length) {
      setLocalRadarFixed(local.symbols, local.at);
      void patchRadarFixedPrefs(local.symbols, local.at);
      return;
    }
    setLocalRadarFixed(
      local.symbols.length ? local.symbols : cloudSyms,
      Math.max(local.at, cloudAt),
    );
  }

  function toggleRadarFixed(symbol) {
    const key = symKey(symbol);
    if (!key) return;
    const cur = getRadarFixedSymbols();
    const idx = cur.indexOf(key);
    if (idx >= 0) cur.splice(idx, 1);
    else cur.push(key);
    const at = Date.now();
    setLocalRadarFixed(cur, at);
    void patchRadarFixedPrefs(cur, at);
  }

  try {
    radarFixedState = loadLocalRadarFixed();
  } catch (_) {
    radarFixedState = { symbols: [], at: 0 };
  }

  function readLocalAutoPinSeen() {
    try {
      const n = Number(localStorage.getItem(AUTO_PIN_SEEN_KEY));
      return Number.isFinite(n) && n > 0 ? n : 0;
    } catch (_) {
      return 0;
    }
  }

  function writeLocalAutoPinSeen(at) {
    const n = Number(at) > 0 ? Number(at) : Date.now();
    state.autoPinSeenAt = n;
    try {
      localStorage.setItem(AUTO_PIN_SEEN_KEY, String(n));
    } catch (_) {
      /* ignore */
    }
    return n;
  }

  let autoPinSeenSyncing = false;

  async function patchAutoPinSeenPrefs(at) {
    if (autoPinSeenSyncing) return;
    if (!window.FutStore || typeof window.FutStore.patchJson !== "function") {
      return;
    }
    autoPinSeenSyncing = true;
    try {
      await window.FutStore.patchJson(
        PATHS.prefs,
        (data) => {
          const cloudAt = Number(data && data.autoPinSeenAt) || 0;
          if (cloudAt >= at) return { data };
          return {
            data: {
              ...data,
              autoPinSeenAt: at,
              updatedAt: Date.now(),
              market: "usdt-perp",
            },
          };
        },
        `Fut autoPinSeenAt ${at}`,
      );
    } catch (error) {
      console.warn("patchAutoPinSeenPrefs failed", error);
    } finally {
      autoPinSeenSyncing = false;
    }
  }

  function mergeAutoPinSeenFromPrefs(prefsData) {
    const cloudAt = Number(prefsData && prefsData.autoPinSeenAt) || 0;
    const localAt = readLocalAutoPinSeen();
    const next = Math.max(cloudAt, localAt, Number(state.autoPinSeenAt) || 0);
    writeLocalAutoPinSeen(next || 0);
    if (localAt > cloudAt && localAt > 0) {
      void patchAutoPinSeenPrefs(localAt);
    }
  }

  function futAutoPinBadgeEntries() {
    return (Array.isArray(state.autoPinEvents) ? state.autoPinEvents : [])
      .filter((entry) => {
        if (!entry || typeof entry !== "object") return false;
        const kind = String(entry.kind || "");
        // 新进 / 补漏算未读；出池 zone-drop 不亮红点
        if (kind !== "new" && kind !== "catch-up") return false;
        return Array.isArray(entry.symbols) && entry.symbols.length > 0;
      })
      .sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0));
  }

  function futAutoPinLatestAtWithin(windowMs) {
    const cutoff = Date.now() - (Number(windowMs) || 0);
    const hit = futAutoPinBadgeEntries().find((entry) => {
      const at = Number(entry.at) || 0;
      return at >= cutoff;
    });
    return hit ? Number(hit.at) || 0 : 0;
  }

  function futAutoPinUnreadCount() {
    const seen = Number(state.autoPinSeenAt) || readLocalAutoPinSeen() || 0;
    const cutoff = Date.now() - AUTO_PIN_BADGE_MS;
    return futAutoPinBadgeEntries().filter((entry) => {
      const at = Number(entry.at) || 0;
      return at > seen && at >= cutoff;
    }).length;
  }

  function setFutSegBadge(el, count) {
    if (!el) return;
    const n = Math.max(0, Math.floor(Number(count) || 0));
    el.hidden = !(n > 0);
    el.textContent = n > 99 ? "99+" : String(n);
  }

  function writeFutAutoPinSeenAt(at) {
    const n = writeLocalAutoPinSeen(at);
    void patchAutoPinSeenPrefs(n);
    return n;
  }

  function syncFutAutoPinBadge() {
    const badge = $("futAutoPinBadge");
    if (!badge) return;
    const seen = Number(state.autoPinSeenAt) || readLocalAutoPinSeen() || 0;
    // 正在看自动盯分栏 = 记已读，不给自己亮角标
    if (state.tab === "auto") {
      const latest = futAutoPinLatestAtWithin(AUTO_PIN_BADGE_MS);
      if (latest > seen || !(seen > 0)) {
        writeFutAutoPinSeenAt(latest || Date.now());
      }
      setFutSegBadge(badge, 0);
      return;
    }
    if (!(seen > 0)) {
      // 首次：基线拉到最新，避免一进页面就爆红点
      const latest = futAutoPinLatestAtWithin(AUTO_PIN_BADGE_MS);
      writeFutAutoPinSeenAt(latest || Date.now());
      setFutSegBadge(badge, 0);
      return;
    }
    setFutSegBadge(badge, futAutoPinUnreadCount());
  }

  function normalizeNails(raw) {
    const list = Array.isArray(raw) ? raw : [];
    return list
      .map((item, index) => {
        if (!item || typeof item !== "object") return null;
        const symbol = symKey(item.symbol);
        if (!symbol || !/USDT$/.test(symbol)) return null;
        return {
          id: String(item.id || `${symbol}:${index}`),
          symbol,
          label: String(item.label || labelOf(symbol)).trim() || labelOf(symbol),
          note: String(item.note || "").trim(),
          noteAt: Number(item.noteAt) || 0,
          pinned: !!item.pinned,
          pinnedAt: Number(item.pinnedAt) || 0,
          order: Number.isFinite(Number(item.order)) ? Number(item.order) : index,
          at: Number(item.at) || 0,
        };
      })
      .filter(Boolean);
  }

  function normalizeAlways(raw) {
    const seen = new Set();
    const out = [];
    (Array.isArray(raw) ? raw : []).forEach((s) => {
      const key = symKey(s);
      if (!key || seen.has(key)) return;
      seen.add(key);
      out.push(key);
    });
    return out;
  }

  function nailMap() {
    const map = new Map();
    state.nails.forEach((n) => map.set(n.symbol, n));
    return map;
  }

  function isUserPinned(symbol) {
    const n = nailMap().get(symKey(symbol));
    return !!(n && n.pinned);
  }

  function isAlways(symbol) {
    return state.alwaysWatch.includes(symKey(symbol));
  }

  function hasRealNail(symbol) {
    const key = symKey(symbol);
    return state.nails.some((n) => n && n.symbol === key && !n._alwaysWatch);
  }

  function makeAlwaysOrphanItem(key) {
    const sym = symKey(key);
    return {
      id: `always:${sym}`,
      symbol: sym,
      label: labelOf(sym),
      note: "",
      noteAt: 0,
      pinned: false,
      pinnedAt: 0,
      order: 9999,
      at: 0,
      _alwaysWatch: true,
    };
  }

  function jumpRevealKey() {
    return state.jumpReveal && state.jumpReveal.symbol
      ? symKey(state.jumpReveal.symbol)
      : "";
  }

  function isJumpGuest(symbol) {
    const key = symKey(symbol);
    return !!(
      key &&
      state.jumpReveal &&
      state.jumpReveal.guest &&
      jumpRevealKey() === key
    );
  }

  function makeJumpGuestItem(key) {
    const sym = symKey(key);
    return {
      id: `jump:${sym}`,
      symbol: sym,
      label: labelOf(sym),
      note: "",
      noteAt: 0,
      pinned: false,
      pinnedAt: 0,
      order: -1,
      at: 0,
      _jumpGuest: true,
    };
  }

  function clearJumpReveal(opts) {
    if (!state.jumpReveal) return;
    state.jumpReveal = null;
    if (opts && opts.rerender && state.tab === "pin") {
      render();
      void paintVisibleKlines();
    }
  }

  function liveOf(symbol) {
    return state.marketMap[symKey(symbol)] || {};
  }

  function noteGain(n) {
    const note = Number(String(n && n.note).replace(/,/g, ""));
    const price = Number(liveOf(n && n.symbol).price);
    if (!(note > 0) || !(price > 0)) return NaN;
    return ((price / note) - 1) * 100;
  }

  function clampPoolRank(v) {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n)) return 35;
    return Math.max(10, Math.min(100, n));
  }

  function zonedParts(ms, timeZone) {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    const parts = {};
    for (const part of dtf.formatToParts(new Date(ms))) {
      if (part.type !== "literal") parts[part.type] = part.value;
    }
    return {
      year: Number(parts.year),
      month: Number(parts.month),
      day: Number(parts.day),
      hour: Number(parts.hour),
      minute: Number(parts.minute),
      second: Number(parts.second),
    };
  }

  function dayKeyInTz(ms, timeZone) {
    const p = zonedParts(ms, timeZone);
    const pad = (n) => String(n).padStart(2, "0");
    return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
  }

  function startOfDayMsInTz(dayKey, timeZone) {
    const match = String(dayKey || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return 0;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    let utc = Date.UTC(year, month - 1, day, 0, 0, 0);
    for (let i = 0; i < 4; i += 1) {
      const asZone = zonedParts(utc, timeZone);
      const asUtc = Date.UTC(
        asZone.year,
        asZone.month - 1,
        asZone.day,
        asZone.hour,
        asZone.minute,
        asZone.second,
      );
      const wanted = Date.UTC(year, month - 1, day, 0, 0, 0);
      utc += wanted - asUtc;
    }
    return utc;
  }

  function nextDailyResetAt(nowMs, timeZone) {
    const now = Number(nowMs) || Date.now();
    const tz = timeZone || DAILY_RESET_TZ;
    const todayStart = startOfDayMsInTz(dayKeyInTz(now, tz), tz);
    if (!(todayStart > 0)) return 0;
    if (now < todayStart) return todayStart;
    return todayStart + 24 * 60 * 60 * 1000;
  }

  function normalizeDailyReset(raw) {
    const data = raw && typeof raw === "object" ? raw : {};
    const postDismissed =
      Number(data.postPromptDismissedAt) ||
      Number(data.promptDismissedAt) ||
      0;
    return {
      resetDay: String(data.resetDay || "").trim(),
      resetAt: Number(data.resetAt) || 0,
      updatedCount: Number(data.updatedCount) || 0,
      skippedPinned: Number(data.skippedPinned) || 0,
      skippedNoPrice: Number(data.skippedNoPrice) || 0,
      prePromptDismissedAt: Number(data.prePromptDismissedAt) || 0,
      postPromptDismissedAt: postDismissed,
      promptWindowMs:
        Number(data.promptWindowMs) > 0
          ? Number(data.promptWindowMs)
          : DAILY_RESET_PROMPT_MS,
      tz: String(data.tz || DAILY_RESET_TZ),
      updatedAt: Number(data.updatedAt) || 0,
    };
  }

  function dailyResetPromptKind(raw, nowMs) {
    const now = Number(nowMs) || Date.now();
    const data = normalizeDailyReset(raw);
    const windowMs =
      Number(data.promptWindowMs) > 0
        ? Number(data.promptWindowMs)
        : DAILY_RESET_PROMPT_MS;
    const upcoming = nextDailyResetAt(now, data.tz);
    if (
      upcoming > 0 &&
      now >= upcoming - windowMs &&
      now < upcoming &&
      Number(data.prePromptDismissedAt) < upcoming
    ) {
      return "pre";
    }
    const resetAt = Number(data.resetAt) || 0;
    if (
      resetAt > 0 &&
      now >= resetAt &&
      Number(data.postPromptDismissedAt) < resetAt
    ) {
      return "post";
    }
    return null;
  }

  function stopDailyResetCountdown() {
    if (state.dailyResetCountdownTimer) {
      window.clearInterval(state.dailyResetCountdownTimer);
      state.dailyResetCountdownTimer = 0;
    }
  }

  function syncDailyResetCountdownText() {
    const el = $("futDailyResetCountdown");
    if (!el) return;
    if (state.dailyResetPromptKind !== "pre") {
      el.hidden = true;
      return;
    }
    const upcoming = nextDailyResetAt(
      Date.now(),
      (state.dailyReset && state.dailyReset.tz) || DAILY_RESET_TZ,
    );
    const left = Math.max(0, upcoming - Date.now());
    const mins = Math.max(1, Math.ceil(left / 60000));
    el.hidden = false;
    el.textContent = `还有 ${mins} 分钟后重置`;
  }

  function closeDailyResetPrompt() {
    stopDailyResetCountdown();
    state.dailyResetPromptKind = null;
    const dialog = $("futDailyResetDialog");
    if (dialog) dialog.hidden = true;
  }

  function openDailyResetPrompt(raw, kind) {
    state.dailyReset = normalizeDailyReset(raw);
    state.dailyResetPromptKind = kind === "post" ? "post" : "pre";
    const dialog = $("futDailyResetDialog");
    const title = $("futDailyResetTitle");
    const body = $("futDailyResetBody");
    if (!dialog) return;
    if (state.dailyResetPromptKind === "pre") {
      if (title) title.textContent = "即将重置便签";
      if (body) {
        body.textContent =
          "请将需要保留的币先置顶。北京时间 0:00 将对非置顶合约钉子写入便签现价。";
      }
    } else {
      const n = Number(state.dailyReset.updatedCount) || 0;
      const pinned = Number(state.dailyReset.skippedPinned) || 0;
      if (title) title.textContent = "便签已重置";
      if (body) {
        body.textContent =
          n > 0
            ? `今日北京时间 0:00 已对 ${n} 个非置顶合约钉子写入便签现价${pinned ? `（置顶 ${pinned} 个未改）` : ""}。`
            : "今日北京时间 0:00 便签重置已完成（置顶未改）。";
      }
    }
    syncDailyResetCountdownText();
    dialog.hidden = false;
    stopDailyResetCountdown();
    if (state.dailyResetPromptKind === "pre") {
      state.dailyResetCountdownTimer = window.setInterval(() => {
        syncDailyResetCountdownText();
      }, 30000);
    }
  }

  async function maybeShowDailyResetPrompt() {
    if (state.dailyResetPromptBusy) return;
    const dialog = $("futDailyResetDialog");
    if (dialog && !dialog.hidden) return;
    state.dailyResetPromptBusy = true;
    try {
      const file = await window.FutStore.loadLocalOrApi(
        PATHS.dailyReset,
        REL.dailyReset,
      );
      const data = normalizeDailyReset(file && file.data);
      state.dailyReset = data;
      const kind = dailyResetPromptKind(data);
      if (!kind) return;
      openDailyResetPrompt(data, kind);
    } catch (error) {
      console.warn("load fut daily reset prompt failed", error);
    } finally {
      state.dailyResetPromptBusy = false;
    }
  }

  async function dismissDailyResetPrompt() {
    const kind = state.dailyResetPromptKind;
    closeDailyResetPrompt();
    if (!kind || !window.FutStore || typeof window.FutStore.patchJson !== "function") {
      return;
    }
    try {
      const result = await window.FutStore.patchJson(
        PATHS.dailyReset,
        (prev) => {
          const base = normalizeDailyReset(prev);
          if (kind === "pre") {
            const upcoming = nextDailyResetAt(Date.now(), base.tz);
            return {
              data: {
                ...base,
                prePromptDismissedAt: Math.max(
                  Number(base.prePromptDismissedAt) || 0,
                  upcoming,
                ),
                updatedAt: Date.now(),
                market: "usdt-perp",
              },
            };
          }
          const resetAt = Number(base.resetAt) || 0;
          return {
            data: {
              ...base,
              postPromptDismissedAt: Math.max(
                Number(base.postPromptDismissedAt) || 0,
                resetAt,
                Date.now(),
              ),
              updatedAt: Date.now(),
              market: "usdt-perp",
            },
          };
        },
        kind === "pre"
          ? "Dismiss fut nail daily reset pre-prompt"
          : "Dismiss fut nail daily reset post-prompt",
      );
      state.dailyReset = normalizeDailyReset(result && result.data);
    } catch (error) {
      console.warn("dismiss fut daily reset failed", error);
      toast((error && error.message) || "关闭提示失败");
    }
  }

  async function loadAllJson() {
    const Store = window.FutStore;
    const [nailsFile, pinsFile, poolFile, stateFile, prefsFile] =
      await Promise.all([
        Store.loadLocalOrApi(PATHS.nails, REL.nails),
        Store.loadLocalOrApi(PATHS.autoPins, REL.autoPins),
        Store.loadLocalOrApi(PATHS.pool, REL.pool),
        Store.loadLocalOrApi(PATHS.state, REL.state),
        Store.loadLocalOrApi(PATHS.prefs, REL.prefs),
      ]);
    state.nails = normalizeNails(nailsFile.data && nailsFile.data.nails);
    state.alwaysWatch = normalizeAlways(
      nailsFile.data && nailsFile.data.alwaysWatch,
    );
    state.autoPins = Array.isArray(pinsFile.data && pinsFile.data.pins)
      ? pinsFile.data.pins
      : [];
    state.pool = Array.isArray(poolFile.data && poolFile.data.watchPool)
      ? poolFile.data.watchPool.map(symKey)
      : [];
    const prefRank = clampPoolRank(
      prefsFile.data && prefsFile.data.watchPoolRank,
    );
    state.poolRank = prefRank;
    const rankInput = $("futWatchPoolRankInput");
    if (rankInput) rankInput.value = String(prefRank);
    mergeRadarFixedFromPrefs(prefsFile.data || {});
    state.autoPinEvents = Array.isArray(
      stateFile.data && stateFile.data.autoPinEvents,
    )
      ? stateFile.data.autoPinEvents
      : [];
    mergeAutoPinSeenFromPrefs(prefsFile.data || {});
    syncFutAutoPinBadge();
    return Math.max(
      Number(nailsFile.data && nailsFile.data.updatedAt) || 0,
      Number(pinsFile.data && pinsFile.data.updatedAt) || 0,
      Number(poolFile.data && poolFile.data.updatedAt) || 0,
      Number(stateFile.data && stateFile.data.updatedAt) || 0,
      Number(prefsFile.data && prefsFile.data.updatedAt) || 0,
    );
  }

  async function fapiGetJson(pathWithQuery) {
    let lastError = null;
    for (const host of FAPI_HOSTS) {
      try {
        const response = await fetch(`${host}${pathWithQuery}`, {
          cache: "no-store",
        });
        if (!response.ok) {
          lastError = new Error(`fapi ${response.status}`);
          continue;
        }
        return await response.json();
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error("fapi failed");
  }

  async function refreshTickers(symbols) {
    const want = new Set((symbols || []).map(symKey).filter(Boolean));
    const full = !want.size || state.tab === "radar";
    const list = await fapiGetJson("/fapi/v1/ticker/24hr");
    const map = {};
    (Array.isArray(list) ? list : []).forEach((item) => {
      const key = symKey(item && item.symbol);
      if (!key.endsWith("USDT")) return;
      if (!full && !want.has(key)) return;
      const price = Number(item.lastPrice);
      const change24h = Number(item.priceChangePercent);
      if (!Number.isFinite(price) || price <= 0) return;
      map[key] = {
        price,
        change24h: Number.isFinite(change24h) ? change24h : null,
      };
    });
    state.marketMap = full ? map : { ...state.marketMap, ...map };
    if (full || state.tab === "radar") state.radarTickerAt = Date.now();
  }

  async function fetchKlines(symbol, interval, limit) {
    const key = symKey(symbol);
    const iv = String(interval || KLINE_INTERVAL);
    const lim = Math.max(12, Number(limit) || KLINE_LIMIT);
    const cacheKey = `${key}|${iv}|${lim}`;
    if (
      Array.isArray(state.klineCache[cacheKey]) &&
      state.klineCache[cacheKey].length
    ) {
      return state.klineCache[cacheKey];
    }
    const q =
      `/fapi/v1/klines?symbol=${encodeURIComponent(key)}` +
      `&interval=${encodeURIComponent(iv)}&limit=${lim}`;
    const raw = await fapiGetJson(q);
    const candles = (Array.isArray(raw) ? raw : [])
      .map((row) => ({
        time: Number(row[0]) || 0,
        open: Number(row[1]),
        high: Number(row[2]),
        low: Number(row[3]),
        close: Number(row[4]),
      }))
      .filter(
        (c) =>
          Number.isFinite(c.open) &&
          Number.isFinite(c.high) &&
          Number.isFinite(c.low) &&
          Number.isFinite(c.close),
      );
    state.klineCache[cacheKey] = candles;
    if (iv === KLINE_INTERVAL && lim === KLINE_LIMIT) {
      state.klineCache[key] = candles;
    }
    return candles;
  }

  function paintMiniKline(canvas, candles, opts) {
    if (!canvas || !candles || !candles.length) return;
    const options = opts || {};
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssW =
      canvas.clientWidth ||
      Number(canvas.getAttribute("width")) ||
      168;
    const cssH =
      canvas.clientHeight ||
      Number(canvas.getAttribute("height")) ||
      62;
    if (!(cssW > 0) || !(cssH > 0)) return;
    canvas.width = Math.floor(cssW * dpr);
    canvas.height = Math.floor(cssH * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    const pin = Number(options.pinPrice);
    const hasPin = Number.isFinite(pin) && pin > 0;
    let min = Infinity;
    let max = -Infinity;
    candles.forEach((c) => {
      if (c.low < min) min = c.low;
      if (c.high > max) max = c.high;
    });
    if (hasPin) {
      if (pin < min) min = pin;
      if (pin > max) max = pin;
    }
    if (!(max > min)) {
      max = min + 1e-9;
    }
    const upColor = KLINE_UP;
    const downColor = KLINE_DOWN;
    const pad = options.pad != null ? Number(options.pad) : 2;
    const n = candles.length;
    const slot = (cssW - pad * 2) / n;
    const bodyW = Math.max(1.2, slot * 0.62);
    const yOf = (price) => pad + ((max - price) / (max - min)) * (cssH - pad * 2);
    const noteAt = Number(options.noteAt) || 0;
    const greenRange =
      hasPin && noteAt > 0
        ? noteGreenActiveRange(
            candles,
            pin,
            findCandleIndexAt(candles, noteAt),
            options.barMs,
          )
        : { from: -1, until: -1 };
    if (hasPin) {
      const y = yOf(pin);
      ctx.save();
      ctx.strokeStyle = "rgba(120, 130, 126, 0.75)";
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(pad, y);
      ctx.lineTo(cssW - pad, y);
      ctx.stroke();
      ctx.restore();
    }
    candles.forEach((c, i) => {
      const x = pad + i * slot + slot / 2;
      const yHigh = yOf(c.high);
      const yLow = yOf(c.low);
      const yOpen = yOf(c.open);
      const yClose = yOf(c.close);
      const up = c.close >= c.open;
      const inGreen =
        up &&
        greenRange.from >= 0 &&
        i >= greenRange.from &&
        i < greenRange.until;
      const tone = inGreen ? KLINE_ALERT_GREEN : up ? upColor : downColor;
      ctx.strokeStyle = tone;
      ctx.fillStyle = tone;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, yHigh);
      ctx.lineTo(x, yLow);
      ctx.stroke();
      const top = Math.min(yOpen, yClose);
      const h = Math.max(1, Math.abs(yClose - yOpen));
      ctx.fillRect(x - bodyW / 2, top, bodyW, h);
    });
    // 现价角标：左上淡字，对齐钉子 data-price-label
    if (options.priceLabel && cssW >= 96) {
      let livePrice = Number(options.livePrice);
      if (!(livePrice > 0)) {
        const last = candles[candles.length - 1];
        livePrice = Number(last && last.close);
      }
      if (livePrice > 0) {
        let labelColor = "";
        let chipBg = "rgba(255, 255, 255, 0.72)";
        try {
          const rootStyle = getComputedStyle(document.documentElement);
          labelColor = rootStyle.getPropertyValue("--secondary").trim();
          const elevated = rootStyle.getPropertyValue("--elevated").trim();
          const fill = rootStyle.getPropertyValue("--fill").trim();
          chipBg = elevated || fill || chipBg;
        } catch (_) {
          /* ignore */
        }
        const text = fmtPrice(livePrice);
        ctx.save();
        ctx.font =
          '10px -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif';
        ctx.textAlign = "left";
        ctx.textBaseline = "top";
        const tx = pad + 1;
        const ty = pad + 1;
        const tw = Math.ceil(ctx.measureText(text).width);
        const th = 11;
        const padX = 3;
        const padY = 1;
        ctx.globalAlpha = 0.55;
        ctx.fillStyle = chipBg;
        const x0 = tx - padX;
        const y0 = ty - padY;
        const rw = tw + padX * 2;
        const rh = th + padY * 2;
        const rx = 3;
        ctx.beginPath();
        ctx.moveTo(x0 + rx, y0);
        ctx.arcTo(x0 + rw, y0, x0 + rw, y0 + rh, rx);
        ctx.arcTo(x0 + rw, y0 + rh, x0, y0 + rh, rx);
        ctx.arcTo(x0, y0 + rh, x0, y0, rx);
        ctx.arcTo(x0, y0, x0 + rw, y0, rx);
        ctx.closePath();
        ctx.fill();
        ctx.globalAlpha = 0.92;
        ctx.fillStyle = labelColor || "rgba(90, 98, 94, 0.95)";
        ctx.fillText(text, tx, ty);
        ctx.restore();
      }
    }
  }

  function notePinPrice(symbol) {
    const n = nailMap().get(symKey(symbol));
    if (!n) return 0;
    const note = Number(String(n.note || "").replace(/,/g, ""));
    return Number.isFinite(note) && note > 0 ? note : 0;
  }

  function noteAtOf(symbol) {
    const n = nailMap().get(symKey(symbol));
    return Number(n && n.noteAt) || 0;
  }

  function findCandleIndexAt(candles, atMs) {
    const t = Number(atMs) || 0;
    if (!(t > 0) || !Array.isArray(candles) || !candles.length) return -1;
    let idx = -1;
    for (let i = 0; i < candles.length; i += 1) {
      const open = Number(candles[i] && candles[i].time) || 0;
      if (open <= t) idx = i;
      else break;
    }
    if (idx < 0) return 0;
    return idx;
  }

  /** 简化版荧光绿区间：从 noteAt 起，破水位收盘则清；不做自动改便签。 */
  function noteGreenActiveRange(candles, notePrice, fromIndex, barMs) {
    const empty = { from: -1, until: -1 };
    if (!Array.isArray(candles) || !candles.length) return empty;
    if (!(notePrice > 0)) return empty;
    const start = Math.max(0, Number(fromIndex) || 0);
    if (start >= candles.length) return empty;
    const duration =
      Number(barMs) > 0 ? Number(barMs) : KLINE_BAR_MS;
    let active = false;
    let greenFrom = -1;
    let greenUntil = -1;
    const now = Date.now();
    for (let i = start; i < candles.length; i += 1) {
      const c = candles[i];
      if (!c) continue;
      const high = Number(c.high);
      const close = Number(c.close);
      const openT = Number(c.time) || 0;
      const closed = openT > 0 ? openT + duration <= now : true;
      if (!active) {
        if (Number.isFinite(high) && high > notePrice) {
          active = true;
          greenFrom = i;
          greenUntil = i + 1;
        }
        continue;
      }
      if (!closed) {
        greenUntil = i + 1;
        continue;
      }
      if (Number.isFinite(close) && close < notePrice) {
        active = false;
        greenFrom = -1;
        greenUntil = -1;
        continue;
      }
      greenUntil = i + 1;
    }
    if (!active || greenFrom < 0 || greenUntil <= greenFrom) return empty;
    return { from: greenFrom, until: greenUntil };
  }

  function zoomLongRangeConfig(range) {
    if (range === "month") {
      return { key: "month", interval: "1M", limit: 36, label: "月 K · 一根一月" };
    }
    if (range === "day") {
      return { key: "day", interval: "1d", limit: 90, label: "日 K · 一根一天" };
    }
    return { key: "week", interval: "1w", limit: 52, label: "周 K · 一根一周" };
  }

  async function ensureKlines(symbols) {
    const list = [...new Set((symbols || []).map(symKey).filter(Boolean))];
    const missing = list.filter((s) => !state.klineCache[s]);
    const concurrency = 4;
    let i = 0;
    async function worker() {
      while (i < missing.length) {
        const idx = i;
        i += 1;
        try {
          await fetchKlines(missing[idx]);
        } catch (error) {
          console.warn("fut kline", missing[idx], error);
        }
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(concurrency, missing.length || 1) }, () =>
        worker(),
      ),
    );
  }

  function clearKlineCacheFor(symbol) {
    const key = symKey(symbol);
    if (!key) return;
    Object.keys(state.klineCache).forEach((cacheKey) => {
      if (cacheKey === key || cacheKey.startsWith(`${key}|`)) {
        delete state.klineCache[cacheKey];
      }
    });
  }

  async function paintVisibleKlines() {
    const nodes = [...document.querySelectorAll("canvas.fut-kline[data-kline]")];
    nodes.forEach((canvas) => canvas.classList.add("is-loading"));
    const symbols = nodes.map((n) => n.getAttribute("data-kline"));
    try {
      await ensureKlines(symbols);
    } finally {
      const draw = () => {
        nodes.forEach((canvas) => {
          if (!canvas.isConnected) return;
          const sym = canvas.getAttribute("data-kline");
          paintMiniKline(canvas, state.klineCache[sym] || [], {
            pinPrice: notePinPrice(sym),
            noteAt: noteAtOf(sym),
            priceLabel: canvas.getAttribute("data-price-label") === "1",
            livePrice: Number(liveOf(sym).price),
          });
          canvas.classList.remove("is-loading");
        });
      };
      draw();
      requestAnimationFrame(draw);
    }
  }

  async function persistNails(mutator, message) {
    if (state.saving) {
      toast("保存中…");
      return false;
    }
    state.saving = true;
    setSaving(true, "保存中…");
    syncSelectUi();
    try {
      const result = await window.FutStore.patchJson(
        PATHS.nails,
        (data) => {
          const nails = normalizeNails(data.nails);
          const alwaysWatch = normalizeAlways(data.alwaysWatch);
          const ctx = {
            nails,
            alwaysWatch,
            dismissedNails: Array.isArray(data.dismissedNails)
              ? data.dismissedNails.map(symKey).filter(Boolean)
              : [],
          };
          const next = mutator(ctx);
          return {
            data: {
              nails: normalizeNails(next.nails),
              alwaysWatch: normalizeAlways(next.alwaysWatch),
              alwaysWatchAt: Date.now(),
              dismissedNails: Array.isArray(next.dismissedNails)
                ? [...new Set(next.dismissedNails.map(symKey).filter(Boolean))]
                : ctx.dismissedNails,
              updatedAt: Date.now(),
              market: "usdt-perp",
            },
          };
        },
        message || "Fut nails update",
      );
      state.nails = normalizeNails(result.data.nails);
      state.alwaysWatch = normalizeAlways(result.data.alwaysWatch);
      render();
      flashListRefresh();
      return true;
    } catch (error) {
      toast((error && error.message) || "保存失败");
      throw error;
    } finally {
      state.saving = false;
      if (!state.refreshing) setSaving(false);
      syncSelectUi();
    }
  }

  async function pinToBoard(symbols, opts) {
    const keys = [...new Set((symbols || []).map(symKey).filter(Boolean))];
    if (!keys.length) return false;
    await refreshTickers(keys);
    const now = Date.now();
    const keySet = new Set(keys);
    const ok = await persistNails((ctx) => {
      let nails = ctx.nails.slice();
      const by = new Map(nails.map((n) => [n.symbol, n]));
      keys.forEach((key) => {
        const price = Number(liveOf(key).price);
        const note =
          Number.isFinite(price) && price > 0 ? fmtPrice(price) : "";
        const prev = by.get(key);
        by.set(key, {
          id: (prev && prev.id) || `${key}:${now}`,
          symbol: key,
          label: labelOf(key),
          note: note || (prev && prev.note) || "",
          noteAt: note ? now : (prev && prev.noteAt) || 0,
          pinned: true,
          pinnedAt: now,
          order: 0,
          at: (prev && prev.at) || now,
        });
      });
      // 新置顶排前
      nails = [...by.values()].map((n, i) => ({
        ...n,
        order: keys.includes(n.symbol) ? keys.indexOf(n.symbol) : 1000 + i,
      }));
      nails.sort((a, b) => (a.order || 0) - (b.order || 0));
      // 手动置顶清 dismissed，避免删后再钉仍被云端补漏跳过
      const dismissedNails = (ctx.dismissedNails || []).filter(
        (s) => !keySet.has(symKey(s)),
      );
      return { ...ctx, nails, dismissedNails };
    }, (opts && opts.message) || `Fut pin ${keys.join(",")}`);
    if (ok) {
      if (keys.includes(jumpRevealKey())) clearJumpReveal();
      toast(`已置顶 ${keys.map(labelOf).join(" · ")}`);
    }
    return ok;
  }

  async function unpinFromBoard(symbols) {
    const keys = new Set((symbols || []).map(symKey).filter(Boolean));
    if (!keys.size) return false;
    const ok = await persistNails((ctx) => {
      const nails = ctx.nails.map((n) =>
        keys.has(n.symbol) ? { ...n, pinned: false, pinnedAt: 0 } : n,
      );
      const alwaysWatch = ctx.alwaysWatch.filter((s) => !keys.has(s));
      return { ...ctx, nails, alwaysWatch };
    }, `Fut unpin ${[...keys].join(",")}`);
    if (ok) toast(`已取消置顶 ${[...keys].map(labelOf).join(" · ")}`);
    return ok;
  }

  async function pinFirst(symbol) {
    const key = symKey(symbol);
    if (!key) return false;
    const ok = await persistNails((ctx) => {
      const by = new Map(ctx.nails.map((n) => [n.symbol, n]));
      const prev = by.get(key);
      if (!prev) {
        by.set(key, {
          id: `${key}:${Date.now()}`,
          symbol: key,
          label: labelOf(key),
          note: "",
          noteAt: 0,
          pinned: true,
          pinnedAt: Date.now(),
          order: -1,
          at: Date.now(),
        });
      } else {
        by.set(key, {
          ...prev,
          pinned: true,
          pinnedAt: prev.pinnedAt || Date.now(),
          order: -1,
        });
      }
      const nails = [...by.values()].sort(
        (a, b) => (a.order || 0) - (b.order || 0),
      );
      return {
        ...ctx,
        nails: nails.map((n, i) => ({ ...n, order: i })),
        dismissedNails: (ctx.dismissedNails || []).filter(
          (s) => symKey(s) !== key,
        ),
      };
    }, `Fut pin first ${key}`);
    if (ok) {
      if (jumpRevealKey() === key) clearJumpReveal();
      toast(`已排到置顶第一 · ${labelOf(key)}`);
    }
    return ok;
  }

  async function setNoteNow(symbols) {
    const keys = [...new Set((symbols || []).map(symKey).filter(Boolean))];
    if (!keys.length) return false;
    await refreshTickers(keys);
    const noteAt = Date.now();
    const ok = await persistNails((ctx) => {
      const by = new Map(ctx.nails.map((n) => [n.symbol, n]));
      keys.forEach((key) => {
        const price = Number(liveOf(key).price);
        if (!(price > 0)) return;
        const prev = by.get(key) || {
          id: `${key}:${noteAt}`,
          symbol: key,
          label: labelOf(key),
          pinned: false,
          pinnedAt: 0,
          order: ctx.nails.length,
          at: noteAt,
        };
        by.set(key, {
          ...prev,
          note: fmtPrice(price),
          noteAt,
        });
      });
      return { ...ctx, nails: [...by.values()] };
    }, `Fut notes ${keys.length}`);
    if (ok) toast(`已写现价便签 ${keys.length} 个`);
    return ok;
  }

  function openNoteEditor(symbol) {
    const key = symKey(symbol);
    if (!key) return;
    const item =
      state.nails.find((n) => n.symbol === key) ||
      (isAlways(key) ? makeAlwaysOrphanItem(key) : null);
    if (!item) {
      toast("列表找不到该币");
      return;
    }
    const editor = $("futNoteEditor");
    const title = $("futNoteEditorTitle");
    const text = $("futNoteEditorText");
    if (!editor || !text) return;
    noteEditorSymbol = key;
    if (title) title.textContent = `编辑 ${labelOf(key)} 便签`;
    text.value = String(item.note || "").trim();
    editor.querySelectorAll('input[name="futNoteTimeMode"]').forEach((radio) => {
      radio.checked = radio.value === noteTimeMode;
    });
    editor.hidden = false;
    requestAnimationFrame(() => {
      text.focus();
      text.setSelectionRange(text.value.length, text.value.length);
    });
  }

  function closeNoteEditor() {
    if (noteEditorSaving) return;
    const editor = $("futNoteEditor");
    if (editor) editor.hidden = true;
    noteEditorSymbol = null;
  }

  async function saveEditedNote(symbol, note, timeMode) {
    const key = symKey(symbol);
    if (!key) return false;
    const text = String(note || "")
      .trim()
      .slice(0, 60);
    const current = state.nails.find((n) => n.symbol === key);
    if (current && String(current.note || "").trim() === text) return true;
    const hasExisting = !!(current && String(current.note || "").trim());
    const noteAt = text
      ? hasExisting && timeMode !== "current"
        ? Number(current.noteAt) || 0
        : Date.now()
      : 0;
    const ok = await persistNails((ctx) => {
      const by = new Map(ctx.nails.map((n) => [n.symbol, n]));
      const prev = by.get(key) || {
        id: `${key}:${Date.now()}`,
        symbol: key,
        label: labelOf(key),
        pinned: false,
        pinnedAt: 0,
        order: ctx.nails.length,
        at: Date.now(),
      };
      by.set(key, {
        ...prev,
        note: text,
        noteAt: text ? noteAt : 0,
      });
      return { ...ctx, nails: [...by.values()] };
    }, `Fut note edit ${key}`);
    if (ok) toast(`已保存便签 · ${labelOf(key)}`);
    return ok;
  }

  async function toggleAlways(symbol, force) {
    const key = symKey(symbol);
    if (!key) return false;
    const wasOn = isAlways(key);
    const nextOn =
      force === true ? true : force === false ? false : !wasOn;
    // 加常看仍要求已置顶；取消常看（含孤儿行）一律放行
    if (nextOn && !isUserPinned(key)) {
      toast("仅已置顶的可加常看");
      return false;
    }
    const ok = await persistNails((ctx) => {
      const set = new Set(ctx.alwaysWatch);
      if (nextOn) set.add(key);
      else set.delete(key);
      return { ...ctx, alwaysWatch: [...set] };
    }, `Fut always ${key}`);
    if (ok) {
      toast(
        nextOn
          ? `${labelOf(key)} 已加常看`
          : `${labelOf(key)} 已取消常看`,
      );
    }
    return ok;
  }

  async function deleteNails(symbols) {
    const keys = [...new Set((symbols || []).map(symKey).filter(Boolean))];
    if (!keys.length) return false;
    // 多选里的 guest：对齐钉子收起语义，不写盘
    const guestKeys = keys.filter((k) => isJumpGuest(k));
    const workKeys = keys.filter((k) => !isJumpGuest(k));
    if (guestKeys.length) {
      clearJumpReveal({ rerender: !workKeys.length });
      if (!workKeys.length) {
        toast("已收起临时查看");
        return true;
      }
    }
    const orphanOnly = workKeys.filter((k) => isAlways(k) && !hasRealNail(k));
    const realKeys = workKeys.filter((k) => hasRealNail(k));
    // 仅常看观察卡（钉子已退出）：删 = 取消常看，不写 dismissed
    if (!realKeys.length && orphanOnly.length) {
      const drop = new Set(orphanOnly);
      const ok = await persistNails(
        (ctx) => ({
          ...ctx,
          alwaysWatch: ctx.alwaysWatch.filter((s) => !drop.has(s)),
        }),
        `Fut cancel always ${orphanOnly.join(",")}`,
      );
      if (ok) {
        toast(`已取消常看 ${orphanOnly.map(labelOf).join(" · ")}`);
      }
      return ok;
    }
    const drop = new Set(workKeys);
    const ok = await persistNails((ctx) => {
      const nails = ctx.nails.filter((n) => !drop.has(n.symbol));
      const alwaysWatch = ctx.alwaysWatch.filter((s) => !drop.has(s));
      const dismissed = [
        ...new Set([
          ...(Array.isArray(ctx.dismissedNails) ? ctx.dismissedNails : []),
          ...realKeys,
        ]),
      ];
      return { ...ctx, nails, alwaysWatch, dismissedNails: dismissed };
    }, `Fut delete ${realKeys.join(",")}`);
    if (ok) {
      if (workKeys.includes(jumpRevealKey())) clearJumpReveal();
      const bits = [];
      if (realKeys.length) bits.push(`已删除 ${realKeys.map(labelOf).join(" · ")}`);
      if (orphanOnly.length) {
        bits.push(`已取消常看 ${orphanOnly.map(labelOf).join(" · ")}`);
      }
      toast(bits.join("；") || "已删除");
    }
    return ok;
  }

  async function addNailByInput(rawName, rawNote) {
    let base = String(rawName || "")
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "");
    if (!base) {
      toast("请输入币名");
      return;
    }
    if (!base.endsWith("USDT")) base += "USDT";
    await refreshTickers([base]);
    const price = Number(liveOf(base).price);
    const noteText = String(rawNote || "").trim() || fmtPrice(price);
    const now = Date.now();
    const ok = await persistNails((ctx) => {
      const by = new Map(ctx.nails.map((n) => [n.symbol, n]));
      const prev = by.get(base);
      by.set(base, {
        id: (prev && prev.id) || `${base}:${now}`,
        symbol: base,
        label: labelOf(base),
        note: noteText || (prev && prev.note) || "",
        noteAt: noteText ? now : (prev && prev.noteAt) || 0,
        pinned: prev ? !!prev.pinned : false,
        pinnedAt: (prev && prev.pinnedAt) || 0,
        order: prev ? prev.order : 0,
        at: (prev && prev.at) || now,
      });
      const dismissed = (ctx.dismissedNails || []).filter(
        (s) => symKey(s) !== base,
      );
      return { ...ctx, nails: [...by.values()], dismissedNails: dismissed };
    }, `Fut add ${base}`);
    if (ok) {
      toast(`已加入 ${labelOf(base)}`);
      setAddOpen(false);
    }
  }

  function setAddOpen(open) {
    state.addOpen = !!open;
    const form = $("futAddForm");
    if (form) form.hidden = !state.addOpen;
    if (state.addOpen) {
      const input = $("futAddSymbol");
      if (input) {
        input.value = "";
        input.focus();
      }
    }
  }

  function updateHeadMeta() {
    const meta = $("futMeta");
    if (!meta) return;
    const { alwaysEligible, pinned, rest } = splitPinSections();
    const n = state.nails.length;
    meta.textContent = `${n} 个 · 置顶 ${pinned.length} · 常看 ${alwaysEligible || 0} · 其余 ${rest.length}`;
  }

  function setTab(tab) {
    state.tab = tab;
    if (tab !== "pin" && state.selectMode) setSelectMode(false);
    // 换分栏就收焦点栏（置顶单击便签 / 自动盯·雷达置顶刷新）
    closeFocusBar();
    if (tab !== "pin") {
      clearJumpReveal();
      setAddOpen(false);
    }
    document.querySelectorAll("[data-fut-tab]").forEach((btn) => {
      const on = btn.getAttribute("data-fut-tab") === tab;
      btn.classList.toggle("is-active", on);
      btn.setAttribute("aria-selected", on ? "true" : "false");
    });
    document.querySelectorAll("[data-fut-pane]").forEach((pane) => {
      pane.hidden = pane.getAttribute("data-fut-pane") !== tab;
    });
    if (tab === "auto") syncFutAutoPinBadge();
    void refreshView({ quiet: true });
  }

  function closeFocusBar() {
    state.focusSymbol = null;
    state.focusScope = null;
    const bar = $("futFocusBar");
    if (bar) bar.hidden = true;
    document
      .querySelectorAll(
        "#pinList .fut-prow-row.is-focus, #autoList .fut-prow-row.is-focus, #radarBody tr.is-radar-selected",
      )
      .forEach((row) => {
        row.classList.remove("is-focus");
        row.classList.remove("is-radar-selected");
      });
  }

  /**
   * @param {string} symbol
   * @param {"pin"|"auto"|"radar"} [scope]
   */
  function openFocusBar(symbol, scope) {
    const key = symKey(symbol);
    if (!key) return;
    const sc =
      scope === "pin" || scope === "radar" || scope === "auto"
        ? scope
        : state.focusScope || "auto";
    state.focusSymbol = key;
    state.focusScope = sc;
    const bar = $("futFocusBar");
    const symEl = $("futFocusSym");
    const pinBtn = $("futFocusPinBtn");
    const noteBtn = $("futFocusNoteBtn");
    const refreshBtn = $("futFocusRefreshBtn");
    if (symEl) symEl.textContent = labelOf(key);
    if (noteBtn) noteBtn.hidden = sc !== "pin";
    if (pinBtn) {
      pinBtn.hidden = sc === "pin";
      const pinned = isUserPinned(key);
      pinBtn.textContent = pinned ? "已置顶" : "置顶";
      pinBtn.disabled = pinned;
    }
    if (refreshBtn) refreshBtn.hidden = false;
    if (bar) bar.hidden = false;
    document.querySelectorAll("#pinList .fut-prow-row").forEach((row) => {
      row.classList.toggle(
        "is-focus",
        sc === "pin" && symKey(row.getAttribute("data-symbol")) === key,
      );
    });
    document.querySelectorAll("#autoList .fut-prow-row").forEach((row) => {
      row.classList.toggle(
        "is-focus",
        sc === "auto" && symKey(row.getAttribute("data-symbol")) === key,
      );
    });
    document.querySelectorAll("#radarBody tr[data-symbol]").forEach((row) => {
      row.classList.toggle(
        "is-radar-selected",
        sc === "radar" && symKey(row.getAttribute("data-symbol")) === key,
      );
    });
  }

  /** 置顶列表单击：切换焦点（再点同一行取消），底栏出便签。 */
  function togglePinFocus(symbol) {
    const key = symKey(symbol);
    if (!key) return;
    if (state.focusSymbol === key && state.focusScope === "pin") {
      closeFocusBar();
      return;
    }
    openFocusBar(key, "pin");
  }

  function focusPinRow(symbol) {
    const key = symKey(symbol);
    if (!key) return false;
    const row = document.querySelector(
      `#pinList .fut-prow-row[data-symbol="${key}"]`,
    );
    if (!row) return false;
    document
      .querySelectorAll(
        "#pinList .fut-prow-row.is-focus, #pinList .fut-prow-row.is-jump-target, #pinList .fut-kline-cell.is-jump-target",
      )
      .forEach((el) => {
        el.classList.remove("is-focus");
        el.classList.remove("is-jump-target");
      });
    row.classList.add("is-focus");
    row.classList.add("is-jump-target");
    const klineCell = row.querySelector(".fut-kline-cell");
    if (klineCell) klineCell.classList.add("is-jump-target");
    if (typeof row.scrollIntoView === "function") {
      row.scrollIntoView({ behavior: "smooth", block: "center" });
    }
    window.setTimeout(() => {
      row.classList.remove("is-focus");
      row.classList.remove("is-jump-target");
      if (klineCell) klineCell.classList.remove("is-jump-target");
    }, 2800);
    return true;
  }

  /** 对齐钉子：清 reveal 后按当前筛选测「自然可见」。 */
  function isPinNaturallyVisible(symbol) {
    const key = symKey(symbol);
    if (!key) return false;
    const prev = state.jumpReveal;
    state.jumpReveal = null;
    const { always, pinned, rest } = splitPinSections();
    state.jumpReveal = prev;
    // 只看置顶：常看仍放行（即便折叠并入「其余」）
    return [...always, ...pinned, ...rest].some((n) => {
      if (symKey(n && n.symbol) !== key) return false;
      if (!state.pinnedOnly) return true;
      if (isAlways(key) || n.pinned) return true;
      return false;
    });
  }

  /**
   * 其它分栏点币名 → 置顶分栏并定位。
   * 对齐钉子 openNailDrawerAtSymbol：不在名单 = 临时露出（guest），不写盘。
   */
  async function jumpToPinSymbol(symbol) {
    const key = symKey(symbol);
    if (!key) return;
    closeFocusBar();
    closeFloatMenu();
    closePinMenus();

    const inNails = hasRealNail(key);
    const naturallyVisible = inNails && isPinNaturallyVisible(key);

    let toastMsg = "";
    if (!inNails) {
      state.jumpReveal = { symbol: key, guest: true };
      toastMsg = `${labelOf(key)} 未在钉子 · 临时查看`;
      try {
        await refreshTickers([key]);
      } catch (_) {
        /* ignore */
      }
    } else if (!naturallyVisible) {
      state.jumpReveal = { symbol: key, guest: false };
      toastMsg = state.pinnedOnly
        ? `${labelOf(key)} 未置顶 · 已临时显示`
        : `${labelOf(key)} 已临时显示`;
    } else {
      // 本来就看得见：清掉过期临时态
      if (jumpRevealKey() && jumpRevealKey() !== key) {
        clearJumpReveal();
      } else if (state.jumpReveal && !state.jumpReveal.guest) {
        clearJumpReveal();
      }
    }

    if (state.tab !== "pin") {
      state.tab = "pin";
      if (state.selectMode) setSelectMode(false);
      setAddOpen(false);
      document.querySelectorAll("[data-fut-tab]").forEach((btn) => {
        const on = btn.getAttribute("data-fut-tab") === "pin";
        btn.classList.toggle("is-active", on);
        btn.setAttribute("aria-selected", on ? "true" : "false");
      });
      document.querySelectorAll("[data-fut-pane]").forEach((pane) => {
        pane.hidden = pane.getAttribute("data-fut-pane") !== "pin";
      });
    }
    render();
    syncSelectUi();
    void paintVisibleKlines();
    const tryFocus = () => focusPinRow(key);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (tryFocus()) return;
        window.setTimeout(() => {
          if (tryFocus()) return;
          window.setTimeout(() => {
            if (!tryFocus()) toast(`${labelOf(key)} 未能定位到行`);
          }, 160);
        }, 80);
      });
    });
    if (toastMsg) toast(toastMsg);
  }

  function sortNailRows(list) {
    const rows = (list || []).slice();
    if (state.sort === "order") return rows;
    if (state.sort === "change24h") {
      return rows.sort((a, b) => {
        const ca = Number(liveOf(a.symbol).change24h);
        const cb = Number(liveOf(b.symbol).change24h);
        const va = Number.isFinite(ca) ? ca : -Infinity;
        const vb = Number.isFinite(cb) ? cb : -Infinity;
        if (vb !== va) return vb - va;
        return (a.order || 0) - (b.order || 0);
      });
    }
    // 便签涨幅：无便签沉底
    return rows.sort((a, b) => {
      const ga = noteGain(a);
      const gb = noteGain(b);
      const hasA = Number.isFinite(ga);
      const hasB = Number.isFinite(gb);
      if (!hasA && !hasB) return (a.order || 0) - (b.order || 0);
      if (!hasA) return 1;
      if (!hasB) return -1;
      if (gb !== ga) return gb - ga;
      return (a.order || 0) - (b.order || 0);
    });
  }

  function splitPinSections() {
    const alwaysSet = new Set(state.alwaysWatch);
    const always = [];
    const pinned = [];
    const rest = [];
    // 对齐钉子：常看展开=独立段；折叠=并入置顶/其余，标题仍保留可再展开。
    const alwaysExpanded = !state.alwaysCollapsed;
    let alwaysEligible = 0;
    const seen = new Set();
    state.nails.forEach((n) => {
      const inAlways = alwaysSet.has(n.symbol);
      if (inAlways) alwaysEligible += 1;
      seen.add(n.symbol);
      if (inAlways && alwaysExpanded) {
        always.push(n);
        return;
      }
      if (inAlways && !alwaysExpanded) {
        if (n.pinned) pinned.push(n);
        else rest.push(n);
        return;
      }
      if (n.pinned) pinned.push(n);
      else rest.push(n);
    });
    // 常看但不在钉子名单（如自动退出后）：合成观察卡，进「常看」段。
    alwaysSet.forEach((key) => {
      if (!key || seen.has(key)) return;
      alwaysEligible += 1;
      const orphan = makeAlwaysOrphanItem(key);
      if (alwaysExpanded) always.push(orphan);
      else rest.push(orphan);
    });
    // 常看独立段固定按 24h，不受全局排序开关影响（同钉子页）
    const alwaysSorted = always.slice().sort((a, b) => {
      const ca = Number(liveOf(a.symbol).change24h);
      const cb = Number(liveOf(b.symbol).change24h);
      const va = Number.isFinite(ca) ? ca : -Infinity;
      const vb = Number.isFinite(cb) ? cb : -Infinity;
      if (vb !== va) return vb - va;
      return (a.order || 0) - (b.order || 0);
    });
    // 对齐钉子：24h 时置顶保持手动序；便签涨幅时置顶+其余都按涨幅排
    const pinnedSorted =
      state.sort === "change24h" ? pinned : sortNailRows(pinned);
    let restSorted = sortNailRows(rest);
    // 跳转临时露出：独立「临时查看」段（不进其余、不写盘）
    const jump = [];
    const revealKey = jumpRevealKey();
    if (revealKey) {
      const strip = (list) =>
        list.filter((n) => symKey(n && n.symbol) !== revealKey);
      const alwaysClean = strip(alwaysSorted);
      const pinnedClean = strip(pinnedSorted);
      restSorted = strip(restSorted);
      let revealItem =
        state.nails.find((n) => n.symbol === revealKey && !n._alwaysWatch) ||
        null;
      if (!revealItem && state.jumpReveal && state.jumpReveal.guest) {
        revealItem = makeJumpGuestItem(revealKey);
      }
      if (!revealItem && isAlways(revealKey) && !hasRealNail(revealKey)) {
        revealItem = makeAlwaysOrphanItem(revealKey);
      }
      if (revealItem) {
        jump.push(revealItem);
        return {
          jump,
          always: alwaysClean,
          alwaysEligible,
          pinned: pinnedClean,
          rest: restSorted,
        };
      }
    }
    return {
      jump,
      always: alwaysSorted,
      alwaysEligible,
      pinned: pinnedSorted,
      rest: restSorted,
    };
  }

  function closePinMenus() {
    document.querySelectorAll(".fut-pin-menu").forEach((m) => m.remove());
    document.querySelectorAll(".fut-pin[aria-expanded='true']").forEach((b) => {
      b.setAttribute("aria-expanded", "false");
    });
  }

  function openPinMenu(pinBtn, symbol) {
    if (!pinBtn) return;
    const key = symKey(symbol);
    if (!key) return;
    if (pinBtn.getAttribute("aria-expanded") === "true") {
      closePinMenus();
      return;
    }
    const wrap = pinBtn.closest(".fut-pin-wrap") || pinBtn.parentElement;
    if (!wrap) return;
    closePinMenus();
    const pinned = isUserPinned(key);
    const alwaysOn = isAlways(key);
    const menu = document.createElement("div");
    menu.className = "fut-pin-menu";
    menu.setAttribute("role", "menu");
    const bits = [];
    if (pinned) {
      bits.push(
        `<button type="button" role="menuitem" data-fut-pin-first="${escapeHtml(key)}">置顶排第一</button>`,
      );
      bits.push(
        alwaysOn
          ? `<button type="button" role="menuitem" data-fut-always-off="${escapeHtml(key)}">取消常看</button>`
          : `<button type="button" role="menuitem" data-fut-always-on="${escapeHtml(key)}">常看</button>`,
      );
      bits.push(
        `<button type="button" role="menuitem" class="is-danger" data-fut-pin-off="${escapeHtml(key)}">取消置顶</button>`,
      );
    } else if (alwaysOn) {
      bits.push(
        `<button type="button" role="menuitem" data-fut-pin-on="${escapeHtml(key)}">置顶</button>`,
      );
      bits.push(
        `<button type="button" role="menuitem" class="is-danger" data-fut-always-off="${escapeHtml(key)}">取消常看</button>`,
      );
    } else {
      // 对齐钉子：未置顶且非常看 → 「置顶排第一」
      bits.push(
        `<button type="button" role="menuitem" data-fut-pin-first="${escapeHtml(key)}">置顶排第一</button>`,
      );
    }
    menu.innerHTML = bits.join("");
    wrap.appendChild(menu);
    pinBtn.setAttribute("aria-expanded", "true");
  }

  function closeFloatMenu() {
    state.floatSymbol = null;
    const mask = $("futRowFloatMask");
    const menu = $("futRowFloatMenu");
    if (mask) mask.hidden = true;
    if (menu) menu.hidden = true;
  }

  function openFloatMenu(symbol, clientX, clientY) {
    const key = symKey(symbol);
    if (!key) return;
    state.floatSymbol = key;
    const mask = $("futRowFloatMask");
    const menu = $("futRowFloatMenu");
    if (!mask || !menu) return;
    const pinned = isUserPinned(key);
    const alwaysOn = isAlways(key);
    const pinBtn = menu.querySelector('[data-fut-float="pin"]');
    const unpinBtn = menu.querySelector('[data-fut-float="unpin"]');
    const alwaysBtn = menu.querySelector('[data-fut-float="always"]');
    if (pinBtn) pinBtn.hidden = pinned;
    if (unpinBtn) unpinBtn.hidden = !pinned;
    if (alwaysBtn) {
      // 置顶可加常看；常看孤儿（钉子已退）可取消常看
      alwaysBtn.hidden = !(pinned || alwaysOn);
      alwaysBtn.textContent = alwaysOn ? "取消常看" : "常看";
    }
    mask.hidden = false;
    menu.hidden = false;
    const mw = menu.offsetWidth || 220;
    const mh = menu.offsetHeight || 48;
    const x = Math.max(8, Math.min(window.innerWidth - mw - 8, clientX - mw / 2));
    const y = Math.max(8, Math.min(window.innerHeight - mh - 8, clientY - mh - 12));
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
  }

  function syncSelectUi() {
    const btn = $("futSelectBtn");
    const bar = $("futBatchBar");
    const countEl = $("futBatchCount");
    const n = state.selected.size;
    if (btn) {
      btn.classList.toggle("is-active", state.selectMode);
      btn.textContent = state.selectMode ? "选中" : "多选";
      btn.hidden = state.tab !== "pin";
    }
    if (bar) bar.hidden = !state.selectMode;
    if (countEl) countEl.textContent = String(n);
    const selectAllBtn = $("futBatchSelectAllBtn");
    if (selectAllBtn) selectAllBtn.disabled = state.saving;
    ["futBatchPinBtn", "futBatchUnpinBtn", "futBatchNoteBtn", "futBatchDeleteBtn"].forEach(
      (id) => {
        const el = $(id);
        if (el) el.disabled = n === 0 || state.saving;
      },
    );
    document.querySelectorAll("#pinList .fut-prow-row").forEach((row) => {
      const sym = symKey(row.getAttribute("data-symbol"));
      const on = state.selectMode && state.selected.has(sym);
      row.classList.toggle("is-selected", on);
      const check = row.querySelector(".fut-check");
      if (check) check.checked = on;
    });
  }

  function setSelectMode(on) {
    state.selectMode = !!on;
    if (!state.selectMode) state.selected.clear();
    closePinMenus();
    closeFloatMenu();
    render();
    syncSelectUi();
  }

  function toggleSelect(symbol) {
    const key = symKey(symbol);
    if (!key) return;
    if (state.selected.has(key)) state.selected.delete(key);
    else state.selected.add(key);
    syncSelectUi();
  }

  function visiblePinSymbols() {
    // 对齐钉子：全选吃当前可见行（含临时 guest）
    return [
      ...document.querySelectorAll("#pinList .fut-prow-row[data-symbol]"),
    ]
      .map((row) => symKey(row.getAttribute("data-symbol")))
      .filter(Boolean);
  }

  /** 对齐钉子：全选当前可见行；已全选则反选清空。 */
  function selectAllVisiblePins() {
    if (!state.selectMode) setSelectMode(true);
    const visible = visiblePinSymbols();
    if (!visible.length) {
      toast("当前没有可选币");
      return;
    }
    const allOn = visible.every((symbol) => state.selected.has(symbol));
    if (allOn) {
      visible.forEach((symbol) => state.selected.delete(symbol));
    } else {
      visible.forEach((symbol) => state.selected.add(symbol));
    }
    syncSelectUi();
  }

  function pinRowHtml(n, opts) {
    const showK = opts && opts.kline !== false;
    const live = liveOf(n.symbol);
    const ch = Number(live.change24h);
    const gain = noteGain(n);
    const key = n.symbol;
    const alwaysOn = isAlways(key);
    const alwaysOrphan = !!(n && n._alwaysWatch) || (alwaysOn && !hasRealNail(key));
    const isGuest = !!(n && n._jumpGuest) || isJumpGuest(key);
    const isReveal = jumpRevealKey() === key;
    const selected = state.selectMode && state.selected.has(key);
    const check = state.selectMode
      ? `<input type="checkbox" class="fut-check" data-fut-select="${escapeHtml(key)}" ${selected ? "checked" : ""} aria-label="选择" />`
      : "";
    const pinBtn = state.selectMode
      ? ""
      : `<span class="fut-pin-wrap"><button type="button" class="fut-pin${n.pinned ? " is-on" : ""}" data-fut-pin="${escapeHtml(key)}" aria-haspopup="menu" aria-expanded="false" title="${n.pinned ? "置顶选项" : isGuest ? "加入钉子并置顶" : alwaysOn ? "常看选项" : "置顶"}">${n.pinned ? "顶" : "↑"}</button></span>`;
    // 对齐钉子：reveal 打「临时/露出」；否则常看标
    const tag = isReveal
      ? `<span class="fut-tag">${isGuest ? "临时" : "露出"}</span>`
      : alwaysOn
        ? '<span class="fut-tag">常看</span>'
        : "";
    const kHtml = showK
      ? `<canvas class="fut-kline" data-kline="${escapeHtml(key)}" data-price-label="1" width="168" height="62"></canvas>`
      : '<span class="fut-status">—</span>';
    // 对齐钉子：仅 guest「收起」；非 guest 强制露出仍「删」
    const delLabel = isGuest ? "收起" : alwaysOrphan ? "取消常看" : "删";
    const delTitle = isGuest
      ? "收起临时查看"
      : alwaysOrphan
        ? "取消常看（钉子已不在）"
        : "删除钉子";
    const opsCell = state.selectMode
      ? `<td class="fut-prow-ops"></td>`
      : `<td class="fut-prow-ops"><button type="button" class="fut-zoom" data-fut-zoom="${escapeHtml(key)}" title="放大 K 线">${ZOOM_ICON}</button><button type="button" class="fut-del" data-fut-del="${escapeHtml(key)}" title="${delTitle}">${delLabel}</button></td>`;
    // 对齐钉子：信息行在币名列空一格，便签落在 K 线下方；现价走角标；文案只显示便签原文。
    const info = [];
    const noteRaw = String(n.note || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 40);
    if (noteRaw) {
      const gainTitle = Number.isFinite(gain)
        ? ` title="便签涨幅 ${fmtPct(gain)}"`
        : "";
      info.push(
        `<span class="fut-info-note${Number.isFinite(gain) ? ` ${pctClass(gain)}` : ""}"${gainTitle}>${escapeHtml(noteRaw)}</span>`,
      );
    }
    const infoCell = `<div class="fut-info">${info.join("")}</div>`;
    return `
      <tr class="fut-prow-row${selected ? " is-selected" : ""}${alwaysOrphan ? " is-always-orphan" : ""}${isReveal ? " is-jump-reveal" : ""}${isGuest ? " is-jump-guest" : ""}" data-symbol="${escapeHtml(key)}" data-fut-row="1"${alwaysOrphan ? ' data-fut-always-orphan="1"' : ""}${isGuest ? ' data-fut-jump-guest="1"' : ""}>
        <td class="fut-name-cell">${check}${pinBtn}<button type="button" class="fut-name" data-fut-copy="${escapeHtml(labelOf(key))}">${escapeHtml(n.label || labelOf(key))}${tag}</button></td>
        <td class="fut-kline-cell">${kHtml}</td>
        <td class="fut-chg ${pctClass(ch)}">${escapeHtml(fmtPct(ch))}</td>
        ${opsCell}
      </tr>
      <tr class="fut-sub" data-symbol="${escapeHtml(key)}"><td></td><td colspan="3">${infoCell}</td></tr>`;
  }

  function sectionHtml(title, rows, opts) {
    const kind = (opts && opts.kind) || "rest";
    const cls =
      kind === "always"
        ? "is-always"
        : kind === "pin"
          ? "is-pin"
          : kind === "jump"
            ? "is-jump"
            : "is-rest";
    const collapsed = kind === "always" && state.alwaysCollapsed;
    const count =
      kind === "always" && Number.isFinite(Number(opts && opts.count))
        ? Number(opts.count)
        : rows.length;
    const caret =
      kind === "always"
        ? `<span class="fut-sec-caret" aria-hidden="true">▾</span>`
        : "";
    const labelAttrs =
      kind === "always"
        ? ` data-fut-sec-toggle="always" role="button" tabindex="0" aria-expanded="${collapsed ? "false" : "true"}" title="点击展开/收起常看"`
        : "";
    const label = `<div class="fut-section-label ${cls}${collapsed ? " is-collapsed" : ""}"${labelAttrs}>${caret}<span>${escapeHtml(title)}</span> <span class="fut-section-count">${count}</span></div>`;
    // 折叠时仍画标题（角标用 eligible），行并入置顶/其余，不在此段渲染
    if (kind === "always" && collapsed) {
      return `<tbody data-fut-sec="always"><tr class="fut-section-row"><td colspan="4">${label}</td></tr></tbody>`;
    }
    if (!rows.length) {
      if (kind === "always" && count > 0) {
        return `<tbody data-fut-sec="always"><tr class="fut-section-row"><td colspan="4">${label}</td></tr></tbody>`;
      }
      if (kind !== "always") return "";
      return `<tbody data-fut-sec="always"><tr class="fut-section-row"><td colspan="4">${label}</td></tr></tbody>`;
    }
    const body = rows.map((n) => pinRowHtml(n, opts)).join("");
    return `<tbody data-fut-sec="${escapeHtml(kind)}"${kind === "always" ? ' data-fut-in-section="always"' : ""}>
      <tr class="fut-section-row"><td colspan="4">${label}</td></tr>
      ${body}
    </tbody>`;
  }

  function renderPinPane() {
    const root = $("pinList");
    if (!root) return;
    const { jump, always, alwaysEligible, pinned, rest } = splitPinSections();
    root.classList.toggle("is-always-collapsed", !!state.alwaysCollapsed);
    let html = `<table class="fut-prow-table">
      <thead><tr><th>币</th><th>K线</th><th>24h</th><th>操作</th></tr></thead>
      ${sectionHtml("临时查看", jump, { kline: true, kind: "jump" })}
      ${sectionHtml("常看", always, {
        kline: true,
        kind: "always",
        count: alwaysEligible,
      })}
      ${sectionHtml("置顶", pinned, { kline: true, kind: "pin" })}`;
    // 只看置顶：藏普通「其余」；常看折叠并入其余的仍放行（对齐钉子）
    if (!state.pinnedOnly) {
      html += sectionHtml("其余", rest, { kline: true, kind: "rest" });
    } else {
      const alwaysInRest = rest.filter((n) => isAlways(n.symbol));
      if (alwaysInRest.length) {
        html += sectionHtml("其余", alwaysInRest, { kline: true, kind: "rest" });
      }
    }
    html += "</table>";
    const restShown = state.pinnedOnly
      ? rest.some((n) => isAlways(n.symbol))
      : rest.length > 0;
    if (
      !jump.length &&
      !alwaysEligible &&
      !pinned.length &&
      !restShown
    ) {
      html =
        '<div class="fut-empty">暂无置顶。点「新增」，或从自动盯 / 雷达置顶；云函数写入后会出现在「其余」。</div>';
    }
    root.innerHTML = html;
    if (state.focusSymbol && state.focusScope === "pin") {
      openFocusBar(state.focusSymbol, "pin");
    }
  }

  function autoRowHtml(p) {
    const sym = symKey(p.symbol);
    const live = liveOf(sym);
    const ch = Number.isFinite(live.change24h)
      ? live.change24h
      : Number(p.change24h);
    const focus =
      state.focusSymbol === sym && state.focusScope === "auto"
        ? " is-focus"
        : "";
    const timeShort = (() => {
      const t = Number(p.pinnedAt) || 0;
      if (!(t > 0)) return "--";
      try {
        return new Date(t).toLocaleTimeString("zh-CN", {
          hour12: false,
          hour: "2-digit",
          minute: "2-digit",
        });
      } catch (_) {
        return "--";
      }
    })();
    const kHtml = `<canvas class="fut-kline" data-kline="${escapeHtml(sym)}" data-price-label="1" width="168" height="62"></canvas>`;
    return `<tr class="fut-prow-row${focus}" data-symbol="${escapeHtml(sym)}" data-fut-auto-row="1">
      <td class="fut-name-cell">
        <button type="button" class="fut-name" data-fut-jump-pin="${escapeHtml(sym)}" title="进置顶并定位（未在名单则临时查看）">${escapeHtml(labelOf(sym))}</button>
      </td>
      <td class="fut-kline-cell">${kHtml}</td>
      <td class="fut-chg ${pctClass(ch)}">${escapeHtml(fmtPct(ch))}</td>
    </tr>
    <tr class="fut-sub" data-symbol="${escapeHtml(sym)}"><td></td><td colspan="2"><div class="fut-info"><span class="fut-info-meta">${escapeHtml(timeShort)}</span></div></td></tr>`;
  }

  function renderAutoPane() {
    const root = $("autoList");
    if (!root) return;
    const list = state.autoPins.slice().sort((a, b) => {
      return (Number(b.pinnedAt) || 0) - (Number(a.pinnedAt) || 0);
    });
    if (!list.length) {
      root.innerHTML =
        '<div class="fut-empty">暂无云端自动盯。部署 futures/cloud-function-fut 后约 5 分钟写入。</div>';
      return;
    }
    const dayMs = 24 * 60 * 60 * 1000;
    const now = Date.now();
    const recent = [];
    const older = [];
    list.forEach((p) => {
      const at = Number(p.pinnedAt) || 0;
      if (at > 0 && now - at <= dayMs) recent.push(p);
      else older.push(p);
    });
    const block = (title, rows) => {
      if (!rows.length) return "";
      return `<tbody>
        <tr class="fut-section-row"><td colspan="3"><div class="fut-section-label">${escapeHtml(title)} <span class="fut-section-count">${rows.length}</span></div></td></tr>
        ${rows.map(autoRowHtml).join("")}
      </tbody>`;
    };
    root.innerHTML = `<table class="fut-prow-table">
      <thead><tr><th>币</th><th>K线</th><th>24h</th></tr></thead>
      ${block("近 24h", recent)}
      ${block("更早", older)}
    </table>`;
    if (state.focusSymbol && state.focusScope === "auto") {
      openFocusBar(state.focusSymbol, "auto");
    }
  }

  function buildRadarRows() {
    const entries = Object.entries(state.marketMap)
      .filter(([symbol]) => symbol.endsWith("USDT"))
      .map(([symbol, row]) => ({
        symbol,
        price: row.price,
        change24h: row.change24h,
      }))
      .sort((a, b) => (b.change24h || 0) - (a.change24h || 0));
    const rankMap = new Map();
    entries.forEach((row, index) => rankMap.set(row.symbol, index + 1));
    state.radarRankMap = rankMap;
    const poolSet = new Set(state.pool);
    const pinnedSet = new Set(
      state.nails.filter((n) => n.pinned).map((n) => n.symbol),
    );
    state.radarRows = entries.slice(0, RADAR_TOP).map((row, index) => ({
      ...row,
      rank: index + 1,
      inPool: poolSet.has(row.symbol),
      pinned: pinnedSet.has(row.symbol),
    }));
  }

  function radarPinnedExtras() {
    const inTop = new Set(state.radarRows.map((r) => r.symbol));
    return state.nails
      .filter((n) => n.pinned && !inTop.has(n.symbol))
      .map((n) => n.symbol);
  }

  function syncRadarChromeUi() {
    const allBtn = $("radarAllKlineBtn");
    if (allBtn) {
      allBtn.setAttribute(
        "aria-pressed",
        state.showAllKlines ? "true" : "false",
      );
      allBtn.classList.toggle("is-active", state.showAllKlines);
      allBtn.title = state.showAllKlines
        ? "当前：全部币都画 K 线，点一下只看置顶"
        : "当前：只画置顶币，点一下全部币都画";
    }
    const groupBtn = $("radarGroupBtn");
    if (groupBtn) {
      groupBtn.setAttribute(
        "aria-pressed",
        state.radarGroupOn ? "true" : "false",
      );
      groupBtn.classList.toggle("is-active", state.radarGroupOn);
      groupBtn.title = state.radarGroupOn
        ? "当前：归集币在顶部；点一下恢复原排名"
        : "当前：已点「归集」的行留在原排名；点一下把它们提到列表顶部";
    }
    const el = $("radarUpdated");
    if (el) {
      const at = Number(state.radarTickerAt) || 0;
      if (!(at > 0)) {
        el.textContent = "";
        el.classList.remove("is-stale");
      } else {
        const stale = Date.now() - at > 90 * 1000;
        el.textContent = `更新 ${fmtClock(at)}${stale ? " · 偏旧" : ""}`;
        el.classList.toggle("is-stale", stale);
      }
    }
  }

  function renderRadarPane() {
    buildRadarRows();
    syncRadarChromeUi();
    const body = $("radarBody");
    const empty = $("radarEmpty");
    const table = body && body.closest("table");
    if (!body) return;
    if (!state.radarRows.length) {
      body.innerHTML = "";
      if (table) table.hidden = true;
      if (empty) empty.hidden = false;
      return;
    }
    if (table) table.hidden = false;
    if (empty) empty.hidden = true;

    const poolSet = new Set(state.pool);
    const pinnedSet = new Set(
      state.nails.filter((n) => n.pinned).map((n) => n.symbol),
    );
    const markedSet = new Set(getRadarFixedSymbols());
    const rankOf = (symbol) => state.radarRankMap.get(symbol) || 0;
    const live = (symbol) => state.marketMap[symbol] || {};

    const buildRow = (symbol, rank, options) => {
      const opts = options || {};
      const key = symKey(symbol);
      const rowLive = live(key);
      const change24h = Number(rowLive.change24h);
      const isMarked = markedSet.has(key);
      const isPinned = pinnedSet.has(key);
      const isFocused = state.focusSymbol === key;
      const rowClass = [
        poolSet.has(key) ? "is-pool" : "",
        rank && rank <= 20 ? "is-top20" : "",
        opts.extra ? "is-radar-extra" : "",
        isMarked ? "is-radar-fixed" : "",
        isFocused ? "is-radar-selected" : "",
      ]
        .filter(Boolean)
        .join(" ");
      const showKline =
        state.showAllKlines || isMarked || isPinned;
      const kHtml = showKline
        ? `<canvas class="fut-kline fut-radar-kline" data-kline="${escapeHtml(key)}" data-price-label="1" width="168" height="62"></canvas>`
        : "";
      const unpinHtml = isPinned
        ? `<button type="button" class="fut-radar-act is-danger" data-fut-act="unpin" data-symbol="${escapeHtml(key)}" title="取消置顶该币">取消置顶</button>`
        : "";
      const markHtml = `<button type="button" class="fut-radar-act${isMarked ? " is-fixed" : ""}" data-radar-fixed-toggle="${escapeHtml(key)}" title="${isMarked ? "不归集" : "归集"}">${isMarked ? "不归集" : "归集"}</button>`;
      return `<tr class="${rowClass}" data-symbol="${escapeHtml(key)}" data-fut-radar-row="1"><td><span class="fut-radar-rank-mini">${rank ? `#${rank}` : "—"}</span><button type="button" class="fut-radar-symbol" data-fut-jump-pin="${escapeHtml(key)}" data-fut-radar-sym="${escapeHtml(key)}" title="进置顶并定位（未在名单则临时查看）">${escapeHtml(labelOf(key))}</button></td><td class="fut-kline-cell">${kHtml}</td><td class="${radarPctClass(change24h)}">${escapeHtml(fmtPct(change24h))}</td><td>${markHtml}${unpinHtml}</td></tr>`;
    };

    const rows = [];
    const grouped = state.radarGroupOn
      ? getRadarFixedSymbols()
          .slice()
          .sort((a, b) => {
            const ra = rankOf(a) || Number.MAX_SAFE_INTEGER;
            const rb = rankOf(b) || Number.MAX_SAFE_INTEGER;
            return ra - rb || a.localeCompare(b);
          })
      : [];
    const groupedSet = new Set(grouped);
    if (grouped.length) {
      rows.push(
        `<tr class="is-radar-sep"><td colspan="4">已归集（${grouped.length}）</td></tr>`,
      );
      grouped.forEach((symbol) => {
        rows.push(buildRow(symbol, rankOf(symbol) || 0));
      });
    }
    state.radarRows.forEach((r) => {
      if (groupedSet.has(r.symbol)) return;
      rows.push(buildRow(r.symbol, r.rank));
    });
    const extras = radarPinnedExtras().filter((s) => !groupedSet.has(s));
    if (extras.length) {
      rows.push(
        `<tr class="is-radar-sep"><td colspan="4">榜单外 · 已置顶（${extras.length}）</td></tr>`,
      );
      extras
        .slice()
        .sort((a, b) => (rankOf(a) || 1e9) - (rankOf(b) || 1e9))
        .forEach((symbol) => {
          rows.push(buildRow(symbol, rankOf(symbol) || 0, { extra: true }));
        });
    }
    body.innerHTML = rows.join("");
    if (state.focusSymbol && state.focusScope === "radar") {
      openFocusBar(state.focusSymbol, "radar");
    }
  }

  function bindRadarChrome() {
    const allBtn = $("radarAllKlineBtn");
    if (allBtn && !allBtn._bound) {
      allBtn._bound = true;
      allBtn.addEventListener("click", () => {
        state.showAllKlines = !state.showAllKlines;
        writeLocal(SHOW_ALL_KEY, state.showAllKlines ? "1" : "0");
        renderRadarPane();
        void paintVisibleKlines();
      });
    }
    const groupBtn = $("radarGroupBtn");
    if (groupBtn && !groupBtn._bound) {
      groupBtn._bound = true;
      groupBtn.addEventListener("click", () => {
        state.radarGroupOn = !state.radarGroupOn;
        writeLocal(RADAR_GROUP_KEY, state.radarGroupOn ? "1" : "0");
        renderRadarPane();
        void paintVisibleKlines();
      });
    }
    const refreshBtn = $("radarRefreshBtn");
    if (refreshBtn && !refreshBtn._bound) {
      refreshBtn._bound = true;
      refreshBtn.addEventListener("click", () => void refreshView());
    }
  }

  function futScrollPctEl() {
    return $("futScrollPct");
  }

  function pickScrollAnchorRow(listEl) {
    if (!listEl) return null;
    const listRect = listEl.getBoundingClientRect();
    const y = listRect.top + Math.max(24, listRect.height * 0.32);
    const rows = [...listEl.querySelectorAll(".fut-prow-row[data-symbol]")].filter(
      (row) => {
        if (!row || row.offsetParent === null) return false;
        const style = window.getComputedStyle(row);
        return style.display !== "none" && style.visibility !== "hidden";
      },
    );
    let best = null;
    let bestDist = Infinity;
    for (const row of rows) {
      const r = row.getBoundingClientRect();
      if (r.bottom < listRect.top || r.top > listRect.bottom) continue;
      const mid = (r.top + r.bottom) / 2;
      const dist = Math.abs(mid - y);
      if (dist < bestDist) {
        bestDist = dist;
        best = row;
      }
    }
    return best;
  }

  function hideFutScrollPct(immediate) {
    const el = futScrollPctEl();
    if (!el) return;
    if (futScrollPctHideTimer) {
      window.clearTimeout(futScrollPctHideTimer);
      futScrollPctHideTimer = 0;
    }
    el.classList.remove("is-visible");
    if (immediate) {
      el.hidden = true;
      el.setAttribute("aria-hidden", "true");
    } else {
      futScrollPctHideTimer = window.setTimeout(() => {
        el.hidden = true;
        el.setAttribute("aria-hidden", "true");
        futScrollPctHideTimer = 0;
      }, 220);
    }
  }

  function updateFutScrollPct(options) {
    const opts = options || {};
    const list = $("pinList");
    const el = futScrollPctEl();
    if (!list || !el) return;
    const show =
      state.tab === "pin" &&
      state.sort === "change24h" &&
      list.scrollHeight > list.clientHeight + 8;
    if (!show) {
      hideFutScrollPct(true);
      return;
    }
    const row = pickScrollAnchorRow(list);
    const symbol = row
      ? String(row.getAttribute("data-symbol") || "")
          .trim()
          .toUpperCase()
      : "";
    const change = symbol ? Number(liveOf(symbol).change24h) : NaN;
    el.textContent = fmtPct(change);
    el.hidden = false;
    el.setAttribute("aria-hidden", "false");
    if (opts.flash === false) return;
    el.classList.add("is-visible");
    if (futScrollPctHideTimer) {
      window.clearTimeout(futScrollPctHideTimer);
    }
    futScrollPctHideTimer = window.setTimeout(() => {
      el.classList.remove("is-visible");
      futScrollPctHideTimer = window.setTimeout(() => {
        el.hidden = true;
        el.setAttribute("aria-hidden", "true");
        futScrollPctHideTimer = 0;
      }, 220);
    }, 900);
  }

  function render() {
    if (state.tab === "pin") renderPinPane();
    else if (state.tab === "auto") renderAutoPane();
    else renderRadarPane();
    syncSelectUi();
    updateHeadMeta();
    syncFutAutoPinBadge();
    if (state.tab === "pin" && state.sort === "change24h") {
      updateFutScrollPct({ flash: false });
    } else {
      hideFutScrollPct(true);
    }
    void paintVisibleKlines();
  }

  function syncFutZoomRangeUi() {
    document.querySelectorAll("[data-fut-zoom-range]").forEach((btn) => {
      const on = btn.getAttribute("data-fut-zoom-range") === state.zoomLongRange;
      btn.classList.toggle("is-active", on);
      btn.setAttribute("aria-pressed", on ? "true" : "false");
    });
  }

  async function paintFutZoomMain(symbol) {
    const canvas = $("futZoomCanvas");
    const meta = $("futZoomMeta");
    if (!canvas || !symbol) return;
    const candles = await fetchKlines(symbol, KLINE_INTERVAL, KLINE_LIMIT);
    if (state.zoomSymbol !== symbol) return;
    const pin = notePinPrice(symbol);
    paintMiniKline(canvas, candles, {
      pinPrice: pin,
      noteAt: noteAtOf(symbol),
      barMs: KLINE_BAR_MS,
      pad: 6,
    });
    const live = liveOf(symbol);
    if (meta) {
      meta.textContent = [
        "4h",
        Number.isFinite(live.price) ? `现价 ${fmtPrice(live.price)}` : "",
        Number.isFinite(live.change24h) ? `24h ${fmtPct(live.change24h)}` : "",
        pin > 0 ? `便签 ${fmtPrice(pin)}` : "",
      ]
        .filter(Boolean)
        .join(" · ");
    }
  }

  async function paintFutZoomLong(symbol) {
    const canvas = $("futZoomLongCanvas");
    const meta = $("futZoomLongMeta");
    if (!canvas || !symbol) return;
    const range = zoomLongRangeConfig(state.zoomLongRange);
    if (meta) meta.textContent = `加载${range.label}…`;
    try {
      const candles = await fetchKlines(symbol, range.interval, range.limit);
      if (
        state.zoomSymbol !== symbol ||
        state.zoomLongRange !== range.key
      ) {
        return;
      }
      const barMs =
        range.key === "day"
          ? 24 * 60 * 60 * 1000
          : range.key === "month"
            ? 30 * 24 * 60 * 60 * 1000
            : 7 * 24 * 60 * 60 * 1000;
      paintMiniKline(canvas, candles, {
        pinPrice: notePinPrice(symbol),
        noteAt: noteAtOf(symbol),
        barMs,
        pad: 6,
      });
      if (meta) meta.textContent = `${range.label} · ${candles.length} 根`;
    } catch (error) {
      if (state.zoomSymbol === symbol && meta) {
        meta.textContent = (error && error.message) || `${range.label}加载失败`;
      }
    }
  }

  async function openZoom(symbol) {
    const key = symKey(symbol);
    if (!key) return;
    const overlay = $("futZoomOverlay");
    const title = $("futZoomTitle");
    const meta = $("futZoomMeta");
    const mainWrap = document.querySelector(".fut-zoom-chart");
    const longWrap = document.querySelector(".fut-zoom-long-chart");
    if (!overlay) return;
    state.zoomSymbol = key;
    state.zoomPaintToken += 1;
    const token = state.zoomPaintToken;
    if (title) title.textContent = labelOf(key);
    if (meta) meta.textContent = "加载 K 线…";
    if (mainWrap) mainWrap.classList.add("is-loading");
    if (longWrap) longWrap.classList.add("is-loading");
    syncFutZoomRangeUi();
    overlay.hidden = false;
    document.body.classList.add("is-fut-zoom");
    try {
      await refreshTickers([key]);
      if (token !== state.zoomPaintToken || state.zoomSymbol !== key) return;
      await Promise.all([paintFutZoomMain(key), paintFutZoomLong(key)]);
      requestAnimationFrame(() => {
        if (state.zoomSymbol === key) {
          void paintFutZoomMain(key);
          void paintFutZoomLong(key);
        }
      });
    } catch (error) {
      if (meta) meta.textContent = (error && error.message) || "K 线加载失败";
      toast((error && error.message) || "放大 K 线失败");
    } finally {
      if (mainWrap) mainWrap.classList.remove("is-loading");
      if (longWrap) longWrap.classList.remove("is-loading");
    }
  }

  function closeZoom() {
    state.zoomSymbol = null;
    state.zoomPaintToken += 1;
    const overlay = $("futZoomOverlay");
    if (overlay) overlay.hidden = true;
    document.body.classList.remove("is-fut-zoom");
  }

  function setFutZoomLongRange(range) {
    const next =
      range === "day" || range === "month" || range === "week" ? range : "week";
    if (next === state.zoomLongRange) return;
    state.zoomLongRange = next;
    syncFutZoomRangeUi();
    if (!state.zoomSymbol) return;
    const longWrap = document.querySelector(".fut-zoom-long-chart");
    if (longWrap) longWrap.classList.add("is-loading");
    void paintFutZoomLong(state.zoomSymbol).finally(() => {
      if (longWrap) longWrap.classList.remove("is-loading");
    });
  }

  async function refreshView(opts) {
    const options = opts || {};
    if (state.refreshing) {
      toast("刷新中…");
      return;
    }
    const quiet = !!options.quiet;
    const status = $("statusMeta");
    const errBox = $("errBox");
    setRefreshingUi(true);
    if (errBox) errBox.hidden = true;
    if (status) status.textContent = "刷新中…";
    try {
      const updated = await loadAllJson();
      const focus = new Set([
        ...state.nails.map((n) => n.symbol),
        ...state.autoPins.map((p) => p.symbol),
        ...state.pool,
      ]);
      if (state.tab === "radar") {
        await refreshTickers([]);
      } else {
        await refreshTickers([...focus]);
      }
      render();
      flashListRefresh();
      if (status) {
        status.textContent = updated
          ? "数据 " + fmtTime(updated)
          : "已刷新 · 等云函数写入池/自动盯";
      }
      updateHeadMeta();
      if (!quiet) toast("已刷新");
      void maybeShowDailyResetPrompt();
    } catch (error) {
      console.warn(error);
      if (errBox) {
        errBox.hidden = false;
        errBox.textContent = (error && error.message) || "刷新失败";
      }
      if (status) status.textContent = "刷新失败";
      updateHeadMeta();
      toast((error && error.message) || "刷新失败");
    } finally {
      setRefreshingUi(false);
    }
  }

  function setSettingsOpen(open) {
    const pop = $("futSettingsPopover");
    const btn = $("futSettingsBtn");
    if (!pop || !btn) return;
    pop.hidden = !open;
    btn.setAttribute("aria-expanded", open ? "true" : "false");
  }

  function syncSettingsChrome() {
    document.querySelectorAll("[data-fut-sort]").forEach((btn) => {
      btn.classList.toggle(
        "is-active",
        btn.getAttribute("data-fut-sort") === state.sort,
      );
    });
    const pinnedOnly = $("futPinnedOnlySwitch");
    if (pinnedOnly) {
      pinnedOnly.setAttribute(
        "aria-checked",
        state.pinnedOnly ? "true" : "false",
      );
    }
    const auto = $("futAutoRefreshSwitch");
    if (auto) {
      auto.setAttribute("aria-checked", state.autoRefresh ? "true" : "false");
    }
  }

  function applyAutoRefresh() {
    if (state.autoRefreshTimer) {
      clearInterval(state.autoRefreshTimer);
      state.autoRefreshTimer = 0;
    }
    if (!state.autoRefresh) return;
    state.autoRefreshTimer = setInterval(() => {
      if (document.hidden || state.refreshing || state.saving) return;
      void refreshView({ quiet: true });
    }, AUTO_REFRESH_MS);
  }

  async function saveWatchPoolRank() {
    const input = $("futWatchPoolRankInput");
    const btn = $("futWatchPoolRankSave");
    const rank = clampPoolRank(input && input.value);
    if (input) input.value = String(rank);
    setButtonLoading(btn, true);
    setSaving(true, "保存设置…");
    try {
      await window.FutStore.patchJson(
        PATHS.prefs,
        (data) => ({
          data: {
            ...data,
            watchPoolRank: rank,
            updatedAt: Date.now(),
            market: "usdt-perp",
          },
        }),
        `Fut prefs pool rank ${rank}`,
      );
      state.poolRank = rank;
      toast(`观察池前 N 已存为 ${rank}`);
      setSettingsOpen(false);
    } catch (error) {
      toast((error && error.message) || "保存失败");
      throw error;
    } finally {
      setButtonLoading(btn, false);
      if (!state.refreshing) setSaving(false);
    }
  }

  async function refreshOneSymbol(symbol) {
    const key = symKey(symbol);
    if (!key) return;
    await refreshTickers([key]);
    clearKlineCacheFor(key);
    await ensureKlines([key]);
    render();
    flashNameRefresh(key);
  }

  function flashNameRefresh(symbol) {
    const key = symKey(symbol);
    if (!key) return;
    document
      .querySelectorAll(
        `#pinList .fut-prow-row[data-symbol="${key}"] .fut-name`,
      )
      .forEach((el) => {
        el.classList.remove("is-refresh-flash");
        void el.offsetWidth;
        el.classList.add("is-refresh-flash");
        clearTimeout(el._flashNameT);
        el._flashNameT = setTimeout(
          () => el.classList.remove("is-refresh-flash"),
          900,
        );
      });
  }

  function bindLongPress(root) {
    if (!root || root.dataset.longBound === "1") return;
    root.dataset.longBound = "1";
    let timer = 0;
    let startX = 0;
    let startY = 0;
    let symbol = "";
    let longFired = false;
    let lastTapKey = "";
    let lastTapAt = 0;
    const clear = () => {
      if (timer) {
        clearTimeout(timer);
        timer = 0;
      }
      symbol = "";
    };
    const onStart = (ev) => {
      if (state.selectMode || state.tab !== "pin") return;
      const row = ev.target.closest("[data-fut-row]");
      if (!row) return;
      if (
        ev.target.closest(
          "button, input, .fut-pin-menu, .fut-check, a, .fut-ops",
        )
      ) {
        return;
      }
      longFired = false;
      const point = ev.touches ? ev.touches[0] : ev;
      startX = point.clientX;
      startY = point.clientY;
      symbol = symKey(row.getAttribute("data-symbol"));
      timer = window.setTimeout(() => {
        timer = 0;
        if (!symbol) return;
        longFired = true;
        openFloatMenu(symbol, startX, startY);
      }, LONG_PRESS_MS);
    };
    const onMove = (ev) => {
      if (!timer) return;
      const point = ev.touches ? ev.touches[0] : ev;
      if (
        Math.abs(point.clientX - startX) > 10 ||
        Math.abs(point.clientY - startY) > 10
      ) {
        clear();
      }
    };
    const onEnd = () => {
      const key = symbol;
      const wasLong = longFired;
      const shortTap = !!timer && !wasLong;
      clear();
      if (!key || wasLong || !shortTap || state.selectMode) return;
      // 短按抬起：双击刷新；单击切换焦点+便签底栏（对齐钉子）
      const now = Date.now();
      if (key === lastTapKey && now - lastTapAt <= DOUBLE_TAP_MS) {
        lastTapKey = "";
        lastTapAt = 0;
        closeFocusBar();
        void refreshOneSymbol(key)
          .then(() => toast(`已刷新 ${labelOf(key)}`))
          .catch((e) => toast((e && e.message) || "刷新失败"));
        return;
      }
      lastTapKey = key;
      lastTapAt = now;
      togglePinFocus(key);
    };
    root.addEventListener("touchstart", onStart, { passive: true });
    root.addEventListener("mousedown", onStart);
    root.addEventListener("touchmove", onMove, { passive: true });
    root.addEventListener("mousemove", onMove);
    root.addEventListener("touchend", onEnd);
    root.addEventListener("mouseup", onEnd);
    root.addEventListener("mouseleave", clear);
  }

  function bind() {
    document.querySelectorAll("[data-fut-tab]").forEach((btn) => {
      btn.addEventListener("click", () =>
        setTab(btn.getAttribute("data-fut-tab")),
      );
    });

    bindRadarChrome();

    const refreshBtn = $("refreshBtn");
    if (refreshBtn) {
      refreshBtn.addEventListener("click", () => void refreshView());
    }

    const selectBtn = $("futSelectBtn");
    if (selectBtn) {
      selectBtn.addEventListener("click", () => setSelectMode(!state.selectMode));
    }

    const batchExit = $("futBatchExitBtn");
    if (batchExit) {
      batchExit.addEventListener("click", () => setSelectMode(false));
    }
    const batchSelectAll = $("futBatchSelectAllBtn");
    if (batchSelectAll) {
      batchSelectAll.addEventListener("click", () => selectAllVisiblePins());
    }
    const runBatch = (btn, job) => {
      setButtonLoading(btn, true);
      void job()
        .then(() => setSelectMode(false))
        .catch((e) => toast(e.message || "失败"))
        .finally(() => setButtonLoading(btn, false));
    };
    const batchPin = $("futBatchPinBtn");
    if (batchPin) {
      batchPin.addEventListener("click", () => {
        runBatch(batchPin, () => pinToBoard([...state.selected]));
      });
    }
    const batchUnpin = $("futBatchUnpinBtn");
    if (batchUnpin) {
      batchUnpin.addEventListener("click", () => {
        runBatch(batchUnpin, () => unpinFromBoard([...state.selected]));
      });
    }
    const batchNote = $("futBatchNoteBtn");
    if (batchNote) {
      batchNote.addEventListener("click", () => {
        runBatch(batchNote, () => setNoteNow([...state.selected]));
      });
    }
    const batchDelete = $("futBatchDeleteBtn");
    if (batchDelete) {
      batchDelete.addEventListener("click", () => {
        runBatch(batchDelete, () => deleteNails([...state.selected]));
      });
    }

    const addBtn = $("futAddBtn");
    if (addBtn) {
      addBtn.addEventListener("click", () => setAddOpen(!state.addOpen));
    }
    const addCancel = $("futAddCancel");
    if (addCancel) {
      addCancel.addEventListener("click", () => setAddOpen(false));
    }
    const addForm = $("futAddForm");
    if (addForm) {
      addForm.addEventListener("submit", (ev) => {
        ev.preventDefault();
        const name = ($("futAddSymbol") && $("futAddSymbol").value) || "";
        const note = ($("futAddNote") && $("futAddNote").value) || "";
        const submitBtn = addForm.querySelector('button[type="submit"]');
        setButtonLoading(submitBtn, true);
        void addNailByInput(name, note)
          .catch((e) => toast(e.message || "新增失败"))
          .finally(() => setButtonLoading(submitBtn, false));
      });
    }

    const focusClose = $("futFocusClose");
    if (focusClose) {
      focusClose.addEventListener("click", () => closeFocusBar());
    }
    const focusNote = $("futFocusNoteBtn");
    if (focusNote) {
      focusNote.addEventListener("click", () => {
        if (!state.focusSymbol || state.focusScope !== "pin") return;
        openNoteEditor(state.focusSymbol);
      });
    }
    const focusPin = $("futFocusPinBtn");
    if (focusPin) {
      focusPin.addEventListener("click", () => {
        if (!state.focusSymbol || isUserPinned(state.focusSymbol)) return;
        const bar = $("futFocusBar");
        if (bar) bar.classList.add("is-busy");
        setButtonLoading(focusPin, true);
        void pinToBoard([state.focusSymbol])
          .then(() => {
            if (state.focusSymbol) {
              openFocusBar(state.focusSymbol, state.focusScope || "auto");
            }
          })
          .catch((e) => toast(e.message || "失败"))
          .finally(() => {
            setButtonLoading(focusPin, false, {
              keepDisabled: isUserPinned(state.focusSymbol),
            });
            if (bar) bar.classList.remove("is-busy");
          });
      });
    }
    const focusRefresh = $("futFocusRefreshBtn");
    if (focusRefresh) {
      focusRefresh.addEventListener("click", () => {
        if (!state.focusSymbol) return;
        const bar = $("futFocusBar");
        if (bar) bar.classList.add("is-busy");
        setButtonLoading(focusRefresh, true);
        void refreshOneSymbol(state.focusSymbol)
          .then(() => toast(`已刷新 ${labelOf(state.focusSymbol)}`))
          .catch((error) => toast((error && error.message) || "刷新失败"))
          .finally(() => {
            setButtonLoading(focusRefresh, false);
            if (bar) bar.classList.remove("is-busy");
          });
      });
    }
    const zoomClose = $("futZoomClose");
    if (zoomClose) zoomClose.addEventListener("click", () => closeZoom());
    const zoomOverlay = $("futZoomOverlay");
    if (zoomOverlay) {
      zoomOverlay.addEventListener("click", (ev) => {
        if (ev.target === zoomOverlay) closeZoom();
      });
    }
    document.querySelectorAll("[data-fut-zoom-range]").forEach((btn) => {
      btn.addEventListener("click", () => {
        setFutZoomLongRange(btn.getAttribute("data-fut-zoom-range"));
      });
    });
    document.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape" && state.zoomSymbol) closeZoom();
    });

    document.body.addEventListener("click", (ev) => {
      const secToggle = ev.target.closest("[data-fut-sec-toggle='always']");
      if (secToggle) {
        state.alwaysCollapsed = !state.alwaysCollapsed;
        writeLocal(ALWAYS_COLLAPSE_KEY, state.alwaysCollapsed ? "1" : "0");
        render();
        return;
      }

      const delBtn = ev.target.closest("[data-fut-del]");
      if (delBtn) {
        const sym = delBtn.getAttribute("data-fut-del");
        // 对齐钉子：仅 guest「收起」清 jumpReveal；非 guest 露出走真删
        if (isJumpGuest(sym)) {
          clearJumpReveal({ rerender: true });
          toast("已收起临时查看");
          return;
        }
        // 仅常看观察卡：删 = 取消常看
        if (isAlways(sym) && !hasRealNail(sym)) {
          void toggleAlways(sym, false).catch((e) =>
            toast(e.message || "取消常看失败"),
          );
          return;
        }
        void deleteNails([sym]).catch((e) => toast(e.message || "删除失败"));
        return;
      }

      const zoomBtn = ev.target.closest("[data-fut-zoom]");
      if (zoomBtn) {
        void openZoom(zoomBtn.getAttribute("data-fut-zoom"));
        return;
      }

      // 对齐钉子：点币名 → 进置顶并定位（未在名单=临时查看）；点行其余区域 → 焦点栏
      const jumpPin = ev.target.closest("[data-fut-jump-pin]");
      if (jumpPin) {
        void jumpToPinSymbol(jumpPin.getAttribute("data-fut-jump-pin"));
        return;
      }

      const autoRow = ev.target.closest("#autoList [data-fut-auto-row]");
      if (autoRow && !ev.target.closest("button, a, input")) {
        const sym = autoRow.getAttribute("data-symbol");
        if (
          state.focusSymbol === symKey(sym) &&
          state.focusScope === "auto"
        ) {
          closeFocusBar();
        } else {
          openFocusBar(sym, "auto");
        }
        return;
      }

      const radarFixedBtn = ev.target.closest("[data-radar-fixed-toggle]");
      if (radarFixedBtn) {
        toggleRadarFixed(radarFixedBtn.getAttribute("data-radar-fixed-toggle"));
        renderRadarPane();
        void paintVisibleKlines();
        return;
      }

      const radarSym = ev.target.closest("[data-fut-radar-sym]");
      if (radarSym) {
        void jumpToPinSymbol(radarSym.getAttribute("data-fut-radar-sym"));
        return;
      }

      const radarRow = ev.target.closest("#radarBody [data-fut-radar-row]");
      if (radarRow && !ev.target.closest("button, a, input")) {
        const sym = radarRow.getAttribute("data-symbol");
        if (
          state.focusSymbol === symKey(sym) &&
          state.focusScope === "radar"
        ) {
          closeFocusBar();
        } else {
          openFocusBar(sym, "radar");
        }
        return;
      }

      const copyBtn = ev.target.closest("[data-fut-copy]");
      if (copyBtn) {
        const text = copyBtn.getAttribute("data-fut-copy") || "";
        if (text && navigator.clipboard && navigator.clipboard.writeText) {
          void navigator.clipboard.writeText(text).then(
            () => toast(`已复制 ${text}`),
            () => {},
          );
        }
        return;
      }

      const selectCheck = ev.target.closest("[data-fut-select]");
      if (selectCheck) {
        toggleSelect(selectCheck.getAttribute("data-fut-select"));
        return;
      }

      if (state.selectMode) {
        const row = ev.target.closest("#pinList [data-fut-row]");
        if (row) {
          toggleSelect(row.getAttribute("data-symbol"));
          return;
        }
      }

      const pinBtn = ev.target.closest("[data-fut-pin]");
      if (pinBtn) {
        ev.preventDefault();
        ev.stopPropagation();
        openPinMenu(pinBtn, pinBtn.getAttribute("data-fut-pin"));
        return;
      }

      const pinOn = ev.target.closest("[data-fut-pin-on]");
      if (pinOn) {
        closePinMenus();
        void pinToBoard([pinOn.getAttribute("data-fut-pin-on")]).catch((e) =>
          toast(e.message || "失败"),
        );
        return;
      }
      const pinFirstBtn = ev.target.closest("[data-fut-pin-first]");
      if (pinFirstBtn) {
        closePinMenus();
        void pinFirst(pinFirstBtn.getAttribute("data-fut-pin-first")).catch(
          (e) => toast(e.message || "失败"),
        );
        return;
      }
      const pinOff = ev.target.closest("[data-fut-pin-off]");
      if (pinOff) {
        closePinMenus();
        void unpinFromBoard([pinOff.getAttribute("data-fut-pin-off")]).catch(
          (e) => toast(e.message || "失败"),
        );
        return;
      }
      const alwaysOn = ev.target.closest("[data-fut-always-on]");
      if (alwaysOn) {
        closePinMenus();
        void toggleAlways(alwaysOn.getAttribute("data-fut-always-on"), true).catch(
          (e) => toast(e.message || "失败"),
        );
        return;
      }
      const alwaysOff = ev.target.closest("[data-fut-always-off]");
      if (alwaysOff) {
        closePinMenus();
        void toggleAlways(
          alwaysOff.getAttribute("data-fut-always-off"),
          false,
        ).catch((e) => toast(e.message || "失败"));
        return;
      }

      const actBtn = ev.target.closest("[data-fut-act]");
      if (actBtn) {
        const act = actBtn.getAttribute("data-fut-act");
        const symbol = actBtn.getAttribute("data-symbol");
        void (async () => {
          try {
            if (act === "pin") await pinToBoard([symbol]);
            else if (act === "unpin") await unpinFromBoard([symbol]);
          } catch (error) {
            toast((error && error.message) || "操作失败");
          }
        })();
        return;
      }

      if (!ev.target.closest(".fut-pin-wrap")) closePinMenus();
    });

    const floatMask = $("futRowFloatMask");
    if (floatMask) {
      floatMask.addEventListener("click", () => closeFloatMenu());
    }
    const floatMenu = $("futRowFloatMenu");
    if (floatMenu) {
      floatMenu.addEventListener("click", (ev) => {
        if (ev.target.closest("[data-fut-row-close]")) {
          closeFloatMenu();
          return;
        }
        const btn = ev.target.closest("[data-fut-float]");
        if (!btn || !state.floatSymbol) return;
        const act = btn.getAttribute("data-fut-float");
        const symbol = state.floatSymbol;
        closeFloatMenu();
        void (async () => {
          try {
            if (act === "note") openNoteEditor(symbol);
            else if (act === "pin") await pinToBoard([symbol]);
            else if (act === "unpin") await unpinFromBoard([symbol]);
            else if (act === "always") await toggleAlways(symbol);
          } catch (error) {
            toast((error && error.message) || "操作失败");
          }
        })();
      });
    }

    bindLongPress($("pinList"));

    const settingsBtn = $("futSettingsBtn");
    if (settingsBtn) {
      settingsBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const pop = $("futSettingsPopover");
        setSettingsOpen(!!(pop && pop.hidden));
      });
    }
    document.addEventListener("click", (ev) => {
      const pop = $("futSettingsPopover");
      if (!pop || pop.hidden) return;
      if (ev.target.closest("#futSettingsPopover, #futSettingsBtn")) return;
      setSettingsOpen(false);
    });

    document.querySelectorAll("[data-fut-sort]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const sort = btn.getAttribute("data-fut-sort");
        if (sort !== "order" && sort !== "noteGain" && sort !== "change24h") {
          return;
        }
        state.sort = sort;
        writeLocal(SORT_KEY, sort);
        syncSettingsChrome();
        if (state.tab === "pin") render();
        if (sort === "change24h") updateFutScrollPct({ flash: false });
        else hideFutScrollPct(true);
      });
    });

    const pinList = $("pinList");
    if (pinList) {
      pinList.addEventListener(
        "scroll",
        () => {
          if (state.tab === "pin" && state.sort === "change24h") {
            updateFutScrollPct();
          }
        },
        { passive: true },
      );
    }

    const noteEditor = $("futNoteEditor");
    const noteEditorForm = $("futNoteEditorForm");
    const noteEditorCancel = $("futNoteEditorCancel");
    const noteEditorSave = $("futNoteEditorSave");
    const noteEditorText = $("futNoteEditorText");
    if (noteEditorCancel) {
      noteEditorCancel.addEventListener("click", closeNoteEditor);
    }
    if (noteEditor) {
      noteEditor.addEventListener("click", (ev) => {
        if (ev.target === noteEditor) closeNoteEditor();
      });
      noteEditor
        .querySelectorAll('input[name="futNoteTimeMode"]')
        .forEach((radio) => {
          radio.addEventListener("change", () => {
            if (!radio.checked) return;
            noteTimeMode =
              radio.value === "current" ? "current" : "original";
            try {
              localStorage.setItem(NOTE_TIME_MODE_KEY, noteTimeMode);
            } catch (_) {
              /* ignore */
            }
          });
        });
    }
    if (noteEditorForm) {
      noteEditorForm.addEventListener("submit", async (ev) => {
        ev.preventDefault();
        if (!noteEditorSymbol || noteEditorSaving) return;
        const mode =
          (noteEditor &&
            noteEditor.querySelector(
              'input[name="futNoteTimeMode"]:checked',
            )?.value) ||
          noteTimeMode;
        noteEditorSaving = true;
        if (noteEditor) noteEditor.setAttribute("aria-busy", "true");
        if (noteEditorSave) {
          noteEditorSave.disabled = true;
          noteEditorSave.textContent = "保存中";
        }
        if (noteEditorCancel) noteEditorCancel.disabled = true;
        if (noteEditorText) noteEditorText.disabled = true;
        try {
          const saved = await saveEditedNote(
            noteEditorSymbol,
            noteEditorText ? noteEditorText.value : "",
            mode,
          );
          if (saved) {
            noteEditorSaving = false;
            closeNoteEditor();
          }
        } catch (error) {
          toast((error && error.message) || "便签保存失败");
        } finally {
          noteEditorSaving = false;
          if (noteEditor) noteEditor.removeAttribute("aria-busy");
          if (noteEditorSave) {
            noteEditorSave.disabled = false;
            noteEditorSave.textContent = "保存";
          }
          if (noteEditorCancel) noteEditorCancel.disabled = false;
          if (noteEditorText) noteEditorText.disabled = false;
        }
      });
    }

    const pinnedOnly = $("futPinnedOnlySwitch");
    if (pinnedOnly) {
      pinnedOnly.addEventListener("click", () => {
        state.pinnedOnly = !state.pinnedOnly;
        writeLocal(PINNED_ONLY_KEY, state.pinnedOnly ? "1" : "0");
        syncSettingsChrome();
        if (state.tab === "pin") render();
      });
    }

    const auto = $("futAutoRefreshSwitch");
    if (auto) {
      auto.addEventListener("click", () => {
        state.autoRefresh = !state.autoRefresh;
        writeLocal(AUTO_REFRESH_KEY, state.autoRefresh ? "1" : "0");
        syncSettingsChrome();
        applyAutoRefresh();
        toast(state.autoRefresh ? "定时刷新已开" : "定时刷新已关");
      });
    }

    const rankSave = $("futWatchPoolRankSave");
    if (rankSave) {
      rankSave.addEventListener("click", () => {
        void saveWatchPoolRank().catch((error) =>
          toast(error.message || "保存失败"),
        );
      });
    }

    const flatBtn = $("futFlatSimplifyBtn");
    if (flatBtn) {
      flatBtn.addEventListener("click", () => {
        const { always, pinned } = splitPinSections();
        const keys = [...always, ...pinned].map((n) => n.symbol);
        if (!keys.length) {
          toast("没有可平简的置顶/常看");
          return;
        }
        setButtonLoading(flatBtn, true);
        void setNoteNow(keys)
          .then(() => setSettingsOpen(false))
          .catch((error) => toast(error.message || "平简失败"))
          .finally(() => setButtonLoading(flatBtn, false));
      });
    }

    const dailyAck = $("futDailyResetAck");
    if (dailyAck) {
      dailyAck.addEventListener("click", () => {
        void dismissDailyResetPrompt();
      });
    }

    syncSettingsChrome();
    applyAutoRefresh();
  }

  bind();
  void (async () => {
    const shell = $("futShell");
    if (shell) shell.classList.add("is-booting");
    setSaving(true, "加载中…");
    try {
      if (window.FutStore && typeof window.FutStore.tryWarmUnlock === "function") {
        try {
          await window.FutStore.tryWarmUnlock();
        } catch (_) {
          /* ignore */
        }
      }
      // 同步分栏 UI，再 quiet 拉数（避免 setTab 再套一层 toast）
      state.tab = "pin";
      document.querySelectorAll("[data-fut-tab]").forEach((btn) => {
        const on = btn.getAttribute("data-fut-tab") === "pin";
        btn.classList.toggle("is-active", on);
        btn.setAttribute("aria-selected", on ? "true" : "false");
      });
      document.querySelectorAll("[data-fut-pane]").forEach((pane) => {
        pane.hidden = pane.getAttribute("data-fut-pane") !== "pin";
      });
      await refreshView({ quiet: true });
    } catch (error) {
      toast((error && error.message) || "加载失败");
    } finally {
      state.booting = false;
      if (shell) shell.classList.remove("is-booting");
      if (!state.refreshing && !state.saving) setSaving(false);
    }
  })();
})();
