'use strict';

/**
 * 事件函数入口（定时检测）
 * Handler: index.handler
 * 触发器：定时触发器（建议每 30 分钟）
 * 不需要 HTTP 触发器
 *
 * 默认 TRADE_MODE=paper（模拟成交）
 * 以后改真实下单：TRADE_MODE=live + 配置币安 Key
 */
const { runScheduledTick } = require('./trade');

exports.handler = async (event, context) => {
  console.log(
    'trade-timer invoke',
    JSON.stringify({
      keys: event && typeof event === 'object' ? Object.keys(event) : [],
      requestId: context && context.requestId,
      mode: process.env.TRADE_MODE || 'paper',
    }),
  );
  const result = await runScheduledTick();
  return result;
};
