// 动态生成链接列表
function renderLinks() {
    const listContainer = document.getElementById('link-list');
    
    // 清空现有内容
    listContainer.innerHTML = '';
    
    // 遍历配置生成 HTML
    linkList.forEach(link => {
      const linkElement = document.createElement('a');
      linkElement.href = link.url;
      linkElement.target = "_blank";  // 新标签页打开
      linkElement.className = "link-item";
      linkElement.innerHTML = `
        <span class="link-name">${link.name}</span>
        <span class="link-url">${link.url}</span>
      `;
      
      listContainer.appendChild(linkElement);
    });
  }
  
  // 页面加载完成后执行渲染
  window.onload = renderLinks;