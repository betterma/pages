# 观察池 K 线（kline）系统说明文档

> 面向评审：完整描述功能、实现逻辑与使用流程。  
> 仓库：`betterma/pages` · 主页面：`kline.html` · 共享状态库：`watch-favorites.js` · 定时推送：`cloud-function-notify/` · 行情快照：`cloud-function-monitor/`

---

## 1. 系统定位

这是一套**币安 USDT 现货观察 / 追踪辅助系统**，不是交易所下单机器人。

核心目标：

1. 从全市场 24h 涨幅中维护一个**观察池**，突出「当前 K 线窗口仍在上涨」的币。
2. 对关注币做**盯一下（钉价）**、**记一笔（动量笔记）**、**持仓观测**。
3. 用**破点高**发现相对基准价的突破，并推送到企业微信。
4. 手机与电脑共用同一份 GitHub JSON 状态，刷新后数据一致。

**明确不做的事：**

- 不会在币安真实下单（「卖出 / 强制止损」只改 GitHub 持仓记录）。
- 交易模拟 / 实盘机器人在 `trade.html` + `cloud-function-trade/`，与本系统推送链路分离。

---

## 2. 架构总览

```
┌─────────────────────────────────────────────────────────────────┐
│  浏览器（GitHub Pages）                                           │
│  kline.html 观察池K线 / 记一笔追踪                                   │
│  watch.html 冲榜雷达（观察池上游展示）                                │
│  watch-favorites.js → GitHub Contents API 读写 watch-*.json       │
└────────────────────────────┬────────────────────────────────────┘
                             │ 共享状态（GitHub）
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│  GitHub: betterma/pages                                          │
│  watch-pins / mom-notes / positions / break-high /               │
│  notify-state / favorites / blacklist / action-log / card-eggs   │
└───────────────┬────────────────────────────▲────────────────────┘
                │ 读/写                        │ 读/写
                ▼                              │
┌───────────────────────────┐    ┌────────────────────────────────┐
│ 华为云函数 notify（≈5min）  │    │ 华为云函数 monitor（≈15min）      │
│ 自动盯 → PushPlus          │    │ 拉币安 24hr → 双写               │
│ 破点高/盯一下文案仅网页      │    │ OBS 完整档 + GitHub 瘦身档       │
└─────────────┬─────────────┘    └───────────────┬────────────────┘
              │ PushPlus / 网页                    │
              ▼                                   ▼
        微信服务通知              OBS 完整 watch-data（冷库）
                                 GitHub 瘦身 watch-data（热库，页面优先读）
```

| 组件 | 路径 | 职责 |
|------|------|------|
| 主 UI | `kline.html` | 双模式页面：观察 / 记一笔；卡片 K 线、动量、破点高、企微浮窗、止损门闩 |
| 共享状态 SDK | `watch-favorites.js` | 所有 `watch-*.json` 的 load/patch（含 409 冲突重试） |
| 推送函数 | `cloud-function-notify/` | 每 5 分钟：自动盯 → PushPlus；破点高/盯一下文案写网页状态 |
| 行情快照 | `cloud-function-monitor/` | 写 OBS 完整 history；另写 GitHub 瘦身版（近 48h × 池/榜前/盯） |
| 冲榜雷达 | `watch.html` | 优先读 GitHub 瘦身 watch-data；失败回落 OBS |

**状态存储原则（硬规则）：**

- 跨设备、需持久化的功能状态 → **只写 GitHub JSON**。
- `localStorage` 仅用于 ephemeral UI（排序偏好、浮窗关闭、一次性 toast、页面侧 rising-zone 种子等）。
- 破点高、记一笔、盯一下、持仓、礼花/NEW、动作日志均走 GitHub。

---

## 3. 名词表

| 产品名 | 含义 |
|--------|------|
| **观察池** | 由历史快照 + 24h 排名维护的币集合；默认关注榜前 30 且当前 4h 窗口上涨者可入池 |
| **窗口上涨** | 相对「当前 4h K 线窗口」开盘价（或窗口起点快照价）现价仍上涨 |
| **盯一下** | 钉住某币某价（`pinPrice`），追踪相对钉价与窗口表现 |
| **记一笔 / 记住** | 记录时间点的动量状态 + 价格；破点高基准优先用最新记住价 |
| **破点高** | 现价突破解析后的基准价 → 命中并抬升基准 |
| **持仓** | 纸面观测仓位（买入价），非交易所仓位 |
| **自动盯** | 未盯币新进入上涨区自动钉价；已盯币进出区不改钉（离开靠触底退出或手动取消） |
| **隐藏盯一下** | 已钉但当前不在窗口上涨的币（企微盯一下文案不纳入） |
| **近 2h / 1h** | 基于 15m 收盘价回算的动量；分类为 爬升 / 横盘 / 衰减 / 其它 |
| **短线抬高** | 5m 连阳（绿名）或 15m 偏热（橙名） |
| **@@@** | 现价高于上次「网页公布」的盯一下现价 |
| **礼花 / NEW** | 卡片彩蛋：周期新高；从隐藏回到窗口上涨 |
| **企微** | 企业微信群机器人推送 |
| **强制止损** | 持仓相对买入价 ≤ −5% 时全屏锁 UI，确认后仅清除 GitHub 持仓 |

---

## 4. 功能清单与实现逻辑

### 4.1 双模式页面

| 模式 | URL | 展示 |
|------|-----|------|
| **观察** | 默认 | 盯一下、新自动盯、窗口上涨、收藏、隐藏盯一下、排序轨 |
| **记一笔** | `?view=notes` | 仅已记币种的 K 线网格；强制算动量并按信号排序；仍跑破点高 |

切换：`setNotesView()` → 改 URL、改标题/Chrome、带进度条重渲染。

### 4.2 观察池与窗口上涨

**数据源：**

- OBS：`watch-data.json` → `history[]`（时间戳 + 各币价格/排名）、`watchPool`
- 币安：`/api/v3/ticker/24hr` → 现价与 24h 排名

**池维护（`updateWatchPool`）：**

1. 已在池内、但跌出 24h 前 30 或被拉黑 → 移出。
2. 24h 前 30 且当前 **4h 窗口上涨** → 加入。

**窗口上涨判定：** 用 OBS history 找当前 4h 窗口起点附近快照价（容差 `WINDOW_TOLERANCE_MS = 2min`），与现价比较；无快照时用 K 线逻辑兜底。

**页面分区：**

- **窗口上涨**：池内上涨且未盯住。
- **盯一下主区**：已盯且窗口上涨。
- **隐藏盯一下**：已盯但不窗口上涨（抽屉）。
- **收藏区**：收藏且窗口上涨、又不在上涨区/主盯区。

> 图表时间范围（近 3 天 4h / 近 10 天 4h / 近 10 天 1d）**只影响画图**；观察池与窗口涨跌**始终按 4h**。

### 4.3 盯一下（Pins）

**文件：** `watch-pins.json`

```json
{
  "pins": [
    {
      "symbol": "XXXUSDT",
      "pinnedAt": 1710000000000,
      "expiresAt": 0,
      "pinPrice": 0.01,
      "source": "manual"
    }
  ]
}
```

| `source` | 来源 |
|----------|------|
| `manual` / `kline` | 用户长按「盯一下」 |
| `buy` | 购买时自动钉 |
| `renew` | 续盯 |
| `auto-rising` | 页面边沿自动盯（遗留） |
| `auto-cloud` | 云函数自动盯 |
| `auto-rewarm` | 旧回暖来源（已废弃，仅兼容展示） |

**交互：**

- 长按卡片 → 盯一下 / 续盯 / 取消盯。
- 多选栏：全选、续盯、取消、去礼花、去 NEW。
- 排序轨：盯幅 | 爬升（爬升会触发动量计算）。

**钉价含义：** 卡片展示相对 `pinPrice` 的涨跌幅（盯幅）；破点高在无记住点时用钉价作基准。

**离开盯一下：** 仅 **触底退出** 或 **用户手动取消**。掉出窗口上涨只写日志，不取消盯。

**过期：** `PIN_TTL_MS = 12h` 仍存在于代码，但 `PIN_EXPIRY_ENABLED = false`（当前不自动过期）。

### 4.4 自动盯（无回暖）

云端边沿检测；页面只同步 snap，不再本地自动钉。

**上涨区（Rising Zone）** = 观察池 ∩ 窗口上涨（**含已盯币**）。

**边沿检测：** 对比上一轮 `risingZoneSnap`（云端在 `watch-notify-state.json`）。

| 情况 | 动作 |
|------|------|
| 首次种子（未 seeded） | 只记快照，**不批量钉** |
| 新进区且未盯 | 新自动盯（`auto-cloud`）+ 同价记一笔 + 捕捉日志 + 可选微信 |
| 新进区且已盯 | **忽略**（无回暖） |
| 已盯且掉出区 | 捕捉日志「掉出窗口」，**不取消盯** |

**新自动盯区 UI：** 近 12h 内 `auto-*` 来源、且仍窗口上涨的钉币；可按时间早/新或盯幅排序。

云函数可选短讯 `【新自动盯】`（`AUTO_PIN_WECOM` / PushPlus）。

### 4.5 记一笔（Mom Notes）

**文件：** `watch-mom-notes.json`，最多 **200** 条。

字段要点：`at`、`symbol`、`status`（爬升/横盘/衰减/其它）、`change2h`、`change1h`、`delta`、`price`。

**写入入口：**

- 「动态」浮窗左侧行的「记」按钮。
- 长按已盯卡片 →「记一笔」。
- 同币约 2 分钟防抖。

**记一笔模式：** 按笔记中出现过的币画 K 线；红点标记录价；支持批量取消记。

**对破点高的影响：** 有记住时，基准 = **最新一笔的 `price`**（按 `at` 最新）；新记一笔会覆盖旧 stored 基准。

### 4.6 动量：近 2h / 1h

**计算触发条件（观察模式懒算）：** 记一笔模式 / 盯一下排序=爬升 / 「动态」浮窗打开。

**算法概要：**

1. 拉 15m K 线（约 24 根）。
2. `changeOverHours`：用已收盘 close 回算 2h（8 根）、1h（4 根）涨跌幅。
3. `build2hTrail`：5 个采样点（每 15m 一步），刻画近 1h 内「2h 动量」轨迹 v0…v4。
4. `classifyMomentumTrend`：

| 状态 | 条件（简化） |
|------|----------------|
| **爬升** | v4>0，Δ=v4−v0 ≥ 1.5pt，近两步至少 1 步上行，未触峰回落否决，1h≥0 |
| **横盘** | v4>0 且 \|Δ\| < 1.5pt |
| **衰减** | 峰回落 ≥ 2pt 等松散条件 |
| **其它** | 数据不全或不匹配 |

排序优先级：爬升 → 横盘 → 衰减 → 其它，再比 Δ / 2h / 1h。

### 4.7 短线信号与 @@@

对盯一下名单（云端写网页文案时）额外拉：

- **5m 连阳 `streak5`**：最近 3 根已收 5m 全阳 → 绿名。
- **15m 热 `heat15`**：最近 3 根已收 15m 至少 2 根阳 → 橙名（无 5m 时）。
- **@@@**：现价 > `lastPinPrices[symbol]`（上次网页盯一下文案公布价）。

### 4.8 破点高（Break High）

**文件：** `watch-break-high.json`  
**冷却：** 10 分钟（`lastCheckAt`），页面与云函数共用。  
**宇宙：** 盯一下 ∪ 记一笔符号（− 拉黑；云端当前调用未传 blacklist，等价空集）。

#### 基准解析（核心）

```
naturalBase:
  若有最新记住价 → base = note.price（source=note）
  否则若有盯住价 → base = pin.pinPrice（source=pin）

resolve(stored, natural):
  无 stored → natural
  natural.noteAt > stored.noteAt → natural（新记一笔重置基准）
  无 note 且 natural.pinAt > stored.pinAt → natural（新钉重置）
  否则 → 保留 stored.base（含突破后抬升价）
```

#### 检查流程

对宇宙内每个有现价的币：

1. `current > base` → 命中；**基准抬升为 current**；记入 `hits`。
2. 否则若尚无 stored → 写入初始 base。
3. 修剪已不在宇宙的 base；更新 `lastCheckAt`、`hits`。

#### 示例

| 操作 | 基准 |
|------|------|
| 盯住 0.01 | 0.01 |
| 记一笔 0.03 | 0.03 |
| 再记一笔 0.02 | **0.02**（最新记住价） |
| 现价涨到 0.025 | 命中；基准抬到 0.025 |
| 再记一笔 0.02 | 基准又回到 **0.02** |

#### 推送

- 云：`WECOM_WEBHOOK_PINS` 发 markdown（有命中列表或「无符合条件」）；有命中再发 K 线拼图（最多 12 张）。
- 页：「动态」右侧列展示；命中时 toast + 打开浮窗。

### 4.9 持仓与强制止损

**文件：** `watch-positions.json`：`{ symbol, buyPrice, boughtAt, source }`。

| 操作 | 行为 |
|------|------|
| 购买 / 更新买入价 | 写入持仓；若未盯则自动钉现价；记日志 `buy` |
| 卖出 | 仅删持仓，**保留盯一下**；记 `sell` |
| 强制止损 | 相对买入 ≤ −5% → 全屏锁；确认后删持仓；记 `sell-stop`；文案注明不下单 |

云端每轮推【持仓】到持仓群；跌破 5% 附告警（同币 **2h** 冷却，存在 `dropAlerts`）。

### 4.10 收藏 / 拉黑

- **收藏** `watch-favorites.json`：展示区单独成格；与上涨区重叠时描边。
- **拉黑** `watch-blacklist.json`：确认后加入；同时去掉盯与持仓；后续不进池、不自动盯。

### 4.11 卡片彩蛋（Card Eggs）

**文件：** `watch-card-eggs.json`

| 类型 | 触发 | 关闭 |
|------|------|------|
| **礼花 / 周期新高** | `3d-4h` 视图下现价处于图内周期高点 | 关闭后抑制至离开高点 |
| **NEW / 回升** | 从隐藏盯一下重新进入窗口上涨 | 关闭后抑制至再次进入隐藏 |

### 4.12 动作日志

**文件：** `watch-action-log.json`（最多 80；页面合并本地缓存与云端 `autoPinEvents`）。

种类：`auto-pin`（自动盯，分类「捕捉」）、`zone-drop`（分类「掉出窗口」）、`period-low-exit`（触底退出）、`buy`、`sell`、`sell-stop`；历史可能仍有 `rewarm`（已废弃，仍归「捕捉」）。

### 4.13 企微浮窗（网页镜像）

轮询 `watch-notify-state.json`（可见时约 60s）：

- 左：`lastPinNotify.markdown`（盯一下文案，**只写网页不发企微**）
- 右：`lastPositionNotify.text`（持仓文案）

用户 dismiss 记 localStorage；内容更新时间更新后重新弹出。

### 4.14 K 线卡片

- 币安 `/api/v3/klines`（优先 `data-api.binance.vision`）。
- Canvas 绘制；钉价竖虚线 + 绿环点；记一笔红点。
- 并发：观察卡片约 10；记一笔约 16；防限流。

---

## 5. 数据文件一览

| 文件 | 用途 | 主要写入方 |
|------|------|------------|
| OBS `watch-data.json` | history、watchPool | monitor 云函数 |
| `watch-pins.json` | 盯一下 | 页面 + notify 自动盯 |
| `watch-mom-notes.json` | 记一笔 | 页面 |
| `watch-positions.json` | 持仓 | 页面（notify 只读） |
| `watch-break-high.json` | 破点高基准/冷却/命中 | 页面 + notify |
| `watch-notify-state.json` | 推送状态、网页镜像、上涨区快照、自动盯事件 | notify（页面读） |
| `watch-favorites.json` | 收藏 | 页面 |
| `watch-blacklist.json` | 拉黑 | 页面 |
| `watch-action-log.json` | 动作日志 | 页面（合并云事件） |
| `watch-card-eggs.json` | 礼花 / NEW | 页面 |
| `watch-spotlight.json` | 聚光（辅助） | 页面 |

### `watch-break-high.json` 形状

```json
{
  "bases": {
    "XXXUSDT": { "base": 0.02, "at": 1710000000000, "noteAt": 1710000000000, "pinAt": 0 }
  },
  "lastCheckAt": 1710000000000,
  "hits": [
    {
      "symbol": "XXXUSDT",
      "label": "XXX",
      "base": 0.02,
      "price": 0.025,
      "at": 1710000000000,
      "source": "note"
    }
  ]
}
```

### `watch-notify-state.json` 关键字段

| 字段 | 含义 |
|------|------|
| `lastNotifyAt` | 推送去抖锁 |
| `dropAlerts` | 持仓跌破告警冷却 |
| `lastPinPrices` | 上次网页公布现价（@@@） |
| `lastPinNotify` | 盯一下网页文案 |
| `lastPositionNotify` | 持仓网页文案 |
| `risingZoneSnap` / `risingZoneSnapSeeded` | 云端自动盯边沿 |
| `autoPinEvents` | 云端自动盯 / 掉出窗口事件（供日志合并） |

---

## 6. 云函数推送流水线（每 ≈5 分钟）

入口：`cloud-function-notify/index.handler` → `notify.main()`。

```
1. 校验 Webhook
2. 并行加载 pins / positions / notify-state
3. 去抖锁（默认 90s，防重入）
4. runAutoPin（读 OBS + blacklist → 可能改 pins）
5. 加载 mom-notes
6. 若 pins/positions/notes 皆空 → 可选自动盯短讯后结束
7. 拉币安 ticker（盯 ∪ 仓 ∪ 破点高宇宙）
8. 【持仓】企微文本（优先发出，避免被拼图拖死）
9. 【新自动盯】可选短讯
10. 盯一下：仅窗口上涨子集 → 动量染色 → 写 lastPinNotify（不发企微）
11. 破点高：10 分钟门闩 → 写 watch-break-high → 企微 markdown（+ 有命中则拼图）
12. 持久化 notify-state（dropAlerts 仅在持仓发送成功时推进）
```

**环境变量（摘要）：**

| 变量 | 说明 |
|------|------|
| `WECOM_WEBHOOK_PINS` | 破点高（+ 可选自动盯）群 |
| `WECOM_WEBHOOK_POSITIONS` | 持仓群 |
| `GITHUB_TOKEN` | 读写 JSON |
| `BREAK_HIGH_COOLDOWN_MS` | 默认 600000 |
| `BREAK_HIGH_CHART_MAX` | 拼图上限默认 12 |
| `AUTO_PIN_WECOM` / `AUTO_PIN_ENABLED` | 自动盯短讯 / 总开关 |
| `OBS_DATA_URL` | OBS watch-data 地址 |
| `DROP_THRESHOLD` / `DROP_COOLDOWN_MS` | 默认 5% / 2h |

`kline-chart.js`：无 Canvas 依赖的服务端 PNG K 线与纵向拼图，供破点高企微图片。

---

## 7. 前端启动与刷新流程

### 7.1 Boot：`refreshAll({ reason: "boot" })`

1. 读 OBS history/pool  
2. 并行/依次 load：favorites、blacklist、pins、positions、mom-notes、notify-state、action-log、card-eggs、break-high  
3. 合并云端 `autoPinEvents` 进日志  
4. 拉币安 ticker → `syncStopLossGate`  
5. `updateWatchPool` → `renderKlines`  
6. `startNotifyPoll`（60s）

### 7.2 `renderKlines`（观察）

`autoPinNewRising` → 渲染上涨/收藏 → `syncFromHiddenEggs` → 盯一下/新自动盯/隐藏 → 调度动量 → `maybeRunBreakHighCheck`（先拉远程再算，保证双端冷却与基准一致）。

### 7.3 其它触发

| 触发 | 行为 |
|------|------|
| 点「刷新」 | 全量 `refreshAll` |
| 页面重新可见 | 距上次成功 ≥ 3min 才全量刷新 |
| 企微轮询 | 可见时 60s 读 notify-state |
| 破点高 | 渲染后 / 强制；受 10min 冷却 |

### 7.4 GitHub 写入模式

`patch*`：GET（带 sha）→ mutate → PUT；遇 `409` 重试（默认 3 次）。读失败时 fallback：main commit SHA + raw → 再空结构。

---

## 8. 典型使用流程

### 8.1 日常观察

1. 打开 `kline.html`（观察模式）。  
2. 看 **窗口上涨**：新晋强势但未盯。  
3. 长按感兴趣币 → **盯一下**。  
4. 盯一下主区看盯幅；需要动量时切排序「爬升」或打开「动态」。  
5. 云端自动盯会出现在「新自动盯」区与「日志」；掉出窗口只进日志。

### 8.2 记一笔追踪

1. 在「动态」对某币点「记」，或长按盯卡片「记一笔」。  
2. 切到 **记一笔** 模式（`?view=notes`）：只看已记币 K 线与红点。  
3. 破点高基准变为最新记住价；价格再破该价会推企微。

### 8.3 持仓观测

1. 长按 → 购买 → 输入买入价（自动钉）。  
2. 每 5 分钟企微持仓群更新买→现。  
3. 跌破 −5%：企微告警（2h 冷却）+ 网页全屏强制确认卖出（只清 JSON）。  
4. 普通卖出：清持仓、保留盯一下。

### 8.4 破点高闭环

1. 盯或记建立基准。  
2. 页面与云每 10 分钟可检查一次。  
3. 突破 → 网页动态右侧 + 企微名单与 K 线拼图；基准抬到现价。  
4. 新记一笔会按新价重置基准。

### 8.5 清理与拉黑

- 「清理」：清过期钉（若启用）、清全部持仓。  
- 拉黑：移出观察体系并去掉盯/仓。  
- 多选：批量取消盯、续盯、去彩蛋；记一笔模式批量取消记。

---

## 9. 关键配置常量（前端）

| 常量 | 值 | 作用 |
|------|-----|------|
| `KLINE_INTERVAL` | `4h` | 窗口涨跌 / 上涨区 |
| `WATCH_POOL_RANK` | `30` | 观察池排名阈值 |
| `STOP_LOSS_PCT` | `5` | 强制止损 / 与企微跌破对齐 |
| `BREAK_HIGH_COOLDOWN_MS` | `10min` | 破点高冷却 |
| `NEW_AUTO_PIN_MS` | `12h` | 「新自动盯」区展示窗口 |
| `AUTO_PIN_EDGE_COOLDOWN_MS` | （已移除） | 旧回暖冷却；回暖取消后不再使用 |
| `MOM_NOTES_MAX` | `200` | 记一笔上限 |
| `ACTION_LOG_MAX` | `80` | 日志上限 |
| `NOTIFY_POLL_MS` | `60s` | 企微状态轮询 |
| `DATA_FOCUS_REFRESH_MIN_MS` | `3min` | 回前台刷新节流 |
| `LONG_PRESS_MS` | `550` | 长按菜单 |
| `MOMENTUM_TREND.minDeltaPts` | `1.5` | 爬升最小 Δ |
| `MOMENTUM_TREND.dropFromPeakPts` | `2` | 峰回落否决 |

---

## 10. 模块与代码锚点

| 模块 | 位置 |
|------|------|
| 页面 CONFIG / 模式切换 | `kline.html` ≈ 2196–2550 |
| 观察池 / 上涨区 / 自动盯 | `kline.html` `updateWatchPool`、`getRisingZoneSymbols`、`autoPinNewRising` |
| 动量分类 | `kline.html` `build2hTrail`、`classifyMomentumTrend` |
| 破点高（前端） | `kline.html` `naturalBreakBase`、`resolveBreakBase`、`maybeRunBreakHighCheck` |
| 破点高（云） | `cloud-function-notify/break-high.js` |
| 自动盯（云） | `cloud-function-notify/auto-pin.js` |
| 推送主流程 | `cloud-function-notify/notify.js` `main` |
| 企微/GitHub SDK | `cloud-function-notify/github-wecom.js` |
| 拼图 | `cloud-function-notify/kline-chart.js` |
| 共享状态 | `watch-favorites.js` → `window.WatchFavorites` |
| 部署说明 | `cloud-function-notify/README.md` |

---

## 11. 与周边页面关系

| 页面 / 服务 | 关系 |
|-------------|------|
| `watch.html` 冲榜雷达 | 展示 OBS 历史与排名；为观察池/自动盯提供上游行情语境 |
| `trade.html` + trade 云函数 | 独立交易/模拟栈；仅导航关联 |
| `okx/kline.html` | OKX 侧类似页，非本币安 kline 主链路 |
| GitHub Pages | 托管静态 `kline.html`；状态仍靠 Contents API + Token 写回 |

---

## 12. 移动端要点

- ≤768px：双列网格、更小字号与 canvas。  
- ≤640px：浮窗与底栏全宽；适配 safe-area。  
- 长按用 Pointer Events；打开菜单可震动；禁用卡片 contextmenu。  
- 双端一致性依赖 GitHub 状态，不依赖 localStorage 业务数据。

---

## 13. 设计约束与已知边界

1. **持仓是纸面账本**：止损确认不会调用币安下单 API。  
2. **盯一下企微已停发**：只保留网页 `lastPinNotify`；企微钉群通道给破点高（及可选自动盯短讯）。  
3. **破点高双端竞态**：以 GitHub `lastCheckAt` + bases 为准；任一侧跑完会推进冷却。  
4. **新记一笔重置基准**：即使 stored 曾被突破抬高，更新的 `noteAt` 也会把基准改回新记住价。  
5. **OBS 是历史权威**：仓库内 `watch-data.json` 可能滞后；notify/页面读 OBS。  
6. **限流**：卡片/动量并发有上限；云端动量并发默认更保守。  
7. **Token**：浏览器写 GitHub 依赖 `WatchFavorites.getGithubToken()`（部署侧配置）；无 Token 则只读/写失败。

---

## 14. 一页纸流程（给评审快速看）

```
币安 24hr + OBS 历史
        │
        ▼
   维护观察池（前30 ∩ 4h窗口涨）
        │
        ├─► 用户/云端「盯一下」──► pinPrice
        ├─► 用户「记一笔」──────► note.price（破点高优先基准）
        ├─► 用户「购买」────────► positions + 自动钉
        │
        ▼
  每 10 分钟破点高：现价 > resolve(base)?
        │ 是
        ▼
  企微【破点高】+ K线拼图；base ← 现价
        │
  每 5 分钟另推【持仓】；−5% 告警 / 网页强制确认卖出
```

---

*文档依据仓库当前实现整理（`kline.html`、`watch-favorites.js`、`cloud-function-notify/*`、`cloud-function-monitor`）。若代码与本文冲突，以代码为准。*
