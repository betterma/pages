# 宝宝日记 · 定时云函数（仅晚间总结）

**仅定时触发**。网页已负责语音 ASR、口语 LLM、自动入库。  
本函数只做：北京时间到点后读 `entries` → 生成总结 → PushPlus。

## 部署

1. 事件函数 + 定时触发（建议每 5～10 分钟，或每天 20:00～21:00 多触发几次）
2. **整包上传**本目录全部 `.js`
3. Handler：`index.handler`，超时 ≥ 60s

## 环境变量

| 变量 | 必填 | 说明 |
|------|------|------|
| `GITHUB_TOKEN` | 是 | 读写 JSON |
| `DASHSCOPE_API_KEY` | 建议 | 写晚间叙述；没有则用兜底短文 |
| `PUSHPLUS_TOKEN` | 推微信时 | 空则只写 `summaries` 不推 |
| `BABY_SUMMARY_HOUR` | 否 | 默认 **20**（北京时间） |
| `BABY_LLM_MODEL` | 否 | 默认 `qwen-plus` |

## 数据

`babyChat/baby-chat-data.json` 的 `entries` 由网页写入；本函数写 `summaries`。
