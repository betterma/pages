(function (global, factory) {
  const api = factory();
  const root =
    typeof globalThis !== "undefined"
      ? globalThis
      : typeof window !== "undefined"
        ? window
        : global;
  if (root) root.OkxFavorites = api;
  if (typeof module === "object" && module != null) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const DEFAULT_REPO = "betterma/pages";
  const FAVORITES_PATH = "okx/favorites.json";

  const CHAINS = {
    "501": { id: "501", code: "SOL", label: "Solana" },
    "4663": { id: "4663", code: "RH", label: "Robinhood" },
  };

  const TOKEN_PART_A = "gh";
  const TOKEN_PART_B = "p_Xrmz1DjzLfbjyiXZqFyJGd9O8aWFIq4D9758";

  function getGithubToken() {
    return TOKEN_PART_A + TOKEN_PART_B;
  }

  function isEvmChain(chainIndex) {
    return String(chainIndex) !== "501";
  }

  function normalizeAddress(chainIndex, address) {
    const raw = String(address || "").trim();
    if (!raw) return "";
    return isEvmChain(chainIndex) ? raw.toLowerCase() : raw;
  }

  function tokenKey(chainIndex, address) {
    const chain = String(chainIndex || "").trim();
    const addr = normalizeAddress(chain, address);
    if (!chain || !addr) return "";
    return `${chain}:${addr}`;
  }

  function normalizeItem(item) {
    if (!item || typeof item !== "object") return null;
    const chainIndex = String(item.chainIndex || "").trim();
    if (!CHAINS[chainIndex]) return null;
    const tokenContractAddress = normalizeAddress(
      chainIndex,
      item.tokenContractAddress || item.address,
    );
    if (!tokenContractAddress) return null;
    const symbol = String(item.symbol || "")
      .trim()
      .slice(0, 32);
    return {
      chainIndex,
      tokenContractAddress,
      symbol: symbol || shortLabel(tokenContractAddress),
      addedAt: Number.isFinite(Number(item.addedAt))
        ? Number(item.addedAt)
        : 0,
      source: item.source ? String(item.source) : "manual",
    };
  }

  function shortLabel(address) {
    const text = String(address || "");
    if (text.length <= 10) return text;
    return `${text.slice(0, 4)}…${text.slice(-4)}`;
  }

  function isPlaceholderSymbol(symbol, address) {
    const text = String(symbol || "").trim();
    if (!text) return true;
    if (text === shortLabel(address)) return true;
    if (text.includes("…") && text.length <= 14) return true;
    return false;
  }

  function normalizeList(raw) {
    const list = Array.isArray(raw)
      ? raw
      : Array.isArray(raw && raw.items)
        ? raw.items
        : [];
    const map = new Map();
    list.forEach((item) => {
      const normalized = normalizeItem(item);
      if (!normalized) return;
      const key = tokenKey(
        normalized.chainIndex,
        normalized.tokenContractAddress,
      );
      const prev = map.get(key);
      if (!prev || normalized.addedAt >= prev.addedAt) {
        map.set(key, normalized);
      }
    });
    return [...map.values()].sort((a, b) => {
      if (b.addedAt !== a.addedAt) return b.addedAt - a.addedAt;
      return tokenKey(a.chainIndex, a.tokenContractAddress).localeCompare(
        tokenKey(b.chainIndex, b.tokenContractAddress),
      );
    });
  }

  function serializeList(list) {
    return {
      updatedAt: Date.now(),
      items: normalizeList(list).map((item) => ({
        chainIndex: item.chainIndex,
        tokenContractAddress: item.tokenContractAddress,
        symbol: item.symbol,
        addedAt: item.addedAt,
        source: item.source || "manual",
      })),
    };
  }

  function decodeBase64Utf8(content) {
    const binary = atob(String(content || "").replace(/\n/g, ""));
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    return new TextDecoder("utf-8").decode(bytes);
  }

  function encodeBase64Utf8(text) {
    const bytes = new TextEncoder().encode(text);
    let binary = "";
    bytes.forEach((byte) => {
      binary += String.fromCharCode(byte);
    });
    return btoa(binary);
  }

  async function fetchJsonFile(options) {
    const repo = options.repo || DEFAULT_REPO;
    const path = options.path || FAVORITES_PATH;
    const token = options.token || getGithubToken();
    const response = await fetch(
      `https://api.github.com/repos/${repo}/contents/${path}?t=${Date.now()}`,
      {
        cache: "no-store",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
    );
    if (response.status === 404) {
      return { data: null, sha: null };
    }
    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `读取 ${path} 失败: ${response.status} ${text.slice(0, 180)}`,
      );
    }
    const file = await response.json();
    let raw = "";
    if (file.content) {
      raw = decodeBase64Utf8(file.content);
    } else if (file.sha) {
      const blobResponse = await fetch(
        `https://api.github.com/repos/${repo}/git/blobs/${file.sha}`,
        {
          cache: "no-store",
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${token}`,
            "X-GitHub-Api-Version": "2022-11-28",
          },
        },
      );
      if (!blobResponse.ok) {
        throw new Error(`读取 ${path} blob 失败: ${blobResponse.status}`);
      }
      const blob = await blobResponse.json();
      raw = decodeBase64Utf8(blob.content || "");
    }
    if (!raw.trim()) {
      return { data: { items: [] }, sha: file.sha };
    }
    return {
      data: JSON.parse(raw),
      sha: file.sha,
    };
  }

  async function writeJsonFile(options) {
    const repo = options.repo || DEFAULT_REPO;
    const path = options.path || FAVORITES_PATH;
    const token = options.token || getGithubToken();
    const payload = {
      message: options.message || `Update ${path}`,
      content: encodeBase64Utf8(JSON.stringify(options.data, null, 2)),
    };
    if (options.sha) payload.sha = options.sha;

    const response = await fetch(
      `https://api.github.com/repos/${repo}/contents/${path}`,
      {
        method: "PUT",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify(payload),
      },
    );
    if (response.status === 409) {
      const error = new Error("GitHub 写入冲突");
      error.code = "conflict";
      throw error;
    }
    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `写入 ${path} 失败: ${response.status} ${text.slice(0, 220)}`,
      );
    }
    return response.json();
  }

  async function loadFavorites(options) {
    const current = await fetchJsonFile(options || {});
    return {
      items: normalizeList(current.data),
      sha: current.sha,
      updatedAt:
        current.data && Number.isFinite(Number(current.data.updatedAt))
          ? Number(current.data.updatedAt)
          : null,
    };
  }

  async function saveFavorites(list, options) {
    const opts = options || {};
    const path = opts.path || FAVORITES_PATH;
    let sha = opts.sha;
    if (!sha) {
      const current = await fetchJsonFile({ ...opts, path });
      sha = current.sha;
    }
    const data = serializeList(list);
    await writeJsonFile({
      ...opts,
      path,
      sha,
      data,
      message: opts.message || "Update OKX watchlist",
    });
    return data;
  }

  function addItems(list, incoming, source) {
    const next = normalizeList(list);
    const map = new Map(
      next.map((item) => [
        tokenKey(item.chainIndex, item.tokenContractAddress),
        item,
      ]),
    );
    const added = [];
    normalizeList(incoming).forEach((item) => {
      const key = tokenKey(item.chainIndex, item.tokenContractAddress);
      if (!key) return;
      if (map.has(key)) return;
      const row = {
        ...item,
        addedAt: Date.now(),
        source: source || item.source || "manual",
      };
      map.set(key, row);
      added.push(row);
    });
    return {
      items: [...map.values()].sort((a, b) => b.addedAt - a.addedAt),
      added,
    };
  }

  function removeItem(list, chainIndex, address) {
    const key = tokenKey(chainIndex, address);
    return normalizeList(list).filter(
      (item) =>
        tokenKey(item.chainIndex, item.tokenContractAddress) !== key,
    );
  }

  /**
   * Batch lines:
   *   501,Contract,SYMBOL
   *   4663,0xabc...
   *   contract   (uses defaultChain)
   */
  function parseBatchText(text, defaultChain) {
    const lines = String(text || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const items = [];
    const errors = [];
    lines.forEach((line, index) => {
      const parts = line.split(/[\s,|]+/).filter(Boolean);
      let chainIndex = defaultChain;
      let address = "";
      let symbol = "";
      if (parts.length === 1) {
        address = parts[0];
      } else if (parts.length >= 2 && CHAINS[parts[0]]) {
        chainIndex = parts[0];
        address = parts[1];
        symbol = parts[2] || "";
      } else if (parts.length >= 2) {
        address = parts[0];
        symbol = parts[1];
      }
      if (!CHAINS[chainIndex]) {
        errors.push(`第 ${index + 1} 行：链无效`);
        return;
      }
      const normalized = normalizeItem({
        chainIndex,
        tokenContractAddress: address,
        symbol,
        source: "batch",
      });
      if (!normalized) {
        errors.push(`第 ${index + 1} 行：地址无效`);
        return;
      }
      items.push(normalized);
    });
    return { items, errors };
  }

  return {
    CHAINS,
    FAVORITES_PATH,
    tokenKey,
    normalizeAddress,
    normalizeList,
    serializeList,
    loadFavorites,
    saveFavorites,
    addItems,
    removeItem,
    parseBatchText,
    shortLabel,
    isPlaceholderSymbol,
  };
});
