'use strict';

/**
 * 盯一下 / 持仓 企业微信推送（定时事件函数）
 * Handler: index.handler
 */
const { main } = require('./notify');

exports.handler = async (event, context) => {
  console.log(
    'notify invoke',
    JSON.stringify({
      keys: event && typeof event === 'object' ? Object.keys(event) : [],
      requestId: context && context.requestId,
    }),
  );
  return main();
};
