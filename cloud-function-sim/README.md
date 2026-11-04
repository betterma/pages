# 模拟盘止损（独立事件函数）

与 `cloud-function-notify` 的真实持仓完全隔离。页面侧市价买卖写入 `watch-sim-holdings.json`；本函数只负责 **-3% / -5% 固定止损** 的模拟成交。

## 行为

1. 读 `watch-sim-holdings.json`、`watch-sim-sell-tasks.json`
2. 对 `kind=stop` 且 `armed` 的任务拉币安公开 `bookTicker`
3. 买一价 ≤ `triggerPrice` → 按任务比例市价模拟卖出（扣 0.1% 手续费），改余额，去掉该止损任务
4. **绝不**调用币安下单 API

## 部署（华为云事件函数）

1. 上传本目录，Handler：`index.handler`，Node.js 18+
2. 环境变量：

| 变量 | 说明 |
|------|------|
| `GITHUB_TOKEN` | 可读写仓库 |
| `GITHUB_REPO` | 默认 `betterma/pages` |
| `SIM_HOLDINGS_PATH` | 默认 `watch-sim-holdings.json` |
| `SIM_SELL_TASKS_PATH` | 默认 `watch-sim-sell-tasks.json` |
| `SIM_FEE_RATE` | 默认 `0.001` |

3. 定时触发器：建议 **1～5 分钟**
4. 不需要 HTTP，不需要 `BINANCE_API_KEY`

## 与页面的分工

| 动作 | 谁做 |
|------|------|
| 关注币 / 重置本金 / 市价买% / 市价卖% / 手填买入价并种止损 | `kline.html` → GitHub |
| 止损到价模拟减仓 | 本云函数 |
