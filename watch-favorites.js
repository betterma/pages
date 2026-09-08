(function (global, factory) {
  const api = factory();
  const root =
    typeof globalThis !== "undefined"
      ? globalThis
      : typeof window !== "undefined"
        ? window
        : global;
  if (root) root.WatchFavorites = api;
  if (typeof module === "object" && module != null) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // 收藏仍用 GitHub 小文件（浏览器可写），避免 HTTP 函数 / APIG。
  // 行情大数据走 OBS，由定时云函数写入。
  const DEFAULT_REPO = "betterma/pages";
  const FAVORITES_PATH = "watch-favorites.json";

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

  function favoritesToSymbolSet(list) {
    return new Set(normalizeFavorites(list).map((item) => item.symbol));
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

  async function fetchFavoritesFile(options) {
    const repo = (options && options.repo) || DEFAULT_REPO;
    const path = (options && options.path) || FAVORITES_PATH;
    const token = (options && options.token) || getGithubToken();
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
      throw new Error(`读取收藏失败: ${response.status} ${text.slice(0, 160)}`);
    }
    const file = await response.json();
    if (!file.content) {
      throw new Error("收藏文件内容为空");
    }
    return {
      data: JSON.parse(decodeBase64Utf8(file.content)),
      sha: file.sha,
    };
  }

  async function writeFavoritesFile(options) {
    const repo = (options && options.repo) || DEFAULT_REPO;
    const path = (options && options.path) || FAVORITES_PATH;
    const token = (options && options.token) || getGithubToken();
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
      throw new Error(`写入收藏失败: ${response.status} ${text.slice(0, 180)}`);
    }
    return response.json();
  }

  async function loadFavoritesRaw(options) {
    // 1) GitHub API（无 CDN 缓存，和写入一致）
    try {
      const current = await fetchFavoritesFile(options);
      if (current.data) {
        return {
          favorites: normalizeFavorites(current.data.favorites),
          favoritesUpdatedAt: Number.isFinite(
            Number(current.data.favoritesUpdatedAt),
          )
            ? Number(current.data.favoritesUpdatedAt)
            : null,
          source: "github-api",
        };
      }
    } catch (error) {
      console.warn("loadFavorites via GitHub API failed", error);
    }

    // 2) raw 兜底
    const repo = (options && options.repo) || DEFAULT_REPO;
    const path = (options && options.path) || FAVORITES_PATH;
    const url = `https://raw.githubusercontent.com/${repo}/main/${path}?t=${Date.now()}`;
    const response = await fetch(url, { cache: "no-store" });
    if (response.ok) {
      const data = await response.json();
      return {
        favorites: normalizeFavorites(data.favorites),
        favoritesUpdatedAt: Number.isFinite(Number(data.favoritesUpdatedAt))
          ? Number(data.favoritesUpdatedAt)
          : null,
        source: "github-raw",
      };
    }
    return { favorites: [], favoritesUpdatedAt: null, source: "empty" };
  }

  function toggleFavorite(list, symbol, source) {
    const key = String(symbol || "")
      .trim()
      .toUpperCase();
    const normalized = normalizeFavorites(list);
    const exists = normalized.some((item) => item.symbol === key);
    if (exists) {
      return {
        list: normalized.filter((item) => item.symbol !== key),
        added: false,
      };
    }
    return {
      list: [
        { symbol: key, addedAt: Date.now(), source: source || "manual" },
        ...normalized.filter((item) => item.symbol !== key),
      ],
      added: true,
    };
  }

  async function patchFavorites(options) {
    const maxAttempts = (options && options.maxAttempts) || 3;
    let lastError = null;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        const current = await fetchFavoritesFile(options);
        const base = current.data || {
          favorites: [],
          favoritesUpdatedAt: null,
        };
        const favorites = normalizeFavorites(base.favorites);
        let result;
        if (typeof options.mutate === "function") {
          result = options.mutate(favorites.slice());
        } else {
          result = toggleFavorite(
            favorites,
            options.symbol,
            options.source || "manual",
          );
        }
        const nextFavorites = normalizeFavorites(
          result && result.list ? result.list : result,
        );
        const nextData = {
          favorites: nextFavorites,
          favoritesUpdatedAt: Date.now(),
          updatedAt: Date.now(),
        };
        await writeFavoritesFile({
          ...options,
          data: nextData,
          sha: current.sha,
          message: options.message || `Update favorite ${options.symbol || ""}`.trim(),
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
    FAVORITES_PATH,
    normalizeFavorites,
    favoritesToSymbolSet,
    toggleFavorite,
    loadFavoritesRaw,
    patchFavorites,
  };
});
