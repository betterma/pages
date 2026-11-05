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
    const message =
      `notify.main is not a function (got ${typeof (notify && notify.main)}). ` +
      `请整包上传 cloud-function-notify（含 notify.js / balance-alert.js）。exports=[${keys.join(',')}]`;
    console.error(message);
    return { ok: false, errorType: 'TypeError', errorMessage: message };
  }
  // 事件函数加密环境变量需经 context.getUserData 读取，必须把 context 传下去。
  try {
    return await run(event, context);
  } catch (error) {
    const errorMessage =
      error && error.message ? error.message : String(error);
    const errorType =
      error && error.name ? error.name : 'Error';
    console.error('notify failed', errorType, errorMessage);
    if (error && error.stack) console.error(error.stack);
    // 返回结构化错误，避免控制台「函数返回 / 日志」全是 --。
    return {
      ok: false,
      errorType,
      errorMessage,
    };
  }
};
