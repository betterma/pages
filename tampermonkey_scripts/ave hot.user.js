// ==UserScript==
// @name         ave hot
// @namespace    http://tampermonkey.net/
// @version      1.1
// @description  从 Ave.ai 热搜页提取合约地址（Solana / Robinhood），复制到剪贴板
// @author       pages
// @match        https://ave.ai/*
// @match        https://www.ave.ai/*
// @match        https://pro.ave.ai/*
// @match        https://pc.ave.ai/*
// @match        https://*.ave.ai/*
// @grant        GM_setClipboard
// @grant        GM_addStyle
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==

(function () {
  "use strict";

  const page = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;

  function detectChain() {
    try {
      const q = new URLSearchParams(location.search).get("chain");
      if (q) return String(q).toLowerCase();
      const m = location.pathname.match(
        /\/(solana|robinhood|bsc|ethereum|base|arbitrum)\b/i,
      );
      if (m) return m[1].toLowerCase();
    } catch (_) {
      /* ignore */
    }
    return "solana";
  }

  function isSolanaLike(addr) {
    return /^[1-9A-HJ-NP-Za-km-z]{32,48}$/.test(addr);
  }

  function isEvmLike(addr) {
    return /^0x[a-fA-F0-9]{40}$/.test(addr);
  }

  function looksLikeContract(addr, chain) {
    if (!addr || typeof addr !== "string") return false;
    const a = addr.trim();
    if (chain === "solana") return isSolanaLike(a);
    return isEvmLike(a) || isSolanaLike(a);
  }

  /** 注入到页面主世界，才能截到 Ave 自己的 fetch/XHR */
  function injectPageHook() {
    const source = `(() => {
      if (window.__aveHotHooked) return;
      window.__aveHotHooked = true;
      window.__aveHotBag = window.__aveHotBag || [];
      const bag = window.__aveHotBag;
      const push = (addr) => {
        const a = String(addr || "").trim();
        if (!a) return;
        if (!/^(0x[a-fA-F0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,48})$/.test(a)) return;
        if (!bag.includes(a)) bag.push(a);
      };
      const walk = (node, depth) => {
        if (node == null || depth > 14) return;
        if (typeof node === "string") {
          const id = node.match(/^([1-9A-HJ-NP-Za-km-z0x]{32,66})-([a-z0-9_]+)$/i);
          if (id) push(id[1]);
          else push(node);
          return;
        }
        if (Array.isArray(node)) {
          node.forEach((x) => walk(x, depth + 1));
          return;
        }
        if (typeof node !== "object") return;
        for (const [key, value] of Object.entries(node)) {
          const k = String(key).toLowerCase();
          if (typeof value === "string") {
            if (k === "token_id" || k === "tokenid" || k.endsWith("_token_id")) {
              const parts = value.split("-");
              if (parts.length >= 2) push(parts.slice(0, -1).join("-"));
            }
            if (
              k === "token" ||
              k === "address" ||
              k === "contract" ||
              k === "token_address" ||
              k === "contract_address" ||
              k === "base_address" ||
              k === "ca"
            ) {
              push(value);
            }
          }
          walk(value, depth + 1);
        }
      };
      const ingest = (url, text) => {
        try {
          if (!text || text.length < 2) return;
          if (text[0] !== "{" && text[0] !== "[") return;
          walk(JSON.parse(text), 0);
        } catch (e) {}
      };

      const rawFetch = window.fetch;
      if (typeof rawFetch === "function") {
        window.fetch = function () {
          const args = arguments;
          const input = args[0];
          const url = typeof input === "string" ? input : (input && input.url) || "";
          return rawFetch.apply(this, args).then((res) => {
            try {
              res.clone().text().then((t) => ingest(url, t)).catch(() => {});
            } catch (e) {}
            return res;
          });
        };
      }

      const rawOpen = XMLHttpRequest.prototype.open;
      const rawSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function (method, url) {
        this.__aveHotUrl = url;
        return rawOpen.apply(this, arguments);
      };
      XMLHttpRequest.prototype.send = function () {
        this.addEventListener("load", function () {
          try {
            ingest(this.__aveHotUrl || "", this.responseText || "");
          } catch (e) {}
        });
        return rawSend.apply(this, arguments);
      };
    })();`;

    const el = document.createElement("script");
    el.textContent = source;
    const root = document.documentElement || document.head || document.body;
    if (root) {
      root.appendChild(el);
      el.remove();
    }
  }

  function drainPageBag() {
    const bag = page.__aveHotBag;
    if (!Array.isArray(bag)) return [];
    return bag.slice();
  }

  function scrapeDom(chain) {
    const found = new Set();
    const add = (addr) => {
      const a = String(addr || "").trim();
      if (!looksLikeContract(a, chain)) return;
      found.add(a);
    };

    const html = document.documentElement
      ? document.documentElement.outerHTML
      : "";
    const htmlPatterns = [
      /([1-9A-HJ-NP-Za-km-z]{32,48}|0x[a-fA-F0-9]{40})-(solana|robinhood|bsc|ethereum|base|arbitrum)/gi,
      new RegExp(
        `/${chain}/([1-9A-HJ-NP-Za-km-z]{32,48}|0x[a-fA-F0-9]{40})`,
        "gi",
      ),
      /token[_/=-]([1-9A-HJ-NP-Za-km-z]{32,48}|0x[a-fA-F0-9]{40})/gi,
      /"token"\s*:\s*"([1-9A-HJ-NP-Za-km-z]{32,48}|0x[a-fA-F0-9]{40})"/gi,
      /"address"\s*:\s*"([1-9A-HJ-NP-Za-km-z]{32,48}|0x[a-fA-F0-9]{40})"/gi,
      /"contract"\s*:\s*"([1-9A-HJ-NP-Za-km-z]{32,48}|0x[a-fA-F0-9]{40})"/gi,
    ];
    for (const re of htmlPatterns) {
      let m;
      const r = new RegExp(re.source, re.flags);
      while ((m = r.exec(html))) {
        add(m[1]);
        if (found.size > 300) break;
      }
    }

    document.querySelectorAll("a[href], [href]").forEach((el) => {
      const href = el.getAttribute("href") || "";
      const m =
        href.match(
          new RegExp(
            `/${chain}/([1-9A-HJ-NP-Za-km-z]{32,48}|0x[a-fA-F0-9]{40})`,
            "i",
          ),
        ) ||
        href.match(
          /([1-9A-HJ-NP-Za-km-z]{32,48}|0x[a-fA-F0-9]{40})-(solana|robinhood)/i,
        );
      if (m) add(m[1]);
    });

    document
      .querySelectorAll(
        "[data-address],[data-token],[data-contract],[data-ca],[title],[aria-label]",
      )
      .forEach((el) => {
        for (const attr of [
          "data-address",
          "data-token",
          "data-contract",
          "data-ca",
          "title",
          "aria-label",
        ]) {
          const v = el.getAttribute(attr);
          if (!v) continue;
          const m = v.match(/(0x[a-fA-F0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,48})/);
          if (m) add(m[1]);
        }
      });

    return [...found];
  }

  async function clickCopyButtons(chain) {
    const found = new Set();
    const buttons = [
      ...document.querySelectorAll(
        'button, [role="button"], svg, i, span, div',
      ),
    ].filter((el) => {
      const t = `${el.getAttribute("aria-label") || ""} ${el.getAttribute("title") || ""} ${el.className || ""}`.toLowerCase();
      return /copy|复制|clipboard/.test(t);
    }).slice(0, 80);

    for (const btn of buttons) {
      try {
        const target =
          btn.closest("button, [role='button'], a") || btn;
        target.dispatchEvent(
          new MouseEvent("click", { bubbles: true, cancelable: true, view: page }),
        );
        await new Promise((r) => setTimeout(r, 40));
        const text = await navigator.clipboard.readText();
        const line = String(text || "").trim().split(/\s+/)[0];
        if (looksLikeContract(line, chain)) found.add(line);
      } catch (_) {
        /* ignore */
      }
    }
    return [...found];
  }

  function copyList(list) {
    const text = list.join("\n");
    try {
      if (typeof GM_setClipboard === "function") {
        GM_setClipboard(text, "text");
        return true;
      }
    } catch (_) {
      /* fall through */
    }
    try {
      page.navigator?.clipboard?.writeText(text);
      return true;
    } catch (_) {
      return false;
    }
  }

  function showToast(msg, isError) {
    let el = document.getElementById("aveHotToast");
    if (!el) {
      el = document.createElement("div");
      el.id = "aveHotToast";
      Object.assign(el.style, {
        position: "fixed",
        top: "72px",
        right: "20px",
        zIndex: "100000",
        padding: "10px 16px",
        borderRadius: "8px",
        color: "#fff",
        fontSize: "13px",
        boxShadow: "0 4px 14px rgba(0,0,0,0.35)",
        opacity: "0",
        transition: "opacity 0.2s",
        pointerEvents: "none",
        maxWidth: "320px",
      });
      (document.body || document.documentElement).appendChild(el);
    }
    el.textContent = msg;
    el.style.background = isError
      ? "rgba(180,40,40,0.92)"
      : "rgba(20,24,36,0.92)";
    el.style.opacity = "1";
    clearTimeout(el.__t);
    el.__t = setTimeout(() => {
      el.style.opacity = "0";
    }, 2800);
  }

  async function extractNow() {
    const chain = detectChain();
    injectPageHook();

    const fromNet = drainPageBag().filter((a) => looksLikeContract(a, chain));
    const fromDom = scrapeDom(chain);
    let list = [...new Set([...fromNet, ...fromDom])];

    if (!list.length) {
      showToast("网络缓存为空，尝试点击页内复制按钮…");
      const fromClick = await clickCopyButtons(chain);
      list = [...new Set(fromClick)];
    }

    if (!list.length) {
      showToast(
        `仍未取到合约（链=${chain}）。请硬刷新后再打开热搜，等列表出来再点一次`,
        true,
      );
      console.info("[ave hot] bag", page.__aveHotBag);
      return;
    }

    const ok = copyList(list);
    showToast(
      ok
        ? `已复制 ${list.length} 个合约（${chain}；网络${fromNet.length}/DOM${fromDom.length}）`
        : `已收集 ${list.length} 个，复制失败`,
      !ok,
    );
  }

  function mountUi() {
    if (document.getElementById("aveHotExtractBtn")) return;

    GM_addStyle(`
      #aveHotExtractBtn {
        position: fixed;
        top: 20px;
        right: 20px;
        z-index: 99999;
        padding: 10px 16px;
        border: none;
        border-radius: 8px;
        background: linear-gradient(135deg, #5b8cff, #7a5cff);
        color: #fff;
        font-weight: 700;
        font-size: 13px;
        cursor: pointer;
        box-shadow: 0 4px 14px rgba(91,140,255,0.35);
      }
      #aveHotExtractBtn:hover { filter: brightness(1.08); }
    `);

    const btn = document.createElement("button");
    btn.id = "aveHotExtractBtn";
    btn.type = "button";
    btn.textContent = "提取热搜合约";
    btn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      extractNow().catch((error) => {
        console.error(error);
        showToast(error.message || "提取失败", true);
      });
    });
    (document.body || document.documentElement).appendChild(btn);
  }

  injectPageHook();
  // 文档很早时再补一次注入
  document.addEventListener("DOMContentLoaded", () => {
    injectPageHook();
    mountUi();
  });
  if (document.readyState !== "loading") mountUi();
  setInterval(() => {
    injectPageHook();
    mountUi();
  }, 2500);
})();
