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
    toast._t = setTimeout(() => el.classList.remove("show"), 2400);
  }

  function showFlash(message) {
    const el = $("flash");
    if (!el) return;
    el.hidden = false;
    el.textContent = message;
    clearTimeout(showFlash._t);
    showFlash._t = setTimeout(() => {
      el.hidden = true;
    }, 4200);
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

  function pickEveningSummary() {
    const summaries =
      state.data && state.data.summaries && typeof state.data.summaries === "object"
        ? state.data.summaries
        : {};
    const today = BabyChatStore.shanghaiDate();
    if (summaries[today]) return summaries[today];
    const keys = Object.keys(summaries).sort();
    if (!keys.length) return null;
    return summaries[keys[keys.length - 1]];
  }

  function setLoading(show, title, sub) {
    const overlay = $("loadingOverlay");
    if (!overlay) return;
    if (show) {
      $("loadingTitle").textContent = title || "处理中";
      $("loadingSub").textContent = sub || "请稍候…";
      overlay.hidden = false;
      document.body.classList.add("is-loading");
    } else {
      overlay.hidden = true;
      document.body.classList.remove("is-loading");
    }
  }

  function setBusy(busy, title, sub) {
    state.busy = !!busy;
    ["btnSendText", "btnVoice", "inputText"].forEach((id) => {
      const el = $(id);
      if (el) el.disabled = state.busy;
    });
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

  function entryLabel(e) {
    if (!e) return "";
    if (e.chatOnly) return e.notes || e.text || "备注";
    const parts = [];
    if (e.feedCount) {
      parts.push(
        e.mlTotal
          ? `喂奶 ${e.feedCount}次 / ${e.mlTotal}ml`
          : `喂奶 ${e.feedCount}次`,
      );
    }
    if (e.peeCount) parts.push(`小便 ${e.peeCount}次`);
    if (e.poopCount) parts.push(`大便 ${e.poopCount}次`);
    if (e.sleepCount || e.sleepMinutes) {
      parts.push(
        e.sleepMinutes
          ? `睡眠约${e.sleepMinutes}分钟`
          : `睡眠 ${e.sleepCount}次`,
      );
    }
    if (!parts.length && Array.isArray(e.events) && e.events.length) {
      return BabyChatAI.summarizeParse({ events: e.events, notes: e.notes });
    }
    return parts.join(" · ") || e.text || "记录";
  }

  function renderSummary() {
    const body = $("summaryBody");
    if (!state.data) {
      body.textContent = "加载中…";
      return;
    }
    const totals = BabyChatStore.aggregateToday(state.data.entries);
    if (!totals.entryCount) {
      body.innerHTML =
        '今天还没有记录<span class="summary-hint">点这里可查看/修改明细</span>';
      return;
    }
    const rows = [];
    rows.push(
      `<div class="dim"><span>喂奶</span><span>${totals.feedCount} 次${totals.mlTotal ? ` · ${totals.mlTotal} ml` : ""}</span></div>`,
    );
    rows.push(
      `<div class="dim"><span>小便</span><span>${totals.peeCount} 次</span></div>`,
    );
    rows.push(
      `<div class="dim"><span>大便</span><span>${totals.poopCount} 次</span></div>`,
    );
    if (totals.sleepMinutes || totals.sleepCount) {
      rows.push(
        `<div class="dim"><span>睡眠</span><span>${
          totals.sleepMinutes
            ? `约 ${totals.sleepMinutes} 分钟`
            : `${totals.sleepCount} 次`
        }</span></div>`,
      );
    }
    rows.push(
      `<div class="summary-hint">共 ${totals.entryCount} 条 · 点这里可改明细</div>`,
    );
    body.innerHTML = rows.join("");
  }

  function renderEvening() {
    const body = $("eveningBody");
    if (!body) return;
    if (!state.data) {
      body.className = "evening-body is-empty";
      body.textContent = "加载中…";
      return;
    }
    const item = pickEveningSummary();
    if (!item) {
      body.className = "evening-body is-empty";
      body.textContent = "今晚 22:00 后生成，也会推到企业微信";
      return;
    }
    const today = BabyChatStore.shanghaiDate();
    const isToday = item.date === today;
    const text = String(item.content || item.narrative || "").trim();
    const pushState = item.pushedAt
      ? `已推送微信 · ${formatTime(item.pushedAt)}`
      : item.pushError
        ? `未推送：${item.pushError}`
        : "已生成，待推送微信";
    body.className = "evening-body";
    body.innerHTML = `${escapeHtml(text)}<div class="evening-meta">${escapeHtml(
      isToday ? `今日 · ${pushState}` : `${item.date || ""} · ${pushState}`,
    )}</div>`;
  }

  function renderTodayList() {
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
          return `<div class="card edit-card" data-id="${escapeHtml(e.id)}">
            <div class="field">
              <label>原文</label>
              <input class="text-input" type="text" value="${escapeHtml(e.text || "")}" />
            </div>
            <div class="edit-grid">
              <div class="field">
                <label>喂奶次数</label>
                <input data-field="feedCount" type="number" min="0" step="1" value="${Number(e.feedCount) || 0}" />
              </div>
              <div class="field">
                <label>奶量 (ml)</label>
                <input data-field="mlTotal" type="number" min="0" step="1" value="${Number(e.mlTotal) || 0}" />
              </div>
              <div class="field">
                <label>小便次数</label>
                <input data-field="peeCount" type="number" min="0" step="1" value="${Number(e.peeCount) || 0}" />
              </div>
              <div class="field">
                <label>大便次数</label>
                <input data-field="poopCount" type="number" min="0" step="1" value="${Number(e.poopCount) || 0}" />
              </div>
            </div>
            <div class="row">
              <button type="button" class="primary btn-save-edit" data-id="${escapeHtml(e.id)}">保存</button>
              <button type="button" class="secondary btn-cancel-edit" data-id="${escapeHtml(e.id)}">取消</button>
            </div>
          </div>`;
        }
        return `<div class="card">
          <div class="title">${escapeHtml(entryLabel(e))}</div>
          <div class="meta">${escapeHtml(formatTime(e.at))} · ${escapeHtml(e.source || "")}</div>
          <div style="margin-top:8px">${escapeHtml(e.text || "")}</div>
          <div class="row">
            <button type="button" class="secondary btn-edit" data-id="${escapeHtml(e.id)}">修改</button>
            <button type="button" class="danger btn-delete" data-id="${escapeHtml(e.id)}">删除</button>
          </div>
        </div>`;
      })
      .join("");
  }

  function render() {
    if (!state.data) return;
    renderSummary();
    renderEvening();
    if (!$("detailSheet").hidden) renderTodayList();
  }

  function openSheet() {
    $("detailSheet").hidden = false;
    renderTodayList();
  }

  function closeSheet() {
    state.editingId = null;
    $("detailSheet").hidden = true;
  }

  function buildEntry(opts) {
    const parse = opts.parse || {};
    const stats = BabyChatStore.eventStats(parse.events || []);
    return {
      id: BabyChatStore.newId("e"),
      at: Date.now(),
      date: BabyChatStore.shanghaiDate(),
      source: opts.source || "text",
      text: String(opts.text || "").trim(),
      chatOnly: Boolean(parse.chatOnly),
      events: Array.isArray(parse.events) ? parse.events : [],
      notes: String(parse.notes || ""),
      mlTotal: stats.mlTotal,
      feedCount: stats.feedCount,
      peeCount: stats.peeCount,
      poopCount: stats.poopCount,
      sleepMinutes: stats.sleepMinutes,
      sleepCount: stats.sleepCount,
    };
  }

  function applyData(data, source) {
    state.data = BabyChatStore.normalizeData(data);
    state.source = source || "api";
    render();
  }

  async function saveEntryFromParse(options) {
    const entry = buildEntry(options);
    const saved = await BabyChatStore.patch((data) => {
      data.entries = data.entries || [];
      data.entries.push(entry);
      return data;
    }, "baby-chat: add entry");
    return { entry, data: saved && saved.data };
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
        const saved = await saveEntryFromParse({ text, parse, source: "text" });
        $("inputText").value = "";
        if (saved.data) {
          applyData(saved.data, "api");
        } else {
          progress("同步中", "更新总结…");
          await reload({ silent: true });
        }
        const tip = BabyChatAI.summarizeParse(parse);
        showFlash(`已记：${tip}`);
        toast("已记录");
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
        const saved = await saveEntryFromParse({
          text: asrText,
          parse,
          source: "voice",
        });
        if (saved.data) {
          applyData(saved.data, "api");
        } else {
          progress("同步中", "更新总结…");
          await reload({ silent: true });
        }
        showFlash(`已记：${BabyChatAI.summarizeParse(parse)}`);
        toast("已记录");
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
    const num = (sel) => {
      const el = card.querySelector(`[data-field="${sel}"]`);
      const n = Number(el && el.value);
      return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
    };
    const textInput = card.querySelector(".text-input");
    return {
      text: textInput ? String(textInput.value || "").trim() : "",
      feedCount: num("feedCount"),
      mlTotal: num("mlTotal"),
      peeCount: num("peeCount"),
      poopCount: num("poopCount"),
    };
  }

  async function saveEdit(id, card) {
    if (!card) throw new Error("找不到编辑卡片");
    const edits = readEditCard(card);
    const saved = await BabyChatStore.patch((data) => {
      const entry = (data.entries || []).find((e) => e && e.id === id);
      if (!entry) return data;
      entry.text = edits.text;
      entry.chatOnly = false;
      entry.notes = entry.notes || "";
      entry.feedCount = edits.feedCount;
      entry.mlTotal = edits.mlTotal;
      entry.peeCount = edits.peeCount;
      entry.poopCount = edits.poopCount;
      const events = [];
      if (edits.feedCount) {
        events.push({
          type: "feed",
          count: edits.feedCount,
          ml: edits.mlTotal || null,
          method: "unknown",
          estimated: false,
        });
      }
      if (edits.peeCount) {
        events.push({ type: "pee", count: edits.peeCount });
      }
      if (edits.poopCount) {
        events.push({ type: "poop", count: edits.poopCount });
      }
      entry.events = events;
      if (!events.length && !edits.text) {
        entry.chatOnly = true;
      }
      return data;
    }, "baby-chat: edit entry");
    state.editingId = null;
    if (saved && saved.data) applyData(saved.data, "api");
    else await reload({ silent: true });
    renderTodayList();
    toast("已保存");
  }

  async function deleteEntry(id) {
    const saved = await BabyChatStore.patch((data) => {
      const before = (data.entries || []).length;
      data.entries = (data.entries || []).filter((e) => e && e.id !== id);
      if (data.entries.length === before) {
        throw new Error("未找到要删除的记录");
      }
      return data;
    }, "baby-chat: delete entry");
    if (state.editingId === id) state.editingId = null;
    if (saved && saved.data) applyData(saved.data, "api");
    else await reload({ silent: true });
    renderTodayList();
    toast("已删除");
  }

  function bind() {
    $("btnSendText").addEventListener("click", () => submitText());
    $("summaryPanel").addEventListener("click", () => {
      if (!state.busy) openSheet();
    });
    $("sheetClose").addEventListener("click", closeSheet);
    $("sheetBackdrop").addEventListener("click", closeSheet);

    $("todayList").addEventListener("click", async (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || state.busy) return;
      const btn = target.closest("button");
      if (!btn) return;
      event.preventDefault();
      event.stopPropagation();
      const id = btn.getAttribute("data-id");
      try {
        if (btn.classList.contains("btn-edit") && id) {
          state.editingId = id;
          renderTodayList();
        } else if (btn.classList.contains("btn-cancel-edit")) {
          state.editingId = null;
          renderTodayList();
        } else if (btn.classList.contains("btn-save-edit") && id) {
          await withLoading("保存修改", "正在写入…", async () => {
            await saveEdit(id, btn.closest(".edit-card"));
          });
        } else if (btn.classList.contains("btn-delete") && id) {
          const ok = window.confirm("确定删除这条记录？");
          if (!ok) return;
          await withLoading("删除中", "正在更新…", async () => {
            await deleteEntry(id);
          });
        }
      } catch (error) {
        toast(error.message || "操作失败");
      }
    });

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
    bind();
    try {
      await withLoading("加载中", "正在打开…", async () => {
        await reload({ silent: true });
      });
    } catch (error) {
      toast(error.message || "加载失败");
      $("summaryBody").textContent = "加载失败，请检查网络或配置";
    }
  }

  boot();
})();
