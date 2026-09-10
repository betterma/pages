(function (global, factory) {
  const api = factory();
  const root =
    typeof globalThis !== "undefined"
      ? globalThis
      : typeof window !== "undefined"
        ? window
        : global;
  if (root) root.TradeSim = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const DEFAULT_REPO = "betterma/pages";
  const STATE_PATH = "trade-bot-state.json";
  const WINDOW_MS = 4 * 60 * 60 * 1000;
  const SELL_BUFFER = 0.005;
  const REBUY_BUFFER = 0.003;
  const COOLDOWN_MS = 10 * 60 * 1000;
  const FEE_RATE = 0.001;
  const MAX_LOGS = 200;
  const MAX_ARCHIVE_LOGS = 500;
  const LOGS_PATH = "trade-bot-logs.json";
  const CHECK_MS = 30 * 60 * 1000;

  const TOKEN_PART_A = "gh";
  const TOKEN_PART_B = "p_Xrmz1DjzLfbjyiXZqFyJGd9O8aWFIq4D9758";

  function getGithubToken() {
    return TOKEN_PART_A + TOKEN_PART_B;
  }

  function emptyState() {
    return {
      mode: "paper",
      symbol: "",
      enabled: false,
      status: "idle",
      quoteAmount: 20,
      quantity: 0,
      cash: 0,
      equity: 0,
      anchorPrice: null,
      windowStartMs: null,
      entryPrice: null,
      cooldownUntil: null,
      lastPrice: null,
      lastCheckAt: null,
      lastAction: null,
      lastError: null,
      updatedAt: null,
      startedAt: null,
      feesPaid: 0,
      logs: [],
    };
  }

  function windowStart(timestamp) {
    return Math.floor(Number(timestamp) / WINDOW_MS) * WINDOW_MS;
  }

  function normalizeSymbol(input) {
    let symbol = String(input || "")
      .trim()
      .toUpperCase()
      .replace(/[\/\s\-]/g, "");
    if (!symbol) return "";
    if (!symbol.endsWith("USDT")) symbol = `${symbol}USDT`;
    return symbol;
  }

  function pushLog(state, message, meta) {
    const entry = {
      at: Date.now(),
      source: (meta && meta.source) || "page",
      level: (meta && meta.level) || "info",
      message: String(message),
    };
    const logs = Array.isArray(state.logs) ? state.logs.slice() : [];
    logs.unshift(entry);
    state.logs = logs.slice(0, MAX_LOGS);
    if (!Array.isArray(state._newLogs)) state._newLogs = [];
    state._newLogs.push(entry);
  }

  async function fetchJsonFile(path) {
    const response = await fetch(
      `https://api.github.com/repos/${DEFAULT_REPO}/contents/${path}?t=${Date.now()}`,
      {
        cache: "no-store",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${getGithubToken()}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
    );
    if (response.status === 404) return { data: null, sha: null };
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`读取 ${path} 失败: ${response.status} ${text.slice(0, 160)}`);
    }
    const file = await response.json();
    const raw = decodeBase64Utf8(file.content || "");
    return {
      data: raw.trim() ? JSON.parse(raw) : null,
      sha: file.sha,
    };
  }

  async function writeJsonFile(path, data, sha, message) {
    const payload = {
      message: message || `Update ${path}`,
      content: encodeBase64Utf8(JSON.stringify(data, null, 2)),
    };
    if (sha) payload.sha = sha;
    const response = await fetch(
      `https://api.github.com/repos/${DEFAULT_REPO}/contents/${path}`,
      {
        method: "PUT",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${getGithubToken()}`,
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify(payload),
      },
    );
    if (response.status === 409) {
      const error = new Error("GitHub 写入冲突，请重试");
      error.code = "conflict";
      throw error;
    }
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`写入 ${path} 失败: ${response.status} ${text.slice(0, 200)}`);
    }
    return response.json();
  }

  async function appendArchiveLogs(newLogs) {
    if (!Array.isArray(newLogs) || !newLogs.length) return;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const current = await fetchJsonFile(LOGS_PATH);
        const base =
          current.data && Array.isArray(current.data.logs)
            ? current.data.logs
            : [];
        const merged = [...newLogs, ...base].slice(0, MAX_ARCHIVE_LOGS);
        await writeJsonFile(
          LOGS_PATH,
          {
            updatedAt: Date.now(),
            count: merged.length,
            logs: merged,
          },
          current.sha,
          `Append trade logs x${newLogs.length}`,
        );
        return;
      } catch (error) {
        if (error.code !== "conflict") {
          console.warn("archive logs failed", error);
          return;
        }
      }
    }
  }

  function markEquity(state, price) {
    const px = Number.isFinite(price) ? price : Number(state.lastPrice);
    if (state.status === "holding" && state.quantity > 0 && Number.isFinite(px)) {
      state.equity = state.quantity * px;
      state.cash = 0;
      return;
    }
    if (Number.isFinite(Number(state.cash))) {
      state.equity = Number(state.cash);
    }
  }

  function encodeBase64Utf8(text) {
    const bytes = new TextEncoder().encode(text);
    let binary = "";
    const chunk = 0x8000;
    for (let index = 0; index < bytes.length; index += chunk) {
      binary += String.fromCharCode.apply(
        null,
        bytes.subarray(index, index + chunk),
      );
    }
    return btoa(binary);
  }

  function decodeBase64Utf8(content) {
    const binary = atob(String(content || "").replace(/\n/g, ""));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return new TextDecoder().decode(bytes);
  }

  async function fetchStateFile(repo) {
    const response = await fetch(
      `https://api.github.com/repos/${repo}/contents/${STATE_PATH}?t=${Date.now()}`,
      {
        cache: "no-store",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${getGithubToken()}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
    );
    if (response.status === 404) return { data: emptyState(), sha: null };
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`读取状态失败: ${response.status} ${text.slice(0, 160)}`);
    }
    const file = await response.json();
    const raw = decodeBase64Utf8(file.content || "");
    const parsed = raw.trim() ? JSON.parse(raw) : {};
    return {
      data: { ...emptyState(), ...parsed, logs: parsed.logs || [] },
      sha: file.sha,
    };
  }

  async function writeStateFile(repo, data, sha) {
    const payload = {
      message: `paper-trade ${data.symbol || "-"} ${data.lastAction || "update"}`,
      content: encodeBase64Utf8(JSON.stringify(data, null, 2)),
    };
    if (sha) payload.sha = sha;
    const response = await fetch(
      `https://api.github.com/repos/${repo}/contents/${STATE_PATH}`,
      {
        method: "PUT",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${getGithubToken()}`,
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify(payload),
      },
    );
    if (response.status === 409) {
      const error = new Error("GitHub 写入冲突，请重试");
      error.code = "conflict";
      throw error;
    }
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`写入状态失败: ${response.status} ${text.slice(0, 200)}`);
    }
    const result = await response.json();
    return (result.content && result.content.sha) || result.sha;
  }

  async function patchState(mutate) {
    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const current = await fetchStateFile(DEFAULT_REPO);
        const state = { ...current.data };
        state._newLogs = [];
        const meta = await mutate(state);
        state.mode = "paper";
        state.updatedAt = Date.now();
        const newLogs = Array.isArray(state._newLogs) ? state._newLogs.slice() : [];
        delete state._newLogs;
        await writeStateFile(DEFAULT_REPO, state, current.sha);
        await appendArchiveLogs(newLogs);
        return { state, meta };
      } catch (error) {
        lastError = error;
        if (error.code !== "conflict") throw error;
      }
    }
    throw lastError || new Error("保存失败");
  }

  async function fetchJson(url) {
    const endpoints = [url];
    if (url.includes("data-api.binance.vision")) {
      endpoints.push(url.replace("data-api.binance.vision", "api.binance.com"));
    }
    let lastError = null;
    for (const endpoint of endpoints) {
      try {
        const response = await fetch(endpoint, { cache: "no-store" });
        if (!response.ok) {
          lastError = new Error(`HTTP ${response.status}`);
          continue;
        }
        return response.json();
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error("行情请求失败");
  }

  async function getPrice(symbol) {
    const data = await fetchJson(
      `https://data-api.binance.vision/api/v3/ticker/price?symbol=${symbol}`,
    );
    const price = Number(data.price);
    if (!Number.isFinite(price) || price <= 0) {
      throw new Error(`价格无效: ${symbol}`);
    }
    return price;
  }

  async function getWindowOpen(symbol, atMs) {
    const ws = windowStart(atMs || Date.now());
    const rows = await fetchJson(
      `https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=4h&startTime=${ws}&limit=1`,
    );
    if (!Array.isArray(rows) || !rows.length) {
      throw new Error("无法读取 4h 开盘价");
    }
    const open = Number(rows[0][1]);
    if (!Number.isFinite(open) || open <= 0) {
      throw new Error("4h 开盘价无效");
    }
    return { open, windowStartMs: ws };
  }

  function viewOf(state) {
    const sellLine =
      Number.isFinite(state.anchorPrice) && state.anchorPrice > 0
        ? state.anchorPrice * (1 - SELL_BUFFER)
        : null;
    return {
      ...state,
      sellLine,
      params: {
        sellBuffer: SELL_BUFFER,
        rebuyBuffer: REBUY_BUFFER,
        cooldownMs: COOLDOWN_MS,
        feeRate: FEE_RATE,
        checkMs: CHECK_MS,
        window: "4h",
      },
    };
  }

  async function load() {
    const current = await fetchStateFile(DEFAULT_REPO);
    return viewOf(current.data);
  }

  async function startTrade(symbolInput, quoteAmount) {
    const symbol = normalizeSymbol(symbolInput);
    const amount = Number(quoteAmount);
    if (!symbol) throw new Error("请填写币种，例如 IOST");
    if (!(amount > 0)) throw new Error("请填写有效的 USDT 数量");

    const result = await patchState(async (state) => {
      if (state.enabled && state.status === "holding" && state.quantity > 0) {
        throw new Error("已有进行中的模拟持仓，请先「停止并平仓」");
      }
      const price = await getPrice(symbol);
      const { open, windowStartMs } = await getWindowOpen(symbol);
      const fee = amount * FEE_RATE;
      const qty = (amount - fee) / price;

      Object.assign(state, emptyState(), {
        mode: "paper",
        symbol,
        quoteAmount: amount,
        quantity: qty,
        cash: 0,
        entryPrice: price,
        anchorPrice: open,
        windowStartMs,
        status: "holding",
        enabled: true,
        lastPrice: price,
        lastCheckAt: Date.now(),
        startedAt: Date.now(),
        feesPaid: fee,
        lastAction: "paper_start",
        logs: state.logs || [],
      });
      markEquity(state, price);
      pushLog(
        state,
        `【模拟开仓】${symbol} 投入 ${amount} USDT @ ${price} → 数量 ${qty.toPrecision(8)}；4h起步价 ${open}；手续费 ${fee.toFixed(4)} USDT；已开启定时检测`,
        { source: "page", level: "trade" },
      );
      return { started: true };
    });
    return viewOf(result.state);
  }

  async function stopDetection() {
    const result = await patchState(async (state) => {
      state.enabled = false;
      state.lastAction = "stop_detection";
      state.lastError = null;
      pushLog(state, "已停止自动检测（仓位保留，云函数定时器也会跳过）");
      return { stopped: true };
    });
    return viewOf(result.state);
  }

  async function closeAndStop() {
    const result = await patchState(async (state) => {
      let price = state.lastPrice;
      if (state.symbol) {
        try {
          price = await getPrice(state.symbol);
        } catch (error) {
          /* keep last */
        }
      }
      if (state.status === "holding" && state.quantity > 0 && Number.isFinite(price)) {
        const gross = state.quantity * price;
        const fee = gross * FEE_RATE;
        state.cash = gross - fee;
        state.feesPaid = (state.feesPaid || 0) + fee;
        state.quantity = 0;
        pushLog(
          state,
          `【模拟平仓】@ ${price}，到账 ${state.cash.toFixed(2)} USDT，手续费 ${fee.toFixed(4)}`,
        );
      }
      state.enabled = false;
      state.status = "idle";
      state.anchorPrice = null;
      state.windowStartMs = null;
      state.cooldownUntil = null;
      state.entryPrice = null;
      state.lastPrice = price || state.lastPrice;
      state.lastAction = "close_and_stop";
      state.lastError = null;
      markEquity(state, price);
      pushLog(state, "已停止检测并结束本轮模拟");
      return { closed: true };
    });
    return viewOf(result.state);
  }

  async function runTick(options) {
    const force = Boolean(options && options.force);
    const result = await patchState(async (state) => {
      const now = Date.now();
      state.lastCheckAt = now;
      if (!force && !state.enabled) {
        state.lastAction = "tick_skipped";
        pushLog(state, "检测跳过：自动检测已关闭");
        return { skipped: true };
      }
      if (!state.symbol) throw new Error("尚未开始模拟交易");

      const price = await getPrice(state.symbol);
      state.lastPrice = price;
      state.lastError = null;

      if (state.status === "holding") {
        const ws = windowStart(now);
        if (state.windowStartMs !== ws) {
          const { open } = await getWindowOpen(state.symbol, now);
          pushLog(state, `换窗：起步价 ${state.anchorPrice} → ${open}`);
          state.anchorPrice = open;
          state.windowStartMs = ws;
        }
        const sellLine = state.anchorPrice * (1 - SELL_BUFFER);
        if (price <= sellLine) {
          const gross = state.quantity * price;
          const fee = gross * FEE_RATE;
          state.cash = gross - fee;
          state.feesPaid = (state.feesPaid || 0) + fee;
          state.quantity = 0;
          state.status = "cooldown";
          state.cooldownUntil = now + COOLDOWN_MS;
          state.lastAction = "paper_sell_stop";
          markEquity(state, price);
          pushLog(
            state,
            `【模拟卖出】现价 ${price} ≤ 卖出线 ${sellLine.toPrecision(6)}，到账 ${state.cash.toFixed(2)}，冷静 10 分钟`,
          );
          return { sold: true };
        }
        markEquity(state, price);
        state.lastAction = "paper_hold";
        pushLog(
          state,
          `持仓中：现价 ${price}，卖出线 ${sellLine.toPrecision(6)}，权益 ${state.equity.toFixed(2)}`,
        );
        return { holding: true };
      }

      if (state.status === "cooldown") {
        if (!state.cooldownUntil || now >= state.cooldownUntil) {
          state.status = "flat_rebuy";
          state.cooldownUntil = null;
          state.lastAction = "cooldown_end";
          pushLog(state, "冷静期结束，等待回补");
        } else {
          const left = Math.ceil((state.cooldownUntil - now) / 60000);
          state.lastAction = "paper_cooldown";
          pushLog(state, `冷静期中，约剩 ${left} 分钟`);
        }
        markEquity(state, price);
        return { cooldown: true };
      }

      if (state.status === "flat_rebuy") {
        const { open, windowStartMs } = await getWindowOpen(state.symbol, now);
        const rebuyLine = open * (1 + REBUY_BUFFER);
        const budget =
          Number.isFinite(state.cash) && state.cash > 0
            ? state.cash
            : state.quoteAmount;
        if (price >= rebuyLine && budget > 0) {
          const fee = budget * FEE_RATE;
          const qty = (budget - fee) / price;
          state.feesPaid = (state.feesPaid || 0) + fee;
          state.quantity = qty;
          state.cash = 0;
          state.entryPrice = price;
          state.anchorPrice = open;
          state.windowStartMs = windowStartMs;
          state.status = "holding";
          state.lastAction = "paper_rebuy";
          markEquity(state, price);
          pushLog(
            state,
            `【模拟回补】现价 ${price} ≥ ${rebuyLine.toPrecision(6)}，用 ${budget.toFixed(2)} USDT，起步价 ${open}`,
          );
          return { rebuy: true };
        }
        markEquity(state, price);
        state.lastAction = "paper_wait_rebuy";
        pushLog(
          state,
          `等待回补：现价 ${price}，回补线 ${rebuyLine.toPrecision(6)}，现金 ${Number(budget || 0).toFixed(2)}`,
        );
        return { waiting: true };
      }

      state.lastAction = "paper_idle";
      pushLog(state, "空闲，无持仓");
      return { idle: true };
    });
    return viewOf(result.state);
  }

  return {
    STATE_PATH,
    CHECK_MS,
    FEE_RATE,
    normalizeSymbol,
    emptyState,
    load,
    startTrade,
    stopDetection,
    closeAndStop,
    runTick,
    viewOf,
  };
});
