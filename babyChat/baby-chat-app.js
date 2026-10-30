(function () {
  "use strict";

  const MAX_AUDIO_CHARS = 1800000;

  const state = {
    data: null,
    source: "",
    recording: false,
    mediaRecorder: null,
    chunks: [],
    busy: false,
    editingId: null,
  };

  const $ = (id) => document.getElementById(id);

  function toast(message) {
    const el = $("toast");
    el.textContent = message;
    el.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove("show"), 2600);
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

  function setLoading(show, title, sub) {
    const overlay = $("loadingOverlay");
    const titleEl = $("loadingTitle");
    const subEl = $("loadingSub");
    if (!overlay) return;
    if (show) {
      if (titleEl) titleEl.textContent = title || "处理中";
      if (subEl) subEl.textContent = sub || "请稍候…";
      overlay.hidden = false;
      document.body.classList.add("is-loading");
    } else {
      overlay.hidden = true;
      document.body.classList.remove("is-loading");
    }
  }

  function setBusy(busy, title, sub) {
    state.busy = !!busy;
    const send = $("btnSendText");
    const voice = $("btnVoice");
    const refresh = $("btnRefresh");
    if (send) send.disabled = state.busy;
    if (voice) voice.disabled = state.busy;
    if (refresh) refresh.disabled = state.busy;
    if ($("inputText")) $("inputText").disabled = state.busy;
    $("voiceMeta").textContent = busy ? title || "处理中…" : "";
    setLoading(busy, title, sub);
  }

  async function withLoading(title, sub, work) {
    if (state.busy) return null;
    setBusy(true, title, sub);
    try {
      return await work((nextTitle, nextSub) => {
        setBusy(true, nextTitle || title, nextSub || sub);
      });
    } finally {
      setBusy(false);
    }
  }

  async function reload(options) {
    const opts = options || {};
    const run = async () => {
      const loaded = await BabyChatStore.loadRaw();
      state.data = loaded.data;
      state.source = loaded.source;
      render();
    };
    if (opts.silent || state.busy) {
      await run();
      return;
    }
    await withLoading("同步中", "正在拉取最新记录…", run);
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
      state.source === "api" || state.source === "raw"
        ? "已同步"
        : state.source === "local"
          ? "本地预览"
          : "未连接";
    $("ageLine").innerHTML = `<span class="status-dot"></span>${label} · ${src}`;
    const stats = todayStats();
    $("todayMl").textContent = `${stats.ml} ml`;
    $("todayFeeds").textContent = String(stats.feeds);
    $("syncHint").textContent =
      "文字/语音在网页即时解析并自动入库；可随时改记录。每晚 20:00 云函数推微信总结。";
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
        if (state.editingId === e.id) {
          const events = Array.isArray(e.events) ? e.events : [];
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
              : '<div class="meta">无喂奶事件</div>';
          return `<div class="card edit-card" data-id="${escapeHtml(e.id)}">
            <div class="title">编辑记录</div>
            <div class="field">
              <label>原文</label>
              <input class="text-input" type="text" value="${escapeHtml(e.text || "")}" />
            </div>
            <div class="field">
              <label>备注</label>
              <input class="notes-input" type="text" value="${escapeHtml(e.notes || "")}" />
            </div>
            <div class="events-edit">${eventRows}</div>
            <label class="meta" style="display:flex;gap:8px;align-items:center;margin-top:10px">
              <input type="checkbox" class="chat-only" ${e.chatOnly ? "checked" : ""} />
              仅闲聊（不计入奶量）
            </label>
            <div class="row">
              <button type="button" class="primary btn-save-edit" data-id="${escapeHtml(e.id)}">保存</button>
              <button type="button" class="secondary btn-cancel-edit">取消</button>
              <button type="button" class="danger btn-delete" data-id="${escapeHtml(e.id)}">删除</button>
            </div>
          </div>`;
        }
        const title = e.chatOnly
          ? "闲聊"
          : `奶 ${e.mlTotal || 0} ml / ${e.feedCount || 0} 顿`;
        return `<div class="card">
          <div class="title">${escapeHtml(title)}</div>
          <div class="meta">${escapeHtml(formatTime(e.at))} · ${escapeHtml(e.source || "")}</div>
          <div style="margin-top:8px">${escapeHtml(e.text || "")}</div>
          ${e.notes ? `<div class="meta" style="margin-top:6px">${escapeHtml(e.notes)}</div>` : ""}
          <div class="row">
            <button type="button" class="secondary btn-edit" data-id="${escapeHtml(e.id)}">修改</button>
          </div>
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
    renderToday();
    renderSummary();
  }

  async function saveEntryFromParse(options) {
    const opts = options || {};
    const text = String(opts.text || "").trim();
    const parse = opts.parse || {};
    const source = opts.source || "text";
    const date = BabyChatStore.shanghaiDate();
    const stats = BabyChatStore.feedStats(parse.events || []);
    const id = BabyChatStore.newId("e");
    const entry = {
      id,
      at: Date.now(),
      date,
      source,
      text,
      chatOnly: Boolean(parse.chatOnly),
      events: Array.isArray(parse.events) ? parse.events : [],
      notes: String(parse.notes || ""),
      mlTotal: stats.mlTotal,
      feedCount: stats.feedCount,
    };
    await BabyChatStore.patch((data) => {
      data.entries = data.entries || [];
      data.entries.push(entry);
      return data;
    }, "baby-chat: add entry");
    return entry;
  }

  async function submitText() {
    if (state.busy) return;
    const text = String($("inputText").value || "").trim();
    if (!text) {
      toast("先说点什么");
      return;
    }
    try {
      await withLoading("正在解析", "理解口语内容…", async (progress) => {
        const parse = await BabyChatAI.parseDiaryText(text);
        progress("正在保存", "写入今日记录…");
        await saveEntryFromParse({ text, parse, source: "text" });
        $("inputText").value = "";
        progress("同步中", "刷新列表…");
        await reload({ silent: true });
        toast(parse.chatOnly ? "已记闲聊" : "已自动入库");
      });
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

  async function submitVoiceBlob(blob) {
    try {
      await withLoading("处理录音", "读取音频…", async (progress) => {
        const dataUri = await blobToDataUri(blob);
        if (dataUri.length > MAX_AUDIO_CHARS) {
          throw new Error("录音太长，请说短一点");
        }
        progress("语音转写中", "正在听写内容…");
        const asrText = await BabyChatAI.transcribeAudio(dataUri);
        if (!String(asrText || "").trim()) {
          throw new Error("没听清，请再说一次");
        }
        progress("正在解析", "理解口语内容…");
        const parse = await BabyChatAI.parseDiaryText(asrText);
        progress("正在保存", "写入今日记录…");
        await saveEntryFromParse({
          text: asrText,
          parse,
          source: "voice",
        });
        progress("同步中", "刷新列表…");
        await reload({ silent: true });
        toast(parse.chatOnly ? "语音闲聊已记" : "语音已自动入库");
      });
    } catch (error) {
      toast(error.message || "语音处理失败");
    }
  }

  async function startRecording() {
    if (state.recording || state.busy) return;
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
        await submitVoiceBlob(blob);
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
  }

  function readEditCard(card) {
    const textInput = card.querySelector(".text-input");
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
    const onlyChat = !!(chatOnly && chatOnly.checked);
    return {
      text: textInput ? String(textInput.value || "").trim() : "",
      notes: notes ? String(notes.value || "").trim() : "",
      chatOnly: onlyChat,
      events: onlyChat ? [] : events,
    };
  }

  async function saveEdit(id, card) {
    const edits = readEditCard(card);
    const stats = BabyChatStore.feedStats(edits.events);
    await withLoading("保存修改", "正在写入…", async (progress) => {
      await BabyChatStore.patch((data) => {
        const entry = (data.entries || []).find((e) => e && e.id === id);
        if (!entry) return data;
        entry.text = edits.text;
        entry.notes = edits.notes;
        entry.chatOnly = edits.chatOnly;
        entry.events = edits.events;
        entry.mlTotal = stats.mlTotal;
        entry.feedCount = stats.feedCount;
        return data;
      }, "baby-chat: edit entry");
      state.editingId = null;
      progress("同步中", "刷新列表…");
      await reload({ silent: true });
      toast("已保存修改");
    });
  }

  async function deleteEntry(id) {
    await withLoading("删除中", "正在更新记录…", async (progress) => {
      await BabyChatStore.patch((data) => {
        data.entries = (data.entries || []).filter((e) => e && e.id !== id);
        return data;
      }, "baby-chat: delete entry");
      state.editingId = null;
      progress("同步中", "刷新列表…");
      await reload({ silent: true });
      toast("已删除");
    });
  }

  function bindList() {
    $("todayList").addEventListener("click", async (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (state.busy) return;
      const id = target.getAttribute("data-id");
      try {
        if (target.classList.contains("btn-edit") && id) {
          state.editingId = id;
          renderToday();
        } else if (target.classList.contains("btn-cancel-edit")) {
          state.editingId = null;
          renderToday();
        } else if (target.classList.contains("btn-save-edit") && id) {
          const card = target.closest(".edit-card");
          await saveEdit(id, card);
        } else if (target.classList.contains("btn-delete") && id) {
          if (!window.confirm("删除这条记录？")) return;
          await deleteEntry(id);
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
    bindList();
    bindVoiceButton();
    $("btnSendText").addEventListener("click", () => {
      submitText();
    });
    $("btnRefresh").addEventListener("click", () => {
      if (state.busy) return;
      reload()
        .then(() => toast("已刷新"))
        .catch((error) => toast(error.message || "刷新失败"));
    });
    try {
      await withLoading("加载中", "正在打开日记…", async () => {
        await reload({ silent: true });
      });
    } catch (error) {
      toast(error.message || "加载失败");
      $("ageLine").innerHTML =
        '<span class="status-dot warn"></span>加载失败，请检查网络';
    }
  }

  boot();
})();
