(function (global) {
  "use strict";

  const EVENT_TYPES = new Set(["feed", "pee", "poop", "sleep", "other"]);

  function cfg() {
    return global.BabyChatConfig || {};
  }

  function apiKey() {
    return String(cfg().DASHSCOPE_API_KEY || "").trim();
  }

  function baseUrl() {
    return String(
      cfg().DASHSCOPE_BASE_URL ||
        "https://dashscope.aliyuncs.com/compatible-mode/v1",
    ).replace(/\/$/, "");
  }

  async function chatCompletions(body) {
    const key = apiKey();
    if (!key) {
      throw new Error("请先在 baby-chat-config.js 填写 DASHSCOPE_API_KEY");
    }
    const response = await fetch(`${baseUrl()}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const raw = await response.text();
    if (!response.ok) {
      throw new Error(`DashScope HTTP ${response.status}: ${raw.slice(0, 280)}`);
    }
    let data;
    try {
      data = JSON.parse(raw || "{}");
    } catch (error) {
      throw new Error(`DashScope bad JSON: ${raw.slice(0, 200)}`);
    }
    const text =
      data &&
      data.choices &&
      data.choices[0] &&
      data.choices[0].message
        ? String(data.choices[0].message.content || "").trim()
        : "";
    if (!text) throw new Error(`DashScope empty content: ${raw.slice(0, 200)}`);
    return { text, raw: data };
  }

  function extractJsonObject(text) {
    const raw = String(text || "").trim();
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
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(raw.slice(start, end + 1));
      } catch (error) {
        return null;
      }
    }
    return null;
  }

  function normalizeEvent(item) {
    if (!item || typeof item !== "object") return null;
    let type = String(item.type || "").toLowerCase();
    // 口语别名
    if (type === "urine" || type === "wee" || type === "尿") type = "pee";
    if (type === "stool" || type === "diaper_poop" || type === "便" || type === "拉")
      type = "poop";
    if (type === "milk" || type === "nursing" || type === "喂奶") type = "feed";
    if (!EVENT_TYPES.has(type)) return null;

    const countRaw = item.count == null || item.count === "" ? 1 : Number(item.count);
    const count =
      Number.isFinite(countRaw) && countRaw > 0 ? Math.round(countRaw) : 1;

    if (type === "feed") {
      const mlRaw = item.ml == null || item.ml === "" ? null : Number(item.ml);
      const ml = Number.isFinite(mlRaw) && mlRaw > 0 ? Math.round(mlRaw) : null;
      const methodRaw = String(item.method || "unknown").toLowerCase();
      const method =
        methodRaw === "bottle" || methodRaw === "breast" ? methodRaw : "unknown";
      return {
        type: "feed",
        count,
        ml,
        method,
        estimated: Boolean(item.estimated),
      };
    }

    if (type === "sleep") {
      const minutesRaw =
        item.minutes == null || item.minutes === "" ? null : Number(item.minutes);
      const minutes =
        Number.isFinite(minutesRaw) && minutesRaw > 0
          ? Math.round(minutesRaw)
          : null;
      return { type: "sleep", count, minutes };
    }

    return { type, count };
  }

  function normalizeParse(raw) {
    const intent = String(raw.intent || "other").toLowerCase();
    const events = Array.isArray(raw.events)
      ? raw.events.map(normalizeEvent).filter(Boolean)
      : [];
    const chatOnly =
      raw.chatOnly === true ||
      (events.length === 0 && (intent === "chat" || intent === "other"));
    const confidenceRaw = Number(raw.confidence);
    return {
      intent: ["care", "feeding", "mixed", "chat", "other"].includes(intent)
        ? intent
        : events.length
          ? "care"
          : "other",
      chatOnly,
      confidence: Number.isFinite(confidenceRaw)
        ? Math.max(0, Math.min(1, confidenceRaw))
        : 0.5,
      notes: raw.notes != null ? String(raw.notes).trim() : "",
      events: chatOnly ? [] : events,
    };
  }

  function summarizeParse(parse) {
    const parts = [];
    (parse.events || []).forEach((ev) => {
      if (!ev) return;
      if (ev.type === "feed") {
        const ml =
          ev.ml != null ? `${ev.ml}ml` : ev.count > 1 ? `${ev.count}次` : "1次";
        parts.push(ev.ml != null ? `喂奶 ${ml}` : `喂奶 ${ev.count || 1}次`);
      } else if (ev.type === "pee") {
        parts.push(`小便 ${ev.count || 1}次`);
      } else if (ev.type === "poop") {
        parts.push(`大便 ${ev.count || 1}次`);
      } else if (ev.type === "sleep") {
        parts.push(
          ev.minutes != null ? `睡眠约${ev.minutes}分钟` : `睡眠 ${ev.count || 1}次`,
        );
      } else {
        parts.push("其他护理");
      }
    });
    if (!parts.length) {
      return parse.notes || parse.chatOnly ? "备注" : "已记录";
    }
    return parts.join(" · ");
  }

  async function transcribeAudio(dataUri) {
    const model = String(cfg().BABY_ASR_MODEL || "qwen3-asr-flash");
    const audio = String(dataUri || "").trim();
    if (!audio) throw new Error("录音为空");
    const result = await chatCompletions({
      model,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "input_audio",
              input_audio: { data: audio },
            },
          ],
        },
      ],
      asr_options: {
        language: "zh",
        enable_itn: true,
      },
    });
    return result.text;
  }

  async function parseDiaryText(text) {
    const model = String(cfg().BABY_LLM_MODEL || "qwen-plus");
    const input = String(text || "").trim();
    if (!input) throw new Error("文本为空");
    const system = [
      "你是宝妈口语日记解析器。从中文口语提取宝宝护理事实（不限奶量）。",
      "只输出一个 JSON 对象，不要 Markdown，不要解释。",
      "字段：",
      '{"intent":"care|feeding|mixed|chat|other","chatOnly":boolean,"confidence":0-1,',
      '"notes":"补充说明","events":[...]}',
      "events 单项 type 只能是：feed | pee | poop | sleep | other",
      "feed: {type,count,ml,method,estimated} ml可空；method=bottle|breast|unknown",
      "pee/poop/other: {type,count}",
      "sleep: {type,count,minutes} minutes可空",
      "规则：",
      "1) 「刚才尿了一次」→ pee count=1；「上午拉了两次」→ poop count=2",
      "2) 「刚才喂了一次奶」→ feed count=1，ml=null（未说毫升不要编）",
      "3) 「喂了120」→ feed ml=120 count=1",
      "4) 一句可含多事件；无护理事实则 chatOnly=true、events=[]",
      "5) count 默认 1；半瓶等估量标 estimated=true",
    ].join("\n");
    const result = await chatCompletions({
      model,
      temperature: 0.1,
      messages: [
        { role: "system", content: system },
        { role: "user", content: input },
      ],
    });
    const parsed = extractJsonObject(result.text);
    if (!parsed || typeof parsed !== "object") {
      throw new Error(`解析失败: ${result.text.slice(0, 200)}`);
    }
    return normalizeParse(parsed);
  }

  global.BabyChatAI = {
    transcribeAudio,
    parseDiaryText,
    normalizeParse,
    summarizeParse,
  };
})(typeof window !== "undefined" ? window : globalThis);
