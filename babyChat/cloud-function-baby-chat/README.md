# 宝宝日记 · 定时云函数（仅晚间总结）

**仅定时触发**。网页已负责语音 ASR、口语 LLM、自动入库。  
本函数只做：北京时间到点后读 `entries` → 生成总结 → 企业微信群机器人。

## 部署

1. 事件函数 + 定时触发（建议每 5～10 分钟，或每天 22:00～23:00 多触发几次）
2. **整包上传**本目录全部 `.js`
3. Handler：`index.handler`，超时 ≥ 60s

## 环境变量

| 变量 | 必填 | 说明 |
|------|------|------|
| `GITHUB_TOKEN` | 是 | 读写 JSON |
| `DASHSCOPE_API_KEY` | 建议 | 写晚间叙述；没有则用兜底短文 |
| `WECOM_WEBHOOK_URL` | 否 | 企业微信机器人 Webhook；未设则用代码内默认群 |
| `BABY_SUMMARY_HOUR` | 否 | 默认 **22**（北京时间） |
| `BABY_LLM_MODEL` | 否 | 默认 `qwen-plus` |

## 数据

`babyChat/baby-chat-data.json` 的 `entries` 由网页写入；本函数写 `summaries`。
