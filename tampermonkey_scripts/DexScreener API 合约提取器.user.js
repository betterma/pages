// ==UserScript==
// @name         DexScreener API 合约提取器
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  通过DexScreener官方API获取代币合约地址
// @author       YourName
// @match        https://dexscreener.com/*
// @match        https://app.dexscreener.com/*
// @match        https://*.dexscreener.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setClipboard
// @grant        GM_addStyle
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    // 添加样式
    GM_addStyle(`
        #dexApiExtractor {
            position: fixed;
            top: 50%;
            right: 20px;
            transform: translateY(-50%);
            z-index: 9999;
            background: linear-gradient(135deg, #1a1f2e, #0f1420);
            color: #fff;
            padding: 20px;
            border-radius: 16px;
            box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
            width: 340px;
            font-family: 'Segoe UI', system-ui, sans-serif;
            border: 1px solid #2a3045;
            display: none;
        }

        #dexApiExtractor.active {
            display: block;
        }

        .api-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 15px;
            padding-bottom: 15px;
            border-bottom: 1px solid #2a3045;
        }

        .api-title {
            font-size: 18px;
            font-weight: 600;
            color: #6b8cff;
        }

        .api-close {
            background: transparent;
            border: none;
            color: #8f9bb5;
            font-size: 20px;
            cursor: pointer;
            padding: 0 8px;
            border-radius: 4px;
        }

        .api-close:hover {
            background: #2a3045;
            color: #fff;
        }

        .chain-selector {
            display: flex;
            gap: 8px;
            margin-bottom: 15px;
            flex-wrap: wrap;
        }

        .chain-btn {
            padding: 6px 12px;
            border-radius: 20px;
            background: #262b3c;
            border: 1px solid #363d54;
            color: #b4bcd0;
            cursor: pointer;
            font-size: 13px;
            transition: 0.2s;
        }

        .chain-btn.active {
            background: #6b8cff;
            border-color: #6b8cff;
            color: white;
        }

        .stats-bar {
            display: flex;
            justify-content: space-between;
            background: #262b3c;
            padding: 10px;
            border-radius: 8px;
            margin-bottom: 15px;
            font-size: 13px;
        }

        .stat-total { color: #6b8cff; }
        .stat-success { color: #4caf50; }
        .stat-failed { color: #ff6b6b; }

        .tabs {
            display: flex;
            gap: 10px;
            margin-bottom: 10px;
            border-bottom: 1px solid #2a3045;
        }

        .tab {
            padding: 8px 0;
            cursor: pointer;
            color: #8f9bb5;
            border-bottom: 2px solid transparent;
            margin-right: 20px;
        }

        .tab.active {
            color: #6b8cff;
            border-bottom-color: #6b8cff;
        }

        .results-panel {
            max-height: 300px;
            overflow-y: auto;
            background: #262b3c;
            border-radius: 8px;
            padding: 10px;
            margin-bottom: 15px;
            font-family: 'Monaco', monospace;
            font-size: 12px;
        }

        .result-item {
            padding: 8px;
            border-radius: 4px;
            margin-bottom: 4px;
            word-break: break-all;
        }

        .result-item.success {
            background: rgba(76, 175, 80, 0.1);
            border-left: 3px solid #4caf50;
            color: #a5d6a7;
        }

        .result-item.failed {
            background: rgba(255, 107, 107, 0.1);
            border-left: 3px solid #ff6b6b;
            color: #ffb3b3;
        }

        .token-name {
            color: #b4bcd0;
            font-size: 11px;
            margin-top: 2px;
        }

        .action-buttons {
            display: flex;
            gap: 10px;
        }

        .api-btn {
            flex: 1;
            padding: 10px;
            border: none;
            border-radius: 8px;
            font-weight: 600;
            cursor: pointer;
            transition: 0.2s;
        }

        .api-btn.primary {
            background: linear-gradient(135deg, #6b8cff, #8b6bff);
            color: white;
        }

        .api-btn.secondary {
            background: #2a3045;
            color: #b4bcd0;
            border: 1px solid #363d54;
        }

        .api-btn:hover {
            transform: translateY(-2px);
            filter: brightness(1.1);
        }

        .api-btn:active {
            transform: translateY(0);
        }

        .notification {
            position: fixed;
            top: 70px;
            right: 20px;
            padding: 12px 24px;
            background: #1a1f2e;
            border-left: 4px solid #4caf50;
            color: white;
            border-radius: 8px;
            font-size: 14px;
            box-shadow: 0 5px 15px rgba(0,0,0,0.3);
            transform: translateX(120%);
            transition: transform 0.3s;
            z-index: 10000;
        }

        .notification.show {
            transform: translateX(0);
        }

        .notification.error {
            border-left-color: #ff6b6b;
        }

        .loader {
            text-align: center;
            padding: 20px;
        }

        .loader-spinner {
            width: 30px;
            height: 30px;
            border: 3px solid #2a3045;
            border-top-color: #6b8cff;
            border-radius: 50%;
            margin: 0 auto 10px;
            animation: spin 1s linear infinite;
        }

        @keyframes spin {
            to { transform: rotate(360deg); }
        }
    `);

    // 创建触发按钮
    const triggerBtn = document.createElement('button');
    triggerBtn.id = 'apiExtractorTrigger';
    triggerBtn.textContent = '🔍 API合约提取';
    Object.assign(triggerBtn.style, {
        position: 'fixed',
        top: '70px',
        right: '20px',
        zIndex: '9999',
        background: 'linear-gradient(135deg, #6b8cff, #8b6bff)',
        color: 'white',
        border: 'none',
        padding: '10px 20px',
        borderRadius: '8px',
        fontWeight: '600',
        cursor: 'pointer',
        boxShadow: '0 4px 15px rgba(107, 140, 255, 0.3)',
        transition: '0.3s'
    });
    document.body.appendChild(triggerBtn);

    // 创建主面板
    const panel = document.createElement('div');
    panel.id = 'dexApiExtractor';
    panel.innerHTML = `
        <div class="api-header">
            <span class="api-title">📊 API合约提取</span>
            <button class="api-close">✕</button>
        </div>
        <div class="chain-selector">
            <button class="chain-btn active" data-chain="solana">Solana</button>
            <button class="chain-btn" data-chain="ethereum">Ethereum</button>
            <button class="chain-btn" data-chain="bsc">BSC</button>
            <button class="chain-btn" data-chain="base">Base</button>
            <button class="chain-btn" data-chain="arbitrum">Arbitrum</button>
            <button class="chain-btn" data-chain="robinhood">Robinhood</button>
        </div>
        <div class="stats-bar">
            <span>总计: <span class="stat-total" id="statTotal">0</span></span>
            <span>成功: <span class="stat-success" id="statSuccess">0</span></span>
            <span>失败: <span class="stat-failed" id="statFailed">0</span></span>
        </div>
        <div class="tabs">
            <div class="tab active" data-tab="success">✅ 成功</div>
            <div class="tab" data-tab="failed">❌ 失败</div>
        </div>
        <div id="successPanel" class="results-panel"></div>
        <div id="failedPanel" class="results-panel" style="display: none;"></div>
        <div class="action-buttons">
            <button class="api-btn primary" id="extractBtn">🔍 提取合约</button>
            <button class="api-btn secondary" id="copyBtn">📋 复制成功项</button>
        </div>
    `;
    document.body.appendChild(panel);

    // 创建通知
    const notification = document.createElement('div');
    notification.className = 'notification';
    document.body.appendChild(notification);

    // 当前选择的链
    let currentChain = 'solana';

    // 显示通知
    function showNotif(msg, isError = false) {
        notification.textContent = msg;
        notification.classList.add('show');
        if (isError) notification.classList.add('error');
        else notification.classList.remove('error');
        setTimeout(() => notification.classList.remove('show'), 2000);
    }

    // 切换面板显示
    triggerBtn.addEventListener('click', () => {
        panel.classList.toggle('active');
        triggerBtn.textContent = panel.classList.contains('active') ? '📋 收起面板' : '🔍 API合约提取';
    });

    // 关闭按钮
    panel.querySelector('.api-close').addEventListener('click', () => {
        panel.classList.remove('active');
        triggerBtn.textContent = '🔍 API合约提取';
    });

    // 链选择
    panel.querySelectorAll('.chain-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            panel.querySelectorAll('.chain-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentChain = btn.dataset.chain;
        });
    });

    // 标签页切换
    const tabs = panel.querySelectorAll('.tab');
    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            tabs.forEach(t => t.classList.remove('active'));
            tab.classList.add('active');

            const showSuccess = tab.dataset.tab === 'success';
            document.getElementById('successPanel').style.display = showSuccess ? 'block' : 'none';
            document.getElementById('failedPanel').style.display = showSuccess ? 'none' : 'block';
        });
    });

    // 提取合约的主函数
    async function extractContracts() {
        const successPanel = document.getElementById('successPanel');
        const failedPanel = document.getElementById('failedPanel');

        // 显示加载状态
        successPanel.innerHTML = `
            <div class="loader">
                <div class="loader-spinner"></div>
                <div>正在通过API查询...</div>
            </div>
        `;
        failedPanel.innerHTML = '';

        // 重置统计
        document.getElementById('statTotal').textContent = '0';
        document.getElementById('statSuccess').textContent = '0';
        document.getElementById('statFailed').textContent = '0';

        // 获取当前页面的所有代币对
        const tokenPairs = [];

        // 方法1: 从表格行中提取代币名称和链接
        document.querySelectorAll('.ds-dex-table-row').forEach(row => {
            const link = row.getAttribute('href');
            const tokenName = row.querySelector('.ds-dex-table-row-base-token-symbol')?.textContent?.trim() ||
                             row.querySelector('.ds-dex-table-row-base-token-name-text')?.textContent?.trim();

            if (link) {
                // 从链接中提取可能的路由ID
                const match = link.match(new RegExp(`/${currentChain}/([^/]+)`));
                if (match) {
                    tokenPairs.push({
                        routeId: match[1],
                        tokenName: tokenName || '未知代币',
                        fullLink: link
                    });
                }
            }
        });

        // 如果表格没找到，尝试从页面标题或URL获取
        if (tokenPairs.length === 0) {
            const pathMatch = window.location.pathname.match(new RegExp(`/${currentChain}/([^/]+)`));
            if (pathMatch) {
                tokenPairs.push({
                    routeId: pathMatch[1],
                    tokenName: document.title.split('|')[0].trim() || '当前代币',
                    fullLink: window.location.pathname
                });
            }
        }

        document.getElementById('statTotal').textContent = tokenPairs.length;

        const successItems = [];
        const failedItems = [];

        // 遍历每个代币，调用API查询
        for (const pair of tokenPairs) {
            try {
                // 方法1: 通过路由ID查询
                const apiUrl = `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(pair.routeId)}`;

                await new Promise((resolve) => {
                    GM_xmlhttpRequest({
                        method: 'GET',
                        url: apiUrl,
                        onload: (resp) => {
                            try {
                                const data = JSON.parse(resp.responseText);

                                if (data.pairs && data.pairs.length > 0) {
                                    // 过滤出当前链的交易对
                                    const chainPairs = data.pairs.filter(p => p.chainId === currentChain);

                                    if (chainPairs.length > 0) {
                                        // 取第一个交易对的baseToken地址
                                        const contract = chainPairs[0].baseToken.address;
                                        successItems.push({
                                            contract: contract,
                                            name: chainPairs[0].baseToken.symbol || pair.tokenName,
                                            pairAddress: chainPairs[0].pairAddress || ''
                                        });
                                        console.log(`✅ ${pair.tokenName}: ${contract}`);
                                    } else {
                                        // 没找到当前链的数据，尝试用代币名称搜索
                                        searchByName(pair.tokenName, pair, successItems, failedItems);
                                    }
                                } else {
                                    // API没返回数据，尝试用代币名称搜索
                                    searchByName(pair.tokenName, pair, successItems, failedItems);
                                }
                            } catch (e) {
                                failedItems.push({
                                    name: pair.tokenName,
                                    reason: `API解析失败: ${e.message}`
                                });
                            }
                            resolve();
                        },
                        onerror: () => {
                            failedItems.push({
                                name: pair.tokenName,
                                reason: 'API请求失败'
                            });
                            resolve();
                        }
                    });
                });

                // 稍微延迟避免请求过快
                await new Promise(r => setTimeout(r, 300));

            } catch (error) {
                failedItems.push({
                    name: pair.tokenName,
                    reason: `处理错误: ${error.message}`
                });
            }
        }

        // 用代币名称搜索的辅助函数
        function searchByName(name, originalPair, successList, failedList) {
            if (!name || name === '未知代币') {
                failedList.push({
                    name: originalPair.tokenName,
                    reason: '无法获取代币名称'
                });
                return;
            }

            GM_xmlhttpRequest({
                method: 'GET',
                url: `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(name)}`,
                synchronous: true,
                onload: (resp) => {
                    try {
                        const data = JSON.parse(resp.responseText);
                        if (data.pairs && data.pairs.length > 0) {
                            const chainPairs = data.pairs.filter(p => p.chainId === currentChain);
                            if (chainPairs.length > 0) {
                                const contract = chainPairs[0].baseToken.address;
                                successList.push({
                                    contract: contract,
                                    name: name,
                                    pairAddress: chainPairs[0].pairAddress || ''
                                });
                                console.log(`✅ [名称搜索] ${name}: ${contract}`);
                                return;
                            }
                        }
                        failedList.push({
                            name: name,
                            reason: 'API未返回该链的数据'
                        });
                    } catch (e) {
                        failedList.push({
                            name: name,
                            reason: `名称搜索失败: ${e.message}`
                        });
                    }
                },
                onerror: () => {
                    failedList.push({
                        name: name,
                        reason: '名称搜索请求失败'
                    });
                }
            });
        }

        // 更新统计
        document.getElementById('statSuccess').textContent = successItems.length;
        document.getElementById('statFailed').textContent = failedItems.length;

        // 显示成功项
        if (successItems.length > 0) {
            successPanel.innerHTML = successItems.map(item => `
                <div class="result-item success">
                    <div>${item.contract}</div>
                    <div class="token-name">${item.name} ${item.pairAddress ? '| Pair: ' + item.pairAddress.substring(0, 8) + '...' : ''}</div>
                </div>
            `).join('');
        } else {
            successPanel.innerHTML = '<div class="result-item" style="text-align:center;color:#8f9bb5;">暂无成功项</div>';
        }

        // 显示失败项
        if (failedItems.length > 0) {
            failedPanel.innerHTML = failedItems.map(item => `
                <div class="result-item failed">
                    <div>${item.name}</div>
                    <div class="token-name">❌ ${item.reason}</div>
                </div>
            `).join('');
        } else {
            failedPanel.innerHTML = '<div class="result-item" style="text-align:center;color:#8f9bb5;">暂无失败项</div>';
        }

        if (successItems.length > 0) {
            showNotif(`✅ 成功提取 ${successItems.length} 个合约地址`);
        } else {
            showNotif('❌ 未提取到合约地址', true);
        }
    }

    // 绑定提取按钮
    document.getElementById('extractBtn').addEventListener('click', extractContracts);

    // 复制成功项
    document.getElementById('copyBtn').addEventListener('click', () => {
        const contracts = [];
        document.querySelectorAll('#successPanel .result-item.success').forEach(el => {
            const contractLine = el.querySelector('div:first-child')?.textContent?.trim();
            if (contractLine) contracts.push(contractLine);
        });

        if (contracts.length === 0) {
            showNotif('没有可复制的合约地址', true);
            return;
        }

        GM_setClipboard(contracts.join('\n'), 'text');
        showNotif(`📋 已复制 ${contracts.length} 个合约地址`);
    });

})();