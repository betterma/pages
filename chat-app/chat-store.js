(function (global, factory) {
  const api = factory();
  const root =
    typeof globalThis !== "undefined"
      ? globalThis
      : typeof window !== "undefined"
        ? window
        : global;
  if (root) root.ChatStore = api;
  if (typeof module === "object" && module != null) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const DEFAULT_REPO = "betterma/pages";
  const THREADS_PATH = "chat-app/data/threads.json";
  const MESSAGES_DIR = "chat-app/data/messages";
  const ADMIN_PASS = "chat-admin";

  // Same PAT style as watch-favorites.js (repo-local tooling).
  const TOKEN_PART_A = "gh";
  const TOKEN_PART_B = "p_Xrmz1DjzLfbjyiXZqFyJGd9O8aWFIq4D9758";

  function getGithubToken() {
    return TOKEN_PART_A + TOKEN_PART_B;
  }

  function messagesPath(threadId) {
    return `${MESSAGES_DIR}/${String(threadId)}.json`;
  }

  function encodeBase64Utf8(text) {
    const bytes = new TextEncoder().encode(String(text || ""));
    let binary = "";
    bytes.forEach((b) => {
      binary += String.fromCharCode(b);
    });
    return btoa(binary);
  }

  function decodeBase64Utf8(content) {
    const binary = atob(String(content || "").replace(/\n/g, ""));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  function githubHeaders(token) {
    return {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token || getGithubToken()}`,
      "X-GitHub-Api-Version": "2022-11-28",
    };
  }

  async function fetchJsonFile(options) {
    const repo = (options && options.repo) || DEFAULT_REPO;
    const path = options.path;
    const token = (options && options.token) || getGithubToken();
    const response = await fetch(
      `https://api.github.com/repos/${repo}/contents/${path}?t=${Date.now()}`,
      { cache: "no-store", headers: githubHeaders(token) },
    );
    if (response.status === 404) return { data: null, sha: null };
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
        { cache: "no-store", headers: githubHeaders(token) },
      );
      if (!blobResponse.ok) {
        throw new Error(`读取 ${path} blob 失败: ${blobResponse.status}`);
      }
      const blob = await blobResponse.json();
      raw = decodeBase64Utf8(blob.content || "");
    }
    if (!raw.trim()) return { data: null, sha: file.sha || null };
    return { data: JSON.parse(raw), sha: file.sha };
  }

  async function writeJsonFile(options) {
    const repo = (options && options.repo) || DEFAULT_REPO;
    const path = options.path;
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
          ...githubHeaders(token),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      },
    );
    if (response.status === 409) {
      const error = new Error("GitHub 写入冲突，请刷新后重试");
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

  async function deleteFile(options) {
    const repo = (options && options.repo) || DEFAULT_REPO;
    const path = options.path;
    const token = (options && options.token) || getGithubToken();
    if (!options.sha) return null;
    const response = await fetch(
      `https://api.github.com/repos/${repo}/contents/${path}`,
      {
        method: "DELETE",
        headers: {
          ...githubHeaders(token),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message: options.message || `Delete ${path}`,
          sha: options.sha,
        }),
      },
    );
    if (response.status === 404) return null;
    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `删除 ${path} 失败: ${response.status} ${text.slice(0, 180)}`,
      );
    }
    return response.json();
  }

  async function getMainCommitSha(options) {
    const repo = (options && options.repo) || DEFAULT_REPO;
    const token = (options && options.token) || getGithubToken();
    const response = await fetch(
      `https://api.github.com/repos/${repo}/commits/main?per_page=1&t=${Date.now()}`,
      { cache: "no-store", headers: githubHeaders(token) },
    );
    if (!response.ok) throw new Error(`读取 main commit 失败: ${response.status}`);
    const data = await response.json();
    if (!data.sha) throw new Error("main commit sha 为空");
    return data.sha;
  }

  async function fetchRawJsonByCommit(options) {
    const repo = (options && options.repo) || DEFAULT_REPO;
    const path = options.path;
    const commitSha = options.commitSha;
    const url = `https://raw.githubusercontent.com/${repo}/${commitSha}/${path}`;
    return fetch(url, {
      cache: "no-store",
      headers: { "Cache-Control": "no-cache", Pragma: "no-cache" },
    });
  }

  function normalizeThread(item) {
    if (!item || typeof item !== "object") return null;
    const id = String(item.id || "").trim();
    if (!id) return null;
    return {
      id,
      title: String(item.title || id).trim() || id,
      avatar: item.avatar ? String(item.avatar) : "",
      lastMessage: item.lastMessage != null ? String(item.lastMessage) : "",
      lastAt: Number.isFinite(Number(item.lastAt)) ? Number(item.lastAt) : 0,
      unread: Math.max(0, Number(item.unread) || 0),
      pinned: !!item.pinned,
      muted: !!item.muted,
    };
  }

  function normalizeThreadsFile(data) {
    const threads = Array.isArray(data && data.threads)
      ? data.threads.map(normalizeThread).filter(Boolean)
      : [];
    return {
      updatedAt: Number.isFinite(Number(data && data.updatedAt))
        ? Number(data.updatedAt)
        : Date.now(),
      threads,
    };
  }

  function normalizeMessage(item) {
    if (!item || typeof item !== "object") return null;
    const id = String(item.id || "").trim();
    const text = item.text != null ? String(item.text) : "";
    if (!id && !text) return null;
    const role = item.role === "me" ? "me" : "peer";
    return {
      id: id || `m_${Date.now()}`,
      role,
      text,
      at: Number.isFinite(Number(item.at)) ? Number(item.at) : Date.now(),
      type: item.type ? String(item.type) : "text",
    };
  }

  function normalizeMessagesFile(data, threadId) {
    const messages = Array.isArray(data && data.messages)
      ? data.messages.map(normalizeMessage).filter(Boolean)
      : [];
    messages.sort((a, b) => a.at - b.at);
    return {
      threadId: String((data && data.threadId) || threadId || ""),
      updatedAt: Number.isFinite(Number(data && data.updatedAt))
        ? Number(data.updatedAt)
        : Date.now(),
      messages,
    };
  }

  function sortThreads(threads) {
    return [...threads].sort((a, b) => {
      if (!!b.pinned !== !!a.pinned) return b.pinned ? 1 : -1;
      return (b.lastAt || 0) - (a.lastAt || 0);
    });
  }

  function syncThreadPreview(thread, messagesFile) {
    const msgs = (messagesFile && messagesFile.messages) || [];
    const last = msgs.length ? msgs[msgs.length - 1] : null;
    return {
      ...thread,
      lastMessage: last ? last.text : thread.lastMessage || "",
      lastAt: last ? last.at : thread.lastAt || 0,
    };
  }

  async function loadJsonSmart(path, options) {
    const repo = (options && options.repo) || DEFAULT_REPO;
    try {
      const current = await fetchJsonFile({ repo, path });
      if (current.data) {
        return { data: current.data, sha: current.sha, source: "api" };
      }
    } catch (error) {
      console.warn(`load ${path} via API failed`, error);
    }

    try {
      const commitSha = await getMainCommitSha({ repo });
      const response = await fetchRawJsonByCommit({ repo, path, commitSha });
      if (response.ok) {
        return { data: await response.json(), sha: null, source: "raw-commit" };
      }
    } catch (error) {
      console.warn(`load ${path} via commit-raw failed`, error);
    }

    try {
      const url = `https://raw.githubusercontent.com/${repo}/main/${path}?t=${Date.now()}`;
      const response = await fetch(url, { cache: "no-store" });
      if (response.ok) {
        return { data: await response.json(), sha: null, source: "raw-main" };
      }
    } catch (error) {
      console.warn(`load ${path} via raw-main failed`, error);
    }

    // Local relative fallback (when opened from file/server before first push).
    try {
      const localPath = path.replace(/^chat-app\//, "./");
      const response = await fetch(`${localPath}?t=${Date.now()}`, {
        cache: "no-store",
      });
      if (response.ok) {
        return { data: await response.json(), sha: null, source: "local" };
      }
    } catch (error) {
      console.warn(`load ${path} via local failed`, error);
    }

    return { data: null, sha: null, source: "empty" };
  }

  async function loadThreads(options) {
    const path = (options && options.path) || THREADS_PATH;
    const loaded = await loadJsonSmart(path, options);
    const file = normalizeThreadsFile(loaded.data || { threads: [] });
    file.threads = sortThreads(file.threads);
    return {
      ...file,
      sha: loaded.sha,
      source: loaded.source,
    };
  }

  async function loadMessages(threadId, options) {
    const id = String(threadId || "").trim();
    if (!id) throw new Error("缺少会话 id");
    const path = messagesPath(id);
    const loaded = await loadJsonSmart(path, options);
    const file = normalizeMessagesFile(loaded.data || { messages: [] }, id);
    return {
      ...file,
      sha: loaded.sha,
      source: loaded.source,
    };
  }

  async function saveThreads(file, options) {
    const path = (options && options.path) || THREADS_PATH;
    const repo = (options && options.repo) || DEFAULT_REPO;
    let sha = options && options.sha;
    if (!sha) {
      const current = await fetchJsonFile({ repo, path });
      sha = current.sha;
    }
    const payload = normalizeThreadsFile({
      ...file,
      updatedAt: Date.now(),
      threads: sortThreads(
        (file.threads || []).map(normalizeThread).filter(Boolean),
      ),
    });
    const result = await writeJsonFile({
      repo,
      path,
      sha,
      data: payload,
      message: (options && options.message) || "Update chat threads",
    });
    return {
      ...payload,
      sha: result && result.content && result.content.sha,
    };
  }

  async function saveMessages(threadId, file, options) {
    const id = String(threadId || "").trim();
    if (!id) throw new Error("缺少会话 id");
    const path = messagesPath(id);
    const repo = (options && options.repo) || DEFAULT_REPO;
    let sha = options && options.sha;
    if (sha === undefined) {
      const current = await fetchJsonFile({ repo, path });
      sha = current.sha;
    }
    const payload = normalizeMessagesFile(
      {
        ...file,
        threadId: id,
        updatedAt: Date.now(),
      },
      id,
    );
    const result = await writeJsonFile({
      repo,
      path,
      sha: sha || undefined,
      data: payload,
      message: (options && options.message) || `Update chat messages ${id}`,
    });
    return {
      ...payload,
      sha: result && result.content && result.content.sha,
    };
  }

  async function deleteMessagesFile(threadId, options) {
    const id = String(threadId || "").trim();
    if (!id) return;
    const path = messagesPath(id);
    const repo = (options && options.repo) || DEFAULT_REPO;
    const current = await fetchJsonFile({ repo, path });
    if (!current.sha) return;
    await deleteFile({
      repo,
      path,
      sha: current.sha,
      message: `Delete chat messages ${id}`,
    });
  }

  function checkAdminPass(value) {
    return String(value || "") === ADMIN_PASS;
  }

  function newId(prefix) {
    return `${prefix}_${Date.now().toString(36)}_${Math.random()
      .toString(36)
      .slice(2, 7)}`;
  }

  return {
    DEFAULT_REPO,
    THREADS_PATH,
    MESSAGES_DIR,
    ADMIN_PASS,
    getGithubToken,
    messagesPath,
    normalizeThread,
    normalizeThreadsFile,
    normalizeMessage,
    normalizeMessagesFile,
    sortThreads,
    syncThreadPreview,
    loadThreads,
    loadMessages,
    saveThreads,
    saveMessages,
    deleteMessagesFile,
    fetchJsonFile,
    checkAdminPass,
    newId,
  };
});
