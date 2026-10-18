// ==UserScript==
// @name         Raydium hot (Simple Style) - Always On
// @namespace    http://tampermonkey.net/
// @version      5.0.2
// @description  高性能合约监控系统 - 始终开启版
// @match        https://raydium.io/liquidity-pools/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_notification
// @grant        GM_addStyle
// @grant        GM_openInTab
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    // 原子级样式系统 - 朴素版（微调：移除LED相关样式）
    GM_addStyle(`
        #raydium-helper {
            position: fixed !important;
            bottom: 20px !important;
            right: 20px !important;
            z-index: 2147483647 !important;

            background: #ffffff;
            border: 1px solid #dcdcdc;
            border-radius: 8px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.08);
            padding: 15px;
            min-width: 260px;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, "Fira Sans", "Droid Sans", "Helvetica Neue", sans-serif;
            color: #333;
            font-size: 14px;
        }

        #raydium-helper h3 {
            margin: 0 0 12px 0; /* 与按钮组间距 */
            color: #333;
            font-size: 16px;
            display: flex;
            align-items: center;
        }

        .raydium-btn {
            padding: 8px 14px;
            border-radius: 6px;
            border: 1px solid #cccccc;
            cursor: pointer;
            transition: all 0.2s ease-in-out;
            margin: 4px;
            color: #333;
            background-color: #f0f0f0;
            font-size: 13px;
        }

        .raydium-btn:hover {
            background-color: #e0e0e0;
            border-color: #bbbbbb;
        }

        #copy-btn {
            background-color: #6c757d;
            color: white;
            border-color: #6c757d;
        }
        #copy-btn:hover {
            background-color: #5a6268;
            border-color: #5a6268;
        }

        #reset-btn {
            background-color: #dc3545;
            color: white;
            border-color: #dc3545;
        }
        #reset-btn:hover {
            background-color: #c82333;
            border-color: #c82333;
        }

        /* 计数器文本样式 */
        #raydium-helper > div:last-child {
            color: #666;
            font-size: 12px;
            margin-top: 10px;
            text-align: right;
        }
    `);

    // 核心控制器 - 始终开启模式
    class RaydiumHelper {
        constructor() {
            this.state = {
                contracts: new Set(GM_getValue('contracts', [])),
                // isActive 已移除，始终激活
                domCache: new WeakSet()
            };

            this.initUI();
            this.startMonitoring(); // 直接开始监控
            this.attachObservers();
            this.checkVisibility();
        }

        // 初始化界面（无暂停按钮，无LED）
        initUI() {
            this.container = document.createElement('div');
            this.container.id = 'raydium-helper';
            this.container.innerHTML = `
                <h3>🔭 合约监控</h3>
                <div style="margin:12px 0">
                    <button class="raydium-btn" id="copy-btn">📋 复制</button>
                    <button class="raydium-btn" id="reset-btn">♻ 重置</button>
                </div>
                <div>
                    已捕获：<span id="counter">${this.state.contracts.size}</span> 个合约
                </div>
            `;
            document.documentElement.appendChild(this.container);

            // 事件绑定
            this.container.querySelector('#copy-btn').addEventListener('click', () => this.copyContracts());
            this.container.querySelector('#reset-btn').addEventListener('click', () => this.reset());
        }

        // 启动监控（始终运行）
        startMonitoring() {
            this.observer = new MutationObserver(mutations => {
                this.scanContracts(); // 直接扫描，无需判断状态
            });
            this.observer.observe(document.body, {
                childList: true,
                subtree: true
            });
            this.scanContracts(); // 初始扫描
        }

        // 合约扫描
        scanContracts() {
            const targets = document.querySelectorAll('img.chakra-image:not([data-raydium-scanned])');
            targets.forEach(img => {
                const contract = img.alt?.trim();
                if (contract && this.validateContract(contract)) {
                    this.state.contracts.add(contract);
                    img.setAttribute('data-raydium-scanned', 'true');
                }
            });

            if (targets.length > 0) {
                GM_setValue('contracts', [...this.state.contracts]);
                this.updateCounter();
            }
        }

        // 合约验证
        validateContract(contract) {
            return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(contract);
        }

        // 复制功能
        copyContracts() {
            const text = [...this.state.contracts].join('\n');
            navigator.clipboard.writeText(text).then(() => {
                GM_notification({
                    title: '复制成功',
                    text: `已复制 ${this.state.contracts.size} 个地址`,
                    timeout: 2000
                });
            });
        }

        // 重置系统
        reset() {
            if (confirm('确认清除所有合约数据？')) {
                this.state.contracts.clear();
                GM_setValue('contracts', []);
                document.querySelectorAll('[data-raydium-scanned]').forEach(el => el.removeAttribute('data-raydium-scanned'));
                this.updateCounter();
            }
        }

        // 更新计数
        updateCounter() {
            const counter = this.container.querySelector('#counter');
            if (counter) counter.textContent = this.state.contracts.size;
        }

        // 可见性保障
        checkVisibility() {
            setInterval(() => {
                if (!document.getElementById('raydium-helper')) {
                    this.initUI();
                }
            }, 1000);
        }

        // DOM观察器（确保UI存在）
        attachObservers() {
            new MutationObserver(() => {
                if (!document.contains(this.container)) {
                    this.initUI();
                }
            }).observe(document, { childList: true, subtree: true });
        }
    }

    // 启动系统
    window.addEventListener('load', () => {
        new RaydiumHelper();
    }, { once: true });

    // 兼容性保障
    if (typeof GM_addStyle === "undefined") {
        const style = document.createElement('style');
        style.textContent = '#raydium-helper { display: block !important; }';
        document.head.appendChild(style);
    }
})();