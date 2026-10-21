// ==UserScript==
// @name         DexScreener API 合约提取器
// @namespace    http://tampermonkey.net/
// @version      1.3
// @description  从当前榜单页链接提取 pair，再经 DexScreener API 解析 baseToken 合约（RH 支持 0x/v4）
// @author       YourName
// @match        https://dexscreener.com/*
// @match        https://app.dexscreener.com/*
// @match        https://*.dexscreener.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setClipboard
// @grant        GM_addStyle
// @connect      api.dexscreener.com
// @run-at       document-end
// ==/UserScript==

(function () {
  "use strict";

  GM_addStyle(`
        #dexApiExtractor {
            position: fixed;
            top: 50%;
            right: 20px;
            transform: translateY(-50%);
            z-index: 9999;
            background: linear-gradient(135deg, #1a1f2e, #0f1420);
            color: #fff;
            padding: 20px;
            border-radius: 16px;
            box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
            width: 340px;
            font-family: 'Segoe UI', system-ui, sans-serif;
            border: 1px solid #2a3045;
            display: none;
        }

        #dexApiExtractor.active {
            display: block;
        }

        .api-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 15px;
            padding-bottom: 15px;
            border-bottom: 1px solid #2a3045;
        }

        .api-title {
            font-size: 18px;
            font-weight: 600;
            color: #6b8cff;
        }

        .api-close {
            background: transparent;
            border: none;
            color: #8f9bb5;
            font-size: 20px;
            cursor: pointer;
            padding: 0 8px;
            border-radius: 4px;
        }

        .api-close:hover {
            background: #2a3045;
            color: #fff;
        }

        .chain-selector {
            display: flex;
            gap: 8px;
            margin-bottom: 15px;
            flex-wrap: wrap;
        }

        .chain-btn {
            padding: 6px 12px;
            border-radius: 20px;
            background: #262b3c;
            border: 1px solid #363d54;
            color: #b4bcd0;
            cursor: pointer;
            font-size: 13px;
            transition: 0.2s;
        }

        .chain-btn.active {
            background: #6b8cff;
            border-color: #6b8cff;
            color: white;
        }

        .stats-bar {
            display: flex;
            justify-content: space-between;
            background: #262b3c;
            padding: 10px;
            border-radius: 8px;
            margin-bottom: 15px;
            font-size: 13px;
        }

        .stat-total { color: #6b8cff; }
        .stat-success { color: #4caf50; }
        .stat-failed { color: #ff6b6b; }

        .tabs {
            display: flex;
            gap: 10px;
            margin-bottom: 10px;
            border-bottom: 1px solid #2a3045;
        }

        .tab {
            padding: 8px 0;
            cursor: pointer;
            color: #8f9bb5;
            border-bottom: 2px solid transparent;
            margin-right: 20px;
        }

        .tab.active {
            color: #6b8cff;
            border-bottom-color: #6b8cff;
        }

        .results-panel {
            max-height: 300px;
            overflow-y: auto;
            background: #262b3c;
            border-radius: 8px;
            padding: 10px;
            margin-bottom: 15px;
            font-family: 'Monaco', monospace;
            font-size: 12px;
        }

        .result-item {
            padding: 8px;
            border-radius: 4px;
            margin-bottom: 4px;
            word-break: break-all;
        }

        .result-item.success {
            background: rgba(76, 175, 80, 0.1);
            border-left: 3px solid #4caf50;
            color: #a5d6a7;
        }

        .result-item.failed {
            background: rgba(255, 107, 107, 0.1);
            border-left: 3px solid #ff6b6b;
            color: #ffb3b3;
        }

        .token-name {
            color: #b4bcd0;
            font-size: 11px;
            margin-top: 2px;
        }

        .action-buttons {
            display: flex;
            gap: 10px;
        }

        .api-btn {
            flex: 1;
            padding: 10px;
            border: none;
            border-radius: 8px;
            font-weight: 600;
            cursor: pointer;
            transition: 0.2s;
        }

        .api-btn.primary {
            background: linear-gradient(135deg, #6b8cff, #8b6bff);
            color: white;
        }

        .api-btn.secondary {
            background: #2a3045;
            color: #b4bcd0;
            border: 1px solid #363d54;
        }

        .api-btn:hover {
            transform: translateY(-2px);
            filter: brightness(1.1);
        }

        .api-btn:active {
            transform: translateY(0);
        }

        .notification {
            position: fixed;
            top: 70px;
            right: 20px;
            padding: 12px 24px;
            background: #1a1f2e;
            border-left: 4px solid #4caf50;
            color: white;
            border-radius: 8px;
            font-size: 14px;
            box-shadow: 0 5px 15px rgba(0,0,0,0.3);
            transform: translateX(120%);
            transition: transform 0.3s;
            z-index: 10000;
        }

        .notification.show {
            transform: translateX(0);
        }

        .notification.error {
            border-left-color: #ff6b6b;
        }

        .loader {
            text-align: center;
            padding: 20px;
        }

        .loader-spinner {
            width: 30px;
            height: 30px;
            border: 3px solid #2a3045;
            border-top-color: #6b8cff;
            border-radius: 50%;
            margin: 0 auto 10px;
            animation: spin 1s linear infinite;
        }

        @keyframes spin {
            to { transform: rotate(360deg); }
        }
    `);

  const triggerBtn = document.createElement("button");
  triggerBtn.id = "apiExtractorTrigger";
  triggerBtn.textContent = "🔍 API合约提取";
  Object.assign(triggerBtn.style, {
    position: "fixed",
    top: "70px",
    right: "20px",
    zIndex: "9999",
    background: "linear-gradient(135deg, #6b8cff, #8b6bff)",
    color: "white",
    border: "none",
    padding: "10px 20px",
    borderRadius: "8px",
    fontWeight: "600",
    cursor: "pointer",
    boxShadow: "0 4px 15px rgba(107, 140, 255, 0.3)",
    transition: "0.3s",
  });
  document.body.appendChild(triggerBtn);

  const panel = document.createElement("div");
  panel.id = "dexApiExtractor";
  panel.innerHTML = `
        <div class="api-header">
            <span class="api-title">📊 API合约提取</span>
            <button class="api-close">✕</button>
        </div>
        <div class="chain-selector">
            <button class="chain-btn active" data-chain="solana">Solana</button>
            <button class="chain-btn" data-chain="ethereum">Ethereum</button>
            <button class="chain-btn" data-chain="bsc">BSC</button>
            <button class="chain-btn" data-chain="base">Base</button>
            <button class="chain-btn" data-chain="arbitrum">Arbitrum</button>
            <button class="chain-btn" data-chain="robinhood">Robinhood</button>
        </div>
        <div class="stats-bar">
            <span>总计: <span class="stat-total" id="statTotal">0</span></span>
            <span>成功: <span class="stat-success" id="statSuccess">0</span></span>
            <span>失败: <span class="stat-failed" id="statFailed">0</span></span>
        </div>
        <div class="tabs">
            <div class="tab active" data-tab="success">✅ 成功</div>
            <div class="tab" data-tab="failed">❌ 失败</div>
        </div>
        <div id="successPanel" class="results-panel"></div>
        <div id="failedPanel" class="results-panel" style="display: none;"></div>
        <div class="action-buttons">
            <button class="api-btn primary" id="extractBtn">🔍 提取合约</button>
            <button class="api-btn secondary" id="copyBtn">📋 复制成功项</button>
        </div>
    `;
  document.body.appendChild(panel);

  const notification = document.createElement("div");
  notification.className = "notification";
  document.body.appendChild(notification);

  let currentChain = "solana";

  function detectChainFromUrl() {
    const m = window.location.pathname.match(
      /^\/(solana|ethereum|bsc|base|arbitrum|robinhood)(?:\/|$)/i,
    );
    return m ? m[1].toLowerCase() : null;
  }

  function setActiveChain(chain) {
    if (!chain) return;
    currentChain = chain;
    panel.querySelectorAll(".chain-btn").forEach((b) => {
      b.classList.toggle("active", b.dataset.chain === chain);
    });
  }

  function showNotif(msg, isError = false) {
    notification.textContent = msg;
    notification.classList.add("show");
    if (isError) notification.classList.add("error");
    else notification.classList.remove("error");
    setTimeout(() => notification.classList.remove("show"), 2200);
  }

  triggerBtn.addEventListener("click", () => {
    const fromUrl = detectChainFromUrl();
    if (fromUrl) setActiveChain(fromUrl);
    panel.classList.toggle("active");
    triggerBtn.textContent = panel.classList.contains("active")
      ? "📋 收起面板"
      : "🔍 API合约提取";
  });

  panel.querySelector(".api-close").addEventListener("click", () => {
    panel.classList.remove("active");
    triggerBtn.textContent = "🔍 API合约提取";
  });

  panel.querySelectorAll(".chain-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      panel.querySelectorAll(".chain-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      currentChain = btn.dataset.chain;
    });
  });

  panel.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      panel.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      const showSuccess = tab.dataset.tab === "success";
      document.getElementById("successPanel").style.display = showSuccess
        ? "block"
        : "none";
      document.getElementById("failedPanel").style.display = showSuccess
        ? "none"
        : "block";
    });
  });

  function gmGetJson(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "GET",
        url,
        headers: { Accept: "application/json" },
        onload: (resp) => {
          if (resp.status < 200 || resp.status >= 300) {
            reject(new Error(`HTTP ${resp.status}`));
            return;
          }
          try {
            resolve(JSON.parse(resp.responseText));
          } catch (error) {
            reject(error);
          }
        },
        onerror: () => reject(new Error("网络错误")),
      });
    });
  }

  function normalizeHref(raw) {
    if (!raw) return "";
    try {
      if (raw.startsWith("http")) {
        return new URL(raw).pathname;
      }
    } catch (_) {
      /* ignore */
    }
    return String(raw).split("?")[0].split("#")[0];
  }

  function isLikelyPairId(id, chain) {
    if (!id) return false;
    const s = String(id);
    if (chain === "solana") {
      return /^[1-9A-HJ-NP-Za-km-z]{32,48}$/.test(s);
    }
    // Robinhood / EVM：标准 0x+40，以及 Uniswap v4 poolId（0x+64）
    if (chain === "robinhood") {
      return /^0x[a-fA-F0-9]{40}$/.test(s) || /^0x[a-fA-F0-9]{64}$/.test(s);
    }
    return /^0x[a-fA-F0-9]{40}$/.test(s);
  }

  function isEvmTokenAddress(id) {
    return /^0x[a-fA-F0-9]{40}$/.test(String(id || ""));
  }

  function pickBestPair(pairs) {
    const list = Array.isArray(pairs) ? pairs.filter(Boolean) : [];
    if (!list.length) return null;
    return list.slice().sort((a, b) => {
      const la = Number(a?.liquidity?.usd) || 0;
      const lb = Number(b?.liquidity?.usd) || 0;
      if (lb !== la) return lb - la;
      const va = Number(a?.volume?.h24) || 0;
      const vb = Number(b?.volume?.h24) || 0;
      return vb - va;
    })[0];
  }

  function fromPair(pair, fallbackRouteId) {
    if (!pair?.baseToken?.address) return null;
    return {
      contract: pair.baseToken.address,
      name: pair.baseToken.symbol || pair.baseToken.name || "",
      pairAddress: pair.pairAddress || fallbackRouteId || "",
    };
  }

  function readTokenName(el) {
    if (!el) return "";
    const selectors = [
      ".ds-dex-table-row-base-token-symbol",
      ".ds-dex-table-row-base-token-name-text",
      "[class*='base-token-symbol']",
      "[class*='token-symbol']",
      "[class*='Symbol']",
    ];
    for (const sel of selectors) {
      const node = el.querySelector?.(sel) || (el.matches?.(sel) ? el : null);
      const text = node?.textContent?.trim();
      if (text) return text;
    }
    return "";
  }

  /** 兼容旧 .ds-dex-table-row 与新版任意 /{chain}/{pair} 链接 */
  function collectTokenPairs(chain) {
    const seen = new Set();
    const pairs = [];
    const re = new RegExp(`/${chain}/([^/?#]+)`, "i");

    function pushFrom(el, hrefRaw) {
      const path = normalizeHref(hrefRaw);
      const match = path.match(re);
      if (!match) return;
      const routeId = decodeURIComponent(match[1]);
      if (!isLikelyPairId(routeId, chain)) return;
      const key = routeId.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      pairs.push({
        routeId,
        tokenName: readTokenName(el) || "未知代币",
        fullLink: path,
      });
    }

    const rowSelectors = [
      `.ds-dex-table-row[href*="/${chain}/"]`,
      `a.ds-dex-table-row[href*="/${chain}/"]`,
      `[data-group="token-row"] a[href*="/${chain}/"]`,
      `.ds-table-row a[href*="/${chain}/"]`,
      `a[href*="/${chain}/"]`,
      `[href*="/${chain}/"]`,
    ];

    for (const sel of rowSelectors) {
      document.querySelectorAll(sel).forEach((el) => {
        const href =
          el.getAttribute("href") ||
          el.closest?.("a")?.getAttribute("href") ||
          "";
        pushFrom(el, href);
      });
    }

    // 榜单页 URL 本身没有 pair；仅在代币详情页时作为兜底
    if (!pairs.length) {
      const pathMatch = window.location.pathname.match(re);
      if (pathMatch && isLikelyPairId(pathMatch[1], chain)) {
        pairs.push({
          routeId: decodeURIComponent(pathMatch[1]),
          tokenName: document.title.split("|")[0].trim() || "当前代币",
          fullLink: window.location.pathname,
        });
      }
    }

    return pairs;
  }

  async function resolveContract(chain, routeId) {
    // 1) pair 直查（榜单 href 通常是 pair / v4 poolId）
    try {
      const pairData = await gmGetJson(
        `https://api.dexscreener.com/latest/dex/pairs/${encodeURIComponent(chain)}/${encodeURIComponent(routeId)}`,
      );
      const pair = Array.isArray(pairData?.pairs)
        ? pickBestPair(pairData.pairs)
        : pairData?.pair;
      const hit = fromPair(pair, routeId);
      if (hit) return hit;
    } catch (_) {
      /* fall through */
    }

    // 2) 若路由是代币地址（RH 推广/画像页常见），走 tokens / token-pairs
    if (isEvmTokenAddress(routeId)) {
      try {
        const tokenPairs = await gmGetJson(
          `https://api.dexscreener.com/token-pairs/v1/${encodeURIComponent(chain)}/${encodeURIComponent(routeId)}`,
        );
        const hit = fromPair(pickBestPair(tokenPairs), routeId);
        if (hit) return hit;
      } catch (_) {
        /* fall through */
      }
      try {
        const tokensData = await gmGetJson(
          `https://api.dexscreener.com/tokens/v1/${encodeURIComponent(chain)}/${encodeURIComponent(routeId)}`,
        );
        const hit = fromPair(pickBestPair(tokensData), routeId);
        if (hit) {
          // tokens 接口已确认是该链上的代币，合约即 routeId
          return {
            contract: routeId,
            name: hit.name,
            pairAddress: hit.pairAddress,
          };
        }
        // 无池子时仍可返回代币地址本身（RH 榜单偶发只挂 token 链接）
        return {
          contract: routeId,
          name: "",
          pairAddress: "",
        };
      } catch (_) {
        /* fall through */
      }
    }

    // 3) 搜索兜底
    const searchData = await gmGetJson(
      `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(routeId)}`,
    );
    const chainPairs = (searchData?.pairs || []).filter(
      (p) => String(p.chainId || "").toLowerCase() === chain.toLowerCase(),
    );
    const byPair = chainPairs.find(
      (p) =>
        String(p.pairAddress || "").toLowerCase() === routeId.toLowerCase(),
    );
    const byToken = chainPairs.find(
      (p) =>
        String(p.baseToken?.address || "").toLowerCase() ===
        routeId.toLowerCase(),
    );
    const hit = fromPair(byPair || byToken || pickBestPair(chainPairs), routeId);
    if (hit) return hit;
    throw new Error("API 未返回 baseToken");
  }

  async function extractContracts() {
    const successPanel = document.getElementById("successPanel");
    const failedPanel = document.getElementById("failedPanel");

    successPanel.innerHTML = `
            <div class="loader">
                <div class="loader-spinner"></div>
                <div>正在读取页面链接并查询 API…</div>
            </div>
        `;
    failedPanel.innerHTML = "";
    document.getElementById("statTotal").textContent = "0";
    document.getElementById("statSuccess").textContent = "0";
    document.getElementById("statFailed").textContent = "0";

    const tokenPairs = collectTokenPairs(currentChain);
    document.getElementById("statTotal").textContent = String(tokenPairs.length);

    if (!tokenPairs.length) {
      successPanel.innerHTML =
        '<div class="result-item" style="text-align:center;color:#8f9bb5;">页面上没找到交易对链接。请等表格加载完再试；若仍失败，多半是 DOM 又改了。</div>';
      failedPanel.innerHTML =
        '<div class="result-item failed"><div>未找到行</div><div class="token-name">❌ 未匹配 /' +
        currentChain +
        "/… 链接</div></div>";
      showNotif("❌ 未提取到合约地址（页面无链接）", true);
      return;
    }

    const successItems = [];
    const failedItems = [];
    const contractSeen = new Set();

    for (const pair of tokenPairs) {
      try {
        const resolved = await resolveContract(currentChain, pair.routeId);
        const contract = String(resolved.contract || "").trim();
        if (!contract) throw new Error("空合约");
        const key = contract.toLowerCase();
        if (contractSeen.has(key)) continue;
        contractSeen.add(key);
        successItems.push({
          contract,
          name: resolved.name || pair.tokenName,
          pairAddress: resolved.pairAddress || pair.routeId,
        });
      } catch (error) {
        failedItems.push({
          name: pair.tokenName,
          reason: error.message || "查询失败",
        });
      }
      await new Promise((r) => setTimeout(r, 220));
    }

    document.getElementById("statSuccess").textContent = String(
      successItems.length,
    );
    document.getElementById("statFailed").textContent = String(
      failedItems.length,
    );

    successPanel.innerHTML = successItems.length
      ? successItems
          .map(
            (item) => `
                <div class="result-item success">
                    <div>${item.contract}</div>
                    <div class="token-name">${item.name}${
                      item.pairAddress
                        ? " | Pair: " + item.pairAddress.substring(0, 8) + "…"
                        : ""
                    }</div>
                </div>`,
          )
          .join("")
      : '<div class="result-item" style="text-align:center;color:#8f9bb5;">暂无成功项</div>';

    failedPanel.innerHTML = failedItems.length
      ? failedItems
          .map(
            (item) => `
                <div class="result-item failed">
                    <div>${item.name}</div>
                    <div class="token-name">❌ ${item.reason}</div>
                </div>`,
          )
          .join("")
      : '<div class="result-item" style="text-align:center;color:#8f9bb5;">暂无失败项</div>';

    if (successItems.length > 0) {
      showNotif(`✅ 成功提取 ${successItems.length} 个合约地址`);
    } else {
      showNotif("❌ 未提取到合约地址", true);
    }
  }

  document.getElementById("extractBtn").addEventListener("click", () => {
    const fromUrl = detectChainFromUrl();
    if (fromUrl) setActiveChain(fromUrl);
    extractContracts().catch((error) => {
      console.error(error);
      showNotif(error.message || "提取失败", true);
    });
  });

  // 进入 /robinhood 等页面时自动对齐链按钮
  setActiveChain(detectChainFromUrl() || currentChain);

  document.getElementById("copyBtn").addEventListener("click", () => {
    const contracts = [];
    document
      .querySelectorAll("#successPanel .result-item.success")
      .forEach((el) => {
        const contractLine = el.querySelector("div:first-child")?.textContent?.trim();
        if (contractLine) contracts.push(contractLine);
      });

    if (!contracts.length) {
      showNotif("没有可复制的合约地址", true);
      return;
    }

    GM_setClipboard(contracts.join("\n"), "text");
    showNotif(`📋 已复制 ${contracts.length} 个合约地址`);
  });
})();
