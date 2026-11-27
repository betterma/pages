# 合约（只读三栏 · 独立目录）

与仓库根目录现货 kline / `watch-*.json` / `cloud-function-notify` **零共用、零引用**。

## 分栏（对齐现货思路，无买卖账本）

| 分栏 | 做什么 |
|------|--------|
| **置顶** | 常看 + 置顶 + 其余；便签 / 刷新 / 常看开关；迷你 K |
| **自动盯** | 云函数写入的名单；一键「置顶」进置顶板 |
| **雷达** | 24h 榜；置顶行默认画 K；可开「全部 K 线」；可置顶 |

## 文件

| 路径 | 谁写 | 用途 |
|------|------|------|
| `index.html` + `fut-*.js` | — | 页面 |
| `fut-nails.json` | **页面**（置顶/便签/常看） | 置顶板 |
| `fut-auto-pins.json` | 云函数 | 自动盯 |
| `fut-watch-pool.json` | 云函数 | 观察池 |
| `fut-notify-state.json` | 云函数 | 边沿事件 |
| `fut-blacklist.json` | 手改 | 黑名单 |
| `fut-prefs.json` | 页面设置 | 观察池前 N 等（云函数会读） |
| `cloud-function-fut/` | 华为云单独部署 | 只读自动盯 |

置顶栏右上角 **设置**：排序、只看置顶、定时刷新、观察池 N、一键平简、跳回现货 kline（不含买卖/账本类项）。

三栏（置顶 / 自动盯 / 雷达）**一律列表模式**，不做卡片视图。

## 页面写 GitHub

与现货共用 `github-token-vault.js` 密码入口：现货页若已记住密码，打开合约页会静默解锁；否则点置顶/便签时只 prompt 同一套解密密码。业务 JSON 仍只读写 `futures/`，不碰 `watch-*`。

## 部署云函数

见 [`cloud-function-fut/README.md`](./cloud-function-fut/README.md)（华为云 FunctionGraph · `index.handler` · 约 5 分钟）。
