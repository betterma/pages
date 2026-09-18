(function (global) {
  "use strict";

  const AS_KEY = "chat-app.asMap";

  function qs(id) {
    return document.getElementById(id);
  }

  function showToast(message) {
    let el = document.querySelector(".toast");
    if (!el) {
      el = document.createElement("div");
      el.className = "toast";
      document.body.appendChild(el);
    }
    el.textContent = message;
    el.classList.add("show");
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => el.classList.remove("show"), 1800);
  }

  function getAsMap() {
    try {
      const raw = localStorage.getItem(AS_KEY);
      const data = raw ? JSON.parse(raw) : {};
      return data && typeof data === "object" ? data : {};
    } catch (error) {
      return {};
    }
  }

  function viewerIdFor(thread) {
    const map = getAsMap();
    const saved = map[thread && thread.id];
    if (saved && ChatStore.memberById(thread, saved)) return saved;
    return ChatStore.ME_ID;
  }

  function setViewerId(threadId, memberId) {
    const map = getAsMap();
    map[String(threadId)] = memberId;
    localStorage.setItem(AS_KEY, JSON.stringify(map));
  }

  function unreadFor(thread, viewerId) {
    if (!thread) return 0;
    const id = viewerId || ChatStore.ME_ID;
    if (thread.unreadBy && Number.isFinite(Number(thread.unreadBy[id]))) {
      return Number(thread.unreadBy[id]) || 0;
    }
    return id === ChatStore.ME_ID ? Number(thread.unread) || 0 : 0;
  }

  function escapeHtml(text) {
    return String(text || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function escapeAttr(text) {
    return escapeHtml(text).replace(/'/g, "&#39;");
  }

  function personForAvatar(thread, member) {
    if (member) return member;
    if (!thread) return { id: "?", name: "?", color: ChatStore.colorForId("?") };
    if (thread.avatar) {
      return {
        id: thread.id,
        name: thread.title,
        avatar: thread.avatar,
        color: ChatStore.colorForId(thread.id),
      };
    }
    if (thread.type === "group") {
      return {
        id: thread.id,
        name: thread.title,
        color: ChatStore.colorForId(thread.id),
      };
    }
    return ChatStore.peerMember(thread) || {
      id: thread.id,
      name: thread.title,
      color: ChatStore.colorForId(thread.id),
    };
  }

  function avatarHtml(person, className) {
    const cls = className || "avatar";
    const p = person || { id: "?", name: "?" };
    if (p.avatar) {
      return `<div class="${cls}"><img src="${escapeAttr(p.avatar)}" alt="" /></div>`;
    }
    const color = p.color || ChatStore.colorForId(p.id || p.name);
    const text = ChatStore.avatarText(p.name);
    return `<div class="${cls}" style="background:${escapeAttr(
      color,
    )}">${escapeHtml(text)}</div>`;
  }

  function formatListTime(ts) {
    const n = Number(ts);
    if (!Number.isFinite(n) || n <= 0) return "";
    const d = new Date(n);
    const now = new Date();
    const sameDay =
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate();
    if (sameDay) {
      return d.toLocaleTimeString("zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });
    }
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (
      d.getFullYear() === yesterday.getFullYear() &&
      d.getMonth() === yesterday.getMonth() &&
      d.getDate() === yesterday.getDate()
    ) {
      return "昨天";
    }
    return `${d.getMonth() + 1}/${d.getDate()}`;
  }

  function formatMsgTime(ts) {
    const n = Number(ts);
    if (!Number.isFinite(n) || n <= 0) return "";
    return new Date(n).toLocaleString("zh-CN", {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  }

  function queryParam(name) {
    return new URLSearchParams(window.location.search).get(name);
  }

  function skeletonList(count) {
    const n = count || 6;
    let html = '<div class="skeleton-list">';
    for (let i = 0; i < n; i += 1) {
      html += `<div class="skeleton-row"><div class="sk sk-avatar"></div><div class="sk-lines"><div class="sk sk-line short"></div><div class="sk sk-line long"></div></div></div>`;
    }
    html += "</div>";
    return html;
  }

  async function runSplash() {
    const skip = queryParam("skip") === "1";
    const delay = skip ? 0 : 1600;
    await new Promise((resolve) => setTimeout(resolve, delay));
    window.location.replace("./chats.html");
  }

  async function runChatsPage() {
    const listEl = qs("threadList");
    const statusEl = qs("listStatus");
    if (!listEl) return;

    const render = (threads) => {
      if (!threads.length) {
        listEl.innerHTML =
          '<div class="empty-state">暂无会话<br />请到后台添加</div>';
        return;
      }
      listEl.innerHTML = threads
        .map((thread) => {
          const unread = unreadFor(thread, ChatStore.ME_ID);
          const badge =
            unread > 0
              ? `<span class="badge${thread.muted ? " muted" : ""}">${
                  unread > 99 ? "99+" : unread
                }</span>`
              : "";
          const face = personForAvatar(thread);
          const tag =
            thread.type === "group"
              ? `<span class="thread-tag">群</span>`
              : "";
          return `<a class="thread-item${
            thread.pinned ? " is-pinned" : ""
          }" href="./chat.html?id=${encodeURIComponent(thread.id)}">
            ${avatarHtml(face)}
            <div class="thread-main">
              <div class="thread-row">
                <div class="thread-title">${tag}${escapeHtml(thread.title)}</div>
                <div class="thread-time">${escapeHtml(
                  formatListTime(thread.lastAt),
                )}</div>
              </div>
              <div class="thread-preview">
                <div class="thread-last">${escapeHtml(thread.lastMessage)}</div>
                ${badge}
              </div>
            </div>
          </a>`;
        })
        .join("");
    };

    const load = async () => {
      listEl.innerHTML = skeletonList(7);
      if (statusEl) statusEl.textContent = "加载中…";
      try {
        const data = await ChatStore.loadThreads();
        render(data.threads || []);
        if (statusEl) {
          statusEl.textContent = `已更新 · ${new Date().toLocaleTimeString(
            "zh-CN",
            { hour12: false },
          )}`;
        }
      } catch (error) {
        console.error(error);
        listEl.innerHTML = `<div class="empty-state">${escapeHtml(
          error.message || "加载失败",
        )}</div>`;
        if (statusEl) statusEl.textContent = "加载失败";
      }
    };

    qs("refreshBtn")?.addEventListener("click", () => load());
    await load();
  }

  function shouldShowTimeSep(prevAt, at) {
    if (!prevAt) return true;
    return Math.abs(Number(at) - Number(prevAt)) >= 5 * 60 * 1000;
  }

  function receiptHtml(msg, thread, viewerId) {
    if (msg.senderId !== viewerId) return "";
    const rec = ChatStore.receiptForMessage(msg, thread, viewerId);
    if (rec.kind === "group") {
      const tip = rec.readNames.length
        ? `已读：${rec.readNames.join("、")}`
        : "还没有人读";
      return `<div class="receipt" title="${escapeAttr(tip)}">已读 ${
        rec.read
      }人 · 未读 ${rec.unread}人</div>`;
    }
    return `<div class="receipt">${rec.read ? "已读" : "未读"}</div>`;
  }

  function renderMessagesHtml(thread, messages, viewerId) {
    if (!messages.length) {
      return '<div class="empty-state">暂无消息，发一条试试</div>';
    }
    let prevAt = 0;
    return messages
      .map((msg) => {
        const sep = shouldShowTimeSep(prevAt, msg.at)
          ? `<div class="time-sep">${escapeHtml(formatMsgTime(msg.at))}</div>`
          : "";
        prevAt = msg.at;
        const mine = msg.senderId === viewerId;
        const who =
          ChatStore.memberById(thread, msg.senderId) || {
            id: msg.senderId,
            name: msg.senderId,
            color: ChatStore.colorForId(msg.senderId),
          };
        const name =
          thread.type === "group" && !mine
            ? `<div class="msg-name">${escapeHtml(who.name)}</div>`
            : "";
        return `${sep}<div class="msg-row ${mine ? "me" : "peer"}">
            ${avatarHtml(who, "msg-avatar")}
            <div class="msg-col">
              ${name}
              <div class="bubble">${escapeHtml(msg.text)}</div>
              ${receiptHtml(msg, thread, viewerId)}
            </div>
          </div>`;
      })
      .join("");
  }

  async function runChatPage() {
    const threadId = queryParam("id");
    const scroller = qs("msgScroller");
    const titleEl = qs("chatTitle");
    const asSelect = qs("asSelect");
    const sendBtn = qs("sendBtn");
    const input = qs("composerInput");
    if (!scroller) return;

    if (!threadId) {
      scroller.innerHTML = '<div class="empty-state">缺少会话 id</div>';
      return;
    }

    scroller.innerHTML = skeletonList(5);

    let thread = null;
    let messages = [];
    let sending = false;
    let marking = false;

    const paint = () => {
      const viewerId = viewerIdFor(thread);
      if (titleEl) {
        const extra =
          thread.type === "group"
            ? ` (${(thread.members || []).length})`
            : "";
        titleEl.textContent = `${thread.title || threadId}${extra}`;
      }
      if (asSelect) {
        asSelect.innerHTML = (thread.members || [])
          .map((m) => {
            const sel = m.id === viewerId ? " selected" : "";
            return `<option value="${escapeAttr(m.id)}"${sel}>以 ${escapeHtml(
              m.name,
            )} 发送</option>`;
          })
          .join("");
      }
      scroller.innerHTML = renderMessagesHtml(thread, messages, viewerId);
      scroller.scrollTop = scroller.scrollHeight;
    };

    const loadRoom = async (opts) => {
      const threadsFile = await ChatStore.loadThreads();
      thread = (threadsFile.threads || []).find((t) => t.id === threadId);
      if (!thread) {
        thread = ChatStore.normalizeThread({
          id: threadId,
          title: threadId,
          type: "direct",
        });
      }
      const file = await ChatStore.loadMessages(threadId, { thread });
      messages = file.messages || [];
      paint();
      if (opts && opts.skipMark) return;
      const viewerId = viewerIdFor(thread);
      if (marking) return;
      marking = true;
      try {
        const result = await ChatStore.markRead(threadId, { viewerId });
        if (result && result.changed) {
          thread = result.thread || thread;
          messages = result.messages || messages;
          paint();
        }
      } catch (error) {
        console.warn("markRead failed", error);
      } finally {
        marking = false;
      }
    };

    try {
      await loadRoom();
    } catch (error) {
      console.error(error);
      scroller.innerHTML = `<div class="empty-state">${escapeHtml(
        error.message || "加载失败",
      )}</div>`;
    }

    asSelect?.addEventListener("change", async () => {
      setViewerId(threadId, asSelect.value);
      paint();
      try {
        const result = await ChatStore.markRead(threadId, {
          viewerId: asSelect.value,
        });
        if (result && result.changed) {
          thread = result.thread || thread;
          messages = result.messages || messages;
          paint();
        }
      } catch (error) {
        console.warn(error);
      }
    });

    const send = async () => {
      const text = (input?.value || "").trim();
      if (!text || sending || !thread) return;
      sending = true;
      if (sendBtn) {
        sendBtn.disabled = true;
        sendBtn.textContent = "…";
      }
      try {
        const viewerId = viewerIdFor(thread);
        const result = await ChatStore.sendMessage(threadId, {
          text,
          senderId: viewerId,
        });
        thread = result.thread || thread;
        messages = result.messages || messages;
        if (input) input.value = "";
        paint();
      } catch (error) {
        console.error(error);
        showToast(error.message || "发送失败");
      } finally {
        sending = false;
        if (sendBtn) {
          sendBtn.disabled = false;
          sendBtn.textContent = "发送";
        }
      }
    };

    sendBtn?.addEventListener("click", () => send());
    input?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        send();
      }
    });
  }

  global.ChatApp = {
    showToast,
    runSplash,
    runChatsPage,
    runChatPage,
    queryParam,
    escapeHtml,
    formatListTime,
    formatMsgTime,
    unreadFor,
    avatarHtml,
    personForAvatar,
    viewerIdFor,
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
