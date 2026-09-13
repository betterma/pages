'use strict';

/**
 * RH 日 K 缓存刷新（仅定时触发器，无需 HTTP）
 * Handler: index.handler
 *
 * 拉 DexPaprika → 写入 GitHub RH/cache.json → 网页同源读取
 */
const { main } = require('./refresh');

exports.handler = async (event, context) => {
  console.log(
    'rh-cache invoke',
    JSON.stringify({
      keys: event && typeof event === 'object' ? Object.keys(event) : [],
      requestId: context && context.requestId,
      remainingTime:
        context && typeof context.getRemainingTimeInMillis === 'function'
          ? context.getRemainingTimeInMillis()
          : null,
    }),
  );
  return main();
};
