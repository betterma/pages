'use strict';

/**
 * 事件函数入口（定时拉 OKX K 线缓存）
 * Handler: index.handler
 * 触发器：定时触发器（建议 5～15 分钟）
 * 不需要 HTTP 触发器
 *
 * 流程：
 *   读 GitHub okx/favorites.json
 *   拉 OKX historical-candles
 *   写 OBS okx-candles-cache.json（与 watch-data.json 同桶）
 * 页面 okx/kline.html 读 OBS 公开地址
 */
const { fetchHistoricalCandles } = require('./okx-client');
const { FAVORITES_PATH, loadJson } = require('./github');
const { putObjectJson, obsConfig } = require('./obs-client');

const BAR = process.env.OKX_CANDLE_BAR || '4H';
const LIMIT = Math.min(
  299,
  Math.max(1, Number(process.env.OKX_CANDLE_LIMIT) || 72),
);
const OBS_CANDLES_KEY =
  process.env.OBS_OKX_CANDLES_PATH || 'okx-candles-cache.json';
const ALLOWED_CHAINS = new Set(
  String(process.env.OKX_CHAINS || '501,4663')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean),
);

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
    });
  });
  return [...map.values()];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function syncCandlesCache() {
  const favoritesFile = await loadJson(FAVORITES_PATH);
  const tokens = normalizeFavorites(favoritesFile.data);
  console.log(`okx-candles favorites=${tokens.length}`);

  const results = {};
  let okCount = 0;
  let failCount = 0;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const key = `${token.chainIndex}:${token.tokenContractAddress}`;
    try {
      const row = await fetchHistoricalCandles({
        chainIndex: token.chainIndex,
        tokenContractAddress: token.tokenContractAddress,
        bar: BAR,
        limit: LIMIT,
      });
      results[key] = {
        ok: true,
        chainIndex: row.chainIndex,
        tokenContractAddress: row.tokenContractAddress,
        symbol: token.symbol || '',
        candles: row.candles,
      };
      okCount += 1;
    } catch (error) {
      failCount += 1;
      results[key] = {
        ok: false,
        chainIndex: token.chainIndex,
        tokenContractAddress: token.tokenContractAddress,
        symbol: token.symbol || '',
        error: error.message || String(error),
        candles: [],
      };
      console.warn(`candle fail ${key}: ${error.message}`);
    }
    if (index + 1 < tokens.length) await sleep(200);
  }

  const payload = {
    updatedAt: Date.now(),
    bar: BAR,
    limit: LIMIT,
    tokenCount: tokens.length,
    okCount,
    failCount,
    tokens: results,
  };

  await putObjectJson(OBS_CANDLES_KEY, payload);
  const publicUrl = `${obsConfig().publicBase}/${OBS_CANDLES_KEY}`;

  return {
    obsKey: OBS_CANDLES_KEY,
    publicUrl,
    tokenCount: tokens.length,
    okCount,
    failCount,
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
