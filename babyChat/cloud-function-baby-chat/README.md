# 宝宝日记 · 定时云函数

**仅定时触发**（无 HTTP）。网页把文字/语音写入 GitHub `babyChat/baby-chat-data.json`，本函数定时：

1. 处理 `queue` 里 `status=raw`：语音 ASR → 文本，LLM 抽取喂奶/闲聊 → `parsed`
2. 把遗留的 `confirmed` 迁入 `entries`（网页确认时通常已直接写入 entries）
3. 北京时间到点后生成当日总结；若配置了 `PUSHPLUS_TOKEN` 则推微信

## 部署

1. 新建**事件函数**（不要选 HTTP）
2. **整包上传**本目录全部 `.js`：`index.js`、`baby-chat.js`、`dashscope.js`、`github.js`、`runtime-env.js`
3. Handler：`index.handler`，Node.js 18+
4. 超时建议 **≥ 60～120 秒**
5. 定时触发器建议：`0 */2 * * * *`（每 2 分钟；也可 `0 */5 * * * *`）

## 环境变量

| 变量 | 必填 | 说明 |
|------|------|------|
| `GITHUB_TOKEN` | 是 | 读写仓库 JSON |
| `DASHSCOPE_API_KEY` | 是 | 阿里云百炼 API Key（LLM+ASR 共用） |
| `PUSHPLUS_TOKEN` | 否* | 有则每晚推微信；空则只写总结到 JSON |
| `BABY_LLM_MODEL` | 否 | 默认 `qwen-plus` |
| `BABY_ASR_MODEL` | 否 | 默认 `qwen3-asr-flash` |
| `BABY_SUMMARY_HOUR` | 否 | 默认 `21`（北京时间） |
| `DASHSCOPE_BASE_URL` | 否 | 默认 `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| `GITHUB_REPO` | 否 | 默认 `betterma/pages` |
| `BABY_CHAT_DATA_PATH` | 否 | 默认 `babyChat/baby-chat-data.json` |

\* 第一版可先不填 PushPlus；总结仍会写入 `summaries`。

密钥只放云函数环境变量，**不要**写入网页或仓库。

## 数据文件

路径：`babyChat/baby-chat-data.json`

- `config.birthDate`：默认 `2026-06-26`
- `queue`：待解析 / 待确认
- `entries`：已确认记录
- `summaries`：每日总结与推送状态
