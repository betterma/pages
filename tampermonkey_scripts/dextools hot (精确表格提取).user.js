// ==UserScript==
// @name         dextools hot (精确表格提取)
// @description  只提取表格中的20个pump/bond合约地址
// @match        https://www.dextools.io/app/solana/hot-pairs
// @match        https://www.dextools.io/app/*/hot-pairs
// @grant        GM_setClipboard
// @grant        GM_notification
// ==/UserScript==

(function() {
    'use strict';

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
            boxShadow: '0 2px 5px rgba(0,0,0,0.3)',
            fontSize: '14px',
            fontWeight: 'bold'
        });
        btn.textContent = '🔍 提取表格合约';
        return btn;
    };

    const createStatusBar = () => {
        const bar = document.createElement('div');
        bar.id = 'smartCopyStatusBar';
        Object.assign(bar.style, {
            position: 'fixed',
            top: '70px',
            right: '20px',
            zIndex: 99999,
            padding: '10px 20px',
            borderRadius: '8px',
            background: 'rgba(0,0,0,0.85)',
            color: '#fff',
            fontSize: '14px',
            opacity: 0,
            transition: 'opacity 0.3s',
            pointerEvents: 'none',
            backdropFilter: 'blur(5px)',
            border: '1px solid #333'
        });
        document.body.appendChild(bar);
        return bar;
    };

    const showStatus = (statusBar, message, isError = false) => {
        statusBar.textContent = message;
        statusBar.style.background = isError ? 'rgba(255,0,0,0.85)' : 'rgba(0,0,0,0.85)';
        statusBar.style.opacity = '1';
        setTimeout(() => {
            statusBar.style.opacity = '0';
        }, 2000);
    };

    // 只提取表格中的合约地址
    const extractTableContracts = () => {
        const contracts = [];
        const seen = new Set();

        // 使用更稳定的选择器：找到hot-pairs-table表格
        const table = document.querySelector('table.p-datatable-table');
        if (!table) {
            console.log('未找到表格');
            return [];
        }

        // 获取所有表格行，跳过骨架屏
        const rows = table.querySelectorAll('tbody tr');
        console.log(`找到 ${rows.length} 行`);

        let validRowCount = 0;

        rows.forEach((row, index) => {
            // 跳过骨架屏行
            if (row.querySelector('p-skeleton')) {
                return;
            }

            // 跳过无效行（显示???的行）
            if (row.textContent.includes('???')) {
                return;
            }

            validRowCount++;

            // 在当前行中查找Dextools官方图片
            const img = row.querySelector('img[src*="dextools.io/resources/tokens/logos/"]');
            if (img) {
                const src = img.getAttribute('src');
                console.log(`行 ${index + 1} 图片: ${src}`);

                // 提取合约地址 - 匹配/solana/后面的部分
                //const match = src.match(/\/solana\/([a-zA-Z0-9]{32,}(?:pump|bond)?)/i);

                const match = src.match(
                    /\/(?:solana|robinhood)\/([a-zA-Z0-9]{32,}(?:pump|bond)?|0x[a-fA-F0-9]{40})/i
                );

                if (match && match[1]) {
                    const contract = match[1];
                    if (!seen.has(contract)) {
                        seen.add(contract);
                        contracts.push(contract);
                        console.log(`✅ 行 ${index + 1}: 提取到 ${contract}`);
                    }
                } else {
                    console.log(`❌ 行 ${index + 1}: 未匹配到合约地址`);
                }
            } else {
                console.log(`❌ 行 ${index + 1}: 未找到Dextools图片`);
            }
        });

        console.log(`有效行数: ${validRowCount}, 提取到合约: ${contracts.length}`);
        return contracts;
    };

    const copyToClipboard = async (text, statusBar) => {
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch (err) {
            try {
                const textarea = document.createElement('textarea');
                textarea.value = text;
                textarea.style.position = 'fixed';
                textarea.style.opacity = '0';
                document.body.appendChild(textarea);
                textarea.select();
                const success = document.execCommand('copy');
                document.body.removeChild(textarea);
                return success;
            } catch (e) {
                showStatus(statusBar, '❌ 复制失败', true);
                return false;
            }
        }
    };

    const createCollector = (statusBar) => {
        return async function() {
            showStatus(statusBar, '🔍 正在提取表格合约...');

            // 等待表格加载
            await new Promise(resolve => setTimeout(resolve, 1500));

            const contracts = extractTableContracts();

            if (contracts.length > 0) {
                const output = contracts.join('\n');
                const success = await copyToClipboard(output, statusBar);

                if (success) {
                    showStatus(statusBar, `✅ 已复制 ${contracts.length} 个表格合约`);
                    console.log('表格合约列表:', contracts);
                }
            } else {
                showStatus(statusBar, '❌ 未找到合约', true);

                // 调试信息
                console.log('调试信息:');
                console.log('表格存在:', !!document.querySelector('table.p-datatable-table'));
                console.log('所有图片:', document.querySelectorAll('img').length);
                console.log('Dextools图片:', document.querySelectorAll('img[src*="dextools.io/resources/tokens/logos/"]').length);
            }
        };
    };

    class CopyController {
        constructor() {
            this.isActive = false;
            this.collector = null;
            this.btn = createControlButton();
            this.statusBar = createStatusBar();
            this.clickHandler = null;
            this.init();
        }

        init() {
            this.btn.addEventListener('click', (e) => {
                e.stopPropagation();
                e.preventDefault();
                this.toggle();
            });
            document.body.appendChild(this.btn);
        }

        toggle() {
            if (this.isActive) {
                this.deactivate();
            } else {
                this.activate();
            }
        }

        activate() {
            this.isActive = true;
            this.collector = createCollector(this.statusBar);

            this.clickHandler = (e) => {
                if (e.target.closest('#smartCopyToggle')) return;
                setTimeout(() => {
                    if (this.isActive) this.collector();
                }, 500);
            };

            document.addEventListener('click', this.clickHandler, true);
            this.updateUI(true);
            showStatus(this.statusBar, '✅ 表格合约提取已开启');
        }

        deactivate() {
            this.isActive = false;
            if (this.clickHandler) {
                document.removeEventListener('click', this.clickHandler, true);
            }
            this.updateUI(false);
            showStatus(this.statusBar, '⏹️ 已关闭');
        }

        updateUI(active) {
            this.btn.style.background = active ? '#4CAF50' : '#f44336';
            this.btn.textContent = active ? '🟢 运行中 (点击关闭)' : '🔴 已关闭 (点击启动)';
        }
    }

    // 启动
    new CopyController();

})();