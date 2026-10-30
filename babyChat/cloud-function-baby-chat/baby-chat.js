'use strict';

const { getUserData, diagSources } = require('./runtime-env');
const { loadJson, saveJson, sendPushPlus } = require('./github');
const {
  transcribeAudio,
  parseDiaryText,
  writeDailyNarrative,
} = require('./dashscope');

const DATA_PATH =
  process.env.BABY_CHAT_DATA_PATH || 'babyChat/baby-chat-data.json';

function emptyData() {
  return {
    config: {
      name: '葫芦宝',
      birthDate: '2026-06-26',
    },
    queue: [],
    entries: [],
    summaries: {},
    state: {
      lastRunAt: null,
      lastSummaryDate: null,
    },
    updatedAt: null,
  };
}

function shanghaiParts(nowMs) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(new Date(nowMs));
  const map = {};
  parts.forEach((p) => {
    if (p.type !== 'literal') map[p.type] = p.value;
  });
  return {
    date: `${map.year}-${map.month}-${map.day}`,
    hour: Number(map.hour),
  };
}

function parseBirthDate(value) {
  const m = String(value || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (!y || !mo || !d) return null;
  return { y, mo, d };
}

function ageDaysOn(birthDate, onDate) {
  const birth = parseBirthDate(birthDate);
  const on = parseBirthDate(onDate);
  if (!birth || !on) return null;
  const a = Date.UTC(birth.y, birth.mo - 1, birth.d);
  const b = Date.UTC(on.y, on.mo - 1, on.d);
  const days = Math.floor((b - a) / 86400000);
  return Number.isFinite(days) ? days : null;
}

function ageLabel(days) {
  if (days == null) return '月龄未知';
  if (days < 0) return '未出生';
  if (days === 0) return '出生当天';
  const months = Math.floor(days / 30);
  const rem = days % 30;
  if (months <= 0) return `${days}天`;
  if (rem === 0) return `${months}月整`;
  return `${months}月${rem}天`;
}

function feedStatsFromEvents(events) {
  let mlTotal = 0;
  let feedCount = 0;
  (events || []).forEach((ev) => {
    if (!ev || ev.type !== 'feed') return;
    feedCount += 1;
    if (Number.isFinite(Number(ev.ml)) && Number(ev.ml) > 0) {
      mlTotal += Math.round(Number(ev.ml));
    }
  });
  return { mlTotal, feedCount };
}

function normalizeData(raw) {
  const base = emptyData();
  if (!raw || typeof raw !== 'object') return base;
  const cfg = raw.config && typeof raw.config === 'object' ? raw.config : {};
  base.config = {
    name: cfg.name ? String(cfg.name) : base.config.name,
    birthDate: cfg.birthDate
      ? String(cfg.birthDate)
      : base.config.birthDate,
  };
  base.queue = Array.isArray(raw.queue) ? raw.queue : [];
  base.entries = Array.isArray(raw.entries) ? raw.entries : [];
  base.summaries =
    raw.summaries && typeof raw.summaries === 'object' ? raw.summaries : {};
  const st = raw.state && typeof raw.state === 'object' ? raw.state : {};
  base.state = {
    lastRunAt: st.lastRunAt || null,
    lastSummaryDate: st.lastSummaryDate || null,
  };
  base.updatedAt = raw.updatedAt || null;
  return base;
}

function trimStore(data) {
  const maxQueue = Number(process.env.BABY_QUEUE_KEEP || 80);
  const maxEntries = Number(process.env.BABY_ENTRY_KEEP || 400);
  if (data.queue.length > maxQueue) {
    data.queue = data.queue.slice(data.queue.length - maxQueue);
  }
  if (data.entries.length > maxEntries) {
    data.entries = data.entries.slice(data.entries.length - maxEntries);
  }
  const summaryKeys = Object.keys(data.summaries || {}).sort();
  const keepSummaries = Number(process.env.BABY_SUMMARY_KEEP || 60);
  if (summaryKeys.length > keepSummaries) {
    summaryKeys
      .slice(0, summaryKeys.length - keepSummaries)
      .forEach((key) => {
        delete data.summaries[key];
      });
  }
}

async function saveWithRetry(path, mutator, message) {
  let lastError = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const file = await loadJson(path);
    const data = normalizeData(file.data);
    const next = await mutator(data);
    if (!next) return data;
    trimStore(next);
    next.updatedAt = Date.now();
    try {
      await saveJson(path, next, file.sha, message);
      return next;
    } catch (error) {
      lastError = error;
      if (error && error.code === 'conflict') {
        continue;
      }
      throw error;
    }
  }
  throw lastError || new Error('saveWithRetry failed');
}

async function processRawItem(item) {
  const next = { ...item };
  let text = String(next.rawText || '').trim();
  if (next.source === 'voice' && next.audioDataUri) {
    const asr = await transcribeAudio(next.audioDataUri, {
      language: 'zh',
      enableItn: true,
    });
    next.asrText = asr;
    text = asr;
    next.audioDataUri = null;
  }
  if (!text) {
    next.status = 'error';
    next.error = '无可用文本';
    next.audioDataUri = null;
    return next;
  }
  next.rawText = text;
  const parsed = await parseDiaryText(text);
  next.parse = parsed;
  next.status = 'parsed';
  next.error = '';
  next.parsedAt = Date.now();
  return next;
}

function queueItemToEntry(item, dateStr) {
  const parse = item.parse || {};
  const events = Array.isArray(parse.events) ? parse.events : [];
  const stats = feedStatsFromEvents(events);
  return {
    id: item.id,
    at: item.confirmedAt || item.parsedAt || item.createdAt || Date.now(),
    date: dateStr,
    source: item.source || 'text',
    text: String(item.rawText || item.asrText || ''),
    chatOnly: Boolean(parse.chatOnly),
    events,
    notes: String(parse.notes || ''),
    mlTotal: stats.mlTotal,
    feedCount: stats.feedCount,
  };
}

function aggregateDay(entries, dateStr) {
  const dayEntries = (entries || []).filter((e) => e && e.date === dateStr);
  let mlTotal = 0;
  let feedCount = 0;
  const notes = [];
  const chats = [];
  dayEntries.forEach((e) => {
    if (!e.chatOnly) {
      mlTotal += Number(e.mlTotal) || 0;
      feedCount += Number(e.feedCount) || 0;
    }
    if (e.notes) notes.push(String(e.notes));
    if (e.chatOnly && e.text) chats.push(String(e.text));
    else if (!e.chatOnly && e.text) notes.push(String(e.text));
  });
  return {
    dayEntries,
    mlTotal,
    feedCount,
    notes: notes.slice(0, 20),
    chats: chats.slice(0, 10),
  };
}

async function maybePushDailySummary(data, nowMs) {
  const summaryHour = Number(process.env.BABY_SUMMARY_HOUR || 21);
  const parts = shanghaiParts(nowMs);
  if (parts.hour < summaryHour) {
    return { skipped: true, reason: `before ${summaryHour}:00` };
  }
  const existing = data.summaries[parts.date];
  if (existing && existing.pushedAt) {
    return { skipped: true, reason: 'already pushed' };
  }
  if (data.state.lastSummaryDate === parts.date && existing && existing.pushedAt) {
    return { skipped: true, reason: 'state says done' };
  }

  const days = ageDaysOn(data.config.birthDate, parts.date);
  const label = ageLabel(days);
  const milestones = [];
  if (days === 0) milestones.push('今天是出生日');
  if (days === 30) milestones.push('满月快乐');
  if (days === 100) milestones.push('宝宝百天');
  if (days > 0 && days % 365 === 0) {
    milestones.push(`周岁纪念 · ${days / 365} 岁`);
  }

  const agg = aggregateDay(data.entries, parts.date);
  const name = data.config.name || '宝宝';

  let narrative = '';
  try {
    narrative = await writeDailyNarrative({
      babyName: name,
      date: parts.date,
      ageLabel: label,
      feedCount: agg.feedCount,
      mlTotal: agg.mlTotal,
      milestones,
      notes: agg.notes,
      chats: agg.chats,
      entryCount: agg.dayEntries.length,
    });
  } catch (error) {
    narrative = agg.dayEntries.length
      ? `今天共记录 ${agg.dayEntries.length} 条。奶量 ${agg.mlTotal} ml / ${agg.feedCount} 顿。`
      : '今天还没有确认的记录。';
    console.warn('narrative fallback', error && error.message);
  }

  const lines = [
    `【${name} · ${label}】`,
    `日期 ${parts.date}`,
  ];
  if (milestones.length) {
    lines.push(`纪念：${milestones.join(' · ')}`);
  }
  lines.push(`今日奶量：${agg.mlTotal} ml / ${agg.feedCount} 顿`);
  lines.push('');
  lines.push(narrative);

  const content = lines.join('\n');
  const summary = {
    date: parts.date,
    ageLabel: label,
    ageDays: days,
    feedCount: agg.feedCount,
    mlTotal: agg.mlTotal,
    milestones,
    narrative,
    content,
    pushedAt: null,
    pushError: null,
    createdAt: Date.now(),
  };

  const token = String(process.env.PUSHPLUS_TOKEN || '').trim();
  if (!token) {
    summary.pushError = 'PUSHPLUS_TOKEN empty';
    data.summaries[parts.date] = summary;
    console.warn('summary ready but PushPlus skipped: no token');
    return { skipped: false, pushed: false, summary };
  }

  try {
    await sendPushPlus({
      token,
      title: `${name}今日小结 · ${label}`,
      content,
    });
    summary.pushedAt = Date.now();
    data.state.lastSummaryDate = parts.date;
    data.summaries[parts.date] = summary;
    return { skipped: false, pushed: true, summary };
  } catch (error) {
    summary.pushError = error && error.message ? error.message : String(error);
    data.summaries[parts.date] = summary;
    console.warn('PushPlus failed', summary.pushError);
    return { skipped: false, pushed: false, summary };
  }
}

async function main(event, context) {
  const token = getUserData(context, 'GITHUB_TOKEN') || getUserData(context, 'GH_TOKEN');
  if (token) process.env.GITHUB_TOKEN = token;

  const dash =
    getUserData(context, 'DASHSCOPE_API_KEY') ||
    getUserData(context, 'BAILIAN_API_KEY');
  if (dash) process.env.DASHSCOPE_API_KEY = dash;

  const push = getUserData(context, 'PUSHPLUS_TOKEN');
  if (push) process.env.PUSHPLUS_TOKEN = push;

  const llmModel = getUserData(context, 'BABY_LLM_MODEL');
  if (llmModel) process.env.BABY_LLM_MODEL = llmModel;
  const asrModel = getUserData(context, 'BABY_ASR_MODEL');
  if (asrModel) process.env.BABY_ASR_MODEL = asrModel;
  const summaryHour = getUserData(context, 'BABY_SUMMARY_HOUR');
  if (summaryHour) process.env.BABY_SUMMARY_HOUR = summaryHour;
  const baseUrl = getUserData(context, 'DASHSCOPE_BASE_URL');
  if (baseUrl) process.env.DASHSCOPE_BASE_URL = baseUrl;

  console.log(
    'baby-chat env',
    JSON.stringify(
      diagSources(context, [
        'GITHUB_TOKEN',
        'DASHSCOPE_API_KEY',
        'PUSHPLUS_TOKEN',
        'BABY_LLM_MODEL',
        'BABY_ASR_MODEL',
      ]),
    ),
  );

  if (!process.env.GITHUB_TOKEN) {
    throw new Error('Missing GITHUB_TOKEN');
  }
  if (!process.env.DASHSCOPE_API_KEY) {
    throw new Error('Missing DASHSCOPE_API_KEY');
  }

  const maxRaw = Number(process.env.BABY_PROCESS_MAX || 5);
  const nowMs = Date.now();
  const result = {
    processed: 0,
    errors: [],
    summary: null,
  };

  await saveWithRetry(
    DATA_PATH,
    async (data) => {
      const rawItems = data.queue.filter((q) => q && q.status === 'raw');
      for (const item of rawItems.slice(0, maxRaw)) {
        try {
          const updated = await processRawItem(item);
          const idx = data.queue.findIndex((q) => q && q.id === item.id);
          if (idx >= 0) data.queue[idx] = updated;
          result.processed += 1;
        } catch (error) {
          const msg = error && error.message ? error.message : String(error);
          result.errors.push({ id: item.id, error: msg });
          const idx = data.queue.findIndex((q) => q && q.id === item.id);
          if (idx >= 0) {
            data.queue[idx] = {
              ...data.queue[idx],
              status: 'error',
              error: msg.slice(0, 300),
              audioDataUri: null,
            };
          }
        }
      }

      // Move newly confirmed queue items into entries (page may set status=confirmed)
      const confirmed = data.queue.filter((q) => q && q.status === 'confirmed');
      confirmed.forEach((item) => {
        if (data.entries.some((e) => e && e.id === item.id)) {
          item.status = 'archived';
          return;
        }
        const parts = shanghaiParts(item.confirmedAt || item.createdAt || nowMs);
        data.entries.push(queueItemToEntry(item, parts.date));
        item.status = 'archived';
        item.audioDataUri = null;
      });

      const summaryResult = await maybePushDailySummary(data, nowMs);
      result.summary = summaryResult;
      data.state.lastRunAt = nowMs;
      return data;
    },
    'baby-chat: process queue / daily summary',
  );

  console.log('baby-chat done', JSON.stringify(result));
  return result;
}

module.exports = {
  main,
  emptyData,
  normalizeData,
  ageDaysOn,
  ageLabel,
  shanghaiParts,
  feedStatsFromEvents,
};
