// ==UserScript==
// @name         okx hot
// @namespace    http://tampermonkey.net/
// @version      2025-05-16
// @description  动态控制页面内容复制功能
// @match https://web3.okx.com/*
// @version      1.1
// ==/UserScript==

(function() {
    // 创建悬浮控制按钮
    const createControlButton = () => {
        const btn = document.createElement('button');
        btn.id = 'smartCopyToggle';
        Object.assign(btn.style, {
            position: 'fixed',
            top: '20px',
            right: '20px',
            zIndex: 99999,
            padding: '10px 20px',
            borderRadius: '5px',
            cursor: 'pointer',
            background: '#4CAF50',
            color: 'white',
            border: 'none',
            boxShadow: '0 2px 5px rgba(0,0,0,0.3)'
        });
        btn.textContent = '启动智能复制';
        return btn;
    };

    // 创建安全点击事件
    const createSafeClickEvent = (button) => {
        const doc = button.ownerDocument;
        const win = doc.defaultView || window;

        return new win.MouseEvent('click', {
            bubbles: true,
            cancelable: true,
            view: win  // 使用正确的作用域窗口
        });
    };

    // 自动收集器核心逻辑
    const createAutoCollector = () => {
        return async function(event) {
            if (event.target.closest('button.dex.dex-plain-button')) return;


            const allPotentialButtons = [...document.querySelectorAll('button.dex-plain-button')];
const buttons = allPotentialButtons.filter(button => button.querySelector('i.dex-okx-defi-dex-copy1'));
            const results = [];

            for (const button of buttons) {
                try {
                    if(button.innerText.includes("买入")) return
                    button.dispatchEvent(createSafeClickEvent(button));
                    await new Promise(r => setTimeout(r, 50));
                    const text = await navigator.clipboard.readText();
                    results.push(text.trim());
                } catch (err) {
                    console.error('操作失败:', err);
                }
            }

            const output = results.join('\n');
            navigator.clipboard.writeText(output);
        };
    };

    // 主控制器
    class CopyController {
        constructor() {
            this.isActive = false;
            this.originalWriteText = null;
            this.handler = null;
            this.btn = createControlButton();

            this.init();
        }

        init() {
            this.btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.toggleSystem();
            });

            document.body.appendChild(this.btn);
            this.checkPermissions();
        }

        async toggleSystem() {
            if (this.isActive) {
                this.deactivate();
            } else {
                await this.activate();
            }
            this.isActive = !this.isActive;
        }

        async activate() {
            this.originalWriteText = navigator.clipboard.writeText;
            this.handler = createAutoCollector();

            document.addEventListener('click', this.handler);
            this.updateButtonState(true);
        }

        deactivate() {
            document.removeEventListener('click', this.handler);
            if (this.originalWriteText) {
                navigator.clipboard.writeText = this.originalWriteText;
            }
            this.updateButtonState(false);
        }

        updateButtonState(active) {
            this.btn.style.background = active ? '#4CAF50' : '#f44336';
            this.btn.textContent = active ? '运行中 (点击关闭)' : '已关闭 (点击启动)';
        }

        checkPermissions() {
            navigator.permissions.query({ name: 'clipboard-read' }).then(result => {
                if (result.state === 'prompt') {
                    this.btn.style.animation = 'glow 1s infinite alternate';
                }
            });
        }
    }

    // 初始化样式
    const addStyles = () => {
        const style = document.createElement('style');
        style.textContent = `
            @keyframes glow {
                from { box-shadow: 0 0 5px #ffeb3b; }
                to { box-shadow: 0 0 15px #ffeb3b; }
            }
        `;
        document.head.appendChild(style);
    };

    // 启动系统
    addStyles();
    new CopyController();
})();
// @description  try to take over the world!
// @author       You
// @match        http://*/*
// @icon         data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    // Your code here...
})();