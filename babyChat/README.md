# 宝宝日记（口语 + 语音）

手机网页录入，微信只收每晚总结。

## 怎么用

1. 打开本目录 `index.html`（需能加载上级 `github-token-vault.js`，并解锁仓库密码）
2. 发文字，或按住说话
3. 等定时云函数解析（状态变「待确认」）→ 改数字 / 标闲聊 → 确认入库
4. 每晚（默认北京时间 21:00 后）云函数写当日总结；配置了 PushPlus 则推到微信（含月龄、奶量）

## 目录

| 路径 | 作用 |
|------|------|
| `index.html` 等 | 手机录入页 |
| `baby-chat-data.json` | 共享数据（GitHub） |
| `cloud-function-baby-chat/` | **新建**定时云函数整包 |

云函数部署见 `cloud-function-baby-chat/README.md`。

## 与 `baby/` 的关系

`baby/` 是成长手册（身高体重月记）。本目录是**每日口语喂养日记**，互不替代。
