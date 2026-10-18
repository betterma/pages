// ==UserScript==
// @name         悬浮式元素复制助手 - 完整功能版
// @namespace    http://tampermonkey.net/
// @version      4.0
// @description  自动点击复制按钮并收集结果
// @author       YourName
// @match        https://gmgn.ai/trend?chain=sol
// @grant        GM_setClipboard
// @grant        GM_addStyle
// @grant        GM_notification
// @grant        unsafeWindow
// @run-at       document-end
// ==/UserScript==


(function() {
    'use strict';

    // 安全访问 window 对象
    const safeWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

    // 确保body已经存在
    const waitForBody = (callback) => {
        if (document.body) {
            callback();
        } else {
            safeWindow.addEventListener('DOMContentLoaded', callback);
        }
    };

    waitForBody(() => {
        // 创建悬浮窗
        createFloatingWindow();
    });

    function createFloatingWindow() {
        // 确保悬浮窗容器不存在
        if (document.getElementById('custom-floating-container')) return;

        // 创建悬浮窗容器
        const container = document.createElement('div');
        container.id = 'custom-floating-container';
        container.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            z-index: 999999;
            background: white;
            border-radius: 8px;
            box-shadow: 0 4px 15px rgba(0,0,0,0.15);
            min-width: 300px;
            max-width: 400px;
            font-family: Arial, sans-serif;
            border: 1px solid #e0e0e0;
            display: block;
        `;

        // 添加标题
        const header = document.createElement('div');
        header.textContent = '复制助手';
        header.style.cssText = `
            padding: 12px 15px;
            font-weight: bold;
            font-size: 16px;
            border-bottom: 1px solid #f0f0f0;
            background: #4a90e2;
            color: white;
            border-top-left-radius: 8px;
            border-top-right-radius: 8px;
            cursor: move;
        `;

        // 创建操作区
        const controlPanel = document.createElement('div');
        controlPanel.style.cssText = 'padding: 10px 15px; display: flex; gap: 10px;';
        controlPanel.id = 'control-panel';

        // 创建操作按钮
        const copyButton = document.createElement('button');
        copyButton.id = 'copy-action-button';
        copyButton.textContent = '开始复制';
        copyButton.style.cssText = `
            padding: 8px 15px;
            background: #4a90e2;
            color: white;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-weight: bold;
            font-size: 14px;
            flex: 1;
            transition: background 0.3s;
        `;

        // 创建复制全部按钮
        const copyAllButton = document.createElement('button');
        copyAllButton.id = 'copy-all-button';
        copyAllButton.textContent = '复制全部';
        copyAllButton.style.cssText = `
            padding: 8px 15px;
            background: #34a853;
            color: white;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-weight: bold;
            font-size: 14px;
            flex: 1;
            transition: background 0.3s;
        `;

        // 创建显示区域
        const displayArea = document.createElement('div');
        displayArea.id = 'result-display';
        displayArea.style.cssText = `
            max-height: 250px;
            overflow-y: auto;
            padding: 10px 15px;
            border-top: 1px solid #f0f0f0;
            font-size: 13px;
            line-height: 1.4;
            color: #333;
        `;

        // 状态标签
        const statusLabel = document.createElement('div');
        statusLabel.id = 'status-label';
        statusLabel.style.cssText = `
            font-size: 12px;
            text-align: center;
            padding: 8px;
            background: #f9f9f9;
            border-top: 1px solid #eee;
            color: #666;
        `;

        // 组装悬浮窗
        container.appendChild(header);
        controlPanel.appendChild(copyButton);
        controlPanel.appendChild(copyAllButton);
        container.appendChild(controlPanel);
        container.appendChild(displayArea);
        container.appendChild(statusLabel);
        document.body.appendChild(container);

        // 存储结果
        let copiedResults = [];
        let isRunning = false;
        let processedElements = new Set();

        // 更新状态
        function updateStatus(message) {
            statusLabel.textContent = message;
        }

        // 更新显示区域 - 优化显示效果
        function updateDisplay() {
            if (copiedResults.length === 0) {
                displayArea.innerHTML = '<div style="text-align: center; color: #999; padding: 10px;">暂无内容</div>';
                return;
            }

            // 创建结果容器
            const resultsContainer = document.createElement('div');
            resultsContainer.style.cssText = 'display: flex; flex-direction: column; gap: 5px;';

            // 添加结果项（无序号）
            copiedResults.forEach(result => {
                const resultItem = document.createElement('div');
                resultItem.style.cssText = `
                    padding: 6px 8px;
                    background: #f8f8f8;
                    border-radius: 4px;
                    word-break: break-all;
                    font-size: 13px;
                    color: #333;
                    border-left: 3px solid #4a90e2;
                `;
                resultItem.textContent = result;
                resultsContainer.appendChild(resultItem);
            });

            // 清空并添加新内容
            displayArea.innerHTML = '';
            displayArea.appendChild(resultsContainer);
        }

        // HTML转义函数
        function escapeHTML(str) {
            if (!str) return '';
            return str
                .replace(/&/g, "&amp;")
                .replace(/</g, "&lt;")
                .replace(/>/g, "&gt;")
                .replace(/"/g, "&quot;")
                .replace(/'/g, "&#039;");
        }

        // 创建安全的点击事件
        function createSafeClickEvent(element) {
            const rect = element.getBoundingClientRect();
            const clientX = rect.left + rect.width / 2;
            const clientY = rect.top + rect.height / 2;

            try {
                return new safeWindow.MouseEvent('click', {
                    bubbles: true,
                    cancelable: true,
                    view: safeWindow,
                    clientX: clientX,
                    clientY: clientY
                });
            } catch (e) {
                const event = document.createEvent('MouseEvents');
                event.initMouseEvent(
                    'click',
                    true, // bubbles
                    true, // cancelable
                    safeWindow,
                    1, // detail
                    clientX, // screenX
                    clientY, // screenY
                    clientX, // clientX
                    clientY, // clientY
                    false, // ctrlKey
                    false, // altKey
                    false, // shiftKey
                    false, // metaKey
                    0, // button
                    null // relatedTarget
                );
                return event;
            }
        }

        // 检查元素是否在视图范围内
        function isElementInViewport(element) {
            const rect = element.getBoundingClientRect();
            return (
                rect.top >= 0 &&
                rect.left >= 0 &&
                rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) &&
                rect.right <= (window.innerWidth || document.documentElement.clientWidth)
            );
        }

        // 检查元素是否可见
        function isElementVisible(element) {
            const style = window.getComputedStyle(element);
            return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
        }

        // 主功能
        copyButton.addEventListener('click', function() {
            if (isRunning) {
                stopCopying();
                copyButton.textContent = '开始复制';
                copyButton.style.background = '#4a90e2';
                updateStatus('已停止复制');
            } else {
                startCopying();
                copyButton.textContent = '停止复制';
                copyButton.style.background = '#e24a4a';
                updateStatus('正在复制视图内元素...');
            }
        });

        // 复制全部结果功能
        copyAllButton.addEventListener('click', function() {
            if (copiedResults.length === 0) {
                updateStatus('没有可复制的内容');
                return;
            }

            const allResults = copiedResults.join('\n');
            navigator.clipboard.writeText(allResults).then(() => {
                updateStatus('已复制全部结果到剪贴板');
                GM_notification({
                    title: '复制成功',
                    text: `已复制${copiedResults.length}条结果`,
                    silent: true,
                    timeout: 2000
                });
            }).catch(err => {
                updateStatus('复制失败，请检查权限');
                console.error('复制失败:', err);
            });
        });

        function startCopying() {
            isRunning = true;
            processedElements.clear();
            updateDisplay();

            // 查找并点击所有符合条件的SVG元素
            const targetElements = findTargetElements();

            if (targetElements.length > 0) {
                // 只处理视图内可见的元素
                const visibleElements = targetElements.filter(el =>
                    isElementInViewport(el) && isElementVisible(el)
                );

                // 最多处理10个元素
                const elementsToProcess = visibleElements.slice(0, 10);

                if (elementsToProcess.length > 0) {
                    updateStatus(`找到${elementsToProcess.length}个视图内元素`);
                    clickElementsSequentially(elementsToProcess);
                } else {
                    updateStatus('未找到视图内可见的复制按钮');
                    stopCopying();
                }
            } else {
                updateStatus('未找到复制按钮');
                stopCopying();
            }
        }

        function stopCopying() {
            isRunning = false;
            copyButton.textContent = '开始复制';
            copyButton.style.background = '#4a90e2';
            updateStatus('已停止复制');
        }

        // 查找目标元素
        function findTargetElements() {
            return Array.from(document.querySelectorAll('svg')).filter(svg => {
                return svg.getAttribute('width') === '14px' &&
                       svg.getAttribute('height') === '14px' &&
                       svg.getAttribute('viewBox') === '0 0 12 12' &&
                       svg.classList.contains('text-text-300') &&
                       svg.classList.contains('cursor-pointer') &&
                       svg.classList.contains('group-hover:text-text-100') &&
                       svg.classList.contains('hover:text-text-100') &&
                       svg.classList.contains('transition-colors');
            });
        }

        // 顺序点击元素（只在视图范围内）
        function clickElementsSequentially(elements) {
            let index = 0;
            const maxElements = Math.min(elements.length, 10); // 最多10个

            function clickNext() {
                if (!isRunning || index >= maxElements) {
                    stopCopying();
                    return;
                }

                const element = elements[index];
                if (!processedElements.has(element)) {
                    processedElements.add(element);

                    // 安全地模拟点击
                    try {
                        const clickEvent = createSafeClickEvent(element);
                        element.dispatchEvent(clickEvent);
                        updateStatus(`点击元素 ${index + 1}/${maxElements}`);

                        // 尝试获取复制内容
                        setTimeout(() => {
                            getCopiedContent().then(content => {
                                if (content) {
                                    // 合并去重
                                    if (!copiedResults.includes(content)) {
                                        copiedResults.push(content);
                                        updateDisplay();
                                    }
                                }
                                index++;
                                clickNext();
                            });
                        }, 500);
                    } catch (e) {
                        console.error('点击失败:', e);
                        updateStatus(`点击元素 ${index + 1} 失败`);
                        index++;
                        clickNext();
                    }
                } else {
                    index++;
                    clickNext();
                }
            }

            clickNext();
        }

        // 获取复制内容
        function getCopiedContent() {
            return new Promise((resolve) => {
                navigator.clipboard.readText().then(text => {
                    resolve(text);
                }).catch(err => {
                    resolve(null);
                });
            });
        }

        // 添加关闭按钮
        const closeButton = document.createElement('div');
        closeButton.textContent = '×';
        closeButton.style.cssText = `
            position: absolute;
            top: 5px;
            right: 10px;
            font-size: 20px;
            cursor: pointer;
            color: white;
            width: 24px;
            height: 24px;
            text-align: center;
            line-height: 24px;
        `;
        closeButton.addEventListener('click', () => {
            container.style.display = 'none';
            stopCopying();
        });
        header.appendChild(closeButton);

        // 添加拖动功能
        let isDragging = false;
        let offsetX, offsetY;
        header.addEventListener('mousedown', function(e) {
            if (e.target !== closeButton) {
                isDragging = true;
                offsetX = e.clientX - container.getBoundingClientRect().left;
                offsetY = e.clientY - container.getBoundingClientRect().top;
            }
        });

        document.addEventListener('mousemove', function(e) {
            if (isDragging) {
                container.style.left = (e.clientX - offsetX) + 'px';
                container.style.top = (e.clientY - offsetY) + 'px';
                container.style.right = 'auto';
            }
        });

        document.addEventListener('mouseup', function() {
            isDragging = false;
        });

        // 初始状态
        updateStatus('准备就绪');
        updateDisplay();
    }
})();