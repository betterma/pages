'use strict';

/**
 * 事件函数入口（只做定时监控）
 * Handler: index.handler
 * 创建类型：事件函数 + 定时触发器
 */
const { main } = require('./monitor');

exports.handler = async (event, context) => {
  console.log(
    'monitor invoke',
    JSON.stringify({
      keys: event && typeof event === 'object' ? Object.keys(event) : [],
      requestId: context && context.requestId,
    }),
  );
  const result = await main();
  return result;
};
