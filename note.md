可以试：

开系统代理/VPN 后再 git pull / git push
若本机代理已开（常见端口 7890），让 Git 走代理：

git config --global http.proxy http://127.0.0.1:7897
git config --global https.proxy http://127.0.0.1:7897

代理端口按你实际软件改；不用代理时再清掉：

git config --global --unset http.proxy
git config --global --unset https.proxy
