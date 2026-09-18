# 假聊天 App · 使用手册

手机网页演示聊天：看起来像微信，数据存在 GitHub。后台改剧本，前端/App 只是在演。

## 1. 入口

| 页面 | 用途 |
|------|------|
| `chat-app/index.html` | 启动页（加 `?skip=1` 可跳过动画） |
| `chat-app/chats.html` | 会话列表 |
| `chat-app/chat.html?id=会话id` | 聊天记录 |
| `chat-app/admin.html` | 后台（口令 `chat-admin`） |

线上示例：`https://betterma.github.io/pages/chat-app/`  
你当前域名若反代了本仓库，路径同样是 `/chat-app/`。

## 2. 日常使用（前端）

1. 打开启动页，进入会话列表（骨架屏后出数据）。
2. 点某个会话进聊天房。
3. **发消息**：底部输入后点发送，会写入 GitHub（需几秒）。
4. **单聊已读**：进房后，对方消息记为你已读；你发出的消息在对方「进房」前显示「未读」，之后显示「已读」。
5. **群聊已读**：自己发出的消息下方显示「已读 N人 · 未读 M人」。
6. **换身份**：顶栏「以某某发送」——用哪个成员发、就用哪个成员记已读（方便演不同人）。

头像：无图时彩色底。姓名三字取后两字（王小明 → 小明），两字全取（张三 → 张三）。

列表未读角标是「我」（`u_me`）的未读数。

## 3. 后台编排（admin）

1. 打开 `admin.html`，口令 **`chat-admin`**。
2. **重新加载**：从 GitHub 拉最新 `threads.json`。
3. **新建 / 编辑会话**
   - 类型：单聊 / 群聊
   - 单聊会自动带「我」+ 对方（对方名默认用标题）
   - 群聊在成员区添加姓名（「我」不能删）
4. 点 **写入列表（未落盘）** 只改内存。
5. **消息**：选会话 → 选发送成员 → 填正文/时间 → 追加消息。
6. 最后点 **保存到 GitHub**，才会真正落盘。

数据文件：

- `chat-app/data/threads.json`：会话、成员、最后一句、未读
- `chat-app/data/messages/{会话id}.json`：该会话全部消息

## 4. 保存失败时

若提示 JSON / `<<<<<<<`：说明 `threads.json` 被 git 合并冲突写坏了。修好冲突并推送到 `main` 后再保存。不要把冲突标记提交进仓库。

保存依赖 GitHub Contents API 和仓库里的 token（`chat-store.js`）。Token 失效会 401。

多人同时保存可能冲突，前端发送已做重试；后台保存若冲突，刷新后再存一次。

## 5. APK（可选）

同一套页面可用 Capacitor 打包。需要 Node.js、JDK 17、Android Studio。在 `chat-app/`：

```bash
npm install
npm run cap:sync
npm run cap:open
```

改页面后重新 `cap:sync` 再打 APK。聊天数据仍读 GitHub，改后台不必重打包。
