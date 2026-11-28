/* 合约三栏：置顶 / 自动盯 / 雷达 — UI 对齐现货钉子；数据仅 futures/* */
(function () {
  "use strict";

  const PATHS = {
    nails: "futures/fut-nails.json",
    autoPins: "futures/fut-auto-pins.json",
    pool: "futures/fut-watch-pool.json",
    state: "futures/fut-notify-state.json",
    prefs: "futures/fut-prefs.json",
  };
  const REL = {
    nails: "./fut-nails.json",
    autoPins: "./fut-auto-pins.json",
    pool: "./fut-watch-pool.json",
    state: "./fut-notify-state.json",
    prefs: "./fut-prefs.json",
  };
  const FAPI_HOSTS = [
    "https://fapi.binance.com",
    "https://fapi1.binance.com",
    "https://fapi2.binance.com",
    "https://fapi3.binance.com",
  ];
  const RADAR_TOP = 80;
  const KLINE_INTERVAL = "4h";
  const KLINE_LIMIT = 42;
  const SHOW_ALL_KEY = "fut_radar_show_all_klines";
  const SORT_KEY = "fut_pin_sort";
  const PINNED_ONLY_KEY = "fut_pinned_only";
  const AUTO_REFRESH_KEY = "fut_auto_refresh";
  const AUTO_REFRESH_MS = 15 * 1000;
  const LONG_PRESS_MS = 480;

  const state = {
    tab: "pin",
    nails: [],
    alwaysWatch: [],
    autoPins: [],
    pool: [],
    poolRank: 35,
    events: [],
    marketMap: {},
    klineCache: {},
    showAllKlines: false,
    sort: "noteGain",
    pinnedOnly: false,
    autoRefresh: false,
    saving: false,
    radarRows: [],
    autoRefreshTimer: 0,
    selectMode: false,
    selected: new Set(),
    floatSymbol: null,
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
    const sort = readLocalFlag(SORT_KEY, "noteGain");
    state.sort =
      sort === "order" || sort === "change24h" || sort === "noteGain"
        ? sort
        : "noteGain";
    state.pinnedOnly = readLocalFlag(PINNED_ONLY_KEY, "0") === "1";
    state.autoRefresh = readLocalFlag(AUTO_REFRESH_KEY, "0") === "1";
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

  function pctClass(n) {
    if (!Number.isFinite(n) || n === 0) return "";
    return n > 0 ? "is-up" : "is-down";
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
    state.events = Array.isArray(stateFile.data && stateFile.data.events)
      ? stateFile.data.events
      : [];
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
  }

  async function fetchKlines(symbol) {
    const key = symKey(symbol);
    const q =
      `/fapi/v1/klines?symbol=${encodeURIComponent(key)}` +
      `&interval=${KLINE_INTERVAL}&limit=${KLINE_LIMIT}`;
    const raw = await fapiGetJson(q);
    const candles = (Array.isArray(raw) ? raw : [])
      .map((row) => ({
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
    state.klineCache[key] = candles;
    return candles;
  }

  function paintMiniKline(canvas, candles) {
    if (!canvas || !candles || !candles.length) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssW =
      canvas.clientWidth ||
      Number(canvas.getAttribute("width")) ||
      120;
    const cssH =
      canvas.clientHeight ||
      Number(canvas.getAttribute("height")) ||
      40;
    if (!(cssW > 0) || !(cssH > 0)) return;
    canvas.width = Math.floor(cssW * dpr);
    canvas.height = Math.floor(cssH * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    let min = Infinity;
    let max = -Infinity;
    candles.forEach((c) => {
      if (c.low < min) min = c.low;
      if (c.high > max) max = c.high;
    });
    if (!(max > min)) {
      max = min + 1e-9;
    }
    const pad = 2;
    const n = candles.length;
    const slot = (cssW - pad * 2) / n;
    const bodyW = Math.max(1, slot * 0.55);
    candles.forEach((c, i) => {
      const x = pad + i * slot + slot / 2;
      const yHigh = pad + ((max - c.high) / (max - min)) * (cssH - pad * 2);
      const yLow = pad + ((max - c.low) / (max - min)) * (cssH - pad * 2);
      const yOpen = pad + ((max - c.open) / (max - min)) * (cssH - pad * 2);
      const yClose = pad + ((max - c.close) / (max - min)) * (cssH - pad * 2);
      const up = c.close >= c.open;
      ctx.strokeStyle = up ? "#3dcf8e" : "#f07178";
      ctx.fillStyle = up ? "#3dcf8e" : "#f07178";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, yHigh);
      ctx.lineTo(x, yLow);
      ctx.stroke();
      const top = Math.min(yOpen, yClose);
      const h = Math.max(1, Math.abs(yClose - yOpen));
      ctx.fillRect(x - bodyW / 2, top, bodyW, h);
    });
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

  async function paintVisibleKlines() {
    const nodes = [...document.querySelectorAll("canvas.fut-kline[data-kline]")];
    const symbols = nodes.map((n) => n.getAttribute("data-kline"));
    await ensureKlines(symbols);
    const draw = () => {
      nodes.forEach((canvas) => {
        if (!canvas.isConnected) return;
        const sym = canvas.getAttribute("data-kline");
        paintMiniKline(canvas, state.klineCache[sym] || []);
      });
    };
    draw();
    requestAnimationFrame(draw);
  }

  async function persistNails(mutator, message) {
    if (state.saving) {
      toast("保存中…");
      return;
    }
    state.saving = true;
    try {
      const result = await window.FutStore.patchJson(
        PATHS.nails,
        (data) => {
          const nails = normalizeNails(data.nails);
          const alwaysWatch = normalizeAlways(data.alwaysWatch);
          const ctx = {
            nails,
            alwaysWatch,
            dismissedNails: data.dismissedNails,
          };
          const next = mutator(ctx);
          return {
            data: {
              nails: normalizeNails(next.nails),
              alwaysWatch: normalizeAlways(next.alwaysWatch),
              alwaysWatchAt: Date.now(),
              dismissedNails: Array.isArray(next.dismissedNails)
                ? next.dismissedNails
                : data.dismissedNails || [],
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
    } finally {
      state.saving = false;
      syncSelectUi();
    }
  }

  async function pinToBoard(symbols, opts) {
    const keys = [...new Set((symbols || []).map(symKey).filter(Boolean))];
    if (!keys.length) return;
    await refreshTickers(keys);
    const now = Date.now();
    await persistNails((ctx) => {
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
      return { ...ctx, nails };
    }, (opts && opts.message) || `Fut pin ${keys.join(",")}`);
    toast(`已置顶 ${keys.map(labelOf).join(" · ")}`);
  }

  async function unpinFromBoard(symbols) {
    const keys = new Set((symbols || []).map(symKey).filter(Boolean));
    if (!keys.size) return;
    await persistNails((ctx) => {
      const nails = ctx.nails.map((n) =>
        keys.has(n.symbol) ? { ...n, pinned: false, pinnedAt: 0 } : n,
      );
      const alwaysWatch = ctx.alwaysWatch.filter((s) => !keys.has(s));
      return { ...ctx, nails, alwaysWatch };
    }, `Fut unpin ${[...keys].join(",")}`);
    toast(`已取消置顶 ${[...keys].map(labelOf).join(" · ")}`);
  }

  async function pinFirst(symbol) {
    const key = symKey(symbol);
    if (!key) return;
    await persistNails((ctx) => {
      const nails = ctx.nails.map((n) =>
        n.symbol === key
          ? { ...n, pinned: true, pinnedAt: n.pinnedAt || Date.now(), order: -1 }
          : n,
      );
      nails.sort((a, b) => (a.order || 0) - (b.order || 0));
      return {
        ...ctx,
        nails: nails.map((n, i) => ({ ...n, order: i })),
      };
    }, `Fut pin first ${key}`);
  }

  async function setNoteNow(symbols) {
    const keys = [...new Set((symbols || []).map(symKey).filter(Boolean))];
    if (!keys.length) return;
    await refreshTickers(keys);
    const noteAt = Date.now();
    await persistNails((ctx) => {
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
    toast(`已写现价便签 ${keys.length} 个`);
  }

  async function toggleAlways(symbol, force) {
    const key = symKey(symbol);
    if (!isUserPinned(key) && force !== true) {
      toast("仅已置顶的可加常看");
      return;
    }
    await persistNails((ctx) => {
      const set = new Set(ctx.alwaysWatch);
      if (force === true) set.add(key);
      else if (force === false) set.delete(key);
      else if (set.has(key)) set.delete(key);
      else set.add(key);
      return { ...ctx, alwaysWatch: [...set] };
    }, `Fut always ${key}`);
  }

  function setTab(tab) {
    state.tab = tab;
    if (tab !== "pin" && state.selectMode) setSelectMode(false);
    document.querySelectorAll("[data-fut-tab]").forEach((btn) => {
      const on = btn.getAttribute("data-fut-tab") === tab;
      btn.classList.toggle("is-active", on);
      btn.setAttribute("aria-selected", on ? "true" : "false");
    });
    document.querySelectorAll("[data-fut-pane]").forEach((pane) => {
      pane.hidden = pane.getAttribute("data-fut-pane") !== tab;
    });
    const selectBtn = $("futSelectBtn");
    if (selectBtn) selectBtn.hidden = tab !== "pin";
    void refreshView();
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
    return rows.sort((a, b) => {
      const ga = noteGain(a);
      const gb = noteGain(b);
      const va = Number.isFinite(ga) ? ga : -Infinity;
      const vb = Number.isFinite(gb) ? gb : -Infinity;
      if (vb !== va) return vb - va;
      return (a.order || 0) - (b.order || 0);
    });
  }

  function splitPinSections() {
    const alwaysSet = new Set(state.alwaysWatch);
    const always = [];
    const pinned = [];
    const rest = [];
    state.nails.forEach((n) => {
      if (alwaysSet.has(n.symbol) && n.pinned) {
        always.push(n);
        return;
      }
      if (n.pinned) pinned.push(n);
      else rest.push(n);
    });
    return {
      always: sortNailRows(always),
      pinned: sortNailRows(pinned),
      rest: sortNailRows(rest),
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
    } else {
      bits.push(
        `<button type="button" role="menuitem" data-fut-pin-on="${escapeHtml(key)}">置顶</button>`,
      );
      if (alwaysOn) {
        bits.push(
          `<button type="button" role="menuitem" class="is-danger" data-fut-always-off="${escapeHtml(key)}">取消常看</button>`,
        );
      }
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
      alwaysBtn.hidden = !pinned;
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
    ["futBatchPinBtn", "futBatchUnpinBtn", "futBatchNoteBtn"].forEach((id) => {
      const el = $(id);
      if (el) el.disabled = n === 0 || state.saving;
    });
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

  function pinRowHtml(n, opts) {
    const showK = !!(opts && opts.kline);
    const live = liveOf(n.symbol);
    const ch = Number(live.change24h);
    const gain = noteGain(n);
    const key = n.symbol;
    const alwaysOn = isAlways(key);
    const selected = state.selectMode && state.selected.has(key);
    const check = state.selectMode
      ? `<input type="checkbox" class="fut-check" data-fut-select="${escapeHtml(key)}" ${selected ? "checked" : ""} aria-label="选择" />`
      : "";
    const pinBtn = state.selectMode
      ? ""
      : `<span class="fut-pin-wrap"><button type="button" class="fut-pin${n.pinned ? " is-on" : ""}" data-fut-pin="${escapeHtml(key)}" aria-haspopup="menu" aria-expanded="false" title="${n.pinned ? "置顶选项" : "置顶"}">${n.pinned ? "顶" : "↑"}</button></span>`;
    const tag = alwaysOn ? '<span class="fut-tag">常看</span>' : "";
    const kHtml = showK
      ? `<canvas class="fut-kline" data-kline="${escapeHtml(key)}" width="120" height="40"></canvas>`
      : '<span class="fut-status">—</span>';
    const info = [];
    if (Number.isFinite(gain)) {
      info.push(
        `<span class="${pctClass(gain)}">便签 ${escapeHtml(n.note || "--")} · ${escapeHtml(fmtPct(gain))}</span>`,
      );
    } else if (n.note) {
      info.push(`<span>便签 ${escapeHtml(n.note)}</span>`);
    }
    info.push(`<span>现价 ${escapeHtml(fmtPrice(live.price))}</span>`);
    return `
      <tr class="fut-prow-row${selected ? " is-selected" : ""}" data-symbol="${escapeHtml(key)}" data-fut-row="1">
        <td class="fut-name-cell">${check}${pinBtn}<button type="button" class="fut-name" data-fut-copy="${escapeHtml(labelOf(key))}">${escapeHtml(n.label || labelOf(key))}${tag}</button></td>
        <td>${kHtml}</td>
        <td class="fut-chg ${pctClass(ch)}">${escapeHtml(fmtPct(ch))}</td>
      </tr>
      <tr class="fut-sub" data-symbol="${escapeHtml(key)}"><td colspan="3"><div class="fut-info">${info.join("")}</div></td></tr>`;
  }

  function sectionHtml(title, rows, opts) {
    if (!rows.length) {
      return `<tbody><tr class="fut-section-row"><td colspan="3"><div class="fut-section-label">${escapeHtml(title)} <span>0</span></div></td></tr></tbody>`;
    }
    const body = rows.map((n) => pinRowHtml(n, opts)).join("");
    return `<tbody>
      <tr class="fut-section-row"><td colspan="3"><div class="fut-section-label">${escapeHtml(title)} <span>${rows.length}</span></div></td></tr>
      ${body}
    </tbody>`;
  }

  function renderPinPane() {
    const root = $("pinList");
    if (!root) return;
    const { always, pinned, rest } = splitPinSections();
    let html = `<table class="fut-prow-table">
      <thead><tr><th>币</th><th>K线</th><th>24h</th></tr></thead>
      ${sectionHtml("常看", always, { kline: true })}
      ${sectionHtml("置顶", pinned, { kline: true })}`;
    if (!state.pinnedOnly) {
      html += sectionHtml("其余", rest, { kline: false });
    }
    html += "</table>";
    if (!always.length && !pinned.length && (state.pinnedOnly || !rest.length)) {
      html = '<div class="fut-empty">暂无置顶。从自动盯 / 雷达点置顶，或等云函数写入。</div>';
    }
    root.innerHTML = html;
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
    const rows = list
      .map((p) => {
        const sym = symKey(p.symbol);
        const live = liveOf(sym);
        const ch = Number.isFinite(live.change24h)
          ? live.change24h
          : Number(p.change24h);
        const already = isUserPinned(sym);
        const kHtml = `<canvas class="fut-kline" data-kline="${escapeHtml(sym)}" width="120" height="40"></canvas>`;
        return `<tr class="fut-prow-row" data-symbol="${escapeHtml(sym)}" data-fut-row="1">
          <td class="fut-name-cell"><button type="button" class="fut-name" data-fut-copy="${escapeHtml(labelOf(sym))}">${escapeHtml(labelOf(sym))}</button></td>
          <td>${kHtml}</td>
          <td class="fut-chg ${pctClass(ch)}">${escapeHtml(fmtPct(ch))}</td>
        </tr>
        <tr class="fut-sub"><td colspan="3"><div class="fut-info">
          <span>钉入 ${escapeHtml(fmtTime(p.pinnedAt))}</span>
          <span>现价 ${escapeHtml(fmtPrice(live.price || p.pinPrice))}</span>
          <span class="fut-ops">${
            already
              ? '<span class="fut-tag">已置顶</span>'
              : `<button type="button" data-fut-act="pin" data-symbol="${escapeHtml(sym)}">置顶</button>`
          }</span>
        </div></td></tr>`;
      })
      .join("");
    const ev = state.events
      .slice(0, 8)
      .map((e) => {
        const syms = (e.symbols || []).map(labelOf).join(", ");
        return `<li><time>${escapeHtml(fmtTime(e.at))}</time> ${escapeHtml(e.kind || "")} · ${escapeHtml(syms)}</li>`;
      })
      .join("");
    root.innerHTML = `<table class="fut-prow-table">
      <thead><tr><th>币</th><th>K线</th><th>24h</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="fut-section-label" style="margin-top:12px">最近事件</div>
    ${ev ? `<ul style="margin:8px 0 0;padding-left:18px;color:var(--secondary);font-size:12px;line-height:1.55">${ev}</ul>` : '<div class="fut-empty">无</div>'}`;
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

  function renderRadarPane() {
    buildRadarRows();
    const root = $("radarList");
    if (!root) return;
    const toggle = state.showAllKlines ? "全部K线 · 开" : "全部K线 · 关";
    if (!state.radarRows.length) {
      root.innerHTML = `<div class="fut-toolbar-inline">
        <button type="button" class="fut-tool-btn" id="radarShowAllBtn">${toggle}</button>
      </div><div class="fut-empty">雷达暂无数据</div>`;
      bindRadarChrome();
      return;
    }
    const rows = state.radarRows
      .map((r) => {
        const needK = state.showAllKlines || r.pinned;
        const kHtml = needK
          ? `<canvas class="fut-kline" data-kline="${escapeHtml(r.symbol)}" width="120" height="40"></canvas>`
          : '<span class="fut-status">—</span>';
        return `<tr class="fut-prow-row${r.inPool ? " is-pool" : ""}" data-symbol="${escapeHtml(r.symbol)}" data-fut-row="1">
          <td class="fut-name-cell">
            <span class="fut-status">#${r.rank}</span>
            <button type="button" class="fut-name" data-fut-copy="${escapeHtml(labelOf(r.symbol))}">${escapeHtml(labelOf(r.symbol))}${r.inPool ? '<span class="fut-tag">池</span>' : ""}</button>
          </td>
          <td>${kHtml}</td>
          <td class="fut-chg ${pctClass(r.change24h)}">${escapeHtml(fmtPct(r.change24h))}</td>
        </tr>
        <tr class="fut-sub"><td colspan="3"><div class="fut-info">
          <span>现价 ${escapeHtml(fmtPrice(r.price))}</span>
          <span class="fut-ops">${
            r.pinned
              ? `<button type="button" data-fut-act="unpin" data-symbol="${escapeHtml(r.symbol)}">取消置顶</button>`
              : `<button type="button" data-fut-act="pin" data-symbol="${escapeHtml(r.symbol)}">置顶</button>`
          }</span>
        </div></td></tr>`;
      })
      .join("");
    root.innerHTML = `<div class="fut-toolbar-inline">
      <button type="button" class="fut-tool-btn" id="radarShowAllBtn">${toggle}</button>
      <span class="fut-status">前 ${RADAR_TOP} · 池 ${state.pool.length}/${state.poolRank} · 置顶行默认画 K</span>
    </div>
    <table class="fut-prow-table">
      <thead><tr><th>币</th><th>K线</th><th>24h</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
    bindRadarChrome();
  }

  function bindRadarChrome() {
    const btn = $("radarShowAllBtn");
    if (!btn) return;
    btn.onclick = () => {
      state.showAllKlines = !state.showAllKlines;
      writeLocal(SHOW_ALL_KEY, state.showAllKlines ? "1" : "0");
      renderRadarPane();
      void paintVisibleKlines();
    };
  }

  function render() {
    if (state.tab === "pin") renderPinPane();
    else if (state.tab === "auto") renderAutoPane();
    else renderRadarPane();
    syncSelectUi();
    void paintVisibleKlines();
  }

  async function refreshView() {
    const status = $("statusMeta");
    const errBox = $("errBox");
    const btn = $("refreshBtn");
    if (btn) btn.disabled = true;
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
      if (status) {
        status.textContent = updated
          ? "数据 " + fmtTime(updated)
          : "已刷新 · 等云函数写入池/自动盯";
      }
    } catch (error) {
      console.warn(error);
      if (errBox) {
        errBox.hidden = false;
        errBox.textContent = (error && error.message) || "刷新失败";
      }
      if (status) status.textContent = "刷新失败";
    } finally {
      if (btn) btn.disabled = false;
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
      if (document.hidden) return;
      void refreshView();
    }, AUTO_REFRESH_MS);
  }

  async function saveWatchPoolRank() {
    const input = $("futWatchPoolRankInput");
    const rank = clampPoolRank(input && input.value);
    if (input) input.value = String(rank);
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
  }

  function bindLongPress(root) {
    if (!root || root.dataset.longBound === "1") return;
    root.dataset.longBound = "1";
    let timer = 0;
    let startX = 0;
    let startY = 0;
    let symbol = "";
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
      const point = ev.touches ? ev.touches[0] : ev;
      startX = point.clientX;
      startY = point.clientY;
      symbol = symKey(row.getAttribute("data-symbol"));
      timer = window.setTimeout(() => {
        timer = 0;
        if (!symbol) return;
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
    root.addEventListener("touchstart", onStart, { passive: true });
    root.addEventListener("mousedown", onStart);
    root.addEventListener("touchmove", onMove, { passive: true });
    root.addEventListener("mousemove", onMove);
    root.addEventListener("touchend", clear);
    root.addEventListener("mouseup", clear);
    root.addEventListener("mouseleave", clear);
  }

  function bind() {
    document.querySelectorAll("[data-fut-tab]").forEach((btn) => {
      btn.addEventListener("click", () =>
        setTab(btn.getAttribute("data-fut-tab")),
      );
    });

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
    const batchPin = $("futBatchPinBtn");
    if (batchPin) {
      batchPin.addEventListener("click", () => {
        void pinToBoard([...state.selected])
          .then(() => setSelectMode(false))
          .catch((e) => toast(e.message || "失败"));
      });
    }
    const batchUnpin = $("futBatchUnpinBtn");
    if (batchUnpin) {
      batchUnpin.addEventListener("click", () => {
        void unpinFromBoard([...state.selected])
          .then(() => setSelectMode(false))
          .catch((e) => toast(e.message || "失败"));
      });
    }
    const batchNote = $("futBatchNoteBtn");
    if (batchNote) {
      batchNote.addEventListener("click", () => {
        void setNoteNow([...state.selected])
          .then(() => setSelectMode(false))
          .catch((e) => toast(e.message || "失败"));
      });
    }

    document.body.addEventListener("click", (ev) => {
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
            if (act === "note") await setNoteNow([symbol]);
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
      });
    });

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
        void setNoteNow(keys)
          .then(() => setSettingsOpen(false))
          .catch((error) => toast(error.message || "平简失败"));
      });
    }

    syncSettingsChrome();
    applyAutoRefresh();
  }

  bind();
  void (async () => {
    if (window.FutStore && typeof window.FutStore.tryWarmUnlock === "function") {
      try {
        await window.FutStore.tryWarmUnlock();
      } catch (_) {
        /* ignore */
      }
    }
    setTab("pin");
  })();
})();
