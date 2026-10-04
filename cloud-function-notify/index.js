'use strict';

/**
 * 盯一下 / 持仓 定时事件函数
 * Handler: index.handler
 * 必须与 notify.js、auto-pin.js 等一并上传。
 */
const notify = require('./notify');

function resolveMain(mod) {
  if (!mod) return null;
  if (typeof mod.main === 'function') return mod.main;
  if (typeof mod.handler === 'function') return mod.handler;
  if (typeof mod === 'function') return mod;
  return null;
}

exports.handler = async (event, context) => {
  console.log(
    'notify invoke',
    JSON.stringify({
      keys: event && typeof event === 'object' ? Object.keys(event) : [],
      requestId: context && context.requestId,
      remainingTime:
        context && typeof context.getRemainingTimeInMillis === 'function'
          ? context.getRemainingTimeInMillis()
          : null,
    }),
  );
  const run = resolveMain(notify);
  if (typeof run !== 'function') {
    const keys =
      notify && typeof notify === 'object' ? Object.keys(notify) : [];
    throw new TypeError(
      `notify.main is not a function (got ${typeof (notify && notify.main)}). ` +
        `请整包上传 cloud-function-notify（含 notify.js）。exports=[${keys.join(',')}]`,
    );
  }
  return run();
};
