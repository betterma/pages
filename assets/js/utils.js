// utils.js - 工具函数库
window.utils = (function() {
    // 格式化日期
    function formatDate(dateString, format = 'YYYY-MM-DD') {
      return dayjs(dateString).format(format);
    }
    
    // 生成日期范围
    function generateDateRange(startDate, days) {
      const dates = [];
      const start = dayjs(startDate).startOf('day');
      
      for (let i = 0; i < days; i++) {
        dates.push(start.subtract(i, 'day').format('YYYY-MM-DD'));
      }
      
      return dates;
    }
    
    // HTML安全渲染
    function escapeHtml(unsafe) {
      return unsafe
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
    }
    
    // 生成日历视图
    function generateCalendar(year, month) {
      const daysInMonth = dayjs().year(year).month(month).daysInMonth();
      const firstDay = dayjs(`${year}-${month + 1}-01`).day();
      
      const calendar = [];
      
      // 前个月的空格
      for (let i = 0; i < firstDay; i++) {
        calendar.push(null);
      }
      
      // 本月的日期
      for (let d = 1; d <= daysInMonth; d++) {
        calendar.push(d);
      }
      
      return calendar;
    }
    
    return {
      formatDate,
      generateDateRange,
      escapeHtml,
      generateCalendar
    };
  })();

  function showLoading(text = '加载中...') {
    const mask = document.getElementById('globalLoading');
    if (mask) {
      document.getElementById('loadingText').textContent = text;
      mask.style.display = 'flex';
    }
  }
  
  function hideLoading() {
    const mask = document.getElementById('globalLoading');
    if (mask) mask.style.display = 'none';
  }