# RH Screener 代理（线上必用）

`zhangyixuan.space` 等线上域名访问 DexPaprika 会被 **CORS** 拦住。  
本函数做中转：浏览器 → 本函数 → DexPaprika。

**不需要 API Key**（免费档即可）。

## 华为云部署

1. 函数服务 → 创建函数 → Node.js 18+  
2. 上传 `cloud-function-rh` 目录（或只传 `index.js`）  
3. Handler：`index.handler`  
4. 超时：**60 秒**（一次刷很多币会串行拉 K 线，代理单次请求仍应较快）  
5. 创建 **HTTP 触发器**  
   - 认证：不认证 / 公开  
   - 记下完整 URL，例如：  
     `https://xxxxx.apig.cn-north-4.huaweicloudapis.com/`  
     或带路径：`https://xxxxx.../rh`
6. 浏览器打开：`你的触发器URL/health`  
   应看到：`{"ok":true,"network":"robinhood",...}`

## 接到网页

任选其一：

1. 打开 `RH/index.html`，在「代理」框粘贴触发器根地址（能访问 `/health` 的前缀），点刷新  
2. 或改 `RH/config.js`：

```js
window.RH_CONFIG = {
  PROXY_URL: 'https://xxxxx.apig.cn-north-4.huaweicloudapis.com/rh',
};
```

然后重新发布 Pages。

## 自测

```text
GET {PROXY}/health
GET {PROXY}/tokens?fdvMin=5000000&fdvMax=30000000&limit=3
GET {PROXY}/pools?token=0x...
GET {PROXY}/ohlcv?pool=0x...&days=30
```

若网关不支持子路径，也可用：`{PROXY}?route=tokens&fdvMin=...`（函数已兼容）。
