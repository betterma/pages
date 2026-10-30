'use strict';

/**
 * 宝宝日记定时事件函数（仅定时触发，无 HTTP）
 * Handler: index.handler
 * 必须整包上传本目录全部 .js
 */
const babyChat = require('./baby-chat');

function resolveMain(mod) {
  if (!mod) return null;
  if (typeof mod.main === 'function') return mod.main;
  if (typeof mod.handler === 'function') return mod.handler;
  if (typeof mod === 'function') return mod;
  return null;
}

exports.handler = async (event, context) => {
  console.log(
    'baby-chat invoke',
    JSON.stringify({
      keys: event && typeof event === 'object' ? Object.keys(event) : [],
      requestId: context && context.requestId,
      remainingTime:
        context && typeof context.getRemainingTimeInMillis === 'function'
          ? context.getRemainingTimeInMillis()
          : null,
    }),
  );
  const run = resolveMain(babyChat);
  if (typeof run !== 'function') {
    const keys =
      babyChat && typeof babyChat === 'object' ? Object.keys(babyChat) : [];
    throw new TypeError(
      `baby-chat.main is not a function. 请整包上传 cloud-function-baby-chat。exports=[${keys.join(',')}]`,
    );
  }
  return run(event, context);
};
