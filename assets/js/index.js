// index.js - 主页面逻辑
document.addEventListener('DOMContentLoaded', async function() {
    // 初始化日期
    let currentDate = dayjs();
    let entries = [];
    
    // DOM引用
    const calendarGrid = document.getElementById('calendarGrid');
    const entriesContainer = document.getElementById('entriesContainer');
    const currentMonth = document.getElementById('currentMonth');
    const prevMonthBtn = document.getElementById('prevMonth');
    const nextMonthBtn = document.getElementById('nextMonth');
    const newEntryBtn = document.getElementById('newEntry');
    const userDropdown = document.getElementById('userDropdown');
    const userMenu = document.getElementById('userMenu');
    const logoutBtn = document.getElementById('logout');
    const refreshBtn = document.getElementById('refresh');
    const settingsModal = document.getElementById('settingsModal');
    
    // 检查认证状态
    if (!auth.isAuthenticated()) {
      window.location.href = 'login.html';
      return;
    }
    
    // 初始化UI
    renderCalendar(currentDate);
    await loadEntries(); // 每次进入首页都刷新
    
    // 事件监听器
    prevMonthBtn.addEventListener('click', () => {
      currentDate = currentDate.subtract(1, 'month');
      renderCalendar(currentDate);
    });
    
    nextMonthBtn.addEventListener('click', () => {
      currentDate = currentDate.add(1, 'month');
      renderCalendar(currentDate);
    });
    
    newEntryBtn.addEventListener('click', () => {
      const today = dayjs().format('YYYY-MM-DD');
      window.location.href = `editor.html?date=${today}`;
    });
    
    userDropdown.addEventListener('click', () => {
      userMenu.classList.toggle('show');
    });
    
    logoutBtn.addEventListener('click', () => {
      if (confirm('确定要退出登录吗？')) {
        auth.logout();
        window.location.href = 'login.html';
      }
    });
    
    refreshBtn.addEventListener('click', () => {
      loadEntries();
    });
    
    // 关闭下拉菜单（点击外部）
    document.addEventListener('click', (event) => {
      if (!userDropdown.contains(event.target) && 
          !userMenu.contains(event.target)) {
        userMenu.classList.remove('show');
      }
    });
    
    // 渲染日历
    function renderCalendar(date) {
      currentMonth.textContent = `${date.year()}年${date.month() + 1}月`;
      
      const calendar = utils.generateCalendar(date.year(), date.month());
      calendarGrid.innerHTML = '';
      
      // 添加星期标题
      const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
      for (const weekday of weekdays) {
        const dayCell = document.createElement('div');
        dayCell.className = 'calendar-weekday';
        dayCell.textContent = weekday;
        calendarGrid.appendChild(dayCell);
      }
      
      // 添加日期单元格
      calendar.forEach(day => {
        const dayCell = document.createElement('div');
        dayCell.className = 'calendar-day';
        
        if (day !== null) {
          dayCell.textContent = day;
          dayCell.classList.add('calendar-day-active');
          
          // 构造当前月份的完整日期
          const dayDate = dayjs(`${date.year()}-${date.month() + 1}-${day}`).format('YYYY-MM-DD');
          
          // 检查是否有记忆条目
          if (entries.some(entry => entry.date === dayDate)) {
            dayCell.classList.add('has-entry');
          }
          
          // 点击处理
          dayCell.addEventListener('click', () => {
            window.location.href = `editor.html?date=${dayDate}`;
          });
        }
        
        calendarGrid.appendChild(dayCell);
      });
    }
    
    // 加载记忆条目
    async function loadEntries() {
      try {
        showLoading('加载记忆中...');
        entriesContainer.innerHTML = '<div class="loading">加载记忆中...</div>';
        entries = await storage.getEntries();
        
        if (entries.length === 0) {
          entriesContainer.innerHTML = '<div class="empty">还没有记忆，开始写第一篇吧！</div>';
          return;
        }
        
        entriesContainer.innerHTML = '';
        
        // 只展示最新的3条
        const showEntries = entries.slice(0, 3);
        
        showEntries.forEach(entry => {
          const entryEl = document.createElement('div');
          entryEl.className = 'entry-item';
          entryEl.innerHTML = `
            <div class="entry-main">
              <div class="entry-date">${utils.formatDate(entry.date, 'YYYY年MM月DD日')}</div>
              <div class="entry-snippet">加载中...</div>
            </div>
            <div class="entry-actions">
              <button class="entry-delete-btn" title="删除记忆" data-date="${entry.date}">
                &#128465;
              </button>
            </div>
          `;
          
          // 加载记忆预览
          fetch(entry.url)
            .then(response => response.text())
            .then(text => {
              // 只截取前100字符，但保留富文本标签
              let div = document.createElement('div');
              div.innerHTML = text;
              let html = div.innerHTML;
              // 可选：只显示前100字符的HTML（简单裁剪，复杂可用更智能的HTML裁剪库）
              if (html.length > 300) {
                html = html.substring(0, 300) + '...';
              }
              entryEl.querySelector('.entry-snippet').innerHTML = html;
            });
          
          entryEl.addEventListener('click', () => {
            window.location.href = `editor.html?date=${entry.date}`;
          });
          
          // 删除按钮事件绑定
          entryEl.querySelector('.entry-delete-btn').addEventListener('click', async (e) => {
            e.stopPropagation();
            const date = e.currentTarget.getAttribute('data-date');
            if (confirm('确定要删除这篇记忆吗？删除后无法恢复！')) {
              try {
                showLoading('正在删除...');
                await storage.deleteEntry(date);
                alert('删除成功！');
                await loadEntries(); // 删除后刷新列表
              } catch (err) {
                alert('删除失败：' + (err.message || err));
              } finally {
                hideLoading();
              }
            }
          });

          entriesContainer.appendChild(entryEl);
        });
        
        // 添加“更多回忆”按钮
        if (entries.length > 3) {
          const moreBtn = document.createElement('button');
          moreBtn.className = 'btn btn-link entries-more-btn';
          moreBtn.textContent = '更多回忆';
          moreBtn.onclick = () => {
            window.location.href = 'all.html';
          };
          entriesContainer.appendChild(moreBtn);
        }
      } catch (error) {
        entriesContainer.innerHTML = `<div class="error">加载失败: ${error.message}</div>`;
        console.error('加载记忆错误:', error);
      } finally {
        hideLoading();
      }

      await renderCalendar(currentDate);
    }
  });