// ==UserScript==
// @name         Transit Finance 市场页批量复制合约地址
// @description  通过模拟点击复制按钮批量获取完整合约地址
// @match        https://swap.transit.finance/*
// @grant        GM_setClipboard
// @grant        GM_notification
// @grant        GM_addStyle
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    console.log('Transit Finance 批量复制脚本已加载 (点击复制模式)');

    // 添加样式
    GM_addStyle(`
        #copyContractBtn {
            position: fixed;
            top: 20px;
            right: 20px;
            z-index: 999999;
            padding: 12px 24px;
            border-radius: 8px;
            cursor: pointer;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            border: none;
            box-shadow: 0 4px 15px rgba(0,0,0,0.2);
            font-size: 15px;
            font-weight: bold;
            letter-spacing: 0.5px;
            transition: all 0.3s ease;
        }
        #copyContractBtn:hover {
            transform: scale(1.05);
            box-shadow: 0 6px 20px rgba(0,0,0,0.3);
        }
        #copyContractBtn:disabled {
            opacity: 0.6;
            cursor: not-allowed;
            transform: none;
        }
        .copy-progress-bar {
            position: fixed;
            top: 80px;
            right: 20px;
            width: 300px;
            background: white;
            border-radius: 12px;
            overflow: hidden;
            z-index: 999999;
            box-shadow: 0 4px 20px rgba(0,0,0,0.15);
            border: 1px solid #e0e0e0;
        }
        .copy-progress-header {
            padding: 12px 16px;
            background: #f8f9fa;
            border-bottom: 1px solid #e0e0e0;
            font-weight: bold;
            color: #333;
        }
        .copy-progress-body {
            padding: 16px;
        }
        .copy-progress-fill {
            height: 8px;
            background: linear-gradient(90deg, #4CAF50, #45a049);
            border-radius: 4px;
            transition: width 0.3s ease;
            margin-bottom: 8px;
        }
        .copy-progress-text {
            font-size: 14px;
            color: #666;
            display: flex;
            justify-content: space-between;
        }
        .copy-progress-detail {
            font-size: 12px;
            color: #999;
            margin-top: 8px;
            word-break: break-word;
        }
        .copy-status-message {
            position: fixed;
            top: 140px;
            right: 20px;
            padding: 12px 24px;
            border-radius: 8px;
            color: white;
            font-weight: bold;
            z-index: 1000000;
            animation: slideIn 0.3s ease;
            box-shadow: 0 4px 15px rgba(0,0,0,0.3);
            font-size: 14px;
            max-width: 400px;
            word-break: break-word;
        }
        .copy-item-highlight {
            background-color: rgba(102, 126, 234, 0.3) !important;
            transition: background-color 0.2s ease;
            border-radius: 4px;
        }
        @keyframes slideIn {
            from { transform: translateX(100%); opacity: 0; }
            to { transform: translateX(0); opacity: 1; }
        }
    `);

    // 显示状态消息
    const showStatusMessage = (text, type = 'success', duration = 3000) => {
        const colors = {
            success: 'linear-gradient(135deg, #4CAF50 0%, #45a049 100%)',
            error: 'linear-gradient(135deg, #f44336 0%, #d32f2f 100%)',
            info: 'linear-gradient(135deg, #2196F3 0%, #1976D2 100%)',
            warning: 'linear-gradient(135deg, #FF9800 0%, #F57C00 100%)'
        };

        const msg = document.createElement('div');
        msg.className = 'copy-status-message';
        msg.style.background = colors[type] || colors.info;
        msg.textContent = text;
        document.body.appendChild(msg);

        setTimeout(() => {
            msg.style.animation = 'slideIn 0.3s reverse';
            setTimeout(() => msg.remove(), 300);
        }, duration);
    };

    // 创建进度条
    const createProgressBar = (total) => {
        const container = document.createElement('div');
        container.className = 'copy-progress-bar';

        container.innerHTML = `
            <div class="copy-progress-header">
                📋 批量复制合约地址
            </div>
            <div class="copy-progress-body">
                <div class="copy-progress-fill" style="width: 0%"></div>
                <div class="copy-progress-text">
                    <span class="copy-progress-current">0</span>
                    <span>/</span>
                    <span class="copy-progress-total">${total}</span>
                </div>
                <div class="copy-progress-detail" id="progressDetail">
                    准备中...
                </div>
            </div>
        `;

        document.body.appendChild(container);

        return {
            container,
            update: (current, detail) => {
                const percent = (current / total) * 100;
                const fill = container.querySelector('.copy-progress-fill');
                const currentSpan = container.querySelector('.copy-progress-current');
                const detailDiv = container.querySelector('#progressDetail');

                if (fill) fill.style.width = `${percent}%`;
                if (currentSpan) currentSpan.textContent = current;
                if (detailDiv) detailDiv.textContent = detail;
            },
            remove: () => container.remove()
        };
    };

    // 模拟点击复制按钮并获取地址
    const getAddressByClicking = async (copyButton, tokenSymbol) => {
        return new Promise((resolve) => {
            // 创建一个隐藏的文本区域来捕获复制的内容
            const hiddenTextArea = document.createElement('textarea');
            hiddenTextArea.style.position = 'fixed';
            hiddenTextArea.style.top = '-100px';
            hiddenTextArea.style.left = '-100px';
            hiddenTextArea.style.opacity = '0';
            hiddenTextArea.style.pointerEvents = 'none';
            document.body.appendChild(hiddenTextArea);

            // 高亮当前处理的按钮
            copyButton.classList.add('copy-item-highlight');

            // 保存原始的execCommand方法
            const originalExecCommand = document.execCommand;

            // 模拟document.execCommand('copy')
            document.execCommand = function(command, showUI, value) {
                if (command === 'copy') {
                    // 获取选中的文本
                    const selectedText = window.getSelection().toString();
                    if (selectedText) {
                        // 如果选中有文本，使用选中的文本
                        setTimeout(() => {
                            document.execCommand = originalExecCommand;
                            copyButton.classList.remove('copy-item-highlight');
                            document.body.removeChild(hiddenTextArea);
                            resolve(selectedText);
                        }, 100);
                        return true;
                    }
                }
                return originalExecCommand.call(this, command, showUI, value);
            };

            try {
                // 聚焦到隐藏的文本区域
                hiddenTextArea.focus();

                // 模拟点击复制按钮
                copyButton.click();

                // 设置超时
                setTimeout(() => {
                    // 恢复原始方法
                    document.execCommand = originalExecCommand;
                    copyButton.classList.remove('copy-item-highlight');
                    document.body.removeChild(hiddenTextArea);

                    // 尝试从地址元素获取
                    const addressElem = copyButton.closest('.address-copy')?.querySelector('.address');
                    if (addressElem) {
                        const displayAddress = addressElem.textContent.trim();
                        console.log(`⚠️ ${tokenSymbol} 点击复制超时，使用显示地址: ${displayAddress}`);
                        resolve(displayAddress);
                    } else {
                        resolve(null);
                    }
                }, 1000);

            } catch (error) {
                document.execCommand = originalExecCommand;
                copyButton.classList.remove('copy-item-highlight');
                document.body.removeChild(hiddenTextArea);
                console.error(`❌ ${tokenSymbol} 点击复制失败:`, error);
                resolve(null);
            }
        });
    };

    // 获取所有代币信息
    const getAllTokens = () => {
        const tokens = [];

        // 查找所有复制按钮
        const copyButtons = document.querySelectorAll('img.copy');
        console.log(`找到 ${copyButtons.length} 个复制按钮`);

        copyButtons.forEach((button, index) => {
            // 获取代币符号
            let symbol = '未知';
            let displayAddress = '';

            const tokenItem = button.closest('.market-class-token-item');
            if (tokenItem) {
                const symbolElem = tokenItem.querySelector('.symbol');
                if (symbolElem) {
                    symbol = symbolElem.textContent.trim();
                }

                const addressElem = tokenItem.querySelector('.address');
                if (addressElem) {
                    displayAddress = addressElem.textContent.trim();
                }
            }

            tokens.push({
                button: button,
                symbol: symbol,
                displayAddress: displayAddress,
                index: index + 1
            });
        });

        return tokens;
    };

    // 主函数
    const copyAllContracts = async () => {
        // 获取所有代币
        const tokens = getAllTokens();

        if (tokens.length === 0) {
            showStatusMessage('❌ 未找到任何复制按钮', 'error');
            return;
        }

        // 创建进度条
        const progress = createProgressBar(tokens.length);

        const addresses = [];
        const failedTokens = [];

        showStatusMessage(`开始处理 ${tokens.length} 个代币...`, 'info');

        // 逐个点击复制
        for (let i = 0; i < tokens.length; i++) {
            const token = tokens[i];

            progress.update(i + 1, `正在处理 ${i + 1}/${tokens.length}: ${token.symbol}`);

            console.log(`🔄 正在处理第 ${i + 1} 个代币: ${token.symbol} (显示地址: ${token.displayAddress})`);

            // 滚动到当前元素
            token.button.scrollIntoView({ behavior: 'smooth', block: 'center' });

            // 等待滚动完成
            await new Promise(r => setTimeout(r, 200));

            // 点击复制并获取地址
            const fullAddress = await getAddressByClicking(token.button, token.symbol);

            if (fullAddress && fullAddress.length > 30) {
                addresses.push(fullAddress);
                console.log(`✅ 成功获取: ${token.symbol} -> ${fullAddress.substring(0, 10)}...`);
            } else {
                failedTokens.push({ symbol: token.symbol, display: token.displayAddress });
                console.log(`❌ 失败: ${token.symbol}`);
            }

            // 移除高亮
            token.button.classList.remove('copy-item-highlight');

            // 短暂延迟，避免太快
            await new Promise(r => setTimeout(r, 300));
        }

        // 移除进度条
        progress.remove();

        // 去重
        const uniqueAddresses = [...new Set(addresses)];

        if (uniqueAddresses.length === 0) {
            showStatusMessage('❌ 未能获取任何地址', 'error');
            return;
        }

        // 复制到剪贴板
        const output = uniqueAddresses.join('\n');

        try {
            if (typeof GM_setClipboard !== 'undefined') {
                GM_setClipboard(output, 'text');
            } else {
                await navigator.clipboard.writeText(output);
            }

            const successRate = ((uniqueAddresses.length / tokens.length) * 100).toFixed(1);
            let message = `✅ 成功复制 ${uniqueAddresses.length} 个地址 (成功率 ${successRate}%)`;

            if (failedTokens.length > 0) {
                message += `\n失败 ${failedTokens.length} 个`;
                console.log('失败的代币:', failedTokens);
            }

            showStatusMessage(message, 'success', 5000);

            // 在控制台显示完整列表
            console.log('=== 复制的完整地址列表 ===');
            uniqueAddresses.forEach((addr, i) => {
                console.log(`${i + 1}. ${addr}`);
            });

        } catch (e) {
            console.error('复制失败:', e);
            showStatusMessage('❌ 复制失败，请在控制台查看地址', 'error');
            console.log('地址列表:', output);
        }
    };

    // 创建按钮
    const createButton = () => {
        const btn = document.createElement('button');
        btn.id = 'copyContractBtn';
        btn.textContent = '📋 批量复制合约地址 (点击模式)';

        btn.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();

            btn.disabled = true;
            btn.textContent = '⏳ 正在处理...';

            await copyAllContracts();

            btn.disabled = false;
            btn.textContent = '📋 批量复制合约地址 (点击模式)';
        });

        return btn;
    };

    // 初始化
    const init = () => {
        console.log('初始化脚本...');

        if (!document.body) {
            setTimeout(init, 100);
            return;
        }

        // 添加按钮
        const btn = createButton();
        document.body.appendChild(btn);
        console.log('按钮已添加');

        // 显示帮助信息
        setTimeout(() => {
            const copyButtons = document.querySelectorAll('img.copy');
            console.log(`页面就绪，发现 ${copyButtons.length} 个复制按钮`);

            if (copyButtons.length === 0) {
                console.log('提示：未找到复制按钮，请确保页面已完全加载');
            } else {
                console.log('提示：脚本将通过模拟点击每个复制按钮来获取完整地址');
                console.log('注意：请勿在脚本运行期间操作页面');
            }
        }, 2000);
    };

    // 启动脚本
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();