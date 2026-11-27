/* 合约三栏：置顶 / 自动盯 / 雷达 — 只读发现 + 置顶/便签，无买卖账本 */
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
  const FAPI = {
    ticker: "https://fapi.binance.com/fapi/v1/ticker/24hr",
    klines: "https://fapi.binance.com/fapi/v1/klines",
  };
  const RADAR_TOP = 80;
  const KLINE_INTERVAL = "4h";
  const KLINE_LIMIT = 42;
  const SHOW_ALL_KEY = "fut_radar_show_all_klines";
  const SORT_KEY = "fut_pin_sort";
  const PINNED_ONLY_KEY = "fut_pinned_only";
  const AUTO_REFRESH_KEY = "fut_auto_refresh";
  const AUTO_REFRESH_MS = 15 * 1000;

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
    if (!t) return "--";
    try {
      return new Date(t).toLocaleString("zh-CN", { hour12: false });
    } catch (_) {
      return String(t);
    }
  }

  function pctClass(n) {
    if (!Number.isFinite(n)) return "";
    if (n > 0) return "up";
    if (n < 0) return "down";
    return "";
  }

  function escapeHtml(s) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function normalizeNails(raw) {
    const list = Array.isArray(raw) ? raw : [];
    const map = new Map();
    list.forEach((item, index) => {
      if (!item) return;
      const symbol = symKey(item.symbol);
      if (!symbol.endsWith("USDT")) return;
      const pinnedAt = Number(item.pinnedAt) || 0;
      const order = Number.isFinite(Number(item.order))
        ? Number(item.order)
        : index;
      map.set(symbol, {
        id: item.id || `${symbol}:${pinnedAt || Date.now()}`,
        symbol,
        label: item.label || labelOf(symbol),
        note: String(item.note || "").trim().slice(0, 40),
        noteAt: Number(item.noteAt) || 0,
        pinned: !!item.pinned,
        pinnedAt,
        order,
        at: Number(item.at) || pinnedAt || Date.now(),
      });
    });
    return [...map.values()].sort((a, b) => {
      const ap = a.pinned ? 0 : 1;
      const bp = b.pinned ? 0 : 1;
      if (ap !== bp) return ap - bp;
      if (a.pinned && b.pinned) {
        if ((b.pinnedAt || 0) !== (a.pinnedAt || 0)) {
          return (b.pinnedAt || 0) - (a.pinnedAt || 0);
        }
      }
      return (a.order || 0) - (b.order || 0);
    });
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

  function liveOf(symbol) {
    return state.marketMap[symKey(symbol)] || {};
  }

  function noteGain(nail) {
    const notePrice = Number(String(nail.note || "").replace(/,/g, ""));
    const price = Number(liveOf(nail.symbol).price);
    if (!(notePrice > 0) || !(price > 0)) return NaN;
    return ((price - notePrice) / notePrice) * 100;
  }

  function clampPoolRank(raw) {
    const n = Math.floor(Number(raw));
    if (!Number.isFinite(n)) return 35;
    return Math.min(100, Math.max(10, n));
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
    state.poolRank =
      Number(poolFile.data && poolFile.data.rank) || prefRank || 35;
    const rankInput = $("futWatchPoolRankInput");
    if (rankInput) rankInput.value = String(prefRank);
    state.events = Array.isArray(stateFile.data && stateFile.data.autoPinEvents)
      ? stateFile.data.autoPinEvents
      : [];
    const updated = Math.max(
      Number(nailsFile.data && nailsFile.data.updatedAt) || 0,
      Number(pinsFile.data && pinsFile.data.updatedAt) || 0,
      Number(poolFile.data && poolFile.data.updatedAt) || 0,
      Number(stateFile.data && stateFile.data.updatedAt) || 0,
      Number(prefsFile.data && prefsFile.data.updatedAt) || 0,
    );
    return updated;
  }

  async function refreshTickers(symbols) {
    const want = new Set((symbols || []).map(symKey).filter(Boolean));
    const full = !want.size || state.tab === "radar";
    const response = await fetch(FAPI.ticker, { cache: "no-store" });
    if (!response.ok) throw new Error("fapi ticker " + response.status);
    const list = await response.json();
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
    const url =
      `${FAPI.klines}?symbol=${encodeURIComponent(key)}` +
      `&interval=${KLINE_INTERVAL}&limit=${KLINE_LIMIT}`;
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) throw new Error("klines " + key);
    const raw = await response.json();
    const candles = (Array.isArray(raw) ? raw : []).map((row) => ({
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
    }));
    state.klineCache[key] = candles;
    return candles;
  }

  function paintMiniKline(canvas, candles) {
    if (!canvas || !candles || !candles.length) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssW = canvas.clientWidth || 120;
    const cssH = canvas.clientHeight || 36;
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
    if (!(max > min)) return;
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
          console.warn(error);
        }
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(concurrency, missing.length || 1) }, () =>
        worker(),
      ),
    );
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
          const ctx = { nails, alwaysWatch, dismissedNails: data.dismissedNails };
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
    }
  }

  async function pinToBoard(symbols, opts) {
    const keys = [...new Set((symbols || []).map(symKey).filter(Boolean))];
    if (!keys.length) return;
    await refreshTickers(keys);
    const now = Date.now();
    const noteAt = now;
    await persistNails((ctx) => {
      let nails = ctx.nails.slice();
      const by = new Map(nails.map((n) => [n.symbol, n]));
      keys.forEach((key) => {
        const price = Number(liveOf(key).price);
        const note =
          Number.isFinite(price) && price > 0 ? fmtPrice(price) : "";
        const prev = by.get(key);
        const row = {
          id: (prev && prev.id) || `${key}:${now}`,
          symbol: key,
          label: labelOf(key),
          note: note || (prev && prev.note) || "",
          noteAt: note ? noteAt : (prev && prev.noteAt) || 0,
          pinned: true,
          pinnedAt: now,
          order: prev ? prev.order : nails.length,
          at: (prev && prev.at) || now,
        };
        by.set(key, row);
      });
      nails = [...by.values()];
      return { ...ctx, nails };
    }, opts && opts.message ? opts.message : `Fut pin ${keys.join(",")}`);
    toast(`已置顶 ${keys.map(labelOf).join(" · ")}`);
  }

  async function unpinFromBoard(symbol) {
    const key = symKey(symbol);
    await persistNails((ctx) => {
      const nails = ctx.nails.map((n) =>
        n.symbol === key ? { ...n, pinned: false, pinnedAt: 0 } : n,
      );
      const alwaysWatch = ctx.alwaysWatch.filter((s) => s !== key);
      return { ...ctx, nails, alwaysWatch };
    }, `Fut unpin ${key}`);
    toast(`${labelOf(key)} 已取消置顶`);
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

  async function toggleAlways(symbol) {
    const key = symKey(symbol);
    if (!isUserPinned(key)) {
      toast("仅已置顶的可加常看");
      return;
    }
    await persistNails((ctx) => {
      const set = new Set(ctx.alwaysWatch);
      if (set.has(key)) set.delete(key);
      else set.add(key);
      return { ...ctx, alwaysWatch: [...set] };
    }, `Fut always ${key}`);
  }

  function setTab(tab) {
    state.tab = tab;
    document.querySelectorAll("[data-fut-tab]").forEach((btn) => {
      btn.classList.toggle("is-active", btn.getAttribute("data-fut-tab") === tab);
    });
    document.querySelectorAll("[data-fut-pane]").forEach((pane) => {
      pane.hidden = pane.getAttribute("data-fut-pane") !== tab;
    });
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
    // noteGain
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

  function rowHtmlNail(n, opts) {
    const live = liveOf(n.symbol);
    const ch = Number(live.change24h);
    const gain = noteGain(n);
    const showK = opts && opts.kline;
    const kHtml = showK
      ? `<canvas class="mini-k" data-kline="${escapeHtml(n.symbol)}" width="120" height="36"></canvas>`
      : "";
    const alwaysOn = state.alwaysWatch.includes(n.symbol);
    return `<tr data-symbol="${escapeHtml(n.symbol)}">
      <td class="sym">${escapeHtml(n.label || labelOf(n.symbol))}</td>
      <td>${kHtml}</td>
      <td>${escapeHtml(fmtPrice(live.price))}</td>
      <td class="${pctClass(ch)}">${escapeHtml(fmtPct(ch))}</td>
      <td class="${pctClass(gain)}" title="相对便签">${escapeHtml(n.note || "--")} · ${escapeHtml(fmtPct(gain))}</td>
      <td class="ops">
        <button type="button" data-act="note" data-symbol="${escapeHtml(n.symbol)}">便签</button>
        ${
          n.pinned
            ? `<button type="button" data-act="always" data-symbol="${escapeHtml(n.symbol)}">${alwaysOn ? "取消常看" : "常看"}</button>
               <button type="button" data-act="unpin" data-symbol="${escapeHtml(n.symbol)}">取消置顶</button>`
            : `<button type="button" data-act="pin" data-symbol="${escapeHtml(n.symbol)}">置顶</button>`
        }
      </td>
    </tr>`;
  }

  function sectionTable(title, rows, opts) {
    if (!rows.length) {
      return `<div class="sec"><h3>${escapeHtml(title)} <span>0</span></h3><div class="empty">空</div></div>`;
    }
    const body = rows.map((n) => rowHtmlNail(n, opts)).join("");
    return `<div class="sec"><h3>${escapeHtml(title)} <span>${rows.length}</span></h3>
      <div class="table-wrap"><table>
        <thead><tr><th>币</th><th>K</th><th>现价</th><th>24h</th><th>便签</th><th>操作</th></tr></thead>
        <tbody>${body}</tbody>
      </table></div></div>`;
  }

  function renderPinPane() {
    const { always, pinned, rest } = splitPinSections();
    const root = $("panePin");
    let html =
      sectionTable("常看", always, { kline: true }) +
      sectionTable("置顶", pinned, { kline: true });
    if (!state.pinnedOnly) {
      html += sectionTable("其余", rest, { kline: false });
    }
    root.innerHTML = html;
  }

  function renderAutoPane() {
    const root = $("paneAuto");
    const nails = nailMap();
    const list = state.autoPins.slice().sort((a, b) => {
      return (Number(b.pinnedAt) || 0) - (Number(a.pinnedAt) || 0);
    });
    if (!list.length) {
      root.innerHTML =
        '<div class="empty">暂无云端自动盯。部署 futures/cloud-function-fut 后约 5 分钟写入。</div>';
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
        return `<tr data-symbol="${escapeHtml(sym)}">
          <td class="sym">${escapeHtml(labelOf(sym))}</td>
          <td>${escapeHtml(fmtPrice(live.price || p.pinPrice))}</td>
          <td class="${pctClass(ch)}">${escapeHtml(fmtPct(ch))}</td>
          <td>${escapeHtml(fmtTime(p.pinnedAt))}</td>
          <td class="ops">
            ${
              already
                ? '<span class="tag">已置顶</span>'
                : `<button type="button" data-act="pin" data-symbol="${escapeHtml(sym)}">置顶</button>`
            }
          </td>
        </tr>`;
      })
      .join("");
    const ev = state.events
      .slice(0, 8)
      .map((e) => {
        const syms = (e.symbols || []).map(labelOf).join(", ");
        return `<li><time>${escapeHtml(fmtTime(e.at))}</time> ${escapeHtml(e.kind || "")} · ${escapeHtml(syms)}</li>`;
      })
      .join("");
    root.innerHTML = `
      <div class="sec"><h3>自动盯 <span>${list.length}</span></h3>
        <div class="table-wrap"><table>
          <thead><tr><th>币</th><th>现价</th><th>24h</th><th>钉入</th><th>操作</th></tr></thead>
          <tbody>${rows}</tbody>
        </table></div>
      </div>
      <div class="sec"><h3>最近事件</h3>
        ${ev ? `<ul class="events">${ev}</ul>` : '<div class="empty">无</div>'}
      </div>`;
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
    const pinnedSet = new Set(state.nails.filter((n) => n.pinned).map((n) => n.symbol));
    state.radarRows = entries.slice(0, RADAR_TOP).map((row, index) => ({
      ...row,
      rank: index + 1,
      inPool: poolSet.has(row.symbol),
      pinned: pinnedSet.has(row.symbol),
    }));
  }

  function renderRadarPane() {
    buildRadarRows();
    const root = $("paneRadar");
    const toggle = state.showAllKlines ? "全部K线 · 开" : "全部K线 · 关";
    if (!state.radarRows.length) {
      root.innerHTML = `<div class="toolbar-inline">
        <button type="button" id="radarShowAllBtn">${toggle}</button>
      </div><div class="empty">雷达暂无数据</div>`;
      bindRadarChrome();
      return;
    }
    const rows = state.radarRows
      .map((r) => {
        const needK = state.showAllKlines || r.pinned;
        const kHtml = needK
          ? `<canvas class="mini-k" data-kline="${escapeHtml(r.symbol)}" width="140" height="40"></canvas>`
          : '<span class="muted">—</span>';
        const trClass = [
          r.inPool ? "is-pool" : "",
          r.pinned ? "is-pinned" : "",
        ]
          .filter(Boolean)
          .join(" ");
        return `<tr class="${trClass}" data-symbol="${escapeHtml(r.symbol)}">
          <td>#${r.rank}${r.inPool ? ' <span class="tag">池</span>' : ""}</td>
          <td class="sym">${escapeHtml(labelOf(r.symbol))}</td>
          <td>${kHtml}</td>
          <td class="${pctClass(r.change24h)}">${escapeHtml(fmtPct(r.change24h))}</td>
          <td class="ops">
            ${
              r.pinned
                ? `<button type="button" data-act="unpin" data-symbol="${escapeHtml(r.symbol)}">取消置顶</button>`
                : `<button type="button" data-act="pin" data-symbol="${escapeHtml(r.symbol)}">置顶</button>`
            }
          </td>
        </tr>`;
      })
      .join("");
    root.innerHTML = `
      <div class="toolbar-inline">
        <button type="button" id="radarShowAllBtn">${toggle}</button>
        <span class="meta">前 ${RADAR_TOP} · 池 ${state.pool.length}/${state.poolRank} · 置顶行默认画 K</span>
      </div>
      <div class="table-wrap"><table>
        <thead><tr><th>#</th><th>币</th><th>K线</th><th>24h</th><th>操作</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>`;
    bindRadarChrome();
  }

  function bindRadarChrome() {
    const btn = $("radarShowAllBtn");
    if (!btn) return;
    btn.onclick = () => {
      state.showAllKlines = !state.showAllKlines;
      try {
        localStorage.setItem(SHOW_ALL_KEY, state.showAllKlines ? "1" : "0");
      } catch (_) {
        /* ignore */
      }
      renderRadarPane();
      void paintVisibleKlines();
    };
  }

  function render() {
    if (state.tab === "pin") renderPinPane();
    else if (state.tab === "auto") renderAutoPane();
    else renderRadarPane();
    void paintVisibleKlines();
  }

  async function paintVisibleKlines() {
    const nodes = [...document.querySelectorAll("canvas[data-kline]")];
    const symbols = nodes.map((n) => n.getAttribute("data-kline"));
    await ensureKlines(symbols);
    nodes.forEach((canvas) => {
      const sym = canvas.getAttribute("data-kline");
      paintMiniKline(canvas, state.klineCache[sym] || []);
    });
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

  function onClick(ev) {
    const btn = ev.target.closest("button[data-act]");
    if (!btn) return;
    const act = btn.getAttribute("data-act");
    const symbol = btn.getAttribute("data-symbol");
    void (async () => {
      try {
        if (act === "pin") await pinToBoard([symbol]);
        else if (act === "unpin") await unpinFromBoard(symbol);
        else if (act === "note") await setNoteNow([symbol]);
        else if (act === "always") await toggleAlways(symbol);
      } catch (error) {
        console.warn(error);
        toast((error && error.message) || "操作失败");
      }
    })();
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

  function bind() {
    document.querySelectorAll("[data-fut-tab]").forEach((btn) => {
      btn.addEventListener("click", () =>
        setTab(btn.getAttribute("data-fut-tab")),
      );
    });
    $("refreshBtn").addEventListener("click", () => void refreshView());
    $("pinNoteAllBtn").addEventListener("click", () => {
      const { always, pinned } = splitPinSections();
      const keys = [...always, ...pinned].map((n) => n.symbol);
      void setNoteNow(keys).catch((error) => toast(error.message || "失败"));
    });
    document.body.addEventListener("click", onClick);

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
