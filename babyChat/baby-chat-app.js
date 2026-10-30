(function () {
  "use strict";

  const MAX_AUDIO_CHARS = 1200000; // ~0.9MB base64 budget for GitHub JSON
  const POLL_MS = 12000;

  const state = {
    data: null,
    source: "",
    recording: false,
    mediaRecorder: null,
    chunks: [],
    pollTimer: null,
  };

  const $ = (id) => document.getElementById(id);

  function toast(message) {
    const el = $("toast");
    el.textContent = message;
    el.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove("show"), 2400);
  }

  function escapeHtml(text) {
    return String(text || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function formatTime(ms) {
    if (!ms) return "";
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai",
      hour: "2-digit",
      minute: "2-digit",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(ms));
  }

  async function ensureVault() {
    if (!globalThis.GithubTokenVault) {
      throw new Error("缺少 github-token-vault.js");
    }
    await globalThis.GithubTokenVault.ensureUnlocked();
  }

  async function reload() {
    await ensureVault();
    const loaded = await BabyChatStore.loadRaw();
    state.data = loaded.data;
    state.source = loaded.source;
    render();
  }

  function todayStats() {
    const date = BabyChatStore.shanghaiDate();
    let ml = 0;
    let feeds = 0;
    (state.data.entries || []).forEach((e) => {
      if (!e || e.date !== date || e.chatOnly) return;
      ml += Number(e.mlTotal) || 0;
      feeds += Number(e.feedCount) || 0;
    });
    return { ml, feeds, date };
  }

  function renderHeader() {
    const cfg = state.data.config || {};
    $("brandName").textContent = cfg.name || "葫芦宝";
    const days = BabyChatStore.ageDaysOn(
      cfg.birthDate,
      BabyChatStore.shanghaiDate(),
    );
    const label = BabyChatStore.ageLabel(days);
    const src =
      state.source === "api"
        ? "已同步"
        : state.source === "local"
          ? "本地预览"
          : "未连接";
    $("ageLine").innerHTML = `<span class="status-dot"></span>${label} · ${src}`;
    const stats = todayStats();
    $("todayMl").textContent = `${stats.ml} ml`;
    $("todayFeeds").textContent = String(stats.feeds);
    const lastRun = state.data.state && state.data.state.lastRunAt;
    $("syncHint").textContent = lastRun
      ? `云函数最近跑过：${formatTime(lastRun)}。提交后等定时解析（通常几分钟）。微信只收每晚总结。`
      : "云函数仅定时跑：提交后需等解析（通常几分钟内）。微信只收每晚总结。";
  }

  function pendingItems() {
    return (state.data.queue || []).filter(
      (q) =>
        q &&
        (q.status === "raw" ||
          q.status === "parsed" ||
          q.status === "error"),
    );
  }

  function renderPending() {
    const list = $("pendingList");
    const items = pendingItems().slice().reverse();
    if (!items.length) {
      list.innerHTML = '<div class="empty">暂无待确认</div>';
      return;
    }
    list.innerHTML = items
      .map((item) => {
        if (item.status === "raw") {
          return `<div class="card" data-id="${escapeHtml(item.id)}">
            <div class="title"><span class="badge warn">解析中</span>${escapeHtml(item.source === "voice" ? "语音" : "文字")}</div>
            <div class="meta">${escapeHtml(formatTime(item.createdAt))}</div>
            <div style="margin-top:8px">${escapeHtml(item.rawText || "（语音排队中，等云函数转写）")}</div>
          </div>`;
        }
        if (item.status === "error") {
          return `<div class="card" data-id="${escapeHtml(item.id)}">
            <div class="title"><span class="badge err">失败</span></div>
            <div class="meta">${escapeHtml(item.error || "未知错误")}</div>
            <div class="row">
              <button type="button" class="secondary btn-dismiss" data-id="${escapeHtml(item.id)}">忽略</button>
            </div>
          </div>`;
        }
        const parse = item.parse || {};
        const events = Array.isArray(parse.events) ? parse.events : [];
        const eventRows =
          events.length > 0
            ? events
                .map((ev, idx) => {
                  return `<div class="event-row">
                    <input data-ev="${idx}" data-field="ml" type="number" min="0" step="1" value="${ev.ml != null ? escapeHtml(ev.ml) : ""}" placeholder="ml" />
                    <select data-ev="${idx}" data-field="method">
                      <option value="unknown" ${ev.method === "unknown" ? "selected" : ""}>方式不明</option>
                      <option value="bottle" ${ev.method === "bottle" ? "selected" : ""}>奶瓶</option>
                      <option value="breast" ${ev.method === "breast" ? "selected" : ""}>母乳</option>
                    </select>
                    <span class="meta">${ev.estimated ? "约" : ""}</span>
                  </div>`;
                })
                .join("")
            : '<div class="meta">无喂奶事件（可能是闲聊）</div>';
        return `<div class="card confirm-card" data-id="${escapeHtml(item.id)}">
          <div class="title"><span class="badge">待确认</span>${parse.chatOnly ? "闲聊" : "记账"}</div>
          <div class="meta">${escapeHtml(formatTime(item.parsedAt || item.createdAt))} · 置信 ${Math.round((Number(parse.confidence) || 0) * 100)}%</div>
          <div style="margin-top:8px">${escapeHtml(item.rawText || item.asrText || "")}</div>
          <div class="field">
            <label>备注 / 闲聊</label>
            <input class="notes-input" type="text" value="${escapeHtml(parse.notes || "")}" />
          </div>
          <div class="events-edit">${eventRows}</div>
          <label class="meta" style="display:flex;gap:8px;align-items:center;margin-top:10px">
            <input type="checkbox" class="chat-only" ${parse.chatOnly ? "checked" : ""} />
            仅闲聊（不计入奶量）
          </label>
          <div class="row">
            <button type="button" class="primary btn-confirm" data-id="${escapeHtml(item.id)}">确认入库</button>
            <button type="button" class="danger btn-reject" data-id="${escapeHtml(item.id)}">丢弃</button>
          </div>
        </div>`;
      })
      .join("");
  }

  function renderToday() {
    const list = $("todayList");
    const date = BabyChatStore.shanghaiDate();
    const items = (state.data.entries || [])
      .filter((e) => e && e.date === date)
      .slice()
      .reverse();
    if (!items.length) {
      list.innerHTML = '<div class="empty">还没有记录</div>';
      return;
    }
    list.innerHTML = items
      .map((e) => {
        const title = e.chatOnly
          ? "闲聊"
          : `奶 ${e.mlTotal || 0} ml / ${e.feedCount || 0} 顿`;
        return `<div class="card">
          <div class="title">${escapeHtml(title)}</div>
          <div class="meta">${escapeHtml(formatTime(e.at))} · ${escapeHtml(e.source || "")}</div>
          <div style="margin-top:8px">${escapeHtml(e.text || "")}</div>
          ${e.notes ? `<div class="meta" style="margin-top:6px">${escapeHtml(e.notes)}</div>` : ""}
        </div>`;
      })
      .join("");
  }

  function renderSummary() {
    const box = $("summaryBox");
    const keys = Object.keys(state.data.summaries || {}).sort();
    if (!keys.length) {
      box.className = "summary-box empty";
      box.textContent = "暂无";
      return;
    }
    const last = state.data.summaries[keys[keys.length - 1]];
    box.className = "summary-box";
    const pushState = last.pushedAt
      ? `已推送 ${formatTime(last.pushedAt)}`
      : last.pushError
        ? `未推送：${last.pushError}`
        : "已生成，待推送";
    box.textContent = `${last.content || last.narrative || ""}\n\n—— ${pushState}`;
  }

  function render() {
    if (!state.data) return;
    renderHeader();
    renderPending();
    renderToday();
    renderSummary();
  }

  async function enqueue(payload) {
    await BabyChatStore.patch((data) => {
      data.queue = data.queue || [];
      data.queue.push(payload);
      return data;
    }, "baby-chat: enqueue");
    await reload();
  }

  async function sendText() {
    const text = String($("inputText").value || "").trim();
    if (!text) {
      toast("先说点什么");
      return;
    }
    try {
      await enqueue({
        id: BabyChatStore.newId("q"),
        createdAt: Date.now(),
        source: "text",
        status: "raw",
        rawText: text,
        audioDataUri: null,
        asrText: "",
        parse: null,
        error: "",
      });
      $("inputText").value = "";
      toast("已提交，等待云函数解析");
    } catch (error) {
      toast(error.message || "提交失败");
    }
  }

  function blobToDataUri(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(new Error("读取录音失败"));
      reader.readAsDataURL(blob);
    });
  }

  async function sendVoiceBlob(blob) {
    const dataUri = await blobToDataUri(blob);
    if (dataUri.length > MAX_AUDIO_CHARS) {
      throw new Error("录音太长，请说短一点再试");
    }
    await enqueue({
      id: BabyChatStore.newId("q"),
      createdAt: Date.now(),
      source: "voice",
      status: "raw",
      rawText: "",
      audioDataUri: dataUri,
      asrText: "",
      parse: null,
      error: "",
    });
    toast("语音已提交，等待转写+解析");
  }

  async function startRecording() {
    if (state.recording) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      toast("当前浏览器不支持录音");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : MediaRecorder.isTypeSupported("audio/webm")
          ? "audio/webm"
          : "";
      const recorder = new MediaRecorder(
        stream,
        mime ? { mimeType: mime } : undefined,
      );
      state.chunks = [];
      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) state.chunks.push(event.data);
      };
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(state.chunks, {
          type: recorder.mimeType || "audio/webm",
        });
        state.chunks = [];
        try {
          await sendVoiceBlob(blob);
        } catch (error) {
          toast(error.message || "上传语音失败");
        }
      };
      state.mediaRecorder = recorder;
      state.recording = true;
      recorder.start();
      const btn = $("btnVoice");
      btn.classList.add("recording");
      btn.textContent = "松开结束";
      $("voiceMeta").textContent = "录音中…";
    } catch (error) {
      toast(error.message || "无法打开麦克风");
    }
  }

  function stopRecording() {
    if (!state.recording || !state.mediaRecorder) return;
    state.recording = false;
    try {
      state.mediaRecorder.stop();
    } catch (error) {
      /* ignore */
    }
    state.mediaRecorder = null;
    const btn = $("btnVoice");
    btn.classList.remove("recording");
    btn.textContent = "按住说话";
    $("voiceMeta").textContent = "";
  }

  function readConfirmCard(card) {
    const notes = card.querySelector(".notes-input");
    const chatOnly = card.querySelector(".chat-only");
    const eventRows = [...card.querySelectorAll(".event-row")];
    const events = eventRows.map((row) => {
      const mlInput = row.querySelector('[data-field="ml"]');
      const methodInput = row.querySelector('[data-field="method"]');
      const ml = Number(mlInput && mlInput.value);
      return {
        type: "feed",
        ml: Number.isFinite(ml) && ml > 0 ? Math.round(ml) : null,
        method: (methodInput && methodInput.value) || "unknown",
        estimated: false,
      };
    });
    return {
      notes: notes ? String(notes.value || "").trim() : "",
      chatOnly: !!(chatOnly && chatOnly.checked),
      events: chatOnly && chatOnly.checked ? [] : events,
    };
  }

  async function confirmItem(id, card) {
    const edits = readConfirmCard(card);
    const date = BabyChatStore.shanghaiDate();
    await BabyChatStore.patch((data) => {
      const item = (data.queue || []).find((q) => q && q.id === id);
      if (!item || item.status !== "parsed") return data;
      const parse = Object.assign({}, item.parse || {}, {
        notes: edits.notes,
        chatOnly: edits.chatOnly,
        events: edits.events,
        intent: edits.chatOnly ? "chat" : item.parse && item.parse.intent,
      });
      item.parse = parse;
      item.status = "archived";
      item.confirmedAt = Date.now();
      item.audioDataUri = null;
      const stats = BabyChatStore.feedStats(parse.events);
      data.entries = data.entries || [];
      if (!data.entries.some((e) => e && e.id === id)) {
        data.entries.push({
          id,
          at: item.confirmedAt,
          date,
          source: item.source || "text",
          text: String(item.rawText || item.asrText || ""),
          chatOnly: Boolean(parse.chatOnly),
          events: parse.events || [],
          notes: String(parse.notes || ""),
          mlTotal: stats.mlTotal,
          feedCount: stats.feedCount,
        });
      }
      return data;
    }, "baby-chat: confirm entry");
    await reload();
    toast("已确认");
  }

  async function rejectItem(id) {
    await BabyChatStore.patch((data) => {
      const item = (data.queue || []).find((q) => q && q.id === id);
      if (!item) return data;
      item.status = "rejected";
      item.audioDataUri = null;
      return data;
    }, "baby-chat: reject");
    await reload();
    toast("已丢弃");
  }

  async function dismissError(id) {
    await BabyChatStore.patch((data) => {
      const item = (data.queue || []).find((q) => q && q.id === id);
      if (!item) return data;
      item.status = "rejected";
      item.audioDataUri = null;
      return data;
    }, "baby-chat: dismiss error");
    await reload();
  }

  function bindPendingClicks() {
    $("pendingList").addEventListener("click", async (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const id = target.getAttribute("data-id");
      if (!id) return;
      try {
        if (target.classList.contains("btn-confirm")) {
          const card = target.closest(".confirm-card");
          await confirmItem(id, card);
        } else if (target.classList.contains("btn-reject")) {
          await rejectItem(id);
        } else if (target.classList.contains("btn-dismiss")) {
          await dismissError(id);
        }
      } catch (error) {
        toast(error.message || "操作失败");
      }
    });
  }

  function bindVoiceButton() {
    const btn = $("btnVoice");
    const start = (event) => {
      event.preventDefault();
      startRecording();
    };
    const stop = (event) => {
      event.preventDefault();
      stopRecording();
    };
    btn.addEventListener("mousedown", start);
    btn.addEventListener("mouseup", stop);
    btn.addEventListener("mouseleave", stop);
    btn.addEventListener("touchstart", start, { passive: false });
    btn.addEventListener("touchend", stop);
    btn.addEventListener("touchcancel", stop);
  }

  async function boot() {
    bindPendingClicks();
    bindVoiceButton();
    $("btnSendText").addEventListener("click", () => {
      sendText().catch((error) => toast(error.message || "发送失败"));
    });
    $("btnRefresh").addEventListener("click", () => {
      reload()
        .then(() => toast("已刷新"))
        .catch((error) => toast(error.message || "刷新失败"));
    });
    try {
      await reload();
    } catch (error) {
      toast(error.message || "加载失败");
      $("ageLine").innerHTML =
        '<span class="status-dot warn"></span>请先解锁 GitHub 保险库';
    }
    state.pollTimer = setInterval(() => {
      reload().catch(() => {});
    }, POLL_MS);
  }

  boot();
})();
