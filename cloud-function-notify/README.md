# 盯一下 / 持仓 · 企业微信推送

定时事件函数：每 5 分钟读取 GitHub 的盯一下与持仓，拉币安现价，推到企业微信群机器人。

## 推送内容

1. **盯一下**：只推相对盯住价**上涨**的币；每条两行（币名+涨幅 / 盯住价→现价），条目之间空一行；无上涨则跳过  
2. **上涨 Top3** 额外各发一张 **4h K 线 PNG**（图内标题含币名/涨幅；横线为盯住价）  
3. **持仓**：买入价→现价同版式；跌破买入价 **5%** 时附加告警（同币 **2 小时**冷却）

无颜色标记。无盯一下上涨且无持仓时，不发空消息。

可选环境变量：`PIN_CHART_TOP`（默认 3）、`PIN_CHART_INTERVAL`（默认 `4h`）、`PIN_CHART_LIMIT`（默认 42）。

## 企业微信机器人（一次配置）

1. 打开 [企业微信](https://work.weixin.qq.com/) 并登录（个人可创建企业）  
2. 建一个群（可以只有自己）  
3. 群设置 → **群机器人** → 添加 → 复制 Webhook 地址  
4. 两个群各复制 Webhook，分别填 `WECOM_WEBHOOK_PINS`、`WECOM_WEBHOOK_POSITIONS`（或临时共用 `WECOM_WEBHOOK_URL`）

手机安装企业微信，打开消息通知；可选在「微信插件」里接收提醒。

## 部署

1. 上传本目录，Handler：`index.handler`，Node.js 18+  
2. 添加**定时触发器**：`0 */5 * * * *`（每 5 分钟）  
3. 环境变量：

| 变量 | 必填 | 说明 |
|------|------|------|
| `WECOM_WEBHOOK_PINS` | 二选一* | **盯一下**群机器人 Webhook |
| `WECOM_WEBHOOK_POSITIONS` | 二选一* | **持仓/购入**群机器人 Webhook |
| `WECOM_WEBHOOK_URL` | 否 | 兼容旧配置：上面两个都没填时，两类都推到这个地址 |
| `GITHUB_TOKEN` | 是 | 读 pins/positions，写 notify-state |
| `GITHUB_REPO` | 否 | 默认 `betterma/pages` |
| `DROP_THRESHOLD` | 否 | 默认 `0.05`（-5%） |
| `DROP_COOLDOWN_MS` | 否 | 默认 `7200000`（2 小时） |

\* 至少配置一个可用 Webhook；推荐两个群各配一个。

## 双群用法

1. 建两个内部群，例如「盯一下」「持仓」  
2. 各加一个消息推送/机器人，复制两份 Webhook  
3. 云函数环境变量分别填入 `WECOM_WEBHOOK_PINS`、`WECOM_WEBHOOK_POSITIONS`  
4. 重新部署后：上涨盯一下只进第一群，持仓与跌破告警只进第二群

## 数据文件（GitHub）

| 文件 | 来源 |
|------|------|
| `watch-pins.json` | K 线页「盯一下」 |
| `watch-positions.json` | K 线页长按「购买 / 卖出」 |
| `watch-notify-state.json` | 本函数写入跌破告警冷却 |

## 页面操作

K 线长按卡片 → **购买**（录入买入价，默认当前价）/ **卖出**（清除持仓观测）。
