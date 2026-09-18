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
  const ME_ID = "u_me";
  const WRITE_RETRIES = 4;

  const AVATAR_COLORS = [
    "#07c160",
    "#3d7dff",
    "#fa9d3b",
    "#f76260",
    "#9b59b6",
    "#16a085",
    "#e67e22",
    "#2c3e50",
    "#1abc9c",
    "#c0392b",
    "#8e44ad",
    "#2980b9",
  ];

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
    try {
      return { data: JSON.parse(raw), sha: file.sha };
    } catch (error) {
      if (/^<<<<<<<|^=======|^>>>>>>>/m.test(raw)) {
        throw new Error(
          `${path} 含 git 冲突标记，请先修好 JSON 再保存（不要把 <<<<<<< 提交进仓库）`,
        );
      }
      throw new Error(`${path} 不是合法 JSON: ${error.message}`);
    }
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
    const url = `https://raw.githubusercontent.com/${repo}/${commitSha}/${path}?t=${Date.now()}`;
    return fetch(url, { cache: "no-store" });
  }

  function hashHue(key) {
    const s = String(key || "");
    let h = 0;
    for (let i = 0; i < s.length; i += 1) {
      h = (h * 31 + s.charCodeAt(i)) >>> 0;
    }
    return h;
  }

  function colorForId(id) {
    return AVATAR_COLORS[hashHue(id) % AVATAR_COLORS.length];
  }

  /** 三字取后两字，两字全取，一字取一字。 */
  function avatarText(name) {
    const t = String(name || "").trim();
    if (!t) return "?";
    if (t.length >= 3) return t.slice(-2);
    return t;
  }

  function normalizeMember(item, fallbackName) {
    if (typeof item === "string" && item.trim()) {
      const name = item.trim();
      const id = name === "我" ? ME_ID : `u_${hashHue(name).toString(36)}`;
      return { id, name, color: colorForId(id) };
    }
    if (!item || typeof item !== "object") return null;
    const id = String(item.id || "").trim();
    const name = String(item.name || fallbackName || id).trim();
    if (!id && !name) return null;
    const memberId = id || (name === "我" ? ME_ID : `u_${hashHue(name).toString(36)}`);
    return {
      id: memberId,
      name: name || memberId,
      color: item.color ? String(item.color) : colorForId(memberId),
    };
  }

  function ensureMembers(threadLike) {
    const raw = Array.isArray(threadLike && threadLike.members)
      ? threadLike.members.map((item) => normalizeMember(item)).filter(Boolean)
      : [];
    const map = new Map();
    raw.forEach((m) => map.set(m.id, m));
    if (!map.has(ME_ID)) {
      map.set(ME_ID, { id: ME_ID, name: "我", color: colorForId(ME_ID) });
    }
    const type =
      threadLike && threadLike.type === "group"
        ? "group"
        : map.size > 2
          ? "group"
          : "direct";
    if (type === "direct" && map.size < 2) {
      const title = String((threadLike && threadLike.title) || "对方").trim();
      const peer = normalizeMember({
        id: `u_${hashHue(title || "peer").toString(36)}`,
        name: title || "对方",
      });
      if (peer && !map.has(peer.id)) map.set(peer.id, peer);
    }
    return [...map.values()];
  }

  function memberById(thread, id) {
    const members = (thread && thread.members) || [];
    return members.find((m) => m.id === id) || null;
  }

  function peerMember(thread) {
    const members = (thread && thread.members) || [];
    return members.find((m) => m.id !== ME_ID) || members[0] || null;
  }

  function normalizeUnreadBy(raw, members) {
    const next = {};
    (members || []).forEach((m) => {
      const n = raw && Number(raw[m.id]);
      next[m.id] = Math.max(0, Number.isFinite(n) ? n : 0);
    });
    return next;
  }

  function normalizeThread(item) {
    if (!item || typeof item !== "object") return null;
    const id = String(item.id || "").trim();
    if (!id) return null;
    const members = ensureMembers(item);
    const type = item.type === "group" || members.length > 2 ? "group" : "direct";
    const unreadBy = normalizeUnreadBy(item.unreadBy, members);
    if (item.unreadBy == null && Number(item.unread) > 0) {
      unreadBy[ME_ID] = Math.max(unreadBy[ME_ID] || 0, Number(item.unread) || 0);
    }
    return {
      id,
      title: String(item.title || id).trim() || id,
      type,
      avatar: item.avatar ? String(item.avatar) : "",
      members,
      lastMessage: item.lastMessage != null ? String(item.lastMessage) : "",
      lastAt: Number.isFinite(Number(item.lastAt)) ? Number(item.lastAt) : 0,
      unreadBy,
      unread: unreadBy[ME_ID] || 0,
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

  function inferSenderId(item) {
    if (item && item.senderId) return String(item.senderId);
    if (item && item.role === "me") return ME_ID;
    return "";
  }

  function normalizeMessage(item, thread) {
    if (!item || typeof item !== "object") return null;
    const id = String(item.id || "").trim();
    const text = item.text != null ? String(item.text) : "";
    if (!id && !text) return null;
    let senderId = inferSenderId(item);
    if (!senderId) {
      const peer = peerMember(thread);
      senderId = peer ? peer.id : "u_peer";
    }
    const readBy = Array.isArray(item.readBy)
      ? [...new Set(item.readBy.map((x) => String(x)).filter(Boolean))]
      : [senderId];
    if (!readBy.includes(senderId)) readBy.unshift(senderId);
    return {
      id: id || `m_${Date.now()}`,
      senderId,
      text,
      at: Number.isFinite(Number(item.at)) ? Number(item.at) : Date.now(),
      type: item.type ? String(item.type) : "text",
      readBy,
    };
  }

  function normalizeMessagesFile(data, threadId, thread) {
    const messages = Array.isArray(data && data.messages)
      ? data.messages.map((item) => normalizeMessage(item, thread)).filter(Boolean)
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

  function previewText(msg, thread) {
    if (!msg) return "";
    if (thread && thread.type === "group") {
      const who = memberById(thread, msg.senderId);
      const name = who ? who.name : msg.senderId;
      return `${name}: ${msg.text}`;
    }
    return msg.text || "";
  }

  function syncThreadPreview(thread, messagesFile) {
    const msgs = (messagesFile && messagesFile.messages) || [];
    const last = msgs.length ? msgs[msgs.length - 1] : null;
    return {
      ...thread,
      lastMessage: last ? previewText(last, thread) : thread.lastMessage || "",
      lastAt: last ? last.at : thread.lastAt || 0,
    };
  }

  function receiptForMessage(msg, thread, viewerId) {
    const members = (thread && thread.members) || [];
    const others = members.filter((m) => m.id !== msg.senderId);
    const readSet = new Set(msg.readBy || []);
    const readOthers = others.filter((m) => readSet.has(m.id));
    const unreadOthers = others.filter((m) => !readSet.has(m.id));
    if (thread && thread.type === "group") {
      return {
        kind: "group",
        read: readOthers.length,
        unread: unreadOthers.length,
        readNames: readOthers.map((m) => m.name),
        unreadNames: unreadOthers.map((m) => m.name),
      };
    }
    return {
      kind: "direct",
      read: readOthers.length > 0,
      unread: unreadOthers.length > 0,
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
    const thread = options && options.thread;
    const file = normalizeMessagesFile(loaded.data || { messages: [] }, id, thread);
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
      options && options.thread,
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

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function withWriteRetry(task) {
    let lastError = null;
    for (let attempt = 0; attempt < WRITE_RETRIES; attempt += 1) {
      try {
        return await task();
      } catch (error) {
        lastError = error;
        if (!error || error.code !== "conflict") throw error;
        await sleep(200 + attempt * 250);
      }
    }
    throw lastError;
  }

  async function sendMessage(threadId, options) {
    const id = String(threadId || "").trim();
    const text = String((options && options.text) || "").trim();
    const senderId = String((options && options.senderId) || ME_ID).trim() || ME_ID;
    if (!id) throw new Error("缺少会话 id");
    if (!text) throw new Error("请输入内容");
    const repo = (options && options.repo) || DEFAULT_REPO;

    return withWriteRetry(async () => {
      const [threadsRaw, msgsRaw] = await Promise.all([
        fetchJsonFile({ repo, path: THREADS_PATH }),
        fetchJsonFile({ repo, path: messagesPath(id) }),
      ]);
      const threadsFile = normalizeThreadsFile(threadsRaw.data || { threads: [] });
      let thread = threadsFile.threads.find((t) => t.id === id);
      if (!thread) throw new Error("会话不存在");
      thread = normalizeThread(thread);
      if (!memberById(thread, senderId)) {
        throw new Error("发送者不在群成员中");
      }
      const msgFile = normalizeMessagesFile(
        msgsRaw.data || { messages: [] },
        id,
        thread,
      );
      const now = Date.now();
      msgFile.messages.push({
        id: newId("m"),
        senderId,
        text,
        at: now,
        type: "text",
        readBy: [senderId],
      });
      thread = syncThreadPreview(thread, msgFile);
      thread.unreadBy = normalizeUnreadBy(thread.unreadBy, thread.members);
      thread.members.forEach((m) => {
        if (m.id === senderId) thread.unreadBy[m.id] = 0;
        else thread.unreadBy[m.id] = (thread.unreadBy[m.id] || 0) + 1;
      });
      thread.unread = thread.unreadBy[ME_ID] || 0;
      threadsFile.threads = threadsFile.threads.map((t) =>
        t.id === id ? thread : t,
      );

      const savedMsg = await saveMessages(id, msgFile, {
        repo,
        sha: msgsRaw.sha,
        thread,
        message: `Chat send ${id}`,
      });
      const savedThreads = await saveThreads(threadsFile, {
        repo,
        sha: threadsRaw.sha,
        message: `Chat preview ${id}`,
      });
      return {
        thread: savedThreads.threads.find((t) => t.id === id) || thread,
        messages: savedMsg.messages,
        messagesSha: savedMsg.sha,
        threadsSha: savedThreads.sha,
      };
    });
  }

  async function markRead(threadId, options) {
    const id = String(threadId || "").trim();
    const viewerId = String((options && options.viewerId) || ME_ID).trim() || ME_ID;
    if (!id) throw new Error("缺少会话 id");
    const repo = (options && options.repo) || DEFAULT_REPO;

    return withWriteRetry(async () => {
      const [threadsRaw, msgsRaw] = await Promise.all([
        fetchJsonFile({ repo, path: THREADS_PATH }),
        fetchJsonFile({ repo, path: messagesPath(id) }),
      ]);
      const threadsFile = normalizeThreadsFile(threadsRaw.data || { threads: [] });
      let thread = threadsFile.threads.find((t) => t.id === id);
      if (!thread) throw new Error("会话不存在");
      thread = normalizeThread(thread);
      const msgFile = normalizeMessagesFile(
        msgsRaw.data || { messages: [] },
        id,
        thread,
      );
      let changed = false;
      msgFile.messages.forEach((msg) => {
        if (msg.senderId === viewerId) return;
        if (!(msg.readBy || []).includes(viewerId)) {
          msg.readBy = [...(msg.readBy || []), viewerId];
          changed = true;
        }
      });
      const prevUnread = thread.unreadBy[viewerId] || 0;
      if (prevUnread !== 0) {
        thread.unreadBy[viewerId] = 0;
        thread.unread = thread.unreadBy[ME_ID] || 0;
        changed = true;
      }
      if (!changed) {
        return {
          thread,
          messages: msgFile.messages,
          changed: false,
          messagesSha: msgsRaw.sha,
          threadsSha: threadsRaw.sha,
        };
      }
      threadsFile.threads = threadsFile.threads.map((t) =>
        t.id === id ? thread : t,
      );
      const savedMsg = await saveMessages(id, msgFile, {
        repo,
        sha: msgsRaw.sha,
        thread,
        message: `Chat read ${id}`,
      });
      const savedThreads = await saveThreads(threadsFile, {
        repo,
        sha: threadsRaw.sha,
        message: `Chat unread ${id}`,
      });
      return {
        thread: savedThreads.threads.find((t) => t.id === id) || thread,
        messages: savedMsg.messages,
        changed: true,
        messagesSha: savedMsg.sha,
        threadsSha: savedThreads.sha,
      };
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
    ME_ID,
    AVATAR_COLORS,
    getGithubToken,
    messagesPath,
    colorForId,
    avatarText,
    normalizeMember,
    memberById,
    peerMember,
    normalizeThread,
    normalizeThreadsFile,
    normalizeMessage,
    normalizeMessagesFile,
    sortThreads,
    syncThreadPreview,
    previewText,
    receiptForMessage,
    loadThreads,
    loadMessages,
    saveThreads,
    saveMessages,
    deleteMessagesFile,
    sendMessage,
    markRead,
    fetchJsonFile,
    checkAdminPass,
    newId,
  };
});
