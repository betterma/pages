'use strict';

const { requestRaw } = require('./github');

function getApiKey() {
  return String(
    process.env.DASHSCOPE_API_KEY || process.env.BAILIAN_API_KEY || '',
  ).trim();
}

function getBaseUrl() {
  return String(
    process.env.DASHSCOPE_BASE_URL ||
      'https://dashscope.aliyuncs.com/compatible-mode/v1',
  ).replace(/\/$/, '');
}

async function chatCompletions(body) {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error('Missing DASHSCOPE_API_KEY');
  const response = await requestRaw(`${getBaseUrl()}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    timeout: 60000,
  });
  const raw = response.text();
  if (!response.ok) {
    throw new Error(`DashScope HTTP ${response.status}: ${raw.slice(0, 300)}`);
  }
  let data;
  try {
    data = JSON.parse(raw || '{}');
  } catch (error) {
    throw new Error(`DashScope bad JSON: ${raw.slice(0, 200)}`);
  }
  const text = data && data.choices && data.choices[0] && data.choices[0].message
    ? String(data.choices[0].message.content || '').trim()
    : '';
  if (!text) {
    throw new Error(`DashScope empty content: ${raw.slice(0, 200)}`);
  }
  return { text, raw: data };
}

async function transcribeAudio(dataUri, options) {
  const opts = options || {};
  const model = String(opts.model || process.env.BABY_ASR_MODEL || 'qwen3-asr-flash');
  const audio = String(dataUri || '').trim();
  if (!audio) throw new Error('ASR audio empty');
  const result = await chatCompletions({
    model,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'input_audio',
            input_audio: { data: audio },
          },
        ],
      },
    ],
    asr_options: {
      language: opts.language || 'zh',
      enable_itn: opts.enableItn !== false,
    },
  });
  return result.text;
}

function extractJsonObject(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (error) {
    /* continue */
  }
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced && fenced[1]) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch (error) {
      /* continue */
    }
  }
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(raw.slice(start, end + 1));
    } catch (error) {
      return null;
    }
  }
  return null;
}

async function parseDiaryText(text, options) {
  const opts = options || {};
  const model = String(
    opts.model || process.env.BABY_LLM_MODEL || 'qwen-plus',
  );
  const input = String(text || '').trim();
  if (!input) throw new Error('parseDiaryText empty');

  const system = [
    '你是宝妈口语日记解析器。从中文口语里提取宝宝护理事实；闲聊单独标记。',
    '只输出一个 JSON 对象，不要 Markdown，不要解释。',
    '字段：',
    '{"intent":"feeding|mixed|chat|other","chatOnly":boolean,"confidence":0-1,',
    '"notes":"非喂养备注或闲聊摘要","events":[{"type":"feed","ml":number|null,',
    '"method":"bottle|breast|unknown","estimated":boolean}]}',
    '规则：',
    '1) 无明确喂养/护理事实时 chatOnly=true，events=[]。',
    '2) ml 只在明确或可合理估计时填写；「半瓶」等标 estimated=true。',
    '3) 无法判断 ml 时 ml=null，不要编造。',
    '4) notes 保留情绪/闲聊，勿把数字只写在 notes。',
  ].join('\n');

  const result = await chatCompletions({
    model,
    temperature: 0.1,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: input },
    ],
  });
  const parsed = extractJsonObject(result.text);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`LLM parse JSON failed: ${result.text.slice(0, 200)}`);
  }
  return normalizeParse(parsed);
}

function normalizeParse(raw) {
  const intent = String(raw.intent || 'other').toLowerCase();
  const events = Array.isArray(raw.events)
    ? raw.events
        .map((item) => {
          if (!item || typeof item !== 'object') return null;
          const type = String(item.type || 'feed').toLowerCase();
          if (type !== 'feed') return null;
          const mlRaw = item.ml == null || item.ml === '' ? null : Number(item.ml);
          const ml = Number.isFinite(mlRaw) && mlRaw > 0 ? Math.round(mlRaw) : null;
          const methodRaw = String(item.method || 'unknown').toLowerCase();
          const method =
            methodRaw === 'bottle' || methodRaw === 'breast'
              ? methodRaw
              : 'unknown';
          return {
            type: 'feed',
            ml,
            method,
            estimated: Boolean(item.estimated),
          };
        })
        .filter(Boolean)
    : [];
  const chatOnly =
    raw.chatOnly === true ||
    (events.length === 0 && (intent === 'chat' || intent === 'other'));
  const confidenceRaw = Number(raw.confidence);
  return {
    intent: ['feeding', 'mixed', 'chat', 'other'].includes(intent)
      ? intent
      : 'other',
    chatOnly,
    confidence: Number.isFinite(confidenceRaw)
      ? Math.max(0, Math.min(1, confidenceRaw))
      : 0.5,
    notes: raw.notes != null ? String(raw.notes).trim() : '',
    events: chatOnly ? [] : events,
  };
}

async function writeDailyNarrative(payload, options) {
  const opts = options || {};
  const model = String(
    opts.model || process.env.BABY_LLM_MODEL || 'qwen-plus',
  );
  const system = [
    '你是温和的宝宝日记助手。根据给定事实写今日短总结。',
    '要求：中文，5～8 句内；不要改动喂奶/小便/大便/睡眠等给定数字；',
    '可以自然带过各维度；不要医疗建议；闲聊可轻轻带过；不要标题，不要列表符号堆砌。',
  ].join('');

  const result = await chatCompletions({
    model,
    temperature: 0.5,
    messages: [
      { role: 'system', content: system },
      {
        role: 'user',
        content: JSON.stringify(payload, null, 2),
      },
    ],
  });
  return result.text;
}

module.exports = {
  transcribeAudio,
  parseDiaryText,
  writeDailyNarrative,
  normalizeParse,
  extractJsonObject,
};
