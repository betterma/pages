# 宝宝日记（口语 + 语音）

手机网页**即时**解析（ASR/LLM 在浏览器），自动入库；可改可删。  
云函数只负责 **北京时间 20:00** 后推微信每日总结。

## 配置（必做一次）

编辑 `baby-chat-config.js`：

```js
DASHSCOPE_API_KEY: "sk-...",  // 百炼 Key
GITHUB_TOKEN: "ghp_...",      // 能写本仓库的 Token
```

填好后打开页面**不需要输入密码**。

## 怎么用

1. 打开 `index.html` / Pages 上的 `babyChat/`
2. 发文字或按住说话 → 几秒内解析并自动出现在「今日记录」
3. 点「修改」可改 ml / 备注 / 标闲聊，或删除
4. 每晚 20:00 后云函数汇总并 PushPlus 推微信（需云函数配好 `PUSHPLUS_TOKEN`）

## 云函数

见 `cloud-function-baby-chat/README.md`。  
重新整包上传后，建议环境变量 `BABY_SUMMARY_HOUR=20`（代码默认已是 20）。

## 与 `baby/` 的关系

`baby/` = 成长手册；本目录 = 每日喂养口语日记。
