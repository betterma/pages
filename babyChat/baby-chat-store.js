(function (global) {
  "use strict";

  const DEFAULT_REPO = "betterma/pages";
  const DATA_PATH = "babyChat/baby-chat-data.json";

  function getGithubToken() {
    const vault =
      (typeof globalThis !== "undefined" && globalThis.GithubTokenVault) ||
      (typeof window !== "undefined" && window.GithubTokenVault) ||
      null;
    if (!vault || typeof vault.getToken !== "function") {
      throw new Error(
        "GithubTokenVault 未加载：请先引入 github-token-vault.js 并解锁",
      );
    }
    return vault.getToken();
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

  function emptyData() {
    return {
      config: { name: "葫芦宝", birthDate: "2026-06-26" },
      queue: [],
      entries: [],
      summaries: {},
      state: { lastRunAt: null, lastSummaryDate: null },
      updatedAt: null,
    };
  }

  function normalizeData(raw) {
    const base = emptyData();
    if (!raw || typeof raw !== "object") return base;
    const cfg = raw.config && typeof raw.config === "object" ? raw.config : {};
    base.config = {
      name: cfg.name ? String(cfg.name) : base.config.name,
      birthDate: cfg.birthDate
        ? String(cfg.birthDate)
        : base.config.birthDate,
    };
    base.queue = Array.isArray(raw.queue) ? raw.queue : [];
    base.entries = Array.isArray(raw.entries) ? raw.entries : [];
    base.summaries =
      raw.summaries && typeof raw.summaries === "object" ? raw.summaries : {};
    const st = raw.state && typeof raw.state === "object" ? raw.state : {};
    base.state = {
      lastRunAt: st.lastRunAt || null,
      lastSummaryDate: st.lastSummaryDate || null,
    };
    base.updatedAt = raw.updatedAt || null;
    return base;
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
    return {
      data: raw.trim() ? JSON.parse(raw) : null,
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

  async function loadRaw(options) {
    const opts = options || {};
    const path = opts.path || DATA_PATH;
    try {
      const current = await fetchJsonFile({
        repo: opts.repo,
        path,
        token: opts.token,
      });
      if (current.data) {
        return {
          data: normalizeData(current.data),
          sha: current.sha,
          source: "api",
        };
      }
    } catch (error) {
      console.warn("baby-chat load api failed", error);
    }

    try {
      const local = await fetch(`./baby-chat-data.json?t=${Date.now()}`, {
        cache: "no-store",
      });
      if (local.ok) {
        return {
          data: normalizeData(await local.json()),
          sha: null,
          source: "local",
        };
      }
    } catch (error) {
      console.warn("baby-chat load local failed", error);
    }

    return { data: emptyData(), sha: null, source: "empty" };
  }

  async function patch(mutator, message) {
    let lastError = null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const loaded = await loadRaw();
      if (!loaded.sha && loaded.source !== "api") {
        // create file on remote
        const data = normalizeData(loaded.data);
        const next = await mutator(data);
        if (!next) return { data, sha: null };
        next.updatedAt = Date.now();
        try {
          const saved = await writeJsonFile({
            path: DATA_PATH,
            data: next,
            sha: null,
            message: message || "baby-chat: create",
          });
          return {
            data: next,
            sha: saved && saved.content && saved.content.sha,
          };
        } catch (error) {
          lastError = error;
          if (error && error.code === "conflict") continue;
          throw error;
        }
      }

      const data = normalizeData(loaded.data);
      const next = await mutator(data);
      if (!next) return { data, sha: loaded.sha };
      next.updatedAt = Date.now();
      try {
        const saved = await writeJsonFile({
          path: DATA_PATH,
          data: next,
          sha: loaded.sha,
          message: message || "baby-chat: update",
        });
        return {
          data: next,
          sha: saved && saved.content && saved.content.sha,
        };
      } catch (error) {
        lastError = error;
        if (error && error.code === "conflict") continue;
        throw error;
      }
    }
    throw lastError || new Error("baby-chat patch failed");
  }

  function shanghaiDate(ms) {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(ms || Date.now()));
  }

  function ageDaysOn(birthDate, onDate) {
    const parse = (value) => {
      const m = String(value || "")
        .trim()
        .match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (!m) return null;
      return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    };
    const a = parse(birthDate);
    const b = parse(onDate || shanghaiDate());
    if (a == null || b == null) return null;
    return Math.floor((b - a) / 86400000);
  }

  function ageLabel(days) {
    if (days == null) return "月龄未知";
    if (days < 0) return "未出生";
    if (days === 0) return "出生当天";
    const months = Math.floor(days / 30);
    const rem = days % 30;
    if (months <= 0) return `${days}天`;
    if (rem === 0) return `${months}月整`;
    return `${months}月${rem}天`;
  }

  function newId(prefix) {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function feedStats(events) {
    let mlTotal = 0;
    let feedCount = 0;
    (events || []).forEach((ev) => {
      if (!ev || ev.type !== "feed") return;
      feedCount += 1;
      const ml = Number(ev.ml);
      if (Number.isFinite(ml) && ml > 0) mlTotal += Math.round(ml);
    });
    return { mlTotal, feedCount };
  }

  global.BabyChatStore = {
    DATA_PATH,
    emptyData,
    normalizeData,
    loadRaw,
    patch,
    shanghaiDate,
    ageDaysOn,
    ageLabel,
    newId,
    feedStats,
  };
})(typeof window !== "undefined" ? window : globalThis);
