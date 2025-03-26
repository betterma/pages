// 初始化数据
let linkList = JSON.parse(localStorage.getItem('linkList')) || [
  { name: "GitHub", url: "https://github.com" },
  { name: "Google", url: "https://google.com" }
];

// 渲染链接列表
function renderLinks() {
  const listContainer = document.getElementById('link-list');
  listContainer.innerHTML = '';

  linkList.forEach((link, index) => {
    const item = document.createElement('div');
    item.className = 'link-item';
    item.innerHTML = `
      <a href="${link.url}" target="_blank" class="link-content">
        <div class="link-name">${link.name}</div>
        <div class="link-url">${link.url}</div>
      </a>
      <div class="action-buttons">
        <button class="edit-btn" onclick="showEditForm(${index})">✏️ 编辑</button>
        <button class="delete-btn" onclick="deleteLink(${index})">🗑️ 删除</button>
      </div>
    `;
    listContainer.appendChild(item);
  });
}

// 显示编辑表单
function showEditForm(index = -1) {
  const formHtml = `
    <div class="form-overlay">
      <div class="form-container">
        <h3>${index === -1 ? '新增链接' : '编辑链接'}</h3>
        <input type="text" id="edit-name" placeholder="网站名称" 
               value="${index !== -1 ? linkList[index].name : ''}">
        <input type="url" id="edit-url" placeholder="https://example.com" 
               value="${index !== -1 ? linkList[index].url : ''}">
        <button onclick="saveLink(${index})">💾 保存</button>
        <button onclick="closeForm()">❌ 取消</button>
      </div>
    </div>
  `;
  document.body.insertAdjacentHTML('beforeend', formHtml);
}

// 保存数据
function saveLink(index) {
  const nameInput = document.getElementById('edit-name');
  const urlInput = document.getElementById('edit-url');
  
  if (!nameInput.value || !urlInput.value) {
    alert('请填写完整信息！');
    return;
  }

  const newLink = {
    name: nameInput.value.trim(),
    url: urlInput.value.trim()
  };

  if (index === -1) {
    linkList.push(newLink);
  } else {
    linkList[index] = newLink;
  }

  localStorage.setItem('linkList', JSON.stringify(linkList));
  closeForm();
  renderLinks();
}

// 删除数据
function deleteLink(index) {
  if (!confirm('确定要删除这个链接吗？')) return;
  linkList.splice(index, 1);
  localStorage.setItem('linkList', JSON.stringify(linkList));
  renderLinks();
}

// 关闭表单
function closeForm() {
  document.querySelector('.form-overlay').remove();
}

// 导出配置
function exportConfig() {
  const configContent = `const linkList = ${JSON.stringify(linkList, null, 2)};\n`;

  // 优先使用 Clipboard API
  if (navigator.clipboard) {
    navigator.clipboard.writeText(configContent)
      .then(() => showExportSuccess())
      .catch(() => fallbackCopy(configContent));
  } else {
    fallbackCopy(configContent);
  }
}

// 兼容性复制方案
function fallbackCopy(text) {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  document.body.appendChild(textarea);
  textarea.select();
  
  try {
    document.execCommand('copy');
    showExportSuccess();
  } catch (err) {
    alert('复制失败，请手动复制内容');
  } finally {
    document.body.removeChild(textarea);
  }
}

// 显示导出成功提示
function showExportSuccess() {
  const alertBox = document.createElement('div');
  alertBox.className = 'export-alert';
  alertBox.textContent = '✅ 配置已复制到剪贴板！保存到 config.js 后刷新页面生效';
  
  document.body.appendChild(alertBox);
  setTimeout(() => alertBox.remove(), 3000);
}

// 初始化
window.onload = renderLinks;