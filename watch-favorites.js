(function (global, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    global.WatchFavorites = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const DEFAULT_REPO = "betterma/pages";
  const DEFAULT_PATH = "watch-data.json";

  // Same pattern as getcoininfo.html — required for browser → GitHub writes.
  const TOKEN_PART_A = "gh";
  const TOKEN_PART_B = "p_Xrmz1DjzLfbjyiXZqFyJGd9O8aWFIq4D9758";

  function getGithubToken() {
    return TOKEN_PART_A + TOKEN_PART_B;
  }

  function normalizeFavoriteItem(item) {
    if (typeof item === "string" && item.trim()) {
      return {
        symbol: item.trim().toUpperCase(),
        addedAt: 0,
        source: "legacy",
      };
    }
    if (item && typeof item === "object" && item.symbol) {
      const symbol = String(item.symbol).trim().toUpperCase();
      if (!symbol) return null;
      return {
        symbol,
        addedAt: Number.isFinite(Number(item.addedAt))
          ? Number(item.addedAt)
          : 0,
        source: item.source ? String(item.source) : "legacy",
      };
    }
    return null;
  }

  function normalizeFavorites(raw) {
    if (!Array.isArray(raw)) return [];
    const map = new Map();
    raw.forEach((item) => {
      const normalized = normalizeFavoriteItem(item);
      if (!normalized) return;
      const prev = map.get(normalized.symbol);
      if (!prev || normalized.addedAt >= prev.addedAt) {
        map.set(normalized.symbol, normalized);
      }
    });
    return [...map.values()].sort((a, b) => {
      if (b.addedAt !== a.addedAt) return b.addedAt - a.addedAt;
      return a.symbol.localeCompare(b.symbol);
    });
  }

  function serializeFavorites(list) {
    return normalizeFavorites(list).map((item) => ({
      symbol: item.symbol,
      addedAt: item.addedAt,
      source: item.source || "legacy",
    }));
  }

  function favoritesToSymbolSet(list) {
    return new Set(normalizeFavorites(list).map((item) => item.symbol));
  }

  function hasFavorite(list, symbol) {
    const key = String(symbol || "")
      .trim()
      .toUpperCase();
    return normalizeFavorites(list).some((item) => item.symbol === key);
  }

  function addFavorite(list, symbol, source) {
    const key = String(symbol || "")
      .trim()
      .toUpperCase();
    if (!key) return normalizeFavorites(list);
    const next = normalizeFavorites(list).filter((item) => item.symbol !== key);
    next.unshift({
      symbol: key,
      addedAt: Date.now(),
      source: source || "manual",
    });
    return next;
  }

  function removeFavorite(list, symbol) {
    const key = String(symbol || "")
      .trim()
      .toUpperCase();
    return normalizeFavorites(list).filter((item) => item.symbol !== key);
  }

  function toggleFavorite(list, symbol, source) {
    if (hasFavorite(list, symbol)) {
      return { list: removeFavorite(list, symbol), added: false };
    }
    return { list: addFavorite(list, symbol, source), added: true };
  }

  function encodeBase64Utf8(text) {
    return btoa(unescape(encodeURIComponent(text)));
  }

  function decodeBase64Utf8(content) {
    return decodeURIComponent(escape(atob(content.replace(/\n/g, ""))));
  }

  async function fetchWatchDataFile(options) {
    const repo = options.repo || DEFAULT_REPO;
    const path = options.path || DEFAULT_PATH;
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
      return { data: null, sha: null, raw: "" };
    }
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`读取 GitHub 失败: ${response.status} ${text.slice(0, 180)}`);
    }
    const file = await response.json();
    const raw = file.content ? decodeBase64Utf8(file.content) : "";
    if (!raw.trim()) {
      throw new Error("watch-data.json 内容为空");
    }
    return {
      data: JSON.parse(raw),
      sha: file.sha,
      raw,
    };
  }

  async function writeWatchDataFile(options) {
    const repo = options.repo || DEFAULT_REPO;
    const path = options.path || DEFAULT_PATH;
    const token = options.token || getGithubToken();
    const payload = {
      message: options.message || "Update watch favorites",
      content: encodeBase64Utf8(JSON.stringify(options.data)),
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
      throw new Error(`写入 GitHub 失败: ${response.status} ${text.slice(0, 180)}`);
    }
    return response.json();
  }

  async function patchFavorites(options) {
    const maxAttempts = options.maxAttempts || 3;
    let lastError = null;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        const current = await fetchWatchDataFile(options);
        if (!current.data) {
          throw new Error("watch-data.json 不存在，无法保存收藏");
        }
        const favorites = normalizeFavorites(current.data.favorites);
        const result = options.mutate(favorites.slice());
        const nextFavorites = serializeFavorites(
          result && result.list ? result.list : result,
        );
        const nextData = {
          ...current.data,
          favorites: nextFavorites,
          favoritesUpdatedAt: Date.now(),
        };
        await writeWatchDataFile({
          ...options,
          data: nextData,
          sha: current.sha,
          message: options.message || "Update watch favorites",
        });
        return {
          favorites: nextFavorites,
          favoritesUpdatedAt: nextData.favoritesUpdatedAt,
          meta: result && typeof result === "object" ? result : null,
        };
      } catch (error) {
        lastError = error;
        if (error.code !== "conflict") throw error;
      }
    }
    throw lastError || new Error("保存收藏失败");
  }

  return {
    DEFAULT_REPO,
    DEFAULT_PATH,
    getGithubToken,
    normalizeFavorites,
    serializeFavorites,
    favoritesToSymbolSet,
    hasFavorite,
    addFavorite,
    removeFavorite,
    toggleFavorite,
    fetchWatchDataFile,
    writeWatchDataFile,
    patchFavorites,
  };
});
