(function () {
  "use strict";

  const state = {
    data: null,
    source: "",
    metric: "weight",
    view: "overview",
    editingMonthAge: null,
    monthDraft: null,
    dirty: false,
  };

  const $ = (id) => document.getElementById(id);

  function toast(message) {
    const el = $("toast");
    el.textContent = message;
    el.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove("show"), 2200);
  }

  function parseNum(value) {
    if (value == null || String(value).trim() === "") return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function formatNum(n, digits) {
    if (n == null || !Number.isFinite(n)) return "—";
    return Number(n).toFixed(digits);
  }

  function currentAgeDays() {
    return BabyStore.ageDaysOn(state.data.profile.birthDate);
  }

  function monthAgeFromDays(days) {
    if (days == null || days < 0) return 0;
    return Math.floor(days / 30);
  }

  function showPanel(name) {
    state.view = name;
    ["Overview", "Month", "Settings"].forEach((key) => {
      const el = $(`panel${key}`);
      if (!el) return;
      el.classList.toggle("active", key.toLowerCase() === name);
    });
  }

  function renderAgeLine() {
    const profile = state.data.profile;
    $("brandName").textContent = profile.name || "葫芦宝";
    const days = currentAgeDays();
    if (days == null) {
      $("ageLine").innerHTML =
        '<span class="status-dot warn"></span>请先在设置里填写生日';
      return;
    }
    const months = monthAgeFromDays(days);
    const src =
      state.source === "api" || state.source === "raw"
        ? "已同步"
        : state.source === "local"
          ? "本地预览"
          : "未连接";
    $("ageLine").innerHTML = `<span class="status-dot"></span>第 ${days} 天 · ${months} 月龄 · ${src}`;
  }

  function getMonth(monthAge) {
    return state.data.months.find((m) => m.monthAge === monthAge) || null;
  }

  function clone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  function ensureMonthDraft(monthAge) {
    const existing = getMonth(monthAge);
    if (existing) {
      state.monthDraft = clone(existing);
    } else {
      const start = monthAge * 30 + 1;
      const end = (monthAge + 1) * 30;
      state.monthDraft = {
        monthAge,
        ageLabel: `${start}-${end}天`,
        metrics: {
          weightStartKg: null,
          weightEndKg: null,
          heightStartCm: null,
          heightEndCm: null,
          headCm: null,
          milkNote: "",
          sleepHours: null,
        },
        milestones: [],
        notes: { diaper: "", care: "", dailyLife: "", extra: "" },
        updatedAt: 0,
      };
    }
    state.editingMonthAge = monthAge;
    state.dirty = false;
  }

  function metricKey(metric) {
    if (metric === "height") return "heightCm";
    if (metric === "head") return "headCm";
    return "weightKg";
  }

  function unitFor(metric) {
    return metric === "weight" ? "kg" : "cm";
  }

  function babyPoints(metric) {
    const key = metricKey(metric);
    const birth = state.data.profile.birthDate;
    const sex = state.data.profile.sex;
    return state.data.measurements
      .filter((m) => m[key] != null)
      .map((m) => {
        const days = BabyStore.ageDaysOn(birth, m.date);
        if (days == null || days < 0) return null;
        const month = WhoLms.daysToMonths(days);
        const value = m[key];
        const pct = WhoLms.percentileFor(metric, sex, month, value);
        return { month, value, pct, note: m.note || "", date: m.date };
      })
      .filter(Boolean)
      .sort((a, b) => a.month - b.month);
  }

  function drawChart() {
    const canvas = $("growthChart");
    if (!canvas || !state.data) return;
    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth || 800;
    const cssH = canvas.clientHeight || 320;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const pad = { t: 18, r: 16, b: 34, l: 44 };
    const w = cssW - pad.l - pad.r;
    const h = cssH - pad.t - pad.b;

    ctx.clearRect(0, 0, cssW, cssH);

    const days = currentAgeDays() || 100;
    const maxMonth = Math.min(24, Math.max(4, Math.ceil(WhoLms.daysToMonths(days) + 1.5)));
    const sex = state.data.profile.sex || "male";
    const bands = WhoLms.bandSeries(state.metric, sex, maxMonth);
    const points = babyPoints(state.metric);

    let yMin = Infinity;
    let yMax = -Infinity;
    bands.forEach((b) => {
      yMin = Math.min(yMin, b.p3);
      yMax = Math.max(yMax, b.p97);
    });
    points.forEach((p) => {
      yMin = Math.min(yMin, p.value);
      yMax = Math.max(yMax, p.value);
    });
    if (!Number.isFinite(yMin) || !Number.isFinite(yMax)) {
      yMin = 0;
      yMax = 10;
    }
    const padY = (yMax - yMin) * 0.08 || 1;
    yMin -= padY;
    yMax += padY;

    const xOf = (m) => pad.l + (m / maxMonth) * w;
    const yOf = (v) => pad.t + ((yMax - v) / (yMax - yMin)) * h;

    // grid
    ctx.strokeStyle = "rgba(28,36,32,0.08)";
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i += 1) {
      const y = pad.t + (h * i) / 4;
      ctx.beginPath();
      ctx.moveTo(pad.l, y);
      ctx.lineTo(pad.l + w, y);
      ctx.stroke();
    }

    // WHO band P3-P97
    ctx.beginPath();
    bands.forEach((b, i) => {
      const x = xOf(b.month);
      const y = yOf(b.p97);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    for (let i = bands.length - 1; i >= 0; i -= 1) {
      const b = bands[i];
      ctx.lineTo(xOf(b.month), yOf(b.p3));
    }
    ctx.closePath();
    ctx.fillStyle = "rgba(78, 122, 98, 0.14)";
    ctx.fill();

    // P15-P85 inner
    ctx.beginPath();
    bands.forEach((b, i) => {
      const x = xOf(b.month);
      const y = yOf(b.p85);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    for (let i = bands.length - 1; i >= 0; i -= 1) {
      const b = bands[i];
      ctx.lineTo(xOf(b.month), yOf(b.p15));
    }
    ctx.closePath();
    ctx.fillStyle = "rgba(78, 122, 98, 0.16)";
    ctx.fill();

    // P50 dashed
    ctx.beginPath();
    bands.forEach((b, i) => {
      const x = xOf(b.month);
      const y = yOf(b.p50);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.setLineDash([5, 5]);
    ctx.strokeStyle = "rgba(47, 107, 79, 0.75)";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.setLineDash([]);

    // baby line
    if (points.length) {
      ctx.beginPath();
      points.forEach((p, i) => {
        const x = xOf(p.month);
        const y = yOf(p.value);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.strokeStyle = "#e07a5f";
      ctx.lineWidth = 2.4;
      ctx.stroke();

      points.forEach((p) => {
        const x = xOf(p.month);
        const y = yOf(p.value);
        ctx.beginPath();
        ctx.arc(x, y, 4.5, 0, Math.PI * 2);
        ctx.fillStyle = "#e07a5f";
        ctx.fill();
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 1.5;
        ctx.stroke();
      });
    }

    // axes labels
    ctx.fillStyle = "#4a5750";
    ctx.font = "12px DM Sans, sans-serif";
    ctx.textAlign = "center";
    for (let m = 0; m <= maxMonth; m += 1) {
      if (maxMonth > 12 && m % 2 !== 0) continue;
      ctx.fillText(`${m}月`, xOf(m), cssH - 10);
    }
    ctx.textAlign = "right";
    for (let i = 0; i <= 4; i += 1) {
      const v = yMax - ((yMax - yMin) * i) / 4;
      ctx.fillText(v.toFixed(state.metric === "weight" ? 1 : 0), pad.l - 8, pad.t + (h * i) / 4 + 4);
    }

    const last = points[points.length - 1];
    if (last) {
      const pctText =
        last.pct != null ? `约 P${last.pct}` : "百分位暂不可算";
      $("chartHint").textContent = `最近 ${formatNum(last.value, state.metric === "weight" ? 2 : 1)} ${unitFor(state.metric)} · ${pctText}`;
    } else {
      $("chartHint").textContent = "还没有该指标的实测点";
    }
  }

  function renderMonthCards() {
    const grid = $("monthGrid");
    const days = currentAgeDays();
    const currentMonth = days == null ? 2 : Math.max(1, monthAgeFromDays(days));
    const maxShow = Math.max(currentMonth, ...state.data.months.map((m) => m.monthAge), 2);

    const cards = [];
    for (let m = 1; m <= maxShow; m += 1) {
      const rec = getMonth(m);
      const done = rec
        ? rec.milestones.filter((x) => x.done).length
        : 0;
      const total = rec ? rec.milestones.length : 0;
      const w =
        rec && rec.metrics.weightEndKg != null
          ? `${formatNum(rec.metrics.weightStartKg, 2)} → ${formatNum(rec.metrics.weightEndKg, 2)} kg`
          : "";
      const h =
        rec && rec.metrics.heightEndCm != null
          ? `${formatNum(rec.metrics.heightStartCm, 0)} → ${formatNum(rec.metrics.heightEndCm, 0)} cm`
          : "";
      const sticker = rec
        ? done === total && total > 0
          ? "本月满星"
          : "已记录"
        : m === currentMonth
          ? "正当时"
          : "待开启";
      cards.push(`
        <button type="button" class="month-card" data-month="${m}">
          <span class="sticker">${sticker}</span>
          <div class="label">${m} 月龄</div>
          <div class="sub">${rec ? rec.ageLabel : m === currentMonth ? "等你来写小结" : "还没开始呢"}</div>
          <div class="stats">
            ${
              rec
                ? `<div>${w || "体重 —"}</div><div>${h || "身长 —"}</div><div>里程碑 ${done}/${total}</div>`
                : `<div class="empty">点这里写下这一月</div>`
            }
          </div>
        </button>
      `);
    }
    grid.innerHTML = cards.join("");
    grid.querySelectorAll(".month-card").forEach((btn) => {
      btn.addEventListener("click", () => {
        openMonth(Number(btn.dataset.month));
      });
    });
  }

  function autoSizeTextareas() {
    document.querySelectorAll("#panelMonth textarea").forEach((ta) => {
      ta.style.height = "auto";
      ta.style.height = `${Math.max(120, ta.scrollHeight)}px`;
    });
  }

  function renderMilestones() {
    const list = $("milestoneList");
    const items = state.monthDraft.milestones || [];
    list.innerHTML = items
      .map(
        (item, index) => `
      <label class="milestone-item">
        <input type="checkbox" data-index="${index}" ${item.done ? "checked" : ""} />
        <span>${escapeHtml(item.text)}</span>
        <button type="button" class="remove" data-remove="${index}" aria-label="删除">×</button>
      </label>
    `,
      )
      .join("");

    list.querySelectorAll('input[type="checkbox"]').forEach((input) => {
      input.addEventListener("change", () => {
        const i = Number(input.dataset.index);
        state.monthDraft.milestones[i].done = input.checked;
        state.dirty = true;
      });
    });
    list.querySelectorAll("[data-remove]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const i = Number(btn.dataset.remove);
        state.monthDraft.milestones.splice(i, 1);
        state.dirty = true;
        renderMilestones();
      });
    });
  }

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function fillMonthForm() {
    const d = state.monthDraft;
    $("monthTitle").textContent = `${d.monthAge} 月龄`;
    $("ageLabel").value = d.ageLabel || "";
    $("sleepHours").value = d.metrics.sleepHours ?? "";
    $("weightStartKg").value = d.metrics.weightStartKg ?? "";
    $("weightEndKg").value = d.metrics.weightEndKg ?? "";
    $("heightStartCm").value = d.metrics.heightStartCm ?? "";
    $("heightEndCm").value = d.metrics.heightEndCm ?? "";
    $("headCm").value = d.metrics.headCm ?? "";
    $("milkNote").value = d.metrics.milkNote || "";
    $("noteDiaper").value = d.notes.diaper || "";
    $("noteCare").value = d.notes.care || "";
    $("noteDaily").value = d.notes.dailyLife || "";
    $("noteExtra").value = d.notes.extra || "";
    renderMilestones();
    autoSizeTextareas();
  }

  function readMonthForm() {
    const d = state.monthDraft;
    d.ageLabel = $("ageLabel").value.trim() || `${d.monthAge}月龄`;
    d.metrics = {
      weightStartKg: parseNum($("weightStartKg").value),
      weightEndKg: parseNum($("weightEndKg").value),
      heightStartCm: parseNum($("heightStartCm").value),
      heightEndCm: parseNum($("heightEndCm").value),
      headCm: parseNum($("headCm").value),
      milkNote: $("milkNote").value.trim(),
      sleepHours: parseNum($("sleepHours").value),
    };
    d.notes = {
      diaper: $("noteDiaper").value,
      care: $("noteCare").value,
      dailyLife: $("noteDaily").value,
      extra: $("noteExtra").value,
    };
    d.updatedAt = Date.now();
    return d;
  }

  function openMonth(monthAge) {
    ensureMonthDraft(monthAge);
    fillMonthForm();
    showPanel("month");
    window.location.hash = `#m/${monthAge}`;
  }

  function openOverview() {
    state.editingMonthAge = null;
    state.monthDraft = null;
    state.dirty = false;
    showPanel("overview");
    window.location.hash = "";
    renderAgeLine();
    renderMonthCards();
    drawChart();
  }

  function openSettings() {
    const p = state.data.profile;
    $("profileName").value = p.name || "";
    $("profileSex").value = p.sex === "female" ? "female" : "male";
    $("profileBirth").value = p.birthDate || "";
    showPanel("settings");
    window.location.hash = "#settings";
  }

  function routeFromHash() {
    const hash = window.location.hash || "";
    const monthMatch = hash.match(/^#m\/(\d+)/);
    if (monthMatch) {
      openMonth(Number(monthMatch[1]));
      return;
    }
    if (hash === "#settings") {
      openSettings();
      return;
    }
    openOverview();
  }

  async function saveMonth() {
    if (!state.monthDraft) return;
    readMonthForm();
    const draft = clone(state.monthDraft);
    try {
      $("btnSaveMonth").disabled = true;
      const result = await BabyStore.patchBabyData({
        message: `baby: update month ${draft.monthAge}`,
        mutate(data) {
          const idx = data.months.findIndex((m) => m.monthAge === draft.monthAge);
          if (idx >= 0) data.months[idx] = draft;
          else data.months.push(draft);
          data.months.sort((a, b) => a.monthAge - b.monthAge);
          BabyStore.syncMeasurementsFromMonth(data, draft);
          return data;
        },
      });
      state.data = result.data;
      state.source = "api";
      state.dirty = false;
      toast("已保存到 GitHub");
      openOverview();
    } catch (error) {
      console.error(error);
      toast(error.message || "保存失败");
    } finally {
      $("btnSaveMonth").disabled = false;
    }
  }

  async function saveProfile() {
    const name = $("profileName").value.trim() || "葫芦宝";
    const sex = $("profileSex").value === "female" ? "female" : "male";
    const birthDate = $("profileBirth").value;
    try {
      $("btnSaveProfile").disabled = true;
      const result = await BabyStore.patchBabyData({
        message: "baby: update profile",
        mutate(data) {
          data.profile = { name, sex, birthDate };
          return data;
        },
      });
      state.data = result.data;
      state.source = "api";
      toast("档案已保存");
      openOverview();
    } catch (error) {
      console.error(error);
      toast(error.message || "保存失败");
    } finally {
      $("btnSaveProfile").disabled = false;
    }
  }

  function bindEvents() {
    document.querySelectorAll(".chart-tab").forEach((tab) => {
      tab.addEventListener("click", () => {
        state.metric = tab.dataset.metric;
        document
          .querySelectorAll(".chart-tab")
          .forEach((t) => t.classList.toggle("active", t === tab));
        drawChart();
      });
    });

    $("btnSettings").addEventListener("click", openSettings);
    $("btnBackFromSettings").addEventListener("click", openOverview);
    $("btnBackOverview").addEventListener("click", () => {
      if (state.dirty && !confirm("有未保存修改，确定返回？")) return;
      openOverview();
    });
    $("btnDiscardMonth").addEventListener("click", () => {
      if (state.dirty && !confirm("放弃本页修改？")) return;
      openOverview();
    });
    $("btnSaveMonth").addEventListener("click", saveMonth);
    $("btnSaveProfile").addEventListener("click", saveProfile);

    $("btnNewMonth").addEventListener("click", () => {
      const days = currentAgeDays();
      const m = days == null ? 3 : Math.max(1, monthAgeFromDays(days));
      openMonth(m);
    });

    $("btnAddMilestone").addEventListener("click", () => {
      const text = $("milestoneInput").value.trim();
      if (!text || !state.monthDraft) return;
      state.monthDraft.milestones.push({
        id: `ms-${Date.now()}`,
        text,
        done: true,
      });
      $("milestoneInput").value = "";
      state.dirty = true;
      renderMilestones();
    });

    [
      "ageLabel",
      "sleepHours",
      "weightStartKg",
      "weightEndKg",
      "heightStartCm",
      "heightEndCm",
      "headCm",
      "milkNote",
      "noteDiaper",
      "noteCare",
      "noteDaily",
      "noteExtra",
    ].forEach((id) => {
      const el = $(id);
      el.addEventListener("input", () => {
        state.dirty = true;
        if (el.tagName === "TEXTAREA") autoSizeTextareas();
      });
    });

    window.addEventListener("hashchange", routeFromHash);
    window.addEventListener("resize", () => {
      if (state.view === "overview") drawChart();
    });
  }

  async function boot() {
    bindEvents();
    try {
      const loaded = await BabyStore.loadBabyDataRaw();
      state.data = loaded.data;
      state.source = loaded.source;
    } catch (error) {
      console.error(error);
      state.data = BabyStore.emptyData();
      state.source = "empty";
      toast("读取失败，已使用空档案");
    }
    routeFromHash();
  }

  boot();
})();
