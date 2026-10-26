/**
 * 浏览器侧 GitHub PAT 保险库：
 * - 日常打开站点：只输入密码（可记住）
 * - Token 明文不进仓库；密文写在下方 EMBEDDED_BLOB（用 vault-seal.html 生成一次）
 * - 云函数 GITHUB_TOKEN 不走这里
 */
(function (global) {
  "use strict";

  const PASS_KEY = "pages-gh-vault-pass-v1";
  const BLOB_KEY = "pages-gh-vault-blob-v1";
  const ITERATIONS = 310000;

  /**
   * 用 vault-seal.html 生成后整段粘贴到这里（保持 null 表示尚未封存）。
   * 例：{ "v":1, "alg":"AES-GCM", ... }
   */
  const EMBEDDED_BLOB = {
    "v": 1,
    "alg": "AES-GCM",
    "kdf": "PBKDF2-SHA256",
    "iter": 310000,
    "salt": "KoNVnRK8m38MDiGSu32R0Q==",
    "iv": "uHeVIaeIX2gA96d9",
    "ct": "FEpsYlZEg69dIaGi9pNae7q31ZaIdJF3XNBAp3OoDQV2HTXLmQPxcaSWdiIr221Et0lieuo+xKI="
  };
  let memoryToken = "";

  function bufToB64(buf) {
    const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf;
    let binary = "";
    for (let i = 0; i < bytes.length; i += 1) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  function b64ToBuf(b64) {
    const binary = atob(String(b64 || ""));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  async function deriveKey(password, saltBuf) {
    const baseKey = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(String(password || "")),
      "PBKDF2",
      false,
      ["deriveKey"],
    );
    return crypto.subtle.deriveKey(
      {
        name: "PBKDF2",
        salt: saltBuf,
        iterations: ITERATIONS,
        hash: "SHA-256",
      },
      baseKey,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
  }

  async function encryptToken(token, password) {
    const plain = String(token || "").trim();
    const pass = String(password || "");
    if (!plain) throw new Error("Token 为空");
    if (pass.length < 6) throw new Error("密码至少 6 位");
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(pass, salt);
    const ct = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      new TextEncoder().encode(plain),
    );
    return {
      v: 1,
      alg: "AES-GCM",
      kdf: "PBKDF2-SHA256",
      iter: ITERATIONS,
      salt: bufToB64(salt),
      iv: bufToB64(iv),
      ct: bufToB64(ct),
    };
  }

  async function decryptBlob(blob, password) {
    if (!blob || blob.v !== 1 || !blob.salt || !blob.iv || !blob.ct) {
      throw new Error("密文格式无效");
    }
    const iter = Number(blob.iter) || ITERATIONS;
    const salt = b64ToBuf(blob.salt);
    const iv = b64ToBuf(blob.iv);
    const ct = b64ToBuf(blob.ct);
    const baseKey = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(String(password || "")),
      "PBKDF2",
      false,
      ["deriveKey"],
    );
    const key = await crypto.subtle.deriveKey(
      {
        name: "PBKDF2",
        salt,
        iterations: iter,
        hash: "SHA-256",
      },
      baseKey,
      { name: "AES-GCM", length: 256 },
      false,
      ["decrypt"],
    );
    try {
      const raw = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv },
        key,
        ct,
      );
      const text = new TextDecoder().decode(raw).trim();
      if (!text) throw new Error("解密结果为空");
      return text;
    } catch (error) {
      throw new Error("密码错误或密文损坏");
    }
  }

  function readBlob() {
    try {
      const raw = localStorage.getItem(BLOB_KEY);
      if (raw) {
        const local = JSON.parse(raw);
        if (local && local.v === 1) return local;
      }
    } catch (error) {
      /* ignore */
    }
    if (EMBEDDED_BLOB && typeof EMBEDDED_BLOB === "object" && EMBEDDED_BLOB.v === 1) {
      return EMBEDDED_BLOB;
    }
    return null;
  }

  function writeBlob(blob) {
    localStorage.setItem(BLOB_KEY, JSON.stringify(blob));
  }

  function blobSource() {
    try {
      const raw = localStorage.getItem(BLOB_KEY);
      if (raw) {
        const local = JSON.parse(raw);
        if (local && local.v === 1) return "local";
      }
    } catch (error) {
      /* ignore */
    }
    if (EMBEDDED_BLOB && EMBEDDED_BLOB.v === 1) return "embedded";
    return "none";
  }

  function readPass() {
    try {
      return localStorage.getItem(PASS_KEY) || "";
    } catch (error) {
      return "";
    }
  }

  function writePass(password) {
    try {
      localStorage.setItem(PASS_KEY, String(password || ""));
    } catch (error) {
      /* ignore quota */
    }
  }

  function clearPass() {
    try {
      localStorage.removeItem(PASS_KEY);
    } catch (error) {
      /* ignore */
    }
  }

  function getToken() {
    if (!memoryToken) {
      throw new Error("GitHub vault locked — 请先输入解密密码");
    }
    return memoryToken;
  }

  function isUnlocked() {
    return !!memoryToken;
  }

  function hasBlob() {
    return !!readBlob();
  }

  function hasSavedPass() {
    return !!readPass();
  }

  async function unlock(password, options) {
    const remember = !options || options.remember !== false;
    const blob = readBlob();
    if (!blob) {
      throw new Error("尚未封存 Token：请打开 vault-seal.html 生成密文并写入代码");
    }
    memoryToken = await decryptBlob(blob, password);
    if (remember) writePass(password);
    else clearPass();
    return memoryToken;
  }

  async function setup(token, password, options) {
    const remember = !options || options.remember !== false;
    const blob = await encryptToken(token, password);
    writeBlob(blob);
    memoryToken = String(token || "").trim();
    if (remember) writePass(password);
    else clearPass();
    return true;
  }

  async function tryAutoUnlock() {
    if (memoryToken) return true;
    if (!hasBlob()) return false;
    const pass = readPass();
    if (!pass) return false;
    try {
      await unlock(pass, { remember: true });
      return true;
    } catch (error) {
      clearPass();
      return false;
    }
  }

  function lock(options) {
    memoryToken = "";
    if (options && options.clearPass) clearPass();
  }

  function clearAll() {
    memoryToken = "";
    try {
      localStorage.removeItem(PASS_KEY);
      localStorage.removeItem(BLOB_KEY);
    } catch (error) {
      /* ignore */
    }
  }

  /**
   * 次要页面用：自动解锁，否则只 prompt 密码。
   */
  async function ensureUnlocked() {
    if (typeof crypto === "undefined" || !crypto.subtle) {
      throw new Error("当前浏览器不支持 Web Crypto，无法解锁 GitHub Token");
    }
    if (memoryToken) return memoryToken;
    if (await tryAutoUnlock()) return memoryToken;
    if (!hasBlob()) {
      throw new Error(
        "尚未封存 Token：请先打开 vault-seal.html，用 Token+密码生成密文，写入 github-token-vault.js 的 EMBEDDED_BLOB",
      );
    }
    const pass = window.prompt("输入解密密码");
    if (!pass) throw new Error("已取消：未解锁");
    await unlock(String(pass), { remember: true });
    return memoryToken;
  }

  const api = {
    getToken,
    isUnlocked,
    hasBlob,
    hasSavedPass,
    blobSource,
    unlock,
    setup,
    tryAutoUnlock,
    ensureUnlocked,
    lock,
    clearAll,
    encryptToken,
    PASS_KEY,
    BLOB_KEY,
    getEmbeddedBlob: () => EMBEDDED_BLOB,
  };

  global.GithubTokenVault = api;
  if (typeof module === "object" && module != null) {
    module.exports = api;
  }
})(
  typeof globalThis !== "undefined"
    ? globalThis
    : typeof window !== "undefined"
      ? window
      : this,
);
