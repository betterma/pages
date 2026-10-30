(function (global) {
  "use strict";

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

  function normalizeParse(raw) {
    const intent = String(raw.intent || "other").toLowerCase();
    const events = Array.isArray(raw.events)
      ? raw.events
          .map((item) => {
            if (!item || typeof item !== "object") return null;
            const type = String(item.type || "feed").toLowerCase();
            if (type !== "feed") return null;
            const mlRaw =
              item.ml == null || item.ml === "" ? null : Number(item.ml);
            const ml =
              Number.isFinite(mlRaw) && mlRaw > 0 ? Math.round(mlRaw) : null;
            const methodRaw = String(item.method || "unknown").toLowerCase();
            const method =
              methodRaw === "bottle" || methodRaw === "breast"
                ? methodRaw
                : "unknown";
            return {
              type: "feed",
              ml,
              method,
              estimated: Boolean(item.estimated),
            };
          })
          .filter(Boolean)
      : [];
    const chatOnly =
      raw.chatOnly === true ||
      (events.length === 0 && (intent === "chat" || intent === "other"));
    const confidenceRaw = Number(raw.confidence);
    return {
      intent: ["feeding", "mixed", "chat", "other"].includes(intent)
        ? intent
        : "other",
      chatOnly,
      confidence: Number.isFinite(confidenceRaw)
        ? Math.max(0, Math.min(1, confidenceRaw))
        : 0.5,
      notes: raw.notes != null ? String(raw.notes).trim() : "",
      events: chatOnly ? [] : events,
    };
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
      "你是宝妈口语日记解析器。从中文口语里提取宝宝护理事实；闲聊单独标记。",
      "只输出一个 JSON 对象，不要 Markdown，不要解释。",
      "字段：",
      '{"intent":"feeding|mixed|chat|other","chatOnly":boolean,"confidence":0-1,',
      '"notes":"非喂养备注或闲聊摘要","events":[{"type":"feed","ml":number|null,',
      '"method":"bottle|breast|unknown","estimated":boolean}]}',
      "规则：",
      "1) 无明确喂养/护理事实时 chatOnly=true，events=[]。",
      "2) ml 只在明确或可合理估计时填写；「半瓶」等标 estimated=true。",
      "3) 无法判断 ml 时 ml=null，不要编造。",
      "4) notes 保留情绪/闲聊，勿把数字只写在 notes。",
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
  };
})(typeof window !== "undefined" ? window : globalThis);
