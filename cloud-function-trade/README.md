# 模拟 / 实盘交易机器人（事件函数版）

## 你要的形态

1. 在 `kline.html` 复制币名  
2. 打开 `trade.html`，填币名 + USDT，点「开始模拟交易」  
3. 按**当前价**折算数量，扣 **0.1%** 模拟手续费，写入 GitHub `trade-bot-state.json`  
4. 华为云 **事件函数 + 定时触发器（30 分钟）** 自动检测（**不需要 HTTP 触发器**）  
5. 面板可看状态/日志，可「停止检测」「停止并平仓」

## 架构

| 组件 | 作用 |
|------|------|
| `trade.html` + `trade-sim.js` | 开仓 / 停检测 / 立即检测 / 展示 |
| `trade-bot-state.json`（GitHub） | 唯一状态源（仓位、起步价、开关、日志） |
| `cloud-function-trade` 事件函数 | 定时 tick；默认 `TRADE_MODE=paper` |
| 币安公开行情 | 取价 / 4h 开盘价 |
| `TRADE_MODE=live`（预留） | 同一套规则，买卖走真实下单 |

## 规则（与定稿一致）

- 开仓起步价 = 当时 4h 窗口开盘价  
- 换窗更新起步价  
- 现价 ≤ 起步价 × 0.995 → 卖  
- 冷静 10 分钟  
- 现价 ≥ 当前窗开盘 × 1.003 → 回补  
- 检测频率建议 **30 分钟**

## 云函数部署（事件函数）

1. 上传本目录，Handler：`index.handler`，Node.js 18+  
2. 环境变量：

| 变量 | 说明 |
|------|------|
| `GITHUB_TOKEN` | 可读写仓库 `trade-bot-state.json` |
| `GITHUB_REPO` | 默认 `betterma/pages` |
| `TRADE_MODE` | 默认 `paper`；以后改 `live` |
| `BINANCE_API_KEY` / `BINANCE_API_SECRET` | **仅 live 需要** |

3. 添加**定时触发器**：每 30 分钟  
4. 不需要 HTTP 触发器  

## 日志

- `trade-bot-state.json` 内 `logs`：近期约 200 条（面板直接展示）  
- `trade-bot-logs.json`：追加归档，最多约 500 条  
- 华为云函数控制台：每次 tick 也会 `console.log` 同样内容  
- 来源标记：`page`（网页）/ `timer`（定时事件函数）

1. 币安 API Key 配进环境变量（只开现货，关提现）  
2. `TRADE_MODE=live`  
3. `executeBuy` / `executeSell`（`trade.js`）已按模式分支，规则不用重写  

面板开仓目前是网页侧模拟成交；若 live 也要从面板真实买入，再加事件入口或临时 HTTP（当前按你的约束先不做 HTTP）。
