# Robinhood 日 K 浏览

打开一张网页，按市值/FDV 筛 Robinhood Chain 代币，并浏览全部日线 K 线。

## 使用

本地或 GitHub Pages 打开：

`RH/index.html`

默认条件：FDV **5M–30M**，按 24h 成交额排序，最多 24 个，各拉约 90 根日 K。

## 数据源

| 用途 | 来源 | Key |
|------|------|-----|
| 列表筛选 + 日 K | [DexPaprika](https://docs.dexpaprika.com) | **暂不需要** |
| 详情外链 | DexScreener 页面 | 无 |

DexScreener 公开 API **没有**「按市值列全表」和「OHLCV」，所以列表/K 线用 DexPaprika；卡片上保留跳转 DexScreener。

## 若浏览器报 CORS（线上必现）

`www.zhangyixuan.space` 直连 DexPaprika 会被跨域拦截，**必须**部署代理：

1. 部署本仓库 `cloud-function-rh/`（华为云函数 + **HTTP 触发器**）  
2. 浏览器访问 `{触发器}/health` 确认通  
3. 把触发器根地址填进页面「代理」，或写入 `RH/config.js` 的 `PROXY_URL`  

本地用 `localhost` 打开时仍可尝试直连；线上域名会强制提示填代理。

云函数 **不需要** API Key。

## 可选升级（暂未做）

- DexScreener 二次 enrichment（现价对齐）
- 收藏 / 盯一下联动
- 定时缓存到 JSON，减轻 API 压力
