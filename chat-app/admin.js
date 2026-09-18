(function () {
  "use strict";

  const SESSION_KEY = "chat-app.adminUnlocked";

  let threadsState = { threads: [], sha: null };
  /** @type {Map<string, {messages: array, sha: string|null, dirty?: boolean}>} */
  const messagesCache = new Map();
  let selectedId = null;
  let dirtyThreads = false;

  const $ = (id) => document.getElementById(id);

  function setStatus(el, text, kind) {
    if (!el) return;
    el.textContent = text || "";
    el.className = "status-line" + (kind ? ` ${kind}` : "");
  }

  function toDatetimeLocalValue(ts) {
    const d = new Date(Number(ts) || Date.now());
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
      d.getHours(),
    )}:${pad(d.getMinutes())}`;
  }

  function fromDatetimeLocalValue(value) {
    const t = Date.parse(value);
    return Number.isFinite(t) ? t : Date.now();
  }

  function unlock() {
    sessionStorage.setItem(SESSION_KEY, "1");
    $("gateView").hidden = true;
    $("adminView").hidden = false;
    reloadAll();
  }

  function tryGate() {
    if (sessionStorage.getItem(SESSION_KEY) === "1") {
      unlock();
      return;
    }
    $("unlockBtn").addEventListener("click", () => {
      if (ChatStore.checkAdminPass($("passInput").value)) {
        unlock();
      } else {
        setStatus($("gateStatus"), "口令错误", "err");
      }
    });
    $("passInput").addEventListener("keydown", (event) => {
      if (event.key === "Enter") $("unlockBtn").click();
    });
  }

  function ensureMsgCache(threadId) {
    if (!messagesCache.has(threadId)) {
      messagesCache.set(threadId, { messages: [], sha: null, dirty: false });
    }
    return messagesCache.get(threadId);
  }

  async function loadMessagesFor(threadId) {
    if (!threadId) return;
    if (messagesCache.has(threadId) && !messagesCache.get(threadId)._needFetch) {
      // keep cached if already loaded unless forced
    }
    setStatus($("adminStatus"), `加载消息 ${threadId}…`);
    try {
      const file = await ChatStore.loadMessages(threadId);
      messagesCache.set(threadId, {
        messages: file.messages || [],
        sha: file.sha,
        dirty: false,
      });
      setStatus($("adminStatus"), `消息已加载 · ${file.source || ""}`, "ok");
    } catch (error) {
      console.warn(error);
      messagesCache.set(threadId, { messages: [], sha: null, dirty: false });
      setStatus($("adminStatus"), error.message || "消息加载失败", "err");
    }
  }

  function renderThreadList() {
    const list = $("threadAdminList");
    const threads = ChatStore.sortThreads(threadsState.threads || []);
    if (!threads.length) {
      list.innerHTML = '<li class="meta">暂无会话</li>';
      return;
    }
    list.innerHTML = threads
      .map((t) => {
        const active = t.id === selectedId ? " active" : "";
        return `<li class="${active}" data-id="${ChatApp.escapeHtml(t.id)}">
          <div>
            <strong>${ChatApp.escapeHtml(t.title)}</strong>
            <div class="meta">${ChatApp.escapeHtml(t.id)} · 未读 ${
              t.unread
            }${t.pinned ? " · 置顶" : ""}</div>
            <div class="meta">${ChatApp.escapeHtml(t.lastMessage || "")}</div>
          </div>
          <button type="button" data-select="${ChatApp.escapeHtml(t.id)}">编辑</button>
        </li>`;
      })
      .join("");

    list.querySelectorAll("[data-select]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        await selectThread(btn.getAttribute("data-select"));
      });
    });
  }

  function fillThreadForm(thread) {
    if (!thread) {
      $("threadFormTitle").textContent = "新建会话";
      $("threadId").value = "";
      $("threadTitle").value = "";
      $("threadAvatar").value = "";
      $("threadUnread").value = "0";
      $("threadPinned").checked = false;
      $("threadMuted").checked = false;
      return;
    }
    $("threadFormTitle").textContent = `编辑 · ${thread.title}`;
    $("threadId").value = thread.id;
    $("threadTitle").value = thread.title || "";
    $("threadAvatar").value = thread.avatar || "";
    $("threadUnread").value = String(thread.unread || 0);
    $("threadPinned").checked = !!thread.pinned;
    $("threadMuted").checked = !!thread.muted;
  }

  function renderMessages() {
    const list = $("msgAdminList");
    $("msgThreadLabel").textContent = selectedId || "未选择";
    if (!selectedId) {
      list.innerHTML = '<li class="meta">请先选择会话</li>';
      return;
    }
    const cache = ensureMsgCache(selectedId);
    const messages = cache.messages || [];
    if (!messages.length) {
      list.innerHTML = '<li class="meta">暂无消息</li>';
      return;
    }
    list.innerHTML = messages
      .map((m, index) => {
        return `<li data-mid="${ChatApp.escapeHtml(m.id)}">
          <div>
            <strong>${m.role === "me" ? "我" : "对方"}</strong>
            <span class="meta"> · ${ChatApp.formatMsgTime(m.at)}</span>
            <div>${ChatApp.escapeHtml(m.text)}</div>
          </div>
          <button type="button" class="danger" data-del-msg="${index}">删</button>
        </li>`;
      })
      .join("");
    list.querySelectorAll("[data-del-msg]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = Number(btn.getAttribute("data-del-msg"));
        cache.messages.splice(idx, 1);
        cache.dirty = true;
        syncSelectedPreview();
        renderMessages();
        renderThreadList();
      });
    });
  }

  function syncSelectedPreview() {
    if (!selectedId) return;
    const thread = threadsState.threads.find((t) => t.id === selectedId);
    if (!thread) return;
    const cache = ensureMsgCache(selectedId);
    const synced = ChatStore.syncThreadPreview(thread, {
      messages: cache.messages,
    });
    Object.assign(thread, synced);
    dirtyThreads = true;
  }

  async function selectThread(id) {
    selectedId = id;
    const thread = threadsState.threads.find((t) => t.id === id);
    fillThreadForm(thread || null);
    renderThreadList();
    if (!messagesCache.has(id)) {
      await loadMessagesFor(id);
    }
    renderMessages();
    $("msgAt").value = toDatetimeLocalValue(Date.now());
  }

  function upsertThreadFromForm() {
    const title = $("threadTitle").value.trim();
    if (!title) {
      setStatus($("adminStatus"), "请填写昵称", "err");
      return;
    }
    let id = $("threadId").value.trim();
    const isNew = !id;
    if (!id) id = ChatStore.newId("t");
    const next = ChatStore.normalizeThread({
      id,
      title,
      avatar: $("threadAvatar").value.trim(),
      unread: Number($("threadUnread").value) || 0,
      pinned: $("threadPinned").checked,
      muted: $("threadMuted").checked,
      lastMessage: "",
      lastAt: Date.now(),
    });
    const idx = threadsState.threads.findIndex((t) => t.id === id);
    if (idx >= 0) {
      next.lastMessage = threadsState.threads[idx].lastMessage;
      next.lastAt = threadsState.threads[idx].lastAt;
      threadsState.threads[idx] = next;
    } else {
      threadsState.threads.push(next);
      messagesCache.set(id, { messages: [], sha: null, dirty: true });
    }
    dirtyThreads = true;
    selectedId = id;
    fillThreadForm(next);
    if (isNew) syncSelectedPreview();
    else syncSelectedPreview();
    renderThreadList();
    renderMessages();
    setStatus($("adminStatus"), "已写入内存，请点「保存到 GitHub」", "ok");
  }

  function clearThreadForm() {
    selectedId = null;
    fillThreadForm(null);
    renderThreadList();
    renderMessages();
  }

  async function deleteSelectedThread() {
    const id = $("threadId").value.trim() || selectedId;
    if (!id) return;
    if (!window.confirm(`删除会话 ${id}？将从列表移除，并尝试删除消息文件。`)) {
      return;
    }
    threadsState.threads = threadsState.threads.filter((t) => t.id !== id);
    dirtyThreads = true;
    messagesCache.delete(id);
    try {
      await ChatStore.deleteMessagesFile(id);
    } catch (error) {
      console.warn(error);
    }
    clearThreadForm();
    setStatus(
      $("adminStatus"),
      "会话已从内存删除；请保存列表到 GitHub",
      "ok",
    );
  }

  function addMessage() {
    if (!selectedId) {
      setStatus($("adminStatus"), "请先选择或创建会话", "err");
      return;
    }
    const text = $("msgText").value.trim();
    if (!text) {
      setStatus($("adminStatus"), "请填写正文", "err");
      return;
    }
    const cache = ensureMsgCache(selectedId);
    cache.messages.push(
      ChatStore.normalizeMessage({
        id: ChatStore.newId("m"),
        role: $("msgRole").value,
        text,
        at: fromDatetimeLocalValue($("msgAt").value),
      }),
    );
    cache.messages.sort((a, b) => a.at - b.at);
    cache.dirty = true;
    syncSelectedPreview();
    $("msgText").value = "";
    $("msgAt").value = toDatetimeLocalValue(Date.now());
    renderMessages();
    renderThreadList();
    setStatus($("adminStatus"), "消息已追加（内存），请保存", "ok");
  }

  async function reloadAll() {
    setStatus($("adminStatus"), "加载会话…");
    try {
      const file = await ChatStore.loadThreads();
      threadsState = {
        threads: file.threads || [],
        sha: file.sha,
      };
      messagesCache.clear();
      dirtyThreads = false;
      renderThreadList();
      if (selectedId && threadsState.threads.some((t) => t.id === selectedId)) {
        await loadMessagesFor(selectedId);
        fillThreadForm(
          threadsState.threads.find((t) => t.id === selectedId),
        );
      } else {
        clearThreadForm();
      }
      renderMessages();
      setStatus(
        $("adminStatus"),
        `已加载 ${threadsState.threads.length} 个会话 · ${file.source || ""}`,
        "ok",
      );
    } catch (error) {
      console.error(error);
      setStatus($("adminStatus"), error.message || "加载失败", "err");
    }
  }

  async function saveAll() {
    setStatus($("adminStatus"), "保存中…");
    try {
      // Sync all dirty message caches into thread previews first.
      for (const [id, cache] of messagesCache.entries()) {
        if (!cache.dirty) continue;
        const thread = threadsState.threads.find((t) => t.id === id);
        if (thread) {
          Object.assign(
            thread,
            ChatStore.syncThreadPreview(thread, { messages: cache.messages }),
          );
          dirtyThreads = true;
        }
      }

      for (const [id, cache] of messagesCache.entries()) {
        if (!cache.dirty) continue;
        const saved = await ChatStore.saveMessages(
          id,
          { messages: cache.messages },
          { sha: cache.sha },
        );
        cache.sha = saved.sha;
        cache.dirty = false;
        dirtyThreads = true;
      }

      // Keep threads.json lastMessage/lastAt aligned with messages.
      const saved = await ChatStore.saveThreads(
        { threads: threadsState.threads },
        { sha: threadsState.sha },
      );
      threadsState.sha = saved.sha;
      threadsState.threads = saved.threads;
      dirtyThreads = false;

      renderThreadList();
      setStatus($("adminStatus"), "已保存到 GitHub", "ok");
      ChatApp.showToast("保存成功");
    } catch (error) {
      console.error(error);
      setStatus($("adminStatus"), error.message || "保存失败", "err");
      ChatApp.showToast(error.message || "保存失败");
    }
  }

  function bind() {
    $("reloadBtn").addEventListener("click", () => reloadAll());
    $("saveAllBtn").addEventListener("click", () => saveAll());
    $("upsertThreadBtn").addEventListener("click", () => upsertThreadFromForm());
    $("newThreadBtn").addEventListener("click", () => clearThreadForm());
    $("deleteThreadBtn").addEventListener("click", () => deleteSelectedThread());
    $("addMsgBtn").addEventListener("click", () => addMessage());
    $("clearMsgFormBtn").addEventListener("click", () => {
      $("msgText").value = "";
      $("msgAt").value = toDatetimeLocalValue(Date.now());
    });
    $("msgAt").value = toDatetimeLocalValue(Date.now());
  }

  tryGate();
  bind();
})();
