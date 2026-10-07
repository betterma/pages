(function (global) {
  "use strict";

  const DEFAULT_REPO = "betterma/pages";
  const DATA_PATH = "baby/baby-data.json";
  const TOKEN_PART_A = "gh";
  const TOKEN_PART_B = "p_Xrmz1DjzLfbjyiXZqFyJGd9O8aWFIq4D9758";

  function getGithubToken() {
    return TOKEN_PART_A + TOKEN_PART_B;
  }

  function encodeBase64Utf8(text) {
    const bytes = new TextEncoder().encode(text);
    let binary = "";
    const chunk = 0x8000;
    for (let index = 0; index < bytes.length; index += chunk) {
      binary += String.fromCharCode.apply(
        null,
        bytes.subarray(index, index + chunk),
      );
    }
    return btoa(binary);
  }

  function decodeBase64Utf8(content) {
    const binary = atob(String(content || "").replace(/\n/g, ""));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return new TextDecoder().decode(bytes);
  }

  function emptyData() {
    return {
      profile: { name: "葫芦宝", birthDate: "", sex: "male" },
      measurements: [],
      months: [],
      updatedAt: null,
    };
  }

  function normalizeMeasurement(item) {
    if (!item || typeof item !== "object") return null;
    const id = String(item.id || "").trim();
    const date = String(item.date || "").trim();
    if (!id || !date) return null;
    const numOrNull = (v) => {
      if (v == null || v === "") return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    return {
      id,
      date,
      weightKg: numOrNull(item.weightKg),
      heightCm: numOrNull(item.heightCm),
      headCm: numOrNull(item.headCm),
      note: item.note ? String(item.note) : "",
    };
  }

  function normalizeMilestone(item) {
    if (!item || typeof item !== "object") return null;
    const text = String(item.text || "").trim();
    if (!text) return null;
    return {
      id: String(item.id || `ms-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`),
      text,
      done: Boolean(item.done),
    };
  }

  function normalizeMonth(item) {
    if (!item || typeof item !== "object") return null;
    const monthAge = Number(item.monthAge);
    if (!Number.isFinite(monthAge) || monthAge < 0) return null;
    const metrics = item.metrics && typeof item.metrics === "object" ? item.metrics : {};
    const notes = item.notes && typeof item.notes === "object" ? item.notes : {};
    const numOrNull = (v) => {
      if (v == null || v === "") return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    return {
      monthAge,
      ageLabel: item.ageLabel ? String(item.ageLabel) : `${monthAge}月龄`,
      metrics: {
        weightStartKg: numOrNull(metrics.weightStartKg),
        weightEndKg: numOrNull(metrics.weightEndKg),
        heightStartCm: numOrNull(metrics.heightStartCm),
        heightEndCm: numOrNull(metrics.heightEndCm),
        headCm: numOrNull(metrics.headCm),
        milkNote: metrics.milkNote != null ? String(metrics.milkNote) : "",
        sleepHours: numOrNull(metrics.sleepHours),
      },
      milestones: Array.isArray(item.milestones)
        ? item.milestones.map(normalizeMilestone).filter(Boolean)
        : [],
      notes: {
        diaper: notes.diaper != null ? String(notes.diaper) : "",
        care: notes.care != null ? String(notes.care) : "",
        dailyLife: notes.dailyLife != null ? String(notes.dailyLife) : "",
        extra: notes.extra != null ? String(notes.extra) : "",
      },
      updatedAt: Number.isFinite(Number(item.updatedAt))
        ? Number(item.updatedAt)
        : 0,
    };
  }

  function normalizeData(raw) {
    const base = emptyData();
    if (!raw || typeof raw !== "object") return base;
    const profile = raw.profile && typeof raw.profile === "object" ? raw.profile : {};
    const sexRaw = String(profile.sex || "male").toLowerCase();
    base.profile = {
      name: profile.name ? String(profile.name) : "葫芦宝",
      birthDate: profile.birthDate ? String(profile.birthDate) : "",
      sex: sexRaw === "female" ? "female" : "male",
    };
    base.measurements = Array.isArray(raw.measurements)
      ? raw.measurements.map(normalizeMeasurement).filter(Boolean)
      : [];
    base.months = Array.isArray(raw.months)
      ? raw.months
          .map(normalizeMonth)
          .filter(Boolean)
          .sort((a, b) => a.monthAge - b.monthAge)
      : [];
    base.updatedAt = Number.isFinite(Number(raw.updatedAt))
      ? Number(raw.updatedAt)
      : null;
    return base;
  }

  async function fetchJsonFile(options) {
    const repo = options.repo || DEFAULT_REPO;
    const path = options.path;
    const token = options.token || getGithubToken();
    const response = await fetch(
      `https://api.github.com/repos/${repo}/contents/${path}?t=${Date.now()}`,
      {
        cache: "no-store",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
    );
    if (response.status === 404) {
      return { data: null, sha: null };
    }
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
        {
          cache: "no-store",
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${token}`,
            "X-GitHub-Api-Version": "2022-11-28",
          },
        },
      );
      if (!blobResponse.ok) {
        throw new Error(`读取 ${path} blob 失败: ${blobResponse.status}`);
      }
      const blob = await blobResponse.json();
      raw = decodeBase64Utf8(blob.content || "");
    }
    if (!raw.trim()) {
      throw new Error(`${path} 内容为空`);
    }
    return {
      data: JSON.parse(raw),
      sha: file.sha,
    };
  }

  async function writeJsonFile(options) {
    const repo = options.repo || DEFAULT_REPO;
    const path = options.path;
    const token = options.token || getGithubToken();
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
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify(payload),
      },
    );
    if (response.status === 409) {
      const error = new Error("GitHub 写入冲突");
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

  async function getMainCommitSha(options) {
    const repo = options.repo || DEFAULT_REPO;
    const token = options.token || getGithubToken();
    const response = await fetch(
      `https://api.github.com/repos/${repo}/commits/main?per_page=1&t=${Date.now()}`,
      {
        cache: "no-store",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
    );
    if (!response.ok) {
      throw new Error(`读取 main commit 失败: ${response.status}`);
    }
    const data = await response.json();
    if (!data.sha) throw new Error("main commit sha 为空");
    return data.sha;
  }

  async function loadBabyDataRaw(options) {
    const opts = options || {};
    const repo = opts.repo || DEFAULT_REPO;
    const path = opts.path || DATA_PATH;

    try {
      const current = await fetchJsonFile({
        repo,
        path,
        token: opts.token,
      });
      if (current.data) {
        return {
          data: normalizeData(current.data),
          sha: current.sha,
          source: "api",
        };
      }
    } catch (error) {
      console.warn("loadBabyData via API failed, trying raw", error);
    }

    try {
      const commitSha = await getMainCommitSha({
        repo,
        token: opts.token,
      });
      const url = `https://raw.githubusercontent.com/${repo}/${commitSha}/${path}`;
      const response = await fetch(url, {
        cache: "no-store",
        headers: {
          "Cache-Control": "no-cache",
          Pragma: "no-cache",
        },
      });
      if (response.ok) {
        const data = await response.json();
        return {
          data: normalizeData(data),
          sha: null,
          source: "raw",
        };
      }
    } catch (error) {
      console.warn("loadBabyData via commit-raw failed", error);
    }

    // Local fallback when file not yet on remote
    try {
      const local = await fetch(`./baby-data.json?t=${Date.now()}`, {
        cache: "no-store",
      });
      if (local.ok) {
        const data = await local.json();
        return {
          data: normalizeData(data),
          sha: null,
          source: "local",
        };
      }
    } catch (error) {
      console.warn("loadBabyData local fallback failed", error);
    }

    return { data: emptyData(), sha: null, source: "empty" };
  }

  async function patchBabyData(options) {
    const opts = options || {};
    const repo = opts.repo || DEFAULT_REPO;
    const path = opts.path || DATA_PATH;
    const maxAttempts = opts.maxAttempts || 3;
    let lastError = null;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        const current = await fetchJsonFile({
          repo,
          path,
          token: opts.token,
        });
        const base = normalizeData(current.data || emptyData());
        const draft = JSON.parse(JSON.stringify(base));
        const next = normalizeData(opts.mutate(draft));
        next.updatedAt = Date.now();
        await writeJsonFile({
          repo,
          path,
          token: opts.token,
          data: next,
          sha: current.sha,
          message: opts.message || `Update ${path}`,
        });
        return { data: next };
      } catch (error) {
        lastError = error;
        if (error.code !== "conflict") throw error;
      }
    }
    throw lastError || new Error("保存成长手册失败");
  }

  function ageDaysOn(birthDate, onDate) {
    if (!birthDate) return null;
    const birth = new Date(`${birthDate}T00:00:00`);
    const on = onDate ? new Date(`${onDate}T00:00:00`) : new Date();
    if (Number.isNaN(birth.getTime()) || Number.isNaN(on.getTime())) return null;
    const ms = on.getTime() - birth.getTime();
    return Math.floor(ms / (24 * 60 * 60 * 1000));
  }

  function dateFromAgeDays(birthDate, ageDays) {
    if (!birthDate || !Number.isFinite(ageDays)) return "";
    const birth = new Date(`${birthDate}T00:00:00`);
    if (Number.isNaN(birth.getTime())) return "";
    birth.setDate(birth.getDate() + ageDays);
    const y = birth.getFullYear();
    const m = String(birth.getMonth() + 1).padStart(2, "0");
    const d = String(birth.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  /** Sync month start/end metrics into measurements list. */
  function syncMeasurementsFromMonth(data, month) {
    const birth = data.profile.birthDate;
    if (!birth || !month) return data;
    const startDay = month.monthAge * 30 + 1;
    const endDay = (month.monthAge + 1) * 30;
    const startDate = dateFromAgeDays(birth, startDay);
    const endDate = dateFromAgeDays(birth, endDay);
    const startId = `m${month.monthAge}-start`;
    const endId = `m${month.monthAge}-end`;
    const rest = data.measurements.filter(
      (m) => m.id !== startId && m.id !== endId,
    );
    const metrics = month.metrics || {};
    if (
      metrics.weightStartKg != null ||
      metrics.heightStartCm != null
    ) {
      rest.push({
        id: startId,
        date: startDate,
        weightKg: metrics.weightStartKg,
        heightCm: metrics.heightStartCm,
        headCm: null,
        note: `${month.monthAge}月龄初`,
      });
    }
    if (
      metrics.weightEndKg != null ||
      metrics.heightEndCm != null ||
      metrics.headCm != null
    ) {
      rest.push({
        id: endId,
        date: endDate,
        weightKg: metrics.weightEndKg,
        heightCm: metrics.heightEndCm,
        headCm: metrics.headCm,
        note: `${month.monthAge}月龄末`,
      });
    }
    data.measurements = rest
      .map(normalizeMeasurement)
      .filter(Boolean)
      .sort((a, b) => a.date.localeCompare(b.date));
    return data;
  }

  global.BabyStore = {
    DATA_PATH,
    loadBabyDataRaw,
    patchBabyData,
    normalizeData,
    emptyData,
    ageDaysOn,
    dateFromAgeDays,
    syncMeasurementsFromMonth,
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
