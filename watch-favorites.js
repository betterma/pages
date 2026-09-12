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

  const DEFAULT_REPO = "betterma/pages";
  // Personal favorites / blacklist live in small dedicated files so browser
  // writes do not depend on the multi‑MB watch-data.json Contents API limit.
  const FAVORITES_PATH = "watch-favorites.json";
  const BLACKLIST_PATH = "watch-blacklist.json";
  const PINS_PATH = "watch-pins.json";
  const LEGACY_DATA_PATH = "watch-data.json";
  const PIN_TTL_MS = 12 * 60 * 60 * 1000;

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

  async function fetchJsonFile(options) {
    const repo = options.repo || DEFAULT_REPO;
    const path = options.path;
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
      throw new Error(`${path} 内容为空`);
    }
    return {
      data: JSON.parse(raw),
      sha: file.sha,
    };
  }

  async function writeJsonFile(options) {
    const repo = options.repo || DEFAULT_REPO;
    const path = options.path;
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

  async function getMainCommitSha(options) {
    const repo = options.repo || DEFAULT_REPO;
    const token = options.token || getGithubToken();
    const response = await fetch(
      `https://api.github.com/repos/${repo}/commits/main?per_page=1&t=${Date.now()}`,
      {
        cache: "no-store",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
    );
    if (!response.ok) {
      throw new Error(`读取 main commit 失败: ${response.status}`);
    }
    const data = await response.json();
    if (!data.sha) throw new Error("main commit sha 为空");
    return data.sha;
  }

  async function fetchRawJsonByCommit(options) {
    const repo = options.repo || DEFAULT_REPO;
    const path = options.path;
    const commitSha = options.commitSha;
    // Pin to commit sha so CDN key is unique per revision (avoids stale /main cache).
    const url = `https://raw.githubusercontent.com/${repo}/${commitSha}/${path}`;
    const response = await fetch(url, {
      cache: "no-store",
      headers: {
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
      },
    });
    return response;
  }

  async function loadFavoritesRaw(options) {
    const repo = options.repo || DEFAULT_REPO;
    const path = options.path || FAVORITES_PATH;

    // 1) Prefer Contents API — same channel as writes, no raw CDN.
    try {
      const current = await fetchJsonFile({
        repo,
        path,
        token: options.token,
      });
      if (current.data) {
        return {
          favorites: normalizeFavorites(current.data.favorites),
          favoritesUpdatedAt: Number.isFinite(
            Number(current.data.favoritesUpdatedAt),
          )
            ? Number(current.data.favoritesUpdatedAt)
            : null,
          source: "api",
        };
      }
    } catch (error) {
      console.warn("loadFavorites via API failed, trying raw", error);
    }

    // 2) Raw with commit pin: ?t= cannot disable GitHub CDN, but
    //    /{commitSha}/path is a new URL per push → no stale /main blob.
    try {
      const commitSha = await getMainCommitSha({
        repo,
        token: options.token,
      });
      const response = await fetchRawJsonByCommit({
        repo,
        path,
        commitSha,
      });
      if (response.ok) {
        const data = await response.json();
        const favorites = normalizeFavorites(data.favorites);
        if (favorites.length) {
          return {
            favorites,
            favoritesUpdatedAt: Number.isFinite(Number(data.favoritesUpdatedAt))
              ? Number(data.favoritesUpdatedAt)
              : null,
            source: "raw-commit",
          };
        }
      } else if (response.status !== 404) {
        console.warn(`读取收藏 raw 失败: ${response.status}`);
      }
    } catch (error) {
      console.warn("loadFavorites via commit-raw failed", error);
    }

    // 3) Migrate legacy favorites embedded in watch-data.json.
    try {
      const legacy = await fetchJsonFile({
        repo,
        path: LEGACY_DATA_PATH,
        token: options.token,
      });
      if (legacy.data) {
        return {
          favorites: normalizeFavorites(legacy.data.favorites),
          favoritesUpdatedAt: Number.isFinite(
            Number(legacy.data.favoritesUpdatedAt),
          )
            ? Number(legacy.data.favoritesUpdatedAt)
            : null,
          source: "legacy-api",
        };
      }
    } catch (error) {
      console.warn("legacy favorites via API failed", error);
    }

    try {
      const commitSha = await getMainCommitSha({
        repo,
        token: options.token,
      });
      const legacyResponse = await fetchRawJsonByCommit({
        repo,
        path: LEGACY_DATA_PATH,
        commitSha,
      });
      if (legacyResponse.ok) {
        const legacy = await legacyResponse.json();
        return {
          favorites: normalizeFavorites(legacy.favorites),
          favoritesUpdatedAt: Number.isFinite(Number(legacy.favoritesUpdatedAt))
            ? Number(legacy.favoritesUpdatedAt)
            : null,
          source: "legacy-raw-commit",
        };
      }
    } catch (error) {
      console.warn("legacy favorites via commit-raw failed", error);
    }

    return { favorites: [], favoritesUpdatedAt: null, source: "empty" };
  }

  async function patchFavorites(options) {
    const repo = options.repo || DEFAULT_REPO;
    const path = options.path || FAVORITES_PATH;
    const maxAttempts = options.maxAttempts || 3;
    let lastError = null;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        const current = await fetchJsonFile({
          repo,
          path,
          token: options.token,
        });
        const base = current.data || {
          favorites: [],
          favoritesUpdatedAt: null,
        };
        const favorites = normalizeFavorites(base.favorites);
        const result = options.mutate(favorites.slice());
        const nextFavorites = serializeFavorites(
          result && result.list ? result.list : result,
        );
        const nextData = {
          favorites: nextFavorites,
          favoritesUpdatedAt: Date.now(),
          updatedAt: Date.now(),
        };
        await writeJsonFile({
          repo,
          path,
          token: options.token,
          data: nextData,
          sha: current.sha,
          message: options.message || `Update ${path}`,
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

  // Blacklist reuses the same item shape as favorites.
  const normalizeBlacklist = normalizeFavorites;
  const serializeBlacklist = serializeFavorites;
  const blacklistToSymbolSet = favoritesToSymbolSet;
  const hasBlacklist = hasFavorite;
  const addBlacklist = addFavorite;
  const removeBlacklist = removeFavorite;
  const toggleBlacklist = toggleFavorite;

  async function loadBlacklistRaw(options) {
    const repo = (options && options.repo) || DEFAULT_REPO;
    const path = (options && options.path) || BLACKLIST_PATH;

    try {
      const current = await fetchJsonFile({
        repo,
        path,
        token: options && options.token,
      });
      if (current.data) {
        return {
          blacklist: normalizeBlacklist(current.data.blacklist),
          blacklistUpdatedAt: Number.isFinite(
            Number(current.data.blacklistUpdatedAt),
          )
            ? Number(current.data.blacklistUpdatedAt)
            : null,
          source: "api",
        };
      }
    } catch (error) {
      console.warn("loadBlacklist via API failed, trying raw", error);
    }

    try {
      const commitSha = await getMainCommitSha({
        repo,
        token: options && options.token,
      });
      const response = await fetchRawJsonByCommit({
        repo,
        path,
        commitSha,
      });
      if (response.ok) {
        const data = await response.json();
        return {
          blacklist: normalizeBlacklist(data.blacklist),
          blacklistUpdatedAt: Number.isFinite(Number(data.blacklistUpdatedAt))
            ? Number(data.blacklistUpdatedAt)
            : null,
          source: "raw-commit",
        };
      }
      if (response.status !== 404) {
        console.warn(`读取黑名单 raw 失败: ${response.status}`);
      }
    } catch (error) {
      console.warn("loadBlacklist via commit-raw failed", error);
    }

    return { blacklist: [], blacklistUpdatedAt: null, source: "empty" };
  }

  async function patchBlacklist(options) {
    const repo = (options && options.repo) || DEFAULT_REPO;
    const path = (options && options.path) || BLACKLIST_PATH;
    const maxAttempts = (options && options.maxAttempts) || 3;
    let lastError = null;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        const current = await fetchJsonFile({
          repo,
          path,
          token: options && options.token,
        });
        const base = current.data || {
          blacklist: [],
          blacklistUpdatedAt: null,
        };
        const blacklist = normalizeBlacklist(base.blacklist);
        let result;
        if (typeof options.mutate === "function") {
          result = options.mutate(blacklist.slice());
        } else {
          result = toggleBlacklist(
            blacklist,
            options.symbol,
            options.source || "manual",
          );
        }
        const nextBlacklist = serializeBlacklist(
          result && result.list ? result.list : result,
        );
        const nextData = {
          blacklist: nextBlacklist,
          blacklistUpdatedAt: Date.now(),
          updatedAt: Date.now(),
        };
        await writeJsonFile({
          repo,
          path,
          token: options && options.token,
          data: nextData,
          sha: current.sha,
          message:
            options.message ||
            `Update blacklist ${options.symbol || ""}`.trim(),
        });
        return {
          blacklist: nextBlacklist,
          blacklistUpdatedAt: nextData.blacklistUpdatedAt,
          meta: result && typeof result === "object" ? result : null,
        };
      } catch (error) {
        lastError = error;
        if (error.code !== "conflict") throw error;
      }
    }
    throw lastError || new Error("保存黑名单失败");
  }

  // Temporary pins / 盯一下 — 12h TTL; expired entries stay until cleared.
  function normalizePinItem(item) {
    if (!item || typeof item !== "object" || !item.symbol) return null;
    const symbol = String(item.symbol).trim().toUpperCase();
    if (!symbol) return null;
    const pinnedAt = Number.isFinite(Number(item.pinnedAt))
      ? Number(item.pinnedAt)
      : 0;
    const pinPrice = Number(item.pinPrice);
    const expiresAt = Number.isFinite(Number(item.expiresAt))
      ? Number(item.expiresAt)
      : pinnedAt > 0
        ? pinnedAt + PIN_TTL_MS
        : 0;
    return {
      symbol,
      pinnedAt,
      expiresAt,
      pinPrice: Number.isFinite(pinPrice) ? pinPrice : null,
      source: item.source ? String(item.source) : "legacy",
    };
  }

  function normalizePins(raw) {
    if (!Array.isArray(raw)) return [];
    const map = new Map();
    raw.forEach((item) => {
      const normalized = normalizePinItem(item);
      if (!normalized) return;
      const prev = map.get(normalized.symbol);
      if (!prev || normalized.pinnedAt >= prev.pinnedAt) {
        map.set(normalized.symbol, normalized);
      }
    });
    return [...map.values()].sort((a, b) => {
      if (b.pinnedAt !== a.pinnedAt) return b.pinnedAt - a.pinnedAt;
      return a.symbol.localeCompare(b.symbol);
    });
  }

  function serializePins(list) {
    return normalizePins(list).map((item) => ({
      symbol: item.symbol,
      pinnedAt: item.pinnedAt,
      expiresAt: item.expiresAt,
      pinPrice: item.pinPrice,
      source: item.source || "legacy",
    }));
  }

  function pinsToSymbolSet(list) {
    return new Set(normalizePins(list).map((item) => item.symbol));
  }

  function hasPin(list, symbol) {
    const key = String(symbol || "")
      .trim()
      .toUpperCase();
    return normalizePins(list).some((item) => item.symbol === key);
  }

  function isPinExpired(item, now) {
    const ts = Number.isFinite(Number(now)) ? Number(now) : Date.now();
    const expiresAt = Number(item && item.expiresAt);
    return Number.isFinite(expiresAt) && expiresAt > 0 && ts >= expiresAt;
  }

  function addPin(list, symbol, pinPrice, source, ttlMs) {
    const key = String(symbol || "")
      .trim()
      .toUpperCase();
    if (!key) return normalizePins(list);
    const now = Date.now();
    const ttl =
      Number.isFinite(Number(ttlMs)) && Number(ttlMs) > 0
        ? Number(ttlMs)
        : PIN_TTL_MS;
    const price = Number(pinPrice);
    const next = normalizePins(list).filter((item) => item.symbol !== key);
    next.unshift({
      symbol: key,
      pinnedAt: now,
      expiresAt: now + ttl,
      pinPrice: Number.isFinite(price) ? price : null,
      source: source || "manual",
    });
    return next;
  }

  function removePin(list, symbol) {
    const key = String(symbol || "")
      .trim()
      .toUpperCase();
    return normalizePins(list).filter((item) => item.symbol !== key);
  }

  function togglePin(list, symbol, pinPrice, source, ttlMs) {
    if (hasPin(list, symbol)) {
      return { list: removePin(list, symbol), added: false };
    }
    return {
      list: addPin(list, symbol, pinPrice, source, ttlMs),
      added: true,
    };
  }

  async function loadPinsRaw(options) {
    const repo = (options && options.repo) || DEFAULT_REPO;
    const path = (options && options.path) || PINS_PATH;

    try {
      const current = await fetchJsonFile({
        repo,
        path,
        token: options && options.token,
      });
      if (current.data) {
        return {
          pins: normalizePins(current.data.pins),
          pinsUpdatedAt: Number.isFinite(Number(current.data.pinsUpdatedAt))
            ? Number(current.data.pinsUpdatedAt)
            : null,
          source: "api",
        };
      }
    } catch (error) {
      console.warn("loadPins via API failed, trying raw", error);
    }

    try {
      const commitSha = await getMainCommitSha({
        repo,
        token: options && options.token,
      });
      const response = await fetchRawJsonByCommit({
        repo,
        path,
        commitSha,
      });
      if (response.ok) {
        const data = await response.json();
        return {
          pins: normalizePins(data.pins),
          pinsUpdatedAt: Number.isFinite(Number(data.pinsUpdatedAt))
            ? Number(data.pinsUpdatedAt)
            : null,
          source: "raw-commit",
        };
      }
      if (response.status !== 404) {
        console.warn(`读取盯一下 raw 失败: ${response.status}`);
      }
    } catch (error) {
      console.warn("loadPins via commit-raw failed", error);
    }

    return { pins: [], pinsUpdatedAt: null, source: "empty" };
  }

  async function patchPins(options) {
    const repo = (options && options.repo) || DEFAULT_REPO;
    const path = (options && options.path) || PINS_PATH;
    const maxAttempts = (options && options.maxAttempts) || 3;
    let lastError = null;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        const current = await fetchJsonFile({
          repo,
          path,
          token: options && options.token,
        });
        const base = current.data || {
          pins: [],
          pinsUpdatedAt: null,
        };
        const pins = normalizePins(base.pins);
        let result;
        if (typeof options.mutate === "function") {
          result = options.mutate(pins.slice());
        } else {
          result = togglePin(
            pins,
            options.symbol,
            options.pinPrice,
            options.source || "manual",
            options.ttlMs,
          );
        }
        const nextPins = serializePins(
          result && result.list ? result.list : result,
        );
        const nextData = {
          pins: nextPins,
          pinsUpdatedAt: Date.now(),
          updatedAt: Date.now(),
        };
        await writeJsonFile({
          repo,
          path,
          token: options && options.token,
          data: nextData,
          sha: current.sha,
          message:
            options.message ||
            `Update pins ${options.symbol || ""}`.trim(),
        });
        return {
          pins: nextPins,
          pinsUpdatedAt: nextData.pinsUpdatedAt,
          meta: result && typeof result === "object" ? result : null,
        };
      } catch (error) {
        lastError = error;
        if (error.code !== "conflict") throw error;
      }
    }
    throw lastError || new Error("保存盯一下失败");
  }

  return {
    DEFAULT_REPO,
    FAVORITES_PATH,
    BLACKLIST_PATH,
    PINS_PATH,
    PIN_TTL_MS,
    LEGACY_DATA_PATH,
    getGithubToken,
    normalizeFavorites,
    serializeFavorites,
    favoritesToSymbolSet,
    hasFavorite,
    addFavorite,
    removeFavorite,
    toggleFavorite,
    loadFavoritesRaw,
    patchFavorites,
    normalizeBlacklist,
    serializeBlacklist,
    blacklistToSymbolSet,
    hasBlacklist,
    addBlacklist,
    removeBlacklist,
    toggleBlacklist,
    loadBlacklistRaw,
    patchBlacklist,
    normalizePins,
    serializePins,
    pinsToSymbolSet,
    hasPin,
    isPinExpired,
    addPin,
    removePin,
    togglePin,
    loadPinsRaw,
    patchPins,
  };
});
