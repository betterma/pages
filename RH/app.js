'use strict';

(function () {
  const NETWORK = 'robinhood';
  const CACHE_URL =
    (window.RH_CONFIG && window.RH_CONFIG.CACHE_URL) || './cache.json';

  const el = {
    fdvMin: document.getElementById('fdvMin'),
    fdvMax: document.getElementById('fdvMax'),
    limit: document.getElementById('limit'),
    orderBy: document.getElementById('orderBy'),
    reload: document.getElementById('reload'),
    grid: document.getElementById('grid'),
    empty: document.getElementById('empty'),
    dot: document.getElementById('dot'),
    statusText: document.getElementById('statusText'),
    countText: document.getElementById('countText'),
  };

  const charts = new Map();
  let cachePayload = null;

  function money(n) {
    if (!Number.isFinite(n)) return '--';
    if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
    if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
    return n.toFixed(0);
  }

  function pct(n) {
    if (!Number.isFinite(n)) return '--';
    return `${n > 0 ? '+' : ''}${n.toFixed(2)}%`;
  }

  function setStatus(mode, text) {
    el.dot.className = `dot ${mode || ''}`;
    el.statusText.textContent = text || '';
  }

  function escapeHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function destroyCharts() {
    charts.forEach((chart) => {
      try {
        chart.remove();
      } catch (error) {
        /* ignore */
      }
    });
    charts.clear();
  }

  async function loadCache() {
    const url = `${CACHE_URL}${CACHE_URL.includes('?') ? '&' : '?'}t=${Date.now()}`;
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`读取缓存失败 HTTP ${res.status}`);
    return res.json();
  }

  function sortItems(items, orderBy) {
    const key =
      orderBy === 'liquidity_usd'
        ? 'liquidity_usd'
        : orderBy === 'fdv_usd'
          ? 'fdv_usd'
          : 'volume_usd_24h';
    return items.slice().sort((a, b) => {
      const av = Number(a[key]);
      const bv = Number(b[key]);
      const aOk = Number.isFinite(av) ? av : -Infinity;
      const bOk = Number.isFinite(bv) ? bv : -Infinity;
      return bOk - aOk;
    });
  }

  function paintChart(container, bars) {
    container.innerHTML = '';
    if (!window.LightweightCharts) {
      container.innerHTML = '<div class="placeholder">图表库未加载</div>';
      return null;
    }
    if (!bars || !bars.length) {
      container.innerHTML = '<div class="placeholder">暂无日 K</div>';
      return null;
    }
    const chart = window.LightweightCharts.createChart(container, {
      layout: {
        background: { color: 'transparent' },
        textColor: '#8b9790',
      },
      grid: {
        vertLines: { color: '#24303a' },
        horzLines: { color: '#24303a' },
      },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false, timeVisible: false },
      width: container.clientWidth,
      height: container.clientHeight || 220,
    });
    const series = chart.addCandlestickSeries({
      upColor: '#3d9a78',
      downColor: '#c45c4a',
      borderVisible: false,
      wickUpColor: '#3d9a78',
      wickDownColor: '#c45c4a',
    });
    series.setData(bars);
    chart.timeScale().fitContent();
    return chart;
  }

  function renderItems(items) {
    destroyCharts();
    el.grid.innerHTML = '';
    if (!items.length) {
      el.empty.hidden = false;
      el.empty.textContent = '缓存里没有符合当前 FDV 条件的代币';
      return;
    }
    el.empty.hidden = true;

    items.forEach((token) => {
      const card = document.createElement('article');
      card.className = 'card';
      card.dataset.address = token.address;
      const chg = Number(token.price_change_percentage_24h);
      const chgClass = Number.isFinite(chg) ? (chg >= 0 ? 'up' : 'down') : '';
      const dexHref = token.poolId
        ? `https://dexscreener.com/${NETWORK}/${token.poolId}`
        : `https://dexscreener.com/${NETWORK}/${token.address}`;

      card.innerHTML = `
        <div class="card-head">
          <div>
            <h2>${escapeHtml(token.symbol || '--')}</h2>
            <div class="sub" title="${escapeHtml(token.name || '')}">${escapeHtml(token.name || token.address)}</div>
          </div>
          <div class="meta">
            <div>FDV ${money(Number(token.fdv_usd))}</div>
            <div class="chg ${chgClass}">24h ${pct(chg)}</div>
            <div>Vol ${money(Number(token.volume_usd_24h))}</div>
          </div>
        </div>
        <div class="chart"></div>
        <div class="card-foot">
          <span>Liq ${money(Number(token.liquidity_usd))}</span>
          <a href="${dexHref}" target="_blank" rel="noopener">DexScreener</a>
        </div>
      `;
      el.grid.appendChild(card);
      const chartEl = card.querySelector('.chart');
      const chart = paintChart(chartEl, token.bars || []);
      if (chart) charts.set(token.address, chart);
    });
  }

  function applyFilters() {
    if (!cachePayload) return;
    const fdvMin = Number(el.fdvMin.value) * 1e6;
    const fdvMax = Number(el.fdvMax.value) * 1e6;
    const limit = Math.max(1, Math.min(60, Number(el.limit.value) || 24));
    const orderBy = el.orderBy.value || 'volume_usd_24h';

    let items = (cachePayload.items || []).filter((t) => {
      const fdv = Number(t.fdv_usd);
      return Number.isFinite(fdv) && fdv >= fdvMin && fdv <= fdvMax;
    });
    items = sortItems(items, orderBy).slice(0, limit);
    renderItems(items);

    const updatedAt = Number(cachePayload.updatedAt) || 0;
    const when = updatedAt
      ? new Date(updatedAt).toLocaleString('zh-CN', { hour12: false })
      : '尚未生成';
    el.countText.textContent = `显示 ${items.length} · 缓存 ${when}`;
    setStatus(
      updatedAt ? 'ok' : 'err',
      updatedAt ? '缓存已加载' : '缓存为空，请先跑定时云函数',
    );
  }

  async function reload() {
    el.reload.disabled = true;
    setStatus('run', '读取 cache.json…');
    try {
      cachePayload = await loadCache();
      if (cachePayload.params) {
        if (Number.isFinite(cachePayload.params.fdvMin)) {
          el.fdvMin.value = cachePayload.params.fdvMin / 1e6;
        }
        if (Number.isFinite(cachePayload.params.fdvMax)) {
          el.fdvMax.value = cachePayload.params.fdvMax / 1e6;
        }
      }
      applyFilters();
    } catch (error) {
      el.empty.hidden = false;
      el.empty.textContent = `加载失败：${error.message || error}`;
      setStatus('err', '失败');
    } finally {
      el.reload.disabled = false;
    }
  }

  window.addEventListener('resize', () => {
    charts.forEach((chart, address) => {
      const node = el.grid.querySelector(
        `[data-address="${CSS.escape(address)}"] .chart`,
      );
      if (node && chart) {
        chart.applyOptions({
          width: node.clientWidth,
          height: node.clientHeight || 220,
        });
      }
    });
  });

  el.reload.addEventListener('click', () => reload());
  el.fdvMin.addEventListener('change', () => applyFilters());
  el.fdvMax.addEventListener('change', () => applyFilters());
  el.limit.addEventListener('change', () => applyFilters());
  el.orderBy.addEventListener('change', () => applyFilters());
  reload();
})();
