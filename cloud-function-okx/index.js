'use strict';

/**
 * 事件函数入口（定时拉 OKX K 线缓存）
 * Handler: index.handler
 * 触发器：定时触发器（建议 5～15 分钟）
 * 不需要 HTTP 触发器
 *
 * 流程：
 *   读 GitHub okx/favorites.json
 *   拉 OKX historical-candles（多周期）+ token basic-info
 *   写 OBS okx-candles-cache.json
 *   若补全了名字则回写 favorites.json
 */
const {
  fetchHistoricalCandles,
  fetchTokenBasicInfo,
  isPlaceholderSymbol,
  isRateLimitError,
} = require('./okx-client');
const { FAVORITES_PATH, loadJson, saveJson } = require('./github');
const { putObjectJson, getObjectJson, obsConfig } = require('./obs-client');

const BARS = String(process.env.OKX_CANDLE_BARS || '15m,2H,4H,1D,3D,1W')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);

const BAR_LIMITS = {
  '15m': 192, // ~2 天
  '2H': 84, // ~7 天
  '4H': 72, // ~12 天
  '1D': 90,
  '3D': 60,
  '1W': 52,
};

const BAR_GAP_MS = Math.max(
  200,
  Number(process.env.OKX_BAR_GAP_MS) || 450,
);
const TOKEN_GAP_MS = Math.max(
  200,
  Number(process.env.OKX_TOKEN_GAP_MS) || 600,
);
const ALLOWED_CHAINS = new Set(
  String(process.env.OKX_CHAINS || '501,4663')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean),
);

function limitForBar(bar) {
  const fromEnv = Number(process.env[`OKX_LIMIT_${bar}`]);
  if (Number.isFinite(fromEnv) && fromEnv > 0) {
    return Math.min(299, fromEnv);
  }
  return Math.min(299, BAR_LIMITS[bar] || 72);
}

function normalizeFavorites(data) {
  const list = Array.isArray(data)
    ? data
    : Array.isArray(data && data.items)
      ? data.items
      : [];
  const map = new Map();
  list.forEach((item) => {
    if (!item || typeof item !== 'object') return;
    const chainIndex = String(item.chainIndex || '').trim();
    if (!ALLOWED_CHAINS.has(chainIndex)) return;
    const tokenContractAddress = String(
      item.tokenContractAddress || item.address || '',
    ).trim();
    if (!tokenContractAddress) return;
    const address =
      chainIndex === '501'
        ? tokenContractAddress
        : tokenContractAddress.toLowerCase();
    const key = `${chainIndex}:${address}`;
    map.set(key, {
      chainIndex,
      tokenContractAddress: address,
      symbol: String(item.symbol || '').trim(),
      addedAt: Number.isFinite(Number(item.addedAt))
        ? Number(item.addedAt)
        : Date.now(),
      source: item.source ? String(item.source) : 'manual',
    });
  });
  return [...map.values()];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchBarsForToken(token, previous) {
  const prevBars =
    previous && previous.candlesByBar && typeof previous.candlesByBar === 'object'
      ? previous.candlesByBar
      : {};
  const prevLegacy =
    previous && Array.isArray(previous.candles) ? previous.candles : [];
  const byBar = {};
  const errors = {};
  let okBars = 0;
  let reused = 0;

  for (let index = 0; index < BARS.length; index += 1) {
    const bar = BARS[index];
    try {
      const row = await fetchHistoricalCandles({
        chainIndex: token.chainIndex,
        tokenContractAddress: token.tokenContractAddress,
        bar,
        limit: limitForBar(bar),
      });
      byBar[bar] = row.candles;
      if (row.candles && row.candles.length) okBars += 1;
    } catch (error) {
      const prev =
        Array.isArray(prevBars[bar]) && prevBars[bar].length
          ? prevBars[bar]
          : bar === '4H' && prevLegacy.length
            ? prevLegacy
            : [];
      byBar[bar] = prev;
      if (prev.length) {
        reused += 1;
        okBars += 1;
        errors[bar] = `reused previous · ${error.message || error}`;
      } else {
        errors[bar] = error.message || String(error);
      }
      if (isRateLimitError(error)) {
        await sleep(1200);
      }
    }
    if (index + 1 < BARS.length) await sleep(BAR_GAP_MS);
  }

  return { byBar, errors, okBars, reused };
}

async function syncCandlesCache() {
  const favoritesFile = await loadJson(FAVORITES_PATH);
  const tokens = normalizeFavorites(favoritesFile.data);
  console.log(
    `okx-candles favorites=${tokens.length} bars=${BARS.join(',')}`,
  );

  let metaMap = new Map();
  try {
    metaMap = await fetchTokenBasicInfo(tokens);
    console.log(`okx-candles basic-info hit=${metaMap.size}`);
  } catch (error) {
    console.warn(`basic-info failed: ${error.message}`);
  }

  let previousTokens = {};
  try {
    const previous = await getObjectJson(OBS_CANDLES_KEY);
    if (previous && previous.tokens && typeof previous.tokens === 'object') {
      previousTokens = previous.tokens;
    }
  } catch (error) {
    console.warn(`load previous OBS cache failed: ${error.message}`);
  }

  const results = {};
  let okCount = 0;
  let failCount = 0;
  let renamed = 0;
  const nextFavorites = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const key = `${token.chainIndex}:${token.tokenContractAddress}`;
    const meta = metaMap.get(key);
    let symbol = token.symbol;
    if (
      meta &&
      meta.tokenSymbol &&
      isPlaceholderSymbol(symbol, token.tokenContractAddress)
    ) {
      symbol = String(meta.tokenSymbol).slice(0, 32);
      renamed += 1;
    }

    nextFavorites.push({
      chainIndex: token.chainIndex,
      tokenContractAddress: token.tokenContractAddress,
      symbol:
        symbol ||
        (meta && meta.tokenSymbol) ||
        token.symbol ||
        '',
      addedAt: token.addedAt,
      source: token.source,
    });

    try {
      const { byBar, errors, okBars, reused } = await fetchBarsForToken(
        token,
        previousTokens[key],
      );
      const ok = okBars > 0;
      if (ok) okCount += 1;
      else failCount += 1;
      results[key] = {
        ok,
        chainIndex: token.chainIndex,
        tokenContractAddress: token.tokenContractAddress,
        symbol: nextFavorites[nextFavorites.length - 1].symbol,
        tokenName: (meta && meta.tokenName) || '',
        candlesByBar: byBar,
        candles: byBar['4H'] || byBar[BARS[0]] || [],
        errors: Object.keys(errors).length ? errors : undefined,
      };
      if (!ok) {
        console.warn(
          `candle fail ${key}: no bars`,
          JSON.stringify(errors).slice(0, 200),
        );
      } else if (reused) {
        console.warn(`candle reused ${reused} bars for ${key}`);
      }
    } catch (error) {
      failCount += 1;
      results[key] = {
        ok: false,
        chainIndex: token.chainIndex,
        tokenContractAddress: token.tokenContractAddress,
        symbol: nextFavorites[nextFavorites.length - 1].symbol,
        tokenName: (meta && meta.tokenName) || '',
        candlesByBar: {},
        candles: [],
        error: error.message || String(error),
      };
      console.warn(`candle fail ${key}: ${error.message}`);
    }
    if (index + 1 < tokens.length) await sleep(TOKEN_GAP_MS);
  }

  const payload = {
    updatedAt: Date.now(),
    bars: BARS,
    barLimits: Object.fromEntries(BARS.map((bar) => [bar, limitForBar(bar)])),
    tokenCount: tokens.length,
    okCount,
    failCount,
    tokens: results,
  };

  await putObjectJson(OBS_CANDLES_KEY, payload);

  let favoritesUpdated = false;
  if (renamed > 0) {
    try {
      await saveJson(
        FAVORITES_PATH,
        { updatedAt: Date.now(), items: nextFavorites },
        favoritesFile.sha,
        `Fill OKX token symbols · ${renamed}`,
      );
      favoritesUpdated = true;
    } catch (error) {
      console.warn(`favorites symbol write failed: ${error.message}`);
    }
  }

  const publicUrl = `${obsConfig().publicBase}/${OBS_CANDLES_KEY}`;
  return {
    obsKey: OBS_CANDLES_KEY,
    publicUrl,
    bars: BARS,
    tokenCount: tokens.length,
    okCount,
    failCount,
    renamed,
    favoritesUpdated,
    updatedAt: payload.updatedAt,
  };
}

exports.handler = async (event, context) => {
  console.log(
    'okx-candles-timer invoke',
    JSON.stringify({
      keys: event && typeof event === 'object' ? Object.keys(event) : [],
      requestId: context && context.requestId,
    }),
  );
  const result = await syncCandlesCache();
  console.log('okx-candles-timer done', JSON.stringify(result));
  return result;
};

exports.syncCandlesCache = syncCandlesCache;
