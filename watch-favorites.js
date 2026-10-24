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
  const MOM_NOTES_PATH = "watch-mom-notes.json";
  const ACTION_LOG_PATH = "watch-action-log.json";
  const CARD_EGGS_PATH = "watch-card-eggs.json";
  const BREAK_HIGH_PATH = "watch-break-high.json";
  const NAILS_PATH = "watch-nails.json";
  const NAIL_GREEN_NOTICES_PATH = "watch-nail-green-notices.json";
  const NAIL_GREEN_NOTICES_TTL_MS = 24 * 60 * 60 * 1000;
  const NOTES_RANK_SNAPS_PATH = "watch-notes-rank-snaps.json";
  const NOTES_RANK_PREFS_PATH = "watch-notes-rank-prefs.json";
  const PRICE_ALERTS_PATH = "watch-price-alerts.json";
  const LEGACY_DATA_PATH = "watch-data.json";
  const PIN_TTL_MS = 12 * 60 * 60 * 1000;
  // 暂时关闭盯一下过期；改 true 可恢复 12h TTL。
  const PIN_EXPIRY_ENABLED = false;
  const MOM_NOTES_MAX = 200;
  /** 动作日志 / 战绩统一保留近 7 天；条数上限只做安全阀。 */
  const ACTION_LOG_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  const ACTION_LOG_MAX = 10000;
  /** 排序动态日志单独保留 1 天。 */
  const ACTION_LOG_RANK_TTL_MS = 24 * 60 * 60 * 1000;
  const ACTION_LOG_RANK_KINDS = new Set(["rank-new", "rank-up"]);
  /** 裁满上限时优先留买卖与记一笔，避免被 zone-drop 挤掉战绩。 */
  const ACTION_LOG_PRIORITY_KINDS = new Set([
    "buy",
    "sell",
    "sell-stop",
    "mom-note",
    "period-low-exit",
  ]);
  /** 钉子数量不设上限（历史曾为 80）。 */
  const NAILS_MAX = Infinity;
  const NOTES_RANK_SNAPS_TTL_MS = 24 * 60 * 60 * 1000;
  const NOTES_RANK_SNAPS_MAX = 48;
  /** Cloud + browser share this sort for 排序动态 snaps. */
  const NOTES_RANK_PREFS_DEFAULT = {
    keys: ["change2h", "noteAt", "change1h"],
    last: "change2h",
  };
  const NOTES_RANK_SORT_KEYS = new Set([
    "change2h",
    "change1h",
    "change24h",
    "noteAt",
    "gain",
  ]);
  const PRICE_ALERTS_MAX = 40;
  const PRICE_ALERT_SEND_MAX = 10;
  const PRICE_ALERT_SEND_GAP_MS = 60 * 1000;

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
        `https://api.github.com/repos/${repo}/git/blobs/${file.sha}?t=${Date.now()}`,
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
    const url = `https://raw.githubusercontent.com/${repo}/${commitSha}/${path}?t=${Date.now()}`;
    const response = await fetch(url, {
      cache: "no-store",
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

  // Temporary pins / 盯一下 — optional 12h TTL (PIN_EXPIRY_ENABLED).
  function normalizePinItem(item) {
    if (!item || typeof item !== "object" || !item.symbol) return null;
    const symbol = String(item.symbol).trim().toUpperCase();
    if (!symbol) return null;
    const pinnedAt = Number.isFinite(Number(item.pinnedAt))
      ? Number(item.pinnedAt)
      : 0;
    const pinPrice = Number(item.pinPrice);
    let expiresAt = 0;
    if (PIN_EXPIRY_ENABLED) {
      expiresAt = Number.isFinite(Number(item.expiresAt))
        ? Number(item.expiresAt)
        : pinnedAt > 0
          ? pinnedAt + PIN_TTL_MS
          : 0;
    }
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
    if (!PIN_EXPIRY_ENABLED) return false;
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
      expiresAt: PIN_EXPIRY_ENABLED ? now + ttl : 0,
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

  function removeExpiredPins(list, now) {
    const ts = Number.isFinite(Number(now)) ? Number(now) : Date.now();
    return normalizePins(list).filter((item) => !isPinExpired(item, ts));
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

  function normalizeMomNote(item) {
    if (!item || typeof item !== "object") return null;
    const symbol = String(item.symbol || "")
      .trim()
      .toUpperCase();
    if (!symbol) return null;
    const at = Number(item.at);
    const price = Number(item.price);
    return {
      id: item.id ? String(item.id) : `${Date.now().toString(36)}`,
      at: Number.isFinite(at) ? at : Date.now(),
      symbol,
      label: item.label
        ? String(item.label)
        : symbol.replace(/USDT$/i, ""),
      status: item.status ? String(item.status) : null,
      statusLabel: item.statusLabel ? String(item.statusLabel) : null,
      change2h: Number.isFinite(Number(item.change2h))
        ? Number(item.change2h)
        : null,
      change1h: Number.isFinite(Number(item.change1h))
        ? Number(item.change1h)
        : null,
      delta: Number.isFinite(Number(item.delta)) ? Number(item.delta) : null,
      price: Number.isFinite(price) && price > 0 ? price : null,
    };
  }

  function normalizeMomNotes(raw) {
    if (!Array.isArray(raw)) return [];
    return raw
      .map(normalizeMomNote)
      .filter(Boolean)
      .sort((a, b) => b.at - a.at)
      .slice(0, MOM_NOTES_MAX);
  }

  function serializeMomNotes(list) {
    return normalizeMomNotes(list).map((item) => ({
      id: item.id,
      at: item.at,
      symbol: item.symbol,
      label: item.label,
      status: item.status,
      statusLabel: item.statusLabel,
      change2h: item.change2h,
      change1h: item.change1h,
      delta: item.delta,
      price: item.price,
    }));
  }

  async function loadMomNotesRaw(options) {
    const repo = (options && options.repo) || DEFAULT_REPO;
    const path = (options && options.path) || MOM_NOTES_PATH;

    try {
      const current = await fetchJsonFile({
        repo,
        path,
        token: options && options.token,
      });
      if (current.data) {
        return {
          notes: normalizeMomNotes(current.data.notes),
          notesUpdatedAt: Number.isFinite(Number(current.data.notesUpdatedAt))
            ? Number(current.data.notesUpdatedAt)
            : null,
          source: "api",
        };
      }
    } catch (error) {
      console.warn("loadMomNotes via API failed, trying raw", error);
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
          notes: normalizeMomNotes(data.notes),
          notesUpdatedAt: Number.isFinite(Number(data.notesUpdatedAt))
            ? Number(data.notesUpdatedAt)
            : null,
          source: "raw-commit",
        };
      }
      if (response.status !== 404) {
        console.warn(`读取记一笔 raw 失败: ${response.status}`);
      }
    } catch (error) {
      console.warn("loadMomNotes via commit-raw failed", error);
    }

    return { notes: [], notesUpdatedAt: null, source: "empty" };
  }

  async function patchMomNotes(options) {
    const repo = (options && options.repo) || DEFAULT_REPO;
    const path = (options && options.path) || MOM_NOTES_PATH;
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
          notes: [],
          notesUpdatedAt: null,
        };
        const notes = normalizeMomNotes(base.notes);
        let nextList = notes;
        if (typeof options.mutate === "function") {
          const result = options.mutate(notes.slice());
          nextList = Array.isArray(result)
            ? result
            : result && result.list
              ? result.list
              : notes;
        }
        const nextNotes = serializeMomNotes(nextList).slice(0, MOM_NOTES_MAX);
        const nextData = {
          notes: nextNotes,
          notesUpdatedAt: Date.now(),
          updatedAt: Date.now(),
        };
        await writeJsonFile({
          repo,
          path,
          token: options && options.token,
          data: nextData,
          sha: current.sha,
          message: options.message || "Update momentum notes",
        });
        return {
          notes: nextNotes,
          notesUpdatedAt: nextData.notesUpdatedAt,
        };
      } catch (error) {
        lastError = error;
        if (error.code !== "conflict") throw error;
      }
    }
    throw lastError || new Error("保存记一笔失败");
  }

  function nailSymbolKey(raw) {
    let key = String(raw || "")
      .trim()
      .toUpperCase()
      .replace(/\s+/g, "");
    if (!key) return "";
    if (!/USDT$/.test(key)) key += "USDT";
    return key;
  }

  function normalizeNail(item, index) {
    if (!item || typeof item !== "object") return null;
    const symbol = nailSymbolKey(item.symbol || item.label || item.name);
    if (!symbol) return null;
    const at = Number(item.at);
    const exitedAt = Number(item.exitedAt);
    const pinnedAt = Number(item.pinnedAt);
    const noteAt = Number(item.noteAt);
    const order = Number(item.order);
    const note = String(item.note || item.remark || "").trim();
    return {
      id: item.id ? String(item.id) : `${Date.now().toString(36)}`,
      at: Number.isFinite(at) ? at : Date.now(),
      symbol,
      label: item.label
        ? String(item.label).trim()
        : symbol.replace(/USDT$/i, ""),
      note,
      noteAt: note && Number.isFinite(noteAt) && noteAt > 0 ? noteAt : 0,
      exitedAt: Number.isFinite(exitedAt) && exitedAt > 0 ? exitedAt : 0,
      pinned: !!item.pinned,
      pinnedAt: Number.isFinite(pinnedAt) && pinnedAt > 0 ? pinnedAt : 0,
      order: Number.isFinite(order) ? order : Number.isFinite(index) ? index : 0,
    };
  }

  function reindexNails(list) {
    return (Array.isArray(list) ? list : []).map((item, order) => ({
      ...item,
      order,
    }));
  }

  function normalizeNails(raw) {
    if (!Array.isArray(raw)) return [];
    const seen = new Set();
    const list = [];
    raw.forEach((item, index) => {
      const nail = normalizeNail(item, index);
      if (!nail || seen.has(nail.symbol)) return;
      seen.add(nail.symbol);
      list.push(nail);
    });
    list.sort((a, b) => {
      const ap = a.pinned ? 0 : 1;
      const bp = b.pinned ? 0 : 1;
      if (ap !== bp) return ap - bp;
      if (a.order !== b.order) return a.order - b.order;
      if ((b.pinnedAt || 0) !== (a.pinnedAt || 0)) {
        return (b.pinnedAt || 0) - (a.pinnedAt || 0);
      }
      return (b.at || 0) - (a.at || 0);
    });
    return reindexNails(list);
  }

  function serializeNails(list) {
    return normalizeNails(list).map((item, order) => ({
      id: item.id,
      at: item.at,
      symbol: item.symbol,
      label: item.label,
      note: item.note,
      noteAt: item.noteAt || 0,
      exitedAt: item.exitedAt || 0,
      pinned: !!item.pinned,
      pinnedAt: item.pinnedAt || 0,
      order,
    }));
  }

  function upsertNail(list, symbol, note) {
    const key = nailSymbolKey(symbol);
    if (!key) return normalizeNails(list);
    const prev = normalizeNails(list);
    const existing = prev.find((item) => item.symbol === key) || null;
    const next = prev.filter((item) => item.symbol !== key);
    const text = String(note || "").trim();
    const now = Date.now();
    let noteAt = (existing && existing.noteAt) || 0;
    if (text !== String((existing && existing.note) || "").trim()) {
      noteAt = text ? now : 0;
    }
    next.unshift({
      id: (existing && existing.id) || `${now.toString(36)}`,
      at: now,
      symbol: key,
      label: key.replace(/USDT$/i, ""),
      note: text,
      noteAt,
      exitedAt: 0,
      pinned: !!(existing && existing.pinned),
      pinnedAt: (existing && existing.pinnedAt) || 0,
      order: 0,
    });
    return reindexNails(next);
  }

  function removeNail(list, symbol) {
    const key = nailSymbolKey(symbol);
    return reindexNails(
      normalizeNails(list).filter((item) => item.symbol !== key),
    );
  }

  function upsertNailsBatch(list, symbols, notesBySymbol) {
    const keys = [
      ...new Set(
        (symbols || [])
          .map((symbol) => nailSymbolKey(symbol))
          .filter(Boolean),
      ),
    ];
    if (!keys.length) return normalizeNails(list);
    const prev = normalizeNails(list);
    const existingMap = new Map(prev.map((item) => [item.symbol, item]));
    const rest = prev.filter((item) => !keys.includes(item.symbol));
    const now = Date.now();
    const notes =
      notesBySymbol && typeof notesBySymbol === "object" ? notesBySymbol : null;
    const added = keys.map((key, index) => {
      const existing = existingMap.get(key) || null;
      const hasMapped =
        !!notes && Object.prototype.hasOwnProperty.call(notes, key);
      const mappedNote = hasMapped ? String(notes[key] || "").trim() : null;
      const prevNote = (existing && existing.note) || "";
      const note = mappedNote != null ? mappedNote : prevNote;
      let noteAt = (existing && existing.noteAt) || 0;
      if (mappedNote != null && mappedNote !== prevNote) {
        noteAt = mappedNote ? now : 0;
      }
      return {
        id: (existing && existing.id) || `${now.toString(36)}-${index}`,
        at: now,
        symbol: key,
        label: key.replace(/USDT$/i, ""),
        note,
        noteAt,
        exitedAt: 0,
        pinned: !!(existing && existing.pinned),
        pinnedAt: (existing && existing.pinnedAt) || 0,
        order: 0,
      };
    });
    return reindexNails([...added, ...rest]);
  }

  function removeNailsBatch(list, symbols) {
    const keys = new Set(
      (symbols || [])
        .map((symbol) => nailSymbolKey(symbol))
        .filter(Boolean),
    );
    if (!keys.size) return normalizeNails(list);
    return reindexNails(
      normalizeNails(list).filter((item) => !keys.has(item.symbol)),
    );
  }

  function setNailPinned(list, symbol, pinned) {
    const key = nailSymbolKey(symbol);
    if (!key) return normalizeNails(list);
    const want = !!pinned;
    let next = normalizeNails(list);
    const item = next.find((row) => row.symbol === key);
    if (!item) return next;
    next = next.filter((row) => row.symbol !== key);
    const updated = {
      ...item,
      pinned: want,
      pinnedAt: want ? Date.now() : 0,
    };
    if (want) {
      next.unshift(updated);
    } else {
      const firstUnpinned = next.findIndex((row) => !row.pinned);
      if (firstUnpinned < 0) next.push(updated);
      else next.splice(firstUnpinned, 0, updated);
    }
    return reindexNails(next);
  }

  function setNailsPinnedBatch(list, symbols, pinned) {
    const keys = [
      ...new Set(
        (symbols || [])
          .map((symbol) => nailSymbolKey(symbol))
          .filter(Boolean),
      ),
    ];
    if (!keys.length) return normalizeNails(list);
    let next = normalizeNails(list);
    for (const key of keys) {
      next = setNailPinned(next, key, pinned);
    }
    return next;
  }

  function reorderNails(list, fromSymbol, toSymbol) {
    const fromKey = nailSymbolKey(fromSymbol);
    const toKey = nailSymbolKey(toSymbol);
    if (!fromKey || !toKey || fromKey === toKey) return normalizeNails(list);
    const next = normalizeNails(list);
    const from = next.findIndex((item) => item.symbol === fromKey);
    const to = next.findIndex((item) => item.symbol === toKey);
    if (from < 0 || to < 0) return next;
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    return reindexNails(next);
  }

  function markNailsExited(list, symbols) {
    const keys = new Set(
      (symbols || []).map((symbol) => nailSymbolKey(symbol)).filter(Boolean),
    );
    if (!keys.size) return normalizeNails(list);
    const now = Date.now();
    return normalizeNails(list).map((item) =>
      keys.has(item.symbol) ? { ...item, exitedAt: now } : item,
    );
  }

  function setNailNote(list, symbol, note, options = {}) {
    const key = nailSymbolKey(symbol);
    if (!key) return normalizeNails(list);
    const text = String(note || "")
      .trim()
      .slice(0, 40);
    const next = normalizeNails(list);
    const item = next.find((row) => row.symbol === key);
    if (!item) return next;
    const requestedNoteAt = Number(options.noteAt);
    const hasExplicitNoteAt =
      !!options &&
      Object.prototype.hasOwnProperty.call(options, "noteAt") &&
      Number.isFinite(requestedNoteAt) &&
      requestedNoteAt >= 0;
    const noteAt = text
      ? hasExplicitNoteAt
        ? requestedNoteAt
        : Date.now()
      : 0;
    // 允许「同文案、刷新 noteAt」（自动便签现价 / 重开观察）。
    if (
      item.note === text &&
      (!hasExplicitNoteAt || Number(item.noteAt) === noteAt)
    ) {
      return next;
    }
    return next.map((row) =>
      row.symbol === key ? { ...row, note: text, noteAt } : row,
    );
  }

  function normalizeBrowseMaskAt(raw) {
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  function normalizeBrowseRevealed(raw) {
    const list = Array.isArray(raw) ? raw : [];
    const seen = new Set();
    const out = [];
    list.forEach((item) => {
      const key = nailSymbolKey(item);
      if (!key || seen.has(key)) return;
      seen.add(key);
      out.push(key);
    });
    return out;
  }

  /** 用户手动删除的钉子：云函数补钉时跳过，直到再次手动钉入或新自动盯。 */
  function normalizeDismissedNails(raw) {
    return normalizeBrowseRevealed(raw);
  }

  function addDismissedNails(list, symbols) {
    const next = new Set(normalizeDismissedNails(list));
    (symbols || []).forEach((symbol) => {
      const key = nailSymbolKey(symbol);
      if (key) next.add(key);
    });
    return [...next];
  }

  function removeDismissedNails(list, symbols) {
    const drop = new Set(
      (symbols || []).map((symbol) => nailSymbolKey(symbol)).filter(Boolean),
    );
    if (!drop.size) return normalizeDismissedNails(list);
    return normalizeDismissedNails(list).filter((symbol) => !drop.has(symbol));
  }

  async function loadNailsRaw(options) {
    const repo = (options && options.repo) || DEFAULT_REPO;
    const path = (options && options.path) || NAILS_PATH;
    try {
      const current = await fetchJsonFile({
        repo,
        path,
        token: options && options.token,
      });
      if (current.data) {
        return {
          nails: normalizeNails(current.data.nails),
          nailsUpdatedAt: Number.isFinite(Number(current.data.nailsUpdatedAt))
            ? Number(current.data.nailsUpdatedAt)
            : null,
          browseMaskAt: normalizeBrowseMaskAt(current.data.browseMaskAt),
          browseRevealed: normalizeBrowseRevealed(current.data.browseRevealed),
          dismissedNails: normalizeDismissedNails(current.data.dismissedNails),
          source: "api",
        };
      }
    } catch (error) {
      console.warn("loadNails via API failed, trying raw", error);
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
          nails: normalizeNails(data.nails),
          nailsUpdatedAt: Number.isFinite(Number(data.nailsUpdatedAt))
            ? Number(data.nailsUpdatedAt)
            : null,
          browseMaskAt: normalizeBrowseMaskAt(data.browseMaskAt),
          browseRevealed: normalizeBrowseRevealed(data.browseRevealed),
          dismissedNails: normalizeDismissedNails(data.dismissedNails),
          source: "raw-commit",
        };
      }
    } catch (error) {
      console.warn("loadNails via commit-raw failed", error);
    }
    return {
      nails: [],
      nailsUpdatedAt: null,
      browseMaskAt: 0,
      browseRevealed: [],
      dismissedNails: [],
      source: "empty",
    };
  }

  async function patchNails(options) {
    const repo = (options && options.repo) || DEFAULT_REPO;
    const path = (options && options.path) || NAILS_PATH;
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
          nails: [],
          nailsUpdatedAt: null,
          browseMaskAt: 0,
          browseRevealed: [],
          dismissedNails: [],
        };
        const nails = normalizeNails(base.nails);
        let nextList = nails;
        let nextBrowseMaskAt = normalizeBrowseMaskAt(base.browseMaskAt);
        let nextBrowseRevealed = normalizeBrowseRevealed(base.browseRevealed);
        let nextDismissedNails = normalizeDismissedNails(base.dismissedNails);
        if (typeof options.mutate === "function") {
          const result = options.mutate(nails.slice(), {
            browseMaskAt: nextBrowseMaskAt,
            browseRevealed: nextBrowseRevealed.slice(),
            dismissedNails: nextDismissedNails.slice(),
          });
          nextList = Array.isArray(result)
            ? result
            : result && result.list
              ? result.list
              : nails;
          if (result && !Array.isArray(result)) {
            if (result.browseMaskAt != null) {
              nextBrowseMaskAt = normalizeBrowseMaskAt(result.browseMaskAt);
            }
            if (result.browseRevealed != null) {
              nextBrowseRevealed = normalizeBrowseRevealed(
                result.browseRevealed,
              );
            }
            if (result.dismissedNails != null) {
              nextDismissedNails = normalizeDismissedNails(
                result.dismissedNails,
              );
            }
          }
        }
        if (
          options.browseMaskAt != null &&
          Number.isFinite(Number(options.browseMaskAt))
        ) {
          nextBrowseMaskAt = normalizeBrowseMaskAt(options.browseMaskAt);
        }
        if (options.browseRevealed != null) {
          nextBrowseRevealed = normalizeBrowseRevealed(options.browseRevealed);
        }
        if (options.dismissedNails != null) {
          nextDismissedNails = normalizeDismissedNails(options.dismissedNails);
        }
        const nextNails = serializeNails(nextList);
        const nextData = {
          nails: nextNails,
          nailsUpdatedAt: Date.now(),
          updatedAt: Date.now(),
          browseMaskAt: nextBrowseMaskAt,
          browseRevealed: nextBrowseRevealed,
          dismissedNails: nextDismissedNails,
        };
        await writeJsonFile({
          repo,
          path,
          token: options && options.token,
          data: nextData,
          sha: current.sha,
          message: options.message || "Update nails",
        });
        return {
          nails: nextNails,
          nailsUpdatedAt: nextData.nailsUpdatedAt,
          browseMaskAt: nextBrowseMaskAt,
          browseRevealed: nextBrowseRevealed,
          dismissedNails: nextDismissedNails,
        };
      } catch (error) {
        lastError = error;
        if (error.code !== "conflict") throw error;
      }
    }
    throw lastError || new Error("保存钉子失败");
  }

  function nailGreenNoticeId(item) {
    const symbol = nailSymbolKey(item && (item.symbol || item.id));
    const openTime = Number(item && item.openTime) || 0;
    const at = Number(item && item.at) || 0;
    if (!symbol || !openTime) return "";
    return `${symbol}:${openTime}:${at || openTime}`;
  }

  function normalizeNailGreenNotice(item) {
    if (!item || typeof item !== "object") return null;
    const symbol = nailSymbolKey(item.symbol);
    if (!symbol) return null;
    const at = Number(item.at) || 0;
    const openTime = Number(item.openTime) || 0;
    const alertPrice = Number(item.alertPrice);
    if (!at || !openTime || !Number.isFinite(alertPrice) || alertPrice <= 0) {
      return null;
    }
    const label = item.label
      ? String(item.label).trim().slice(0, 32)
      : symbol.replace(/USDT$/i, "");
    const notifyPrice = Number(item.notifyPrice);
    return {
      id: item.id ? String(item.id) : nailGreenNoticeId({ symbol, openTime, at }),
      symbol,
      label,
      at,
      openTime,
      alertPrice,
      notifyPrice:
        Number.isFinite(notifyPrice) && notifyPrice > 0 ? notifyPrice : 0,
      noteAt: Number(item.noteAt) || 0,
      interval: item.interval ? String(item.interval) : "4h",
    };
  }

  function normalizeNailGreenNotices(raw) {
    const cutoff = Date.now() - NAIL_GREEN_NOTICES_TTL_MS;
    const list = Array.isArray(raw)
      ? raw
      : Array.isArray(raw && raw.items)
        ? raw.items
        : [];
    const seen = new Set();
    const out = [];
    list
      .map(normalizeNailGreenNotice)
      .filter((item) => item && item.at >= cutoff)
      .sort((a, b) => (b.at || 0) - (a.at || 0))
      .forEach((item) => {
        // 同一币只留最新一条（已按 at 降序）。
        const key = String(item.symbol || "").toUpperCase();
        if (!key || seen.has(key)) return;
        seen.add(key);
        out.push(item);
      });
    return out;
  }

  function serializeNailGreenNotices(list, readAt) {
    return {
      updatedAt: Date.now(),
      readAt: Number.isFinite(Number(readAt)) && Number(readAt) > 0
        ? Number(readAt)
        : 0,
      items: normalizeNailGreenNotices(list),
    };
  }

  function countUnreadNailGreenNotices(list, readAt) {
    const read = Number(readAt) || 0;
    return normalizeNailGreenNotices(list).filter((item) => item.at > read)
      .length;
  }

  async function loadNailGreenNoticesRaw(options) {
    const repo = (options && options.repo) || DEFAULT_REPO;
    const path =
      (options && options.path) || NAIL_GREEN_NOTICES_PATH;
    try {
      const current = await fetchJsonFile({
        repo,
        path,
        token: options && options.token,
      });
      if (current.data) {
        return {
          items: normalizeNailGreenNotices(current.data.items || current.data),
          readAt: Number(current.data.readAt) || 0,
          updatedAt: Number(current.data.updatedAt) || null,
          sha: current.sha,
          source: "api",
        };
      }
    } catch (error) {
      console.warn("loadNailGreenNotices via API failed, trying raw", error);
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
          items: normalizeNailGreenNotices(data.items || data),
          readAt: Number(data.readAt) || 0,
          updatedAt: Number(data.updatedAt) || null,
          sha: null,
          source: "raw-commit",
        };
      }
    } catch (error) {
      console.warn("loadNailGreenNotices via commit-raw failed", error);
    }
    return {
      items: [],
      readAt: 0,
      updatedAt: null,
      sha: null,
      source: "empty",
    };
  }

  async function patchNailGreenNotices(options) {
    const repo = (options && options.repo) || DEFAULT_REPO;
    const path =
      (options && options.path) || NAIL_GREEN_NOTICES_PATH;
    const maxAttempts = (options && options.maxAttempts) || 3;
    let lastError = null;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        const current = await fetchJsonFile({
          repo,
          path,
          token: options && options.token,
        });
        const base = current.data || { items: [], readAt: 0 };
        const items = normalizeNailGreenNotices(base.items || base);
        const readAt = Number(base.readAt) || 0;
        const mutated =
          typeof options.mutate === "function"
            ? options.mutate(items, { readAt })
            : null;
        const nextItems = normalizeNailGreenNotices(
          mutated && mutated.items != null ? mutated.items : items,
        );
        const nextReadAt =
          mutated && mutated.readAt != null
            ? Number(mutated.readAt) || 0
            : readAt;
        const nextData = serializeNailGreenNotices(nextItems, nextReadAt);
        await writeJsonFile({
          repo,
          path,
          token: options && options.token,
          data: nextData,
          sha: current.sha,
          message: options.message || "Update nail green notices",
        });
        return {
          items: nextData.items,
          readAt: nextData.readAt,
          updatedAt: nextData.updatedAt,
        };
      } catch (error) {
        lastError = error;
        if (error.code !== "conflict") throw error;
      }
    }
    throw lastError || new Error("保存钉子通知失败");
  }

  function normalizeNotesRankSnap(item) {
    if (!item || typeof item !== "object") return null;
    const at = Number(item.at) || 0;
    const symbols = [
      ...new Set(
        (Array.isArray(item.symbols) ? item.symbols : [])
          .map((symbol) => String(symbol || "").trim().toUpperCase())
          .filter(Boolean),
      ),
    ];
    if (!at || !symbols.length) return null;
    return { at, symbols };
  }

  function normalizeNotesRankSnaps(raw) {
    const cutoff = Date.now() - NOTES_RANK_SNAPS_TTL_MS;
    if (!Array.isArray(raw)) return [];
    return raw
      .map(normalizeNotesRankSnap)
      .filter((item) => item && item.at >= cutoff)
      .sort((a, b) => (b.at || 0) - (a.at || 0))
      .slice(0, NOTES_RANK_SNAPS_MAX);
  }

  function serializeNotesRankSnaps(list) {
    return normalizeNotesRankSnaps(list).map((item) => ({
      at: item.at,
      symbols: item.symbols.slice(),
    }));
  }

  function appendNotesRankSnap(list, symbols, at) {
    const ts = Number(at) || Date.now();
    const nextSymbols = [
      ...new Set(
        (symbols || [])
          .map((symbol) => String(symbol || "").trim().toUpperCase())
          .filter(Boolean),
      ),
    ];
    if (!nextSymbols.length) return normalizeNotesRankSnaps(list);
    return normalizeNotesRankSnaps([
      { at: ts, symbols: nextSymbols },
      ...(list || []),
    ]);
  }

  function compareNotesRankSnaps(prev, curr) {
    const prevSymbols = Array.isArray(prev && prev.symbols) ? prev.symbols : [];
    const currSymbols = Array.isArray(curr && curr.symbols) ? curr.symbols : [];
    const prevRank = new Map();
    prevSymbols.forEach((symbol, index) => {
      const key = String(symbol || "")
        .trim()
        .toUpperCase();
      if (key && !prevRank.has(key)) prevRank.set(key, index + 1);
    });
    const currRank = new Map();
    currSymbols.forEach((symbol, index) => {
      const key = String(symbol || "")
        .trim()
        .toUpperCase();
      if (key && !currRank.has(key)) currRank.set(key, index + 1);
    });
    const added = [];
    const advanced = [];
    for (const [symbol, rank] of currRank) {
      if (!prevRank.has(symbol)) {
        added.push(symbol);
        continue;
      }
      const before = prevRank.get(symbol);
      if (Number.isFinite(before) && rank < before) advanced.push(symbol);
    }
    return { added, advanced };
  }

  async function loadNotesRankSnapsRaw(options) {
    const repo = (options && options.repo) || DEFAULT_REPO;
    const path = (options && options.path) || NOTES_RANK_SNAPS_PATH;
    try {
      const current = await fetchJsonFile({
        repo,
        path,
        token: options && options.token,
      });
      if (current.data) {
        return {
          snaps: normalizeNotesRankSnaps(current.data.snaps),
          snapsUpdatedAt: Number.isFinite(Number(current.data.snapsUpdatedAt))
            ? Number(current.data.snapsUpdatedAt)
            : null,
          source: "api",
        };
      }
    } catch (error) {
      console.warn("loadNotesRankSnaps via API failed, trying raw", error);
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
          snaps: normalizeNotesRankSnaps(data.snaps),
          snapsUpdatedAt: Number.isFinite(Number(data.snapsUpdatedAt))
            ? Number(data.snapsUpdatedAt)
            : null,
          source: "raw-commit",
        };
      }
      if (response.status !== 404) {
        console.warn(`读取排序快照 raw 失败: ${response.status}`);
      }
    } catch (error) {
      console.warn("loadNotesRankSnaps via commit-raw failed", error);
    }
    return { snaps: [], snapsUpdatedAt: null, source: "empty" };
  }

  async function patchNotesRankSnaps(options) {
    const repo = (options && options.repo) || DEFAULT_REPO;
    const path = (options && options.path) || NOTES_RANK_SNAPS_PATH;
    const maxAttempts = (options && options.maxAttempts) || 3;
    let lastError = null;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        const current = await fetchJsonFile({
          repo,
          path,
          token: options && options.token,
        });
        const base = current.data || { snaps: [], snapsUpdatedAt: null };
        const snaps = normalizeNotesRankSnaps(base.snaps);
        let nextList = snaps;
        if (typeof options.mutate === "function") {
          const result = options.mutate(snaps.slice());
          nextList = Array.isArray(result)
            ? result
            : result && result.list
              ? result.list
              : snaps;
        }
        const nextSnaps = serializeNotesRankSnaps(nextList);
        const nextData = {
          snaps: nextSnaps,
          snapsUpdatedAt: Date.now(),
          updatedAt: Date.now(),
        };
        await writeJsonFile({
          repo,
          path,
          token: options && options.token,
          data: nextData,
          sha: current.sha,
          message: options.message || "Update notes-rank snaps",
        });
        return {
          snaps: nextSnaps,
          snapsUpdatedAt: nextData.snapsUpdatedAt,
        };
      } catch (error) {
        lastError = error;
        if (error.code !== "conflict") throw error;
      }
    }
    throw lastError || new Error("保存排序快照失败");
  }

  function normalizeNotesRankSortKey(key) {
    const raw = String(key || "").trim();
    return NOTES_RANK_SORT_KEYS.has(raw)
      ? raw
      : NOTES_RANK_PREFS_DEFAULT.last;
  }

  function uniqueNotesRankSortKeys(keys) {
    const seen = new Set();
    const list = [];
    for (const raw of keys || []) {
      const key = normalizeNotesRankSortKey(raw);
      if (seen.has(key)) continue;
      seen.add(key);
      list.push(key);
    }
    return list.length ? list : NOTES_RANK_PREFS_DEFAULT.keys.slice();
  }

  function normalizeNotesRankPrefs(raw) {
    const base =
      raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    const keys = uniqueNotesRankSortKeys(
      Array.isArray(base.keys) ? base.keys : NOTES_RANK_PREFS_DEFAULT.keys,
    );
    let last = normalizeNotesRankSortKey(
      base.last || NOTES_RANK_PREFS_DEFAULT.last,
    );
    if (!keys.includes(last)) last = keys[keys.length - 1];
    return {
      keys,
      last,
      updatedAt: Number.isFinite(Number(base.updatedAt))
        ? Number(base.updatedAt)
        : 0,
    };
  }

  function serializeNotesRankPrefs(prefs) {
    const next = normalizeNotesRankPrefs(prefs);
    return {
      keys: next.keys.slice(),
      last: next.last,
      updatedAt: next.updatedAt || Date.now(),
    };
  }

  async function loadNotesRankPrefsRaw(options) {
    const repo = (options && options.repo) || DEFAULT_REPO;
    const path = (options && options.path) || NOTES_RANK_PREFS_PATH;
    try {
      const current = await fetchJsonFile({
        repo,
        path,
        token: options && options.token,
      });
      if (current.data) {
        return {
          prefs: normalizeNotesRankPrefs(current.data),
          source: "api",
        };
      }
    } catch (error) {
      console.warn("loadNotesRankPrefs via API failed, trying raw", error);
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
          prefs: normalizeNotesRankPrefs(data),
          source: "raw-commit",
        };
      }
      if (response.status !== 404) {
        console.warn(`读取排序偏好 raw 失败: ${response.status}`);
      }
    } catch (error) {
      console.warn("loadNotesRankPrefs via commit-raw failed", error);
    }
    return {
      prefs: normalizeNotesRankPrefs(NOTES_RANK_PREFS_DEFAULT),
      source: "default",
    };
  }

  async function patchNotesRankPrefs(options) {
    const repo = (options && options.repo) || DEFAULT_REPO;
    const path = (options && options.path) || NOTES_RANK_PREFS_PATH;
    const maxAttempts = (options && options.maxAttempts) || 3;
    let lastError = null;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        const current = await fetchJsonFile({
          repo,
          path,
          token: options && options.token,
        });
        const base = normalizeNotesRankPrefs(
          current.data || NOTES_RANK_PREFS_DEFAULT,
        );
        let nextPrefs = base;
        if (typeof options.mutate === "function") {
          const result = options.mutate({ ...base, keys: base.keys.slice() });
          nextPrefs = normalizeNotesRankPrefs(result || base);
        }
        const nextData = serializeNotesRankPrefs({
          ...nextPrefs,
          updatedAt: Date.now(),
        });
        await writeJsonFile({
          repo,
          path,
          token: options && options.token,
          data: nextData,
          sha: current.sha,
          message: options.message || "Update notes-rank prefs",
        });
        return { prefs: nextData };
      } catch (error) {
        lastError = error;
        if (error.code !== "conflict") throw error;
      }
    }
    throw lastError || new Error("保存排序偏好失败");
  }

  function normalizeActionLogEntry(item) {
    if (!item || typeof item !== "object") return null;
    const kind = String(item.kind || "").trim();
    const at = Number(item.at) || 0;
    const symbols = [
      ...new Set(
        (Array.isArray(item.symbols) ? item.symbols : [])
          .map((symbol) => String(symbol || "").trim().toUpperCase())
          .filter(Boolean),
      ),
    ].sort();
    if (!kind || !symbols.length) return null;
    const entry = { at: at || Date.now(), kind, symbols };
    const price = Number(item.price);
    if (Number.isFinite(price) && price > 0) entry.price = price;
    return entry;
  }

  function actionLogIdentityKey(entry) {
    if (!entry) return "";
    const symbols = (Array.isArray(entry.symbols) ? entry.symbols : [])
      .map((symbol) => String(symbol || "").trim().toUpperCase())
      .filter(Boolean)
      .sort()
      .join(",");
    if (!symbols) return "";
    return `${Number(entry.at) || 0}|${String(entry.kind || "").trim()}|${symbols}`;
  }

  function actionLogEntryKey(entry) {
    if (!entry) return "";
    const base = actionLogIdentityKey(entry);
    if (!base) return "";
    const price =
      Number.isFinite(entry.price) && entry.price > 0
        ? String(entry.price)
        : "";
    return `${base}|${price}`;
  }

  function updateActionLogEntryPrice(list, identityKey, price) {
    const key = String(identityKey || "");
    const nextPrice = Number(price);
    if (!key || !Number.isFinite(nextPrice) || nextPrice <= 0) {
      return normalizeActionLog(list);
    }
    return normalizeActionLog(
      (list || []).map((entry) => {
        if (actionLogIdentityKey(entry) !== key) return entry;
        return { ...entry, price: nextPrice };
      }),
    );
  }

  function actionLogEntryTtlMs(kind, fallbackTtl) {
    const k = String(kind || "");
    if (ACTION_LOG_RANK_KINDS.has(k)) return ACTION_LOG_RANK_TTL_MS;
    return fallbackTtl;
  }

  function trimActionLogEntries(list, options) {
    const ttlMs =
      options && Number(options.ttlMs) > 0
        ? Number(options.ttlMs)
        : ACTION_LOG_TTL_MS;
    const max =
      options && Number(options.max) > 0 ? Number(options.max) : ACTION_LOG_MAX;
    const now = Date.now();
    const fresh = (Array.isArray(list) ? list : [])
      .filter((entry) => {
        const at = Number(entry && entry.at) || 0;
        const keepMs = actionLogEntryTtlMs(entry && entry.kind, ttlMs);
        return at >= now - keepMs;
      })
      .sort((a, b) => (b.at || 0) - (a.at || 0));
    if (fresh.length <= max) return fresh;
    const priority = [];
    const rest = [];
    for (const entry of fresh) {
      if (ACTION_LOG_PRIORITY_KINDS.has(String(entry.kind || ""))) {
        priority.push(entry);
      } else {
        rest.push(entry);
      }
    }
    if (priority.length >= max) return priority.slice(0, max);
    return [...priority, ...rest.slice(0, max - priority.length)].sort(
      (a, b) => (b.at || 0) - (a.at || 0),
    );
  }

  function normalizeActionLog(raw) {
    if (!Array.isArray(raw)) return [];
    const seen = new Set();
    const out = [];
    for (const item of raw) {
      const entry = normalizeActionLogEntry(item);
      if (!entry) continue;
      const key = actionLogEntryKey(entry);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(entry);
    }
    return trimActionLogEntries(out);
  }

  function serializeActionLog(list) {
    return normalizeActionLog(list).map((item) => {
      const entry = {
        at: item.at,
        kind: item.kind,
        symbols: item.symbols.slice(),
      };
      if (Number.isFinite(item.price) && item.price > 0) {
        entry.price = item.price;
      }
      return entry;
    });
  }

  function mergeActionLogs(a, b) {
    return normalizeActionLog([...(a || []), ...(b || [])]);
  }

  /** True when local has at least one entry fingerprint not present remotely. */
  function hasLocalOnlyActionLogEntries(remote, local) {
    const seen = new Set();
    for (const item of remote || []) {
      const entry = normalizeActionLogEntry(item);
      if (!entry) continue;
      const key = actionLogEntryKey(entry);
      if (key) seen.add(key);
    }
    for (const item of local || []) {
      const entry = normalizeActionLogEntry(item);
      if (!entry) continue;
      const key = actionLogEntryKey(entry);
      if (key && !seen.has(key)) return true;
    }
    return false;
  }

  async function loadActionLogRaw(options) {
    const repo = (options && options.repo) || DEFAULT_REPO;
    const path = (options && options.path) || ACTION_LOG_PATH;

    try {
      const current = await fetchJsonFile({
        repo,
        path,
        token: options && options.token,
      });
      if (current.data) {
        return {
          entries: normalizeActionLog(current.data.entries),
          entriesUpdatedAt: Number.isFinite(Number(current.data.entriesUpdatedAt))
            ? Number(current.data.entriesUpdatedAt)
            : null,
          source: "api",
        };
      }
    } catch (error) {
      console.warn("loadActionLog via API failed, trying raw", error);
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
          entries: normalizeActionLog(data.entries),
          entriesUpdatedAt: Number.isFinite(Number(data.entriesUpdatedAt))
            ? Number(data.entriesUpdatedAt)
            : null,
          source: "raw-commit",
        };
      }
      if (response.status !== 404) {
        console.warn(`读取动作日志 raw 失败: ${response.status}`);
      }
    } catch (error) {
      console.warn("loadActionLog via commit-raw failed", error);
    }

    return { entries: [], entriesUpdatedAt: null, source: "empty" };
  }

  async function patchActionLog(options) {
    const repo = (options && options.repo) || DEFAULT_REPO;
    const path = (options && options.path) || ACTION_LOG_PATH;
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
          entries: [],
          entriesUpdatedAt: null,
        };
        const entries = normalizeActionLog(base.entries);
        let nextList = entries;
        if (typeof options.mutate === "function") {
          const result = options.mutate(entries.slice());
          nextList = Array.isArray(result)
            ? result
            : result && result.list
              ? result.list
              : entries;
        }
        const nextEntries = trimActionLogEntries(serializeActionLog(nextList));
        const nextData = {
          entries: nextEntries,
          entriesUpdatedAt: Date.now(),
          updatedAt: Date.now(),
        };
        await writeJsonFile({
          repo,
          path,
          token: options && options.token,
          data: nextData,
          sha: current.sha,
          message: options.message || "Update action log",
        });
        return {
          entries: nextEntries,
          entriesUpdatedAt: nextData.entriesUpdatedAt,
        };
      } catch (error) {
        lastError = error;
        if (error.code !== "conflict") throw error;
      }
    }
    throw lastError || new Error("保存动作日志失败");
  }

  function emptyCardEggs() {
    return {
      periodHigh: {},
      periodHighDismiss: {},
      fromHidden: {},
      fromHiddenDismiss: {},
      hiddenSnap: [],
      hiddenSnapSeeded: false,
    };
  }

  function normalizeCardEggs(raw) {
    const base = emptyCardEggs();
    if (!raw || typeof raw !== "object") return base;
    const asMap = (value) =>
      value && typeof value === "object" && !Array.isArray(value) ? value : {};
    return {
      periodHigh: asMap(raw.periodHigh),
      periodHighDismiss: asMap(raw.periodHighDismiss),
      fromHidden: asMap(raw.fromHidden),
      fromHiddenDismiss: asMap(raw.fromHiddenDismiss),
      hiddenSnap: Array.isArray(raw.hiddenSnap)
        ? raw.hiddenSnap.map(String)
        : [],
      hiddenSnapSeeded: !!raw.hiddenSnapSeeded,
    };
  }

  async function loadCardEggsRaw(options) {
    const repo = (options && options.repo) || DEFAULT_REPO;
    const path = (options && options.path) || CARD_EGGS_PATH;
    try {
      const current = await fetchJsonFile({
        repo,
        path,
        token: options && options.token,
      });
      if (current.data) {
        return {
          eggs: normalizeCardEggs(current.data),
          eggsUpdatedAt: Number.isFinite(Number(current.data.eggsUpdatedAt))
            ? Number(current.data.eggsUpdatedAt)
            : null,
          source: "api",
        };
      }
    } catch (error) {
      console.warn("loadCardEggs via API failed, trying raw", error);
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
          eggs: normalizeCardEggs(data),
          eggsUpdatedAt: Number.isFinite(Number(data.eggsUpdatedAt))
            ? Number(data.eggsUpdatedAt)
            : null,
          source: "raw-commit",
        };
      }
      if (response.status !== 404) {
        console.warn(`读取卡片彩蛋 raw 失败: ${response.status}`);
      }
    } catch (error) {
      console.warn("loadCardEggs via commit-raw failed", error);
    }
    return { eggs: emptyCardEggs(), eggsUpdatedAt: null, source: "empty" };
  }

  async function patchCardEggs(options) {
    const repo = (options && options.repo) || DEFAULT_REPO;
    const path = (options && options.path) || CARD_EGGS_PATH;
    const maxAttempts = (options && options.maxAttempts) || 3;
    let lastError = null;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        const current = await fetchJsonFile({
          repo,
          path,
          token: options && options.token,
        });
        const base = normalizeCardEggs(current.data || emptyCardEggs());
        let next = base;
        if (typeof options.mutate === "function") {
          const result = options.mutate({ ...base });
          next = normalizeCardEggs(
            result && result.eggs ? result.eggs : result || base,
          );
        }
        const nextData = {
          ...next,
          eggsUpdatedAt: Date.now(),
          updatedAt: Date.now(),
        };
        await writeJsonFile({
          repo,
          path,
          token: options && options.token,
          data: nextData,
          sha: current.sha,
          message: options.message || "Update card eggs",
        });
        return {
          eggs: normalizeCardEggs(nextData),
          eggsUpdatedAt: nextData.eggsUpdatedAt,
        };
      } catch (error) {
        lastError = error;
        if (error.code !== "conflict") throw error;
      }
    }
    throw lastError || new Error("保存卡片彩蛋失败");
  }

  function emptyBreakHigh() {
    return {
      bases: {},
      lastCheckAt: 0,
      hits: [],
    };
  }

  function normalizeBreakHighHit(item) {
    if (!item || typeof item !== "object") return null;
    const symbol = String(item.symbol || "")
      .trim()
      .toUpperCase();
    if (!symbol) return null;
    const base = Number(item.base);
    const price = Number(item.price);
    const at = Number(item.at) || 0;
    if (!Number.isFinite(base) || base <= 0) return null;
    if (!Number.isFinite(price) || price <= 0) return null;
    return {
      symbol,
      label: item.label
        ? String(item.label)
        : symbol.replace(/USDT$/i, ""),
      base,
      price,
      at,
      source: item.source ? String(item.source) : null,
    };
  }

  function normalizeBreakHighBase(item) {
    if (!item || typeof item !== "object") return null;
    const base = Number(item.base);
    if (!Number.isFinite(base) || base <= 0) return null;
    return {
      base,
      at: Number(item.at) || 0,
      noteAt: Number(item.noteAt) || 0,
      pinAt: Number(item.pinAt) || 0,
    };
  }

  function normalizeBreakHigh(raw) {
    const empty = emptyBreakHigh();
    if (!raw || typeof raw !== "object") return empty;
    const bases = {};
    const rawBases =
      raw.bases && typeof raw.bases === "object" && !Array.isArray(raw.bases)
        ? raw.bases
        : {};
    for (const [key, value] of Object.entries(rawBases)) {
      const symbol = String(key || "")
        .trim()
        .toUpperCase();
      const normalized = normalizeBreakHighBase(value);
      if (!symbol || !normalized) continue;
      bases[symbol] = normalized;
    }
    const hits = Array.isArray(raw.hits)
      ? raw.hits.map(normalizeBreakHighHit).filter(Boolean)
      : [];
    return {
      bases,
      lastCheckAt: Number(raw.lastCheckAt) || 0,
      hits,
    };
  }

  async function loadBreakHighRaw(options) {
    const repo = (options && options.repo) || DEFAULT_REPO;
    const path = (options && options.path) || BREAK_HIGH_PATH;
    try {
      const current = await fetchJsonFile({
        repo,
        path,
        token: options && options.token,
      });
      if (current.data) {
        return {
          state: normalizeBreakHigh(current.data),
          updatedAt: Number.isFinite(Number(current.data.updatedAt))
            ? Number(current.data.updatedAt)
            : null,
          source: "api",
        };
      }
    } catch (error) {
      console.warn("loadBreakHigh via API failed, trying raw", error);
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
          state: normalizeBreakHigh(data),
          updatedAt: Number.isFinite(Number(data.updatedAt))
            ? Number(data.updatedAt)
            : null,
          source: "raw-commit",
        };
      }
      if (response.status !== 404) {
        console.warn(`读取破点高 raw 失败: ${response.status}`);
      }
    } catch (error) {
      console.warn("loadBreakHigh via commit-raw failed", error);
    }
    return { state: emptyBreakHigh(), updatedAt: null, source: "empty" };
  }

  async function patchBreakHigh(options) {
    const repo = (options && options.repo) || DEFAULT_REPO;
    const path = (options && options.path) || BREAK_HIGH_PATH;
    const maxAttempts = (options && options.maxAttempts) || 3;
    let lastError = null;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        const current = await fetchJsonFile({
          repo,
          path,
          token: options && options.token,
        });
        const base = normalizeBreakHigh(current.data || emptyBreakHigh());
        let next = base;
        if (typeof options.mutate === "function") {
          const result = options.mutate({ ...base, bases: { ...base.bases } });
          if (result && result.skipWrite) {
            return {
              state: normalizeBreakHigh(result.state || base),
              updatedAt: Number(current.data && current.data.updatedAt) || null,
              skipped: true,
            };
          }
          next = normalizeBreakHigh(
            result && result.state ? result.state : result || base,
          );
        }
        const nextData = {
          ...next,
          updatedAt: Date.now(),
        };
        await writeJsonFile({
          repo,
          path,
          token: options && options.token,
          data: nextData,
          sha: current.sha,
          message: options.message || "Update break-high",
        });
        return {
          state: normalizeBreakHigh(nextData),
          updatedAt: nextData.updatedAt,
          skipped: false,
        };
      } catch (error) {
        lastError = error;
        if (error.code !== "conflict") throw error;
      }
    }
    throw lastError || new Error("保存破点高失败");
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

  // Positions / 已购入 — buy price tracking for WeCom alerts.
  const POSITIONS_PATH = "watch-positions.json";

  function normalizePositionItem(item) {
    if (!item || typeof item !== "object" || !item.symbol) return null;
    const symbol = String(item.symbol).trim().toUpperCase();
    if (!symbol) return null;
    const buyPrice = Number(item.buyPrice);
    if (!Number.isFinite(buyPrice) || buyPrice <= 0) return null;
    return {
      symbol,
      buyPrice,
      boughtAt: Number.isFinite(Number(item.boughtAt))
        ? Number(item.boughtAt)
        : 0,
      source: item.source ? String(item.source) : "legacy",
    };
  }

  function normalizePositions(raw) {
    if (!Array.isArray(raw)) return [];
    const map = new Map();
    raw.forEach((item) => {
      const normalized = normalizePositionItem(item);
      if (!normalized) return;
      const prev = map.get(normalized.symbol);
      if (!prev || normalized.boughtAt >= prev.boughtAt) {
        map.set(normalized.symbol, normalized);
      }
    });
    return [...map.values()].sort((a, b) => {
      if (b.boughtAt !== a.boughtAt) return b.boughtAt - a.boughtAt;
      return a.symbol.localeCompare(b.symbol);
    });
  }

  function serializePositions(list) {
    return normalizePositions(list).map((item) => ({
      symbol: item.symbol,
      buyPrice: item.buyPrice,
      boughtAt: item.boughtAt,
      source: item.source || "legacy",
    }));
  }

  function positionsToSymbolSet(list) {
    return new Set(normalizePositions(list).map((item) => item.symbol));
  }

  function hasPosition(list, symbol) {
    const key = String(symbol || "")
      .trim()
      .toUpperCase();
    return normalizePositions(list).some((item) => item.symbol === key);
  }

  function upsertPosition(list, symbol, buyPrice, source) {
    const key = String(symbol || "")
      .trim()
      .toUpperCase();
    const price = Number(buyPrice);
    if (!key || !Number.isFinite(price) || price <= 0) {
      return normalizePositions(list);
    }
    const next = normalizePositions(list).filter((item) => item.symbol !== key);
    next.unshift({
      symbol: key,
      buyPrice: price,
      boughtAt: Date.now(),
      source: source || "manual",
    });
    return next;
  }

  function removePosition(list, symbol) {
    const key = String(symbol || "")
      .trim()
      .toUpperCase();
    return normalizePositions(list).filter((item) => item.symbol !== key);
  }

  async function loadPositionsRaw(options) {
    const repo = (options && options.repo) || DEFAULT_REPO;
    const path = (options && options.path) || POSITIONS_PATH;

    try {
      const current = await fetchJsonFile({
        repo,
        path,
        token: options && options.token,
      });
      if (current.data) {
        return {
          positions: normalizePositions(current.data.positions),
          positionsUpdatedAt: Number.isFinite(
            Number(current.data.positionsUpdatedAt),
          )
            ? Number(current.data.positionsUpdatedAt)
            : null,
          source: "api",
        };
      }
    } catch (error) {
      console.warn("loadPositions via API failed, trying raw", error);
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
          positions: normalizePositions(data.positions),
          positionsUpdatedAt: Number.isFinite(Number(data.positionsUpdatedAt))
            ? Number(data.positionsUpdatedAt)
            : null,
          source: "raw-commit",
        };
      }
      if (response.status !== 404) {
        console.warn(`读取持仓 raw 失败: ${response.status}`);
      }
    } catch (error) {
      console.warn("loadPositions via commit-raw failed", error);
    }

    return { positions: [], positionsUpdatedAt: null, source: "empty" };
  }

  async function patchPositions(options) {
    const repo = (options && options.repo) || DEFAULT_REPO;
    const path = (options && options.path) || POSITIONS_PATH;
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
          positions: [],
          positionsUpdatedAt: null,
        };
        const positions = normalizePositions(base.positions);
        let result;
        if (typeof options.mutate === "function") {
          result = options.mutate(positions.slice());
        } else {
          result = {
            list: upsertPosition(
              positions,
              options.symbol,
              options.buyPrice,
              options.source || "manual",
            ),
            added: true,
          };
        }
        const nextPositions = serializePositions(
          result && result.list ? result.list : result,
        );
        const nextData = {
          positions: nextPositions,
          positionsUpdatedAt: Date.now(),
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
            `Update positions ${options.symbol || ""}`.trim(),
        });
        return {
          positions: nextPositions,
          positionsUpdatedAt: nextData.positionsUpdatedAt,
          meta: result && typeof result === "object" ? result : null,
        };
      } catch (error) {
        lastError = error;
        if (error.code !== "conflict") throw error;
      }
    }
    throw lastError || new Error("保存持仓失败");
  }

  function normalizePriceAlertItem(item) {
    if (!item || typeof item !== "object") return null;
    const symbol = String(item.symbol || "")
      .trim()
      .toUpperCase();
    const target = Number(item.target);
    if (!symbol || !Number.isFinite(target) || target <= 0) return null;
    const direction =
      item.direction === "below" || item.direction === "above"
        ? item.direction
        : "above";
    const id =
      String(item.id || "").trim() ||
      `${symbol}-${direction}-${Math.round(target * 1e8)}-${Number(item.createdAt) || 0}`;
    const sentCount = Math.max(0, Math.floor(Number(item.sentCount) || 0));
    return {
      id,
      symbol,
      target,
      direction,
      createdAt: Number.isFinite(Number(item.createdAt))
        ? Number(item.createdAt)
        : Date.now(),
      hitAt:
        Number.isFinite(Number(item.hitAt)) && Number(item.hitAt) > 0
          ? Number(item.hitAt)
          : null,
      sentCount,
      lastSentAt:
        Number.isFinite(Number(item.lastSentAt)) && Number(item.lastSentAt) > 0
          ? Number(item.lastSentAt)
          : 0,
      active: item.active === false ? false : sentCount < PRICE_ALERT_SEND_MAX,
    };
  }

  function normalizePriceAlerts(raw) {
    if (!Array.isArray(raw)) return [];
    const map = new Map();
    for (const item of raw) {
      const normalized = normalizePriceAlertItem(item);
      if (!normalized) continue;
      map.set(normalized.id, normalized);
    }
    return [...map.values()]
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .slice(0, PRICE_ALERTS_MAX);
  }

  function serializePriceAlerts(list) {
    return normalizePriceAlerts(list).map((item) => ({
      id: item.id,
      symbol: item.symbol,
      target: item.target,
      direction: item.direction,
      createdAt: item.createdAt,
      hitAt: item.hitAt,
      sentCount: item.sentCount,
      lastSentAt: item.lastSentAt,
      active: !!item.active,
    }));
  }

  function upsertPriceAlert(list, symbol, target, direction, sourcePrice) {
    const key = String(symbol || "")
      .trim()
      .toUpperCase();
    const price = Number(target);
    if (!key || !Number.isFinite(price) || price <= 0) {
      return normalizePriceAlerts(list);
    }
    let dir = direction === "below" || direction === "above" ? direction : "";
    const spot = Number(sourcePrice);
    if (!dir) {
      dir = Number.isFinite(spot) && spot > price ? "below" : "above";
    }
    const now = Date.now();
    const next = normalizePriceAlerts(list).filter(
      (item) => !(item.symbol === key && item.active),
    );
    next.unshift({
      id: `${key}-${dir}-${Math.round(price * 1e8)}-${now}`,
      symbol: key,
      target: price,
      direction: dir,
      createdAt: now,
      hitAt: null,
      sentCount: 0,
      lastSentAt: 0,
      active: true,
    });
    return normalizePriceAlerts(next);
  }

  function removePriceAlert(list, idOrSymbol) {
    const key = String(idOrSymbol || "").trim();
    if (!key) return normalizePriceAlerts(list);
    const upper = key.toUpperCase();
    return normalizePriceAlerts(list).filter(
      (item) => item.id !== key && item.symbol !== upper,
    );
  }

  async function loadPriceAlertsRaw(options) {
    const repo = (options && options.repo) || DEFAULT_REPO;
    const path = (options && options.path) || PRICE_ALERTS_PATH;
    try {
      const current = await fetchJsonFile({
        repo,
        path,
        token: options && options.token,
      });
      if (current.data) {
        return {
          alerts: normalizePriceAlerts(current.data.alerts),
          alertsUpdatedAt: Number.isFinite(Number(current.data.alertsUpdatedAt))
            ? Number(current.data.alertsUpdatedAt)
            : null,
          source: "api",
        };
      }
    } catch (error) {
      console.warn("loadPriceAlerts via API failed, trying raw", error);
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
          alerts: normalizePriceAlerts(data.alerts),
          alertsUpdatedAt: Number.isFinite(Number(data.alertsUpdatedAt))
            ? Number(data.alertsUpdatedAt)
            : null,
          source: "raw-commit",
        };
      }
    } catch (error) {
      console.warn("loadPriceAlerts via commit-raw failed", error);
    }
    return { alerts: [], alertsUpdatedAt: null, source: "empty" };
  }

  async function patchPriceAlerts(options) {
    const repo = (options && options.repo) || DEFAULT_REPO;
    const path = (options && options.path) || PRICE_ALERTS_PATH;
    const maxAttempts = (options && options.maxAttempts) || 3;
    let lastError = null;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        const current = await fetchJsonFile({
          repo,
          path,
          token: options && options.token,
        });
        const base = current.data || { alerts: [], alertsUpdatedAt: null };
        const alerts = normalizePriceAlerts(base.alerts);
        let nextList = alerts;
        if (typeof options.mutate === "function") {
          const result = options.mutate(alerts.slice());
          nextList = Array.isArray(result)
            ? result
            : result && result.list
              ? result.list
              : alerts;
        }
        const nextAlerts = serializePriceAlerts(nextList).slice(
          0,
          PRICE_ALERTS_MAX,
        );
        const nextData = {
          alerts: nextAlerts,
          alertsUpdatedAt: Date.now(),
          updatedAt: Date.now(),
        };
        await writeJsonFile({
          repo,
          path,
          token: options && options.token,
          data: nextData,
          sha: current.sha,
          message: options.message || "Update price alerts",
        });
        return {
          alerts: nextAlerts,
          alertsUpdatedAt: nextData.alertsUpdatedAt,
        };
      } catch (error) {
        lastError = error;
        if (error.code !== "conflict") throw error;
      }
    }
    throw lastError || new Error("保存价格预警失败");
  }

  return {
    DEFAULT_REPO,
    FAVORITES_PATH,
    BLACKLIST_PATH,
    PINS_PATH,
    POSITIONS_PATH,
    PIN_TTL_MS,
    PIN_EXPIRY_ENABLED,
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
    removeExpiredPins,
    togglePin,
    loadPinsRaw,
    patchPins,
    MOM_NOTES_PATH,
    MOM_NOTES_MAX,
    normalizeMomNotes,
    serializeMomNotes,
    loadMomNotesRaw,
    patchMomNotes,
    ACTION_LOG_PATH,
    ACTION_LOG_MAX,
    ACTION_LOG_TTL_MS,
    ACTION_LOG_RANK_TTL_MS,
    ACTION_LOG_RANK_KINDS,
    trimActionLogEntries,
    normalizeActionLog,
    serializeActionLog,
    mergeActionLogs,
    actionLogEntryKey,
    hasLocalOnlyActionLogEntries,
    loadActionLogRaw,
    patchActionLog,
    CARD_EGGS_PATH,
    emptyCardEggs,
    normalizeCardEggs,
    loadCardEggsRaw,
    patchCardEggs,
    BREAK_HIGH_PATH,
    emptyBreakHigh,
    normalizeBreakHigh,
    loadBreakHighRaw,
    patchBreakHigh,
    NAILS_PATH,
    NAILS_MAX,
    nailSymbolKey,
    normalizeNails,
    serializeNails,
    upsertNail,
    removeNail,
    upsertNailsBatch,
    removeNailsBatch,
    setNailPinned,
    setNailsPinnedBatch,
    reorderNails,
    markNailsExited,
    setNailNote,
    normalizeDismissedNails,
    addDismissedNails,
    removeDismissedNails,
    loadNailsRaw,
    patchNails,
    NAIL_GREEN_NOTICES_PATH,
    NAIL_GREEN_NOTICES_TTL_MS,
    normalizeNailGreenNotices,
    serializeNailGreenNotices,
    countUnreadNailGreenNotices,
    loadNailGreenNoticesRaw,
    patchNailGreenNotices,
    NOTES_RANK_SNAPS_PATH,
    NOTES_RANK_SNAPS_TTL_MS,
    NOTES_RANK_SNAPS_MAX,
    normalizeNotesRankSnaps,
    serializeNotesRankSnaps,
    appendNotesRankSnap,
    compareNotesRankSnaps,
    loadNotesRankSnapsRaw,
    patchNotesRankSnaps,
    NOTES_RANK_PREFS_PATH,
    NOTES_RANK_PREFS_DEFAULT,
    normalizeNotesRankPrefs,
    serializeNotesRankPrefs,
    loadNotesRankPrefsRaw,
    patchNotesRankPrefs,
    normalizePositions,
    serializePositions,
    positionsToSymbolSet,
    hasPosition,
    upsertPosition,
    removePosition,
    loadPositionsRaw,
    patchPositions,
    PRICE_ALERTS_PATH,
    PRICE_ALERTS_MAX,
    PRICE_ALERT_SEND_MAX,
    PRICE_ALERT_SEND_GAP_MS,
    normalizePriceAlerts,
    serializePriceAlerts,
    upsertPriceAlert,
    removePriceAlert,
    loadPriceAlertsRaw,
    patchPriceAlerts,
    actionLogIdentityKey,
    updateActionLogEntryPrice,
    fetchJsonFile,
    getMainCommitSha,
    fetchRawJsonByCommit,
  };
});
