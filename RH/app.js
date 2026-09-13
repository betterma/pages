'use strict';

(function () {
  const NETWORK = 'robinhood';
  const PAPRIKA = 'https://api.dexpaprika.com';
  const QUOTE_BLOCKLIST = new Set(
    [
      '0x5fc5360d0400a0fd4f2af552add042d716f1d168', // USDG
      '0x0bd7d308f8e1639fab988df18a8011f41eacad73', // WETH
      '0x0000000000000000000000000000000000000000', // ETH
    ].map((s) => s.toLowerCase()),
  );

  const el = {
    fdvMin: document.getElementById('fdvMin'),
    fdvMax: document.getElementById('fdvMax'),
    limit: document.getElementById('limit'),
    days: document.getElementById('days'),
    orderBy: document.getElementById('orderBy'),
    proxy: document.getElementById('proxy'),
    reload: document.getElementById('reload'),
    grid: document.getElementById('grid'),
    empty: document.getElementById('empty'),
    dot: document.getElementById('dot'),
    statusText: document.getElementById('statusText'),
    countText: document.getElementById('countText'),
  };

  const charts = new Map();

  function money(n) {
    if (!Number.isFinite(n)) return '--';
    if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
    if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
    return n.toFixed(0);
  }

  function pct(n) {
    if (!Number.isFinite(n)) return '--';
    const s = `${n > 0 ? '+' : ''}${n.toFixed(2)}%`;
    return s;
  }

  function setStatus(mode, text) {
    el.dot.className = `dot ${mode || ''}`;
    el.statusText.textContent = text || '';
  }

  function proxyBase() {
    const fromInput = String(el.proxy.value || '').trim();
    const fromStore = String(localStorage.getItem('rhProxy') || '').trim();
    const fromConfig = String(
      (window.RH_CONFIG && window.RH_CONFIG.PROXY_URL) || '',
    ).trim();
    return (fromInput || fromStore || fromConfig).replace(/\/$/, '');
  }

  function isHostedPage() {
    const host = String(location.hostname || '');
    return (
      host &&
      host !== 'localhost' &&
      host !== '127.0.0.1' &&
      host !== '[::1]'
    );
  }

  function saveProxy() {
    const v = String(el.proxy.value || '').trim();
    if (v) localStorage.setItem('rhProxy', v);
    else localStorage.removeItem('rhProxy');
  }

  async function fetchJson(url) {
    let res;
    try {
      res = await fetch(url, {
        headers: { Accept: 'application/json' },
      });
    } catch (error) {
      throw new Error(
        '网络/CORS 失败。线上站点请部署 cloud-function-rh，并把 HTTP 地址填到「代理」。',
      );
    }
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (error) {
      throw new Error(`非 JSON 响应 (${res.status})`);
    }
    if (!res.ok) {
      const msg =
        (data && (data.error || data.message)) || `HTTP ${res.status}`;
      throw new Error(msg);
    }
    return data;
  }

  async function apiTokens(params) {
    const proxy = proxyBase();
    if (proxy) {
      const q = new URLSearchParams({
        fdvMin: String(params.fdvMin),
        fdvMax: String(params.fdvMax),
        limit: String(params.limit),
        orderBy: params.orderBy,
      });
      return fetchJson(`${proxy}/tokens?${q}`);
    }
    const q = new URLSearchParams({
      fdv_usd_min: String(params.fdvMin),
      fdv_usd_max: String(params.fdvMax),
      order_by: params.orderBy,
      sort: 'desc',
      limit: String(params.limit),
      detailed: 'true',
    });
    return fetchJson(
      `${PAPRIKA}/networks/${NETWORK}/tokens/search?${q}`,
    );
  }

  async function apiBestPool(token) {
    const proxy = proxyBase();
    if (proxy) {
      return fetchJson(
        `${proxy}/pools?token=${encodeURIComponent(token)}&limit=3`,
      );
    }
    const q = new URLSearchParams({
      token_address: token,
      order_by: 'liquidity_usd',
      sort: 'desc',
      limit: '3',
    });
    return fetchJson(
      `${PAPRIKA}/networks/${NETWORK}/pools/search?${q}`,
    );
  }

  async function apiOhlcv(pool, days) {
    const proxy = proxyBase();
    if (proxy) {
      return fetchJson(
        `${proxy}/ohlcv?pool=${encodeURIComponent(pool)}&days=${days}`,
      );
    }
    const start = new Date();
    start.setUTCDate(start.getUTCDate() - days);
    const end = new Date().toISOString().slice(0, 10);
    const q = new URLSearchParams({
      start: start.toISOString().slice(0, 10),
      end,
      interval: '24h',
      limit: String(days),
    });
    return fetchJson(
      `${PAPRIKA}/networks/${NETWORK}/pools/${pool}/ohlcv?${q}`,
    );
  }

  function normalizeBars(raw) {
    const list = Array.isArray(raw) ? raw : [];
    return list
      .map((row) => {
        const t = Math.floor(new Date(row.time_open || row.time).getTime() / 1000);
        const open = Number(row.open);
        const high = Number(row.high);
        const low = Number(row.low);
        const close = Number(row.close);
        if (
          !Number.isFinite(t) ||
          !Number.isFinite(open) ||
          !Number.isFinite(high) ||
          !Number.isFinite(low) ||
          !Number.isFinite(close)
        ) {
          return null;
        }
        return { time: t, open, high, low, close };
      })
      .filter(Boolean)
      .sort((a, b) => a.time - b.time);
  }

  async function mapPool(items, concurrency, worker) {
    const out = new Array(items.length);
    let i = 0;
    async function run() {
      while (i < items.length) {
        const idx = i;
        i += 1;
        out[idx] = await worker(items[idx], idx);
      }
    }
    const n = Math.max(1, Math.min(concurrency, items.length || 1));
    await Promise.all(Array.from({ length: n }, () => run()));
    return out;
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

  function renderCardShell(token) {
    const card = document.createElement('article');
    card.className = 'card';
    card.dataset.address = token.address;

    const chg = Number(token.price_change_percentage_24h);
    const chgClass = Number.isFinite(chg)
      ? chg >= 0
        ? 'up'
        : 'down'
      : '';

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
      <div class="chart"><div class="placeholder">加载 K 线…</div></div>
      <div class="card-foot">
        <span class="pool">池子解析中</span>
        <a class="dex" href="#" target="_blank" rel="noopener">DexScreener</a>
      </div>
    `;
    return card;
  }

  function escapeHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function paintChart(container, bars) {
    container.innerHTML = '';
    if (!window.LightweightCharts) {
      container.innerHTML = '<div class="placeholder">图表库未加载</div>';
      return null;
    }
    if (!bars.length) {
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

  async function loadOneCard(card, token, days) {
    const chartEl = card.querySelector('.chart');
    const poolEl = card.querySelector('.pool');
    const dexEl = card.querySelector('.dex');
    try {
      const poolRes = await apiBestPool(token.address);
      const pool = (poolRes.results || [])[0];
      if (!pool || !pool.id) {
        chartEl.innerHTML = '<div class="placeholder">未找到流动性池</div>';
        poolEl.textContent = '无池';
        return;
      }
      poolEl.textContent = `Liq ${money(Number(pool.liquidity_usd))}`;
      dexEl.href = `https://dexscreener.com/${NETWORK}/${pool.id}`;

      const ohlcv = await apiOhlcv(pool.id, days);
      const bars = normalizeBars(ohlcv);
      const chart = paintChart(chartEl, bars);
      if (chart) charts.set(token.address, chart);
    } catch (error) {
      chartEl.innerHTML = `<div class="placeholder">${escapeHtml(error.message || error)}</div>`;
      poolEl.textContent = '失败';
    }
  }

  async function reload() {
    saveProxy();
    destroyCharts();
    el.grid.innerHTML = '';
    el.empty.hidden = true;
    el.reload.disabled = true;

    if (isHostedPage() && !proxyBase()) {
      el.empty.hidden = false;
      el.empty.innerHTML =
        '线上域名会被 DexPaprika <b>CORS</b> 拦截。<br/>请部署仓库里的 <code>cloud-function-rh</code>，把 HTTP 触发器地址填到上方「代理」，或写入 <code>RH/config.js</code> 的 <code>PROXY_URL</code>。';
      setStatus('err', '需要代理');
      el.reload.disabled = false;
      return;
    }

    const fdvMin = Number(el.fdvMin.value) * 1e6;
    const fdvMax = Number(el.fdvMax.value) * 1e6;
    const limit = Math.max(1, Math.min(60, Number(el.limit.value) || 24));
    const days = Math.max(14, Math.min(180, Number(el.days.value) || 90));
    const orderBy = el.orderBy.value || 'volume_usd_24h';

    setStatus('run', '拉取代币列表…');
    el.countText.textContent = '';

    try {
      const data = await apiTokens({ fdvMin, fdvMax, limit: Math.min(100, limit + 10), orderBy });
      const tokens = (data.results || [])
        .filter((t) => t && t.address && !QUOTE_BLOCKLIST.has(String(t.address).toLowerCase()))
        .filter((t) => {
          const fdv = Number(t.fdv_usd);
          return Number.isFinite(fdv) && fdv >= fdvMin && fdv <= fdvMax;
        })
        .slice(0, limit);

      if (!tokens.length) {
        el.empty.hidden = false;
        setStatus('ok', '列表为空');
        return;
      }

      const cards = tokens.map((t) => {
        const card = renderCardShell(t);
        el.grid.appendChild(card);
        return { card, token: t };
      });

      el.countText.textContent = `${tokens.length} 个代币 · 日 K ${days} 根`;
      setStatus('run', '拉取池子与日 K…');

      let done = 0;
      await mapPool(cards, 4, async (row) => {
        await loadOneCard(row.card, row.token, days);
        done += 1;
        setStatus('run', `K 线 ${done}/${cards.length}`);
      });

      setStatus('ok', `完成 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`);
    } catch (error) {
      el.empty.hidden = false;
      el.empty.textContent = `加载失败：${error.message || error}。若是 CORS，请部署 cloud-function-rh 并填写代理。`;
      setStatus('err', '失败');
    } finally {
      el.reload.disabled = false;
    }
  }

  window.addEventListener('resize', () => {
    charts.forEach((chart, address) => {
      const card = el.grid.querySelector(`[data-address="${address}"] .chart`);
      if (card && chart) {
        chart.applyOptions({ width: card.clientWidth, height: card.clientHeight || 220 });
      }
    });
  });

  el.proxy.value =
    localStorage.getItem('rhProxy') ||
    (window.RH_CONFIG && window.RH_CONFIG.PROXY_URL) ||
    '';
  el.reload.addEventListener('click', () => reload());
  reload();
})();
