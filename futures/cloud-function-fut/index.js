'use strict';

/**
 * 合约只读自动盯 — 华为云 FunctionGraph 事件函数
 * Handler: index.handler
 * 定时触发器建议 5 分钟
 * 只读 fapi 公开行情；写 futures/ 下 JSON；不碰现货 kline / watch-*
 */
const { runFutAutoPin } = require('./auto-pin');
const { runFutNailDailyReset } = require('./daily-reset');

let pruneStaleFutAutoPinNails = async () => ({
  skipped: true,
  reason: 'module-missing',
  removed: [],
});
try {
  pruneStaleFutAutoPinNails =
    require('./prune-stale-fut-auto-pin-nails').pruneStaleFutAutoPinNails;
} catch (_) {
  console.warn(
    'prune-stale-fut-auto-pin-nails module missing — 请整包上传 cloud-function-fut',
  );
}

exports.handler = async (event, context) => {
  const now = Date.now();
  console.log(
    'fut-timer invoke',
    JSON.stringify({
      keys: event && typeof event === 'object' ? Object.keys(event) : [],
      requestId: context && context.requestId,
    }),
  );

  let dailyReset = { skipped: true, reason: 'not-run' };
  try {
    dailyReset = await runFutNailDailyReset({ now });
    console.log('fut-nail-daily-reset', JSON.stringify(dailyReset));
  } catch (error) {
    dailyReset = {
      skipped: true,
      reason: 'failed',
      error: error && error.message ? error.message : String(error),
    };
    console.warn('fut-nail-daily-reset failed', dailyReset.error);
  }

  const result = await runFutAutoPin({ now });
  console.log('fut-auto-pin', JSON.stringify(result));

  let staleNailPrune = { skipped: true, reason: 'not-run', removed: [] };
  try {
    staleNailPrune = await pruneStaleFutAutoPinNails({ now });
    console.log('fut-prune-stale', JSON.stringify(staleNailPrune));
  } catch (error) {
    staleNailPrune = {
      skipped: true,
      reason: 'failed',
      removed: [],
      error: error && error.message ? error.message : String(error),
    };
    console.warn('fut-prune-stale failed', staleNailPrune.error);
  }

  return { ...result, dailyReset, staleNailPrune };
};
