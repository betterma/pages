document.addEventListener('DOMContentLoaded', async function() {
  const container = document.getElementById('allEntriesContainer');
  let entries = await storage.getEntries();
  if (!entries.length) {
    container.innerHTML = '<div class="empty">暂无记忆</div>';
    return;
  }
  entries.forEach(entry => {
    const entryEl = document.createElement('div');
    entryEl.className = 'entry-item';
    entryEl.innerHTML = `
      <div class="entry-main">
        <div class="entry-date">${utils.formatDate(entry.date, 'YYYY年MM月DD日')}</div>
        <div class="entry-snippet">加载中...</div>
      </div>
    `;
    // 加载预览
    fetch(entry.url)
      .then(r => r.text())
      .then(text => {
        let div = document.createElement('div');
        div.innerHTML = text;
        let html = div.innerHTML;
        if (html.length > 300) html = html.substring(0, 300) + '...';
        entryEl.querySelector('.entry-snippet').innerHTML = html;
      });
    entryEl.addEventListener('click', () => {
      window.location.href = `editor.html?date=${entry.date}`;
    });
    container.appendChild(entryEl);
  });
});