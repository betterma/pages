// ==UserScript==
// @name         GeckoTerminal代币ID提取器
// @namespace    http://tampermonkey.net/
// @version      2.0
// @description  提取Solana前50个热门池的代币ID
// @author       YourName
// @match        https://www.geckoterminal.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_notification
// @connect      api.geckoterminal.com
// ==/UserScript==

(function() {
    'use strict';

    // 创建悬浮窗样式
    const style = document.createElement('style');
    style.innerHTML = `
        #token-extractor-panel {
            position: fixed;
            top: 20px;
            right: 20px;
            width: 320px;
            background: rgba(25, 30, 43, 0.95);
            border: 1px solid #2d374b;
            border-radius: 12px;
            padding: 16px;
            box-shadow: 0 8px 32px rgba(0,0,0,0.3);
            z-index: 9999;
            color: #e2e8f0;
            font-family: 'Inter', sans-serif;
            backdrop-filter: blur(10px);
            max-height: 80vh;
            overflow: hidden;
            display: flex;
            flex-direction: column;
        }
        #token-extractor-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 12px;
            padding-bottom: 12px;
            border-bottom: 1px solid #2d374b;
        }
        #token-extractor-title {
            font-weight: 600;
            font-size: 16px;
            color: #8be9fd;
        }
        #close-panel {
            cursor: pointer;
            color: #ff5555;
            font-size: 20px;
            line-height: 1;
        }
        #token-list-container {
            flex: 1;
            overflow-y: auto;
            max-height: 60vh;
            margin-bottom: 12px;
        }
        .token-item {
            padding: 10px;
            margin-bottom: 8px;
            background: rgba(30, 36, 54, 0.7);
            border-radius: 8px;
            font-size: 13px;
            font-family: 'Roboto Mono', monospace;
            word-break: break-all;
            transition: all 0.2s;
            border: 1px solid transparent;
        }
        .token-item:hover {
            background: rgba(40, 46, 64, 0.9);
            border-color: #6272a4;
        }
        #action-buttons {
            display: flex;
            gap: 10px;
        }
        .extractor-btn {
            flex: 1;
            padding: 10px;
            border-radius: 8px;
            border: none;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.2s;
            font-size: 14px;
        }
        #copy-btn {
            background: linear-gradient(90deg, #8a2be2, #4b0082);
            color: white;
        }
        #copy-btn:hover {
            background: linear-gradient(90deg, #9a3bf2, #5b00a2);
        }
        #refresh-btn {
            background: rgba(56, 63, 83, 0.8);
            color: #8be9fd;
        }
        #refresh-btn:hover {
            background: rgba(66, 73, 93, 1);
        }
        #status-indicator {
            margin-top: 12px;
            text-align: center;
            font-size: 12px;
            color: #6272a4;
        }
    `;
    document.head.appendChild(style);

    // 创建主面板
    const panel = document.createElement('div');
    panel.id = 'token-extractor-panel';
    panel.innerHTML = `
        <div id="token-extractor-header">
            <div id="token-extractor-title">Solana热门代币ID列表</div>
            <div id="close-panel">×</div>
        </div>
        <div id="token-list-container"></div>
        <div id="action-buttons">
            <button id="copy-btn" class="extractor-btn">复制全部</button>
            <button id="refresh-btn" class="extractor-btn">刷新数据</button>
        </div>
        <div id="status-indicator">准备就绪</div>
    `;
    document.body.appendChild(panel);

    // 获取DOM元素
    const tokenListContainer = document.getElementById('token-list-container');
    const copyBtn = document.getElementById('copy-btn');
    const refreshBtn = document.getElementById('refresh-btn');
    const closeBtn = document.getElementById('close-panel');
    const statusIndicator = document.getElementById('status-indicator');

    // 关闭面板
    closeBtn.addEventListener('click', () => {
        panel.style.display = 'none';
    });

    // 获取API数据
    async function fetchTokenData() {
        statusIndicator.textContent = '获取数据中...';
        tokenListContainer.innerHTML = '<div class="token-item">加载中，请稍候...</div>';

        try {
            const pages = [1, 2]; // 请求前两页数据
            const allData = [];

            for (const page of pages) {
                const data = await fetchApiData(page);
                allData.push(...data.data);
            }

            processTokenData(allData);
        } catch (error) {
            statusIndicator.textContent = `错误: ${error.message}`;
            tokenListContainer.innerHTML = `<div class="token-item" style="color:#ff5555">请求失败: ${error.message}</div>`;
        }
    }

    // API请求封装
    function fetchApiData(page) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: `https://api.geckoterminal.com/api/v2/networks/solana/trending_pools?page=${page}`,
                onload: function(response) {
                    if (response.status === 200) {
                        resolve(JSON.parse(response.responseText));
                    } else {
                        reject(new Error(`API错误: ${response.status}`));
                    }
                },
                onerror: function(error) {
                    reject(new Error('网络请求失败'));
                }
            });
        });
    }

    // 处理并显示代币数据
    function processTokenData(pools) {
        const tokenIds = [];

        pools.forEach(pool => {
            const tokenId = pool.relationships?.base_token?.data?.id;
            if (tokenId && typeof tokenId === 'string') {
                // 提取下划线后的部分
                const parts = tokenId.split('_');
                if (parts.length > 1) {
                    tokenIds.push(parts[1]);
                }
            }
        });

        displayTokenList(tokenIds);
        statusIndicator.textContent = `已加载 ${tokenIds.length} 个代币ID`;
    }

    // 显示代币列表
    function displayTokenList(tokenIds) {
        tokenListContainer.innerHTML = '';

        if (tokenIds.length === 0) {
            tokenListContainer.innerHTML = '<div class="token-item">未找到有效代币ID</div>';
            return;
        }

        tokenIds.forEach(id => {
            const tokenElement = document.createElement('div');
            tokenElement.className = 'token-item';
            tokenElement.textContent = id;
            tokenListContainer.appendChild(tokenElement);
        });
    }

    // 复制功能
    copyBtn.addEventListener('click', () => {
        const tokenItems = document.querySelectorAll('.token-item');
        const tokenIds = Array.from(tokenItems).map(item => item.textContent);

        if (tokenIds.length === 0) {
            showNotification('复制失败', '没有可复制的代币ID');
            return;
        }

        const textToCopy = tokenIds.join('\n');
        navigator.clipboard.writeText(textToCopy)
            .then(() => {
                showNotification('复制成功', `已复制 ${tokenIds.length} 个代币ID`);
            })
            .catch(err => {
                showNotification('复制失败', '无法访问剪贴板');
                console.error('复制失败:', err);
            });
    });

    // 刷新数据
    refreshBtn.addEventListener('click', () => {
        fetchTokenData();
    });

    // 显示通知
    function showNotification(title, message) {
        statusIndicator.textContent = `${title}: ${message}`;
        statusIndicator.style.color = title === '复制成功' ? '#50fa7b' : '#ff5555';

        setTimeout(() => {
            statusIndicator.style.color = '#6272a4';
            statusIndicator.textContent = '准备就绪';
        }, 3000);
    }

    // 初始加载
    fetchTokenData();
})();
