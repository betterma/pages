/* futures GitHub JSON 存取 — 业务数据仍只写 futures/；Token 与现货共用 GithubTokenVault */
(function (global) {
  "use strict";

  const DEFAULT_REPO = "betterma/pages";

  function cfg() {
    return global.FutConfig || {};
  }

  function repo() {
    return String(cfg().GITHUB_REPO || DEFAULT_REPO).trim() || DEFAULT_REPO;
  }

  function vault() {
    return global.GithubTokenVault || null;
  }

  /** 已解锁则直接取；未解锁不弹窗（给相对路径读失败后的可选 API 读用） */
  function peekToken() {
    const fromCfg = String(cfg().GITHUB_TOKEN || "").trim();
    if (fromCfg) return fromCfg;
    const v = vault();
    if (v && typeof v.isUnlocked === "function" && v.isUnlocked()) {
      try {
        return v.getToken();
      } catch (_) {
        return "";
      }
    }
    return "";
  }

  /**
   * 与现货次要页同一入口：ensureUnlocked
   * （本机若曾在现货记住密码，会静默解锁；否则只 prompt 密码）
   */
  async function ensureToken() {
    const fromCfg = String(cfg().GITHUB_TOKEN || "").trim();
    if (fromCfg) return fromCfg;
    const v = vault();
    if (!v || typeof v.ensureUnlocked !== "function") {
      throw new Error(
        "GithubTokenVault 未加载：请确认已引入 ../github-token-vault.js",
      );
    }
    return v.ensureUnlocked();
  }

  /** 页面启动时尽量静默解锁（有记住的密码则无需再输入） */
  async function tryWarmUnlock() {
    const v = vault();
    if (!v) return false;
    if (typeof v.isUnlocked === "function" && v.isUnlocked()) return true;
    if (typeof v.tryAutoUnlock === "function") {
      try {
        return !!(await v.tryAutoUnlock());
      } catch (_) {
        return false;
      }
    }
    return false;
  }

  function encodeBase64Utf8(text) {
    const bytes = new TextEncoder().encode(String(text || ""));
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  function decodeBase64Utf8(content) {
    const binary = atob(String(content || "").replace(/\n/g, ""));
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    return new TextDecoder("utf-8").decode(bytes);
  }

  async function fetchJsonFile(path) {
    let token = peekToken();
    if (!token) {
      try {
        token = await ensureToken();
      } catch (_) {
        token = "";
      }
    }
    const headers = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    const url = `https://api.github.com/repos/${repo()}/contents/${path}?t=${Date.now()}`;
    const response = await fetch(url, { headers, cache: "no-store" });
    if (response.status === 404) return { data: null, sha: null };
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`GET ${path} ${response.status} ${text.slice(0, 180)}`);
    }
    const file = await response.json();
    const raw = decodeBase64Utf8(file.content || "");
    return {
      data: raw.trim() ? JSON.parse(raw) : null,
      sha: file.sha,
    };
  }

  /** 公开页优先相对路径读；失败再走 API */
  async function loadLocalOrApi(path, relativeUrl) {
    try {
      const response = await fetch(`${relativeUrl}?t=${Date.now()}`, {
        cache: "no-store",
      });
      if (response.ok) {
        return { data: await response.json(), sha: null, source: "relative" };
      }
    } catch (_) {
      /* fall through */
    }
    const file = await fetchJsonFile(path);
    return { ...file, source: "api" };
  }

  async function writeJsonFile(path, data, sha, message) {
    const token = await ensureToken();
    const payload = {
      message: message || `Update ${path}`,
      content: encodeBase64Utf8(JSON.stringify(data, null, 2)),
    };
    if (sha) payload.sha = sha;
    const response = await fetch(
      `https://api.github.com/repos/${repo()}/contents/${path}`,
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
      const err = new Error("GitHub conflict");
      err.code = "conflict";
      throw err;
    }
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`PUT ${path} ${response.status} ${text.slice(0, 200)}`);
    }
    return response.json();
  }

  async function patchJson(path, mutate, message) {
    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const current = await fetchJsonFile(path);
        const base =
          current.data && typeof current.data === "object"
            ? current.data
            : {};
        const next = mutate({ ...base });
        if (next && next.skipWrite) {
          return { data: next.data || base, skipped: true };
        }
        const data = next && next.data != null ? next.data : next;
        await writeJsonFile(path, data, current.sha, message);
        return { data, skipped: false };
      } catch (error) {
        lastError = error;
        if (!error || error.code !== "conflict") throw error;
      }
    }
    throw lastError || new Error(`patch ${path} failed`);
  }

  global.FutStore = {
    repo,
    ensureToken,
    tryWarmUnlock,
    peekToken,
    loadLocalOrApi,
    fetchJsonFile,
    patchJson,
  };
})(typeof window !== "undefined" ? window : globalThis);
