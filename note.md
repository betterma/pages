## 一键 push（推荐）

双击 `push.cmd`，或在仓库根目录：

```bat
.\push.cmd
```

脚本会依次尝试：**直连** → **代理**（默认读 git `http(s).proxy`，否则 `http://127.0.0.1:7897`）。
远端超前时自动 stash → `pull --rebase` → stash pop → 再推。不改全局 git config。

```bat
.\push.cmd -DirectFirst:$false
.\push.cmd -Proxy http://127.0.0.1:7897
```

---

可以试：

开系统代理/VPN 后再 git pull / git push
若本机代理已开（常见端口 7890），让 Git 走代理：

git config --global http.proxy http://127.0.0.1:7897
git config --global https.proxy http://127.0.0.1:7897

代理端口按你实际软件改；不用代理时再清掉：

git config --global --unset http.proxy
git config --global --unset https.proxy
