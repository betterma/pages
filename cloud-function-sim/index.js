'use strict';

/**
 * 模拟盘止损事件函数
 * Handler: index.handler
 * 定时触发器建议 1～5 分钟
 * 不需要 HTTP；不需要币安 Key（只用公开行情）
 */
const { runSimStops } = require('./sim');

exports.handler = async (event, context) => {
  console.log(
    'sim-timer invoke',
    JSON.stringify({
      keys: event && typeof event === 'object' ? Object.keys(event) : [],
      requestId: context && context.requestId,
    }),
  );
  const result = await runSimStops({ now: Date.now() });
  console.log('sim-stops', JSON.stringify(result));
  return result;
};
