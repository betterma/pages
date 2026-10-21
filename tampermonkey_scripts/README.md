# Tampermonkey 脚本说明

浏览器导出的用户脚本，用于各站批量抓取 / 复制代币合约地址，再贴进 `okx/` 自选或其它工具。

## 导出文件结构

每个脚本导出时通常是 **3 个文件**：

| 后缀 | 作用 |
|------|------|
| `.user.js` | 脚本本体（改功能只动这个） |
| `.options.json` | 启用状态、匹配 URL、列表位置等 Tampermonkey 设置 |
| `.storage.json` | `GM_setValue` 持久化数据（多数为空） |

当前共 **8 个脚本**（含 Ave 热搜）。

---

## 脚本一览

| 脚本 | 站点 | 触发方式 | 输出 |
|------|------|----------|------|
| ave hot | Ave.ai 热搜 | 「提取热搜合约」 | 剪贴板，多行地址 |
| okx hot | OKX Web3 | 开关后点页面 | 剪贴板，多行地址 |
| DexScreener API 合约提取器 | DexScreener | 面板「提取合约」 | 剪贴板（成功项） |
| dextools hot | Dextools hot-pairs | 开关后点页面 | 剪贴板，表格内合约 |
| Raydium hot | Raydium 流动性池 | 自动监控 + 复制按钮 | 剪贴板；本地持久化 |
| GeckoTerminal代币ID提取器 | GeckoTerminal | 自动拉 API + 复制 | 剪贴板，热门池 base token |
| 悬浮式元素复制助手 | gmgn.ai trend | 开始复制 / 复制全部 | 剪贴板 |
| Transit Finance 市场页批量复制 | Transit Finance | 一键批量点复制 | 剪贴板 |

---

## 0. ave hot

- **文件**：`ave hot.user.js`（v1.1）
- **匹配**：`https://ave.ai/*`、`https://pro.ave.ai/*`、`https://pc.ave.ai/*` 等
- **适用页**：
  - Solana：`https://ave.ai/markets?chain=solana&tab=hot`
  - Robinhood：`https://ave.ai/markets?chain=robinhood&tab=hot`
- **作用**：把 `fetch`/XHR 钩子**注入页面主世界**（避免油猴沙箱截不到请求），再扫 DOM；仍空时尝试点页内复制按钮。点「提取热搜合约」写入剪贴板。
- **注意**：更新脚本后请**硬刷新**热搜页（让钩子在请求发出前挂上）；链名从 `chain=` 读取。

---

## 1. okx hot

- **文件**：`okx hot.user.js`
- **匹配**：`https://web3.okx.com/*`
- **作用**：在 OKX Web3 页右上角放「启动智能复制」开关。开启后，点击页面任意处（排除买入类按钮）会：
  1. 找到带复制图标的 `button.dex-plain-button`
  2. 逐个模拟点击 → `clipboard.readText()` 读出地址
  3. 合并成多行再写回剪贴板
- **注意**：依赖剪贴板读写权限；跳过文案含「买入」的按钮。

---

## 2. DexScreener API 合约提取器

- **文件**：`DexScreener API 合约提取器.user.js`（v1.2）
- **匹配**：`https://dexscreener.com/*` 等
- **作用**：右侧固定触发按钮打开面板；选链（Solana / ETH / BSC / Base / Arbitrum / Robinhood）后：
  1. 从页面收集 `/{chain}/{pair}` 链接（兼容旧 `.ds-dex-table-row` 与新版任意 `a[href]`）
  2. 优先 `latest/dex/pairs/{chain}/{pair}` 解析 `baseToken.address`，失败再 search 兜底
  3. 分「成功 / 失败」列表，可「复制成功项」
- **权限**：`GM_xmlhttpRequest`、`GM_setClipboard`、`@connect api.dexscreener.com`
- **改时注意**：榜单页要等表格加载完再点提取；若仍为 0，多半是链接 DOM 又变了。
- **已知问题（已修）**：旧版只认 `.ds-dex-table-row`，页面改版后会提示「未提取到合约地址」。

---

## 3. dextools hot (精确表格提取)

- **文件**：`dextools hot (精确表格提取).user.js`
- **匹配**：`https://www.dextools.io/app/*/hot-pairs`（含 solana）
- **作用**：开关开启后，页面点击会延迟提取 `table.p-datatable-table` 行内 logo 图 URL：
  - 从 `…/solana/|robinhood/…` 路径抠合约（含 `pump`/`bond` 后缀，或 `0x…`）
  - 跳过骨架屏、`???` 行；去重后写入剪贴板
- **改时注意**：表格选择器、logo CDN 路径格式。

---

## 4. Raydium hot (Simple Style) - Always On

- **文件**：`Raydium hot (Simple Style) - Always On.user.js`
- **匹配**：`https://raydium.io/liquidity-pools/*`
- **作用**：右下角常驻「合约监控」面板；**始终开启**：
  - `MutationObserver` 扫描 `img.chakra-image` 的 `alt`（视为合约）
  - Base58 长度校验后写入 `Set`，并用 `GM_setValue('contracts')` 持久化
  - 「复制」= 全部地址换行；「重置」= 清空本地与扫描标记
- **改时注意**：img class / alt 是否仍是合约；WeakSet 去重逻辑。

---

## 5. GeckoTerminal代币ID提取器

- **文件**：`GeckoTerminal代币ID提取器.user.js`
- **匹配**：`https://www.geckoterminal.com/*`
- **作用**：右上角面板；启动时请求：
  - `api.geckoterminal.com/api/v2/networks/solana/trending_pools?page=1|2`
  - 取 `relationships.base_token.data.id`，按下划线拆出后半段（合约）
  - 「复制全部」「刷新数据」
- **权限**：`GM_xmlhttpRequest` + `@connect api.geckoterminal.com`
- **改时注意**：API path、分页数、id 格式 `network_address`。

---

## 6. 悬浮式元素复制助手 - 完整功能版

- **文件**：`悬浮式元素复制助手 - 完整功能版.user.js`
- **匹配**：`https://gmgn.ai/trend?chain=sol`
- **作用**：可拖动悬浮窗：
  - 「开始复制」：找视图内可见的复制按钮（SVG 相关），最多处理约 10 个，顺序模拟点击并从剪贴板收集
  - 「复制全部」：把本次收集结果一次性写入剪贴板
- **权限**：`GM_setClipboard`、`unsafeWindow`（跨沙箱点 DOM）
- **改时注意**：目标元素选择器、视口过滤、GMGN 改版后的复制按钮结构。

---

## 7. Transit Finance 市场页批量复制合约地址

- **文件**：`Transit Finance 市场页批量复制合约地址.user.js`
- **匹配**：`https://swap.transit.finance/*`
- **作用**：一键批量：
  1. 找所有 `img.copy` 及其所属 `.market-class-token-item`
  2. 滚动定位 → 模拟点击复制 → 拦截 `document.execCommand('copy')` / 选区文本拿完整地址
  3. 进度条 + 汇总写入剪贴板；超时则回退到页面显示的截断地址
- **改时注意**：复制图标选择器、token 列表 DOM、站点复制实现是否仍走 `execCommand`。

---

## 和 pages 项目的关系

这些脚本产出的多行合约地址，常见用途：

- 贴进 `okx/kline.html` 手动加自选（Solana `501` / Robinhood `4663`）
- 其它自建列表 / 对比工具

**不是** `kline.html` 币安观察池链路的一部分；改脚本不会影响云函数 `cloud-function-okx` / `cloud-function-notify`。

---

## 改脚本时的约定

1. 只改对应 `.user.js`；改完在 Tampermonkey 里重新导入或粘贴覆盖。
2. `.options.json` / `.storage.json` 一般不必手改；导入时由扩展管理。
3. 站点 DOM / API 易变：先对照当前页面结构再改选择器。
4. 涉及剪贴板的脚本需用户授权「剪贴板读写」；API 类需 `@connect` 白名单。
5. 命名里的 `hot` 多指「热门榜 / 热池」页，不是温度。

---

## 快速定位（按站点）

```
web3.okx.com          → okx hot
dexscreener.com       → DexScreener API 合约提取器
dextools.io …/hot-pairs → dextools hot
raydium.io/liquidity-pools → Raydium hot
geckoterminal.com     → GeckoTerminal代币ID提取器
gmgn.ai/trend         → 悬浮式元素复制助手
swap.transit.finance  → Transit Finance 批量复制
```
