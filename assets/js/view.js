document.addEventListener('DOMContentLoaded', async function() {
  const params = new URLSearchParams(window.location.search);
  const date = params.get('date');
  if (!date) {
    document.getElementById('viewContent').innerHTML = '无效的日期';
    return;
  }
  document.getElementById('viewTitle').textContent = utils.formatDate(date, 'YYYY年MM月DD日');
  try {
    const entry = await storage.getEntry(date);
    const content = entry.content || '';
    document.getElementById('viewContent').innerHTML = content;
  } catch (e) {
    document.getElementById('viewContent').innerHTML = '加载失败';
  }
});