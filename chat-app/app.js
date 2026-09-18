(function (global) {
  "use strict";

  const READ_KEY = "chat-app.readMap";

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

  function getReadMap() {
    try {
      const raw = sessionStorage.getItem(READ_KEY);
      const data = raw ? JSON.parse(raw) : {};
      return data && typeof data === "object" ? data : {};
    } catch (error) {
      return {};
    }
  }

  function markThreadRead(threadId) {
    const map = getReadMap();
    map[String(threadId)] = Date.now();
    sessionStorage.setItem(READ_KEY, JSON.stringify(map));
  }

  function effectiveUnread(thread) {
    if (!thread) return 0;
    const map = getReadMap();
    if (map[thread.id]) return 0;
    return Number(thread.unread) || 0;
  }

  function initials(title) {
    const t = String(title || "?").trim();
    if (!t) return "?";
    return t.slice(0, 1).toUpperCase();
  }

  function avatarHtml(thread, className) {
    const cls = className || "avatar";
    const title = (thread && thread.title) || "";
    if (thread && thread.avatar) {
      return `<div class="${cls}"><img src="${escapeAttr(thread.avatar)}" alt="" /></div>`;
    }
    return `<div class="${cls}">${escapeHtml(initials(title))}</div>`;
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
          const unread = effectiveUnread(thread);
          const badge =
            unread > 0
              ? `<span class="badge${thread.muted ? " muted" : ""}">${
                  unread > 99 ? "99+" : unread
                }</span>`
              : "";
          return `<a class="thread-item${
            thread.pinned ? " is-pinned" : ""
          }" href="./chat.html?id=${encodeURIComponent(thread.id)}">
            ${avatarHtml(thread)}
            <div class="thread-main">
              <div class="thread-row">
                <div class="thread-title">${escapeHtml(thread.title)}</div>
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

  async function runChatPage() {
    const threadId = queryParam("id");
    const scroller = qs("msgScroller");
    const titleEl = qs("chatTitle");
    if (!scroller) return;

    if (!threadId) {
      scroller.innerHTML = '<div class="empty-state">缺少会话 id</div>';
      return;
    }

    scroller.innerHTML = skeletonList(5);
    markThreadRead(threadId);

    let thread = null;
    try {
      const threadsFile = await ChatStore.loadThreads();
      thread = (threadsFile.threads || []).find((t) => t.id === threadId) || {
        id: threadId,
        title: threadId,
        avatar: "",
      };
      if (titleEl) titleEl.textContent = thread.title || threadId;
    } catch (error) {
      if (titleEl) titleEl.textContent = threadId;
    }

    try {
      const file = await ChatStore.loadMessages(threadId);
      const messages = file.messages || [];
      if (!messages.length) {
        scroller.innerHTML = '<div class="empty-state">暂无消息</div>';
        return;
      }
      let prevAt = 0;
      const meThread = { title: "我", avatar: "" };
      scroller.innerHTML = messages
        .map((msg) => {
          const sep = shouldShowTimeSep(prevAt, msg.at)
            ? `<div class="time-sep">${escapeHtml(formatMsgTime(msg.at))}</div>`
            : "";
          prevAt = msg.at;
          const who = msg.role === "me" ? meThread : thread;
          return `${sep}<div class="msg-row ${msg.role}">
            ${avatarHtml(who, "msg-avatar")}
            <div class="bubble">${escapeHtml(msg.text)}</div>
          </div>`;
        })
        .join("");
      scroller.scrollTop = scroller.scrollHeight;
    } catch (error) {
      console.error(error);
      scroller.innerHTML = `<div class="empty-state">${escapeHtml(
        error.message || "加载失败",
      )}</div>`;
    }

    qs("sendBtn")?.addEventListener("click", () => {
      showToast("演示版不可发送");
    });
    qs("composerInput")?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        showToast("演示版不可发送");
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
    markThreadRead,
    effectiveUnread,
    avatarHtml,
    initials,
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
