'use strict';

/**
 * 合约只读自动盯 — 华为云 FunctionGraph 事件函数
 * Handler: index.handler
 * 定时触发器建议 5 分钟
 * 只读 fapi 公开行情；写 futures/ 下 JSON；不碰现货 kline / watch-*
 */
const { runFutAutoPin } = require('./auto-pin');

exports.handler = async (event, context) => {
  console.log(
    'fut-timer invoke',
    JSON.stringify({
      keys: event && typeof event === 'object' ? Object.keys(event) : [],
      requestId: context && context.requestId,
    }),
  );
  const result = await runFutAutoPin({ now: Date.now() });
  console.log('fut-auto-pin', JSON.stringify(result));
  return result;
};
