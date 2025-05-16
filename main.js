// 初始化集合
let currentSet = new Set();

// 加载初始数据
function loadInitialData() {
    try {
        currentSet = new Set(initialData);
        document.getElementById('initialSet').value = Array.from(currentSet).join('\n');
    } catch (error) {
        alert('加载初始数据失败: ' + error.message);
    }
}

// 计算差异
function calculate() {
    try {
        // 获取用户输入
        const userInput = document.getElementById('userInput').value
            .split('\n')
            .map(s => s.trim())
            .filter(s => s.length > 0);

        // 输入验证
        // const validLength = 8; // 固定长度
        // const invalidItems = userInput.filter(s => s.length !== validLength);
        // if (invalidItems.length > 0) {
        //     alert(`以下条目长度不符合要求（要求长度${validLength}）:\n${invalidItems.join('\n')}`);
        //     return;
        // }

        // 转换为Set
        const userSet = new Set(userInput);
        
        // 计算新增集合
        const newItems = Array.from(userSet).filter(item => !currentSet.has(item));
        document.getElementById('newSet').value = newItems.join('\n');

        // 合并集合
        newItems.forEach(item => currentSet.add(item));
        document.getElementById('mergedSet').value = Array.from(currentSet).join('\n');

    } catch (error) {
        alert('计算过程中发生错误: ' + error.message);
    }
}

// 页面加载完成后初始化
window.onload = loadInitialData;