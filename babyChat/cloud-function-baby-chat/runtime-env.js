'use strict';

/**
 * 华为云 FunctionGraph（事件函数）环境变量读取：
 * - 明文变量有时在 process.env
 * - 官方推荐：context.getUserData('KEY')
 * - 加密变量还可能在 process.env.RUNTIME_USERDATA（JSON）
 */

function trimStr(value) {
  if (value == null) return '';
  return String(value).trim();
}

function fromRuntimeUserData(name) {
  const raw = process.env.RUNTIME_USERDATA;
  if (!raw) return '';
  try {
    const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!obj || typeof obj !== 'object') return '';
    return trimStr(obj[name]);
  } catch (error) {
    return '';
  }
}

function getUserData(context, name) {
  const key = String(name || '');
  if (!key) return '';

  const fromEnv = trimStr(process.env[key]);
  if (fromEnv) return fromEnv;

  if (context && typeof context.getUserData === 'function') {
    try {
      const value = trimStr(context.getUserData(key));
      if (value) return value;
    } catch (error) {
      /* ignore */
    }
  }

  return fromRuntimeUserData(key);
}

function getUserDataFirst(context, names) {
  for (const name of names || []) {
    const value = getUserData(context, name);
    if (value) return value;
  }
  return '';
}

function diagSources(context, names) {
  const list = Array.isArray(names) ? names : [];
  const hasGetUserData =
    !!(context && typeof context.getUserData === 'function');
  const runtimeUserDataLen = process.env.RUNTIME_USERDATA
    ? String(process.env.RUNTIME_USERDATA).length
    : 0;
  const seen = [];
  list.forEach((name) => {
    const viaEnv = !!trimStr(process.env[name]);
    let viaCtx = false;
    if (hasGetUserData) {
      try {
        viaCtx = !!trimStr(context.getUserData(name));
      } catch (error) {
        viaCtx = false;
      }
    }
    const viaRuntime = !!fromRuntimeUserData(name);
    if (viaEnv || viaCtx || viaRuntime) {
      seen.push({ name, viaEnv, viaCtx, viaRuntime });
    }
  });
  return { hasGetUserData, runtimeUserDataLen, seen };
}

module.exports = {
  getUserData,
  getUserDataFirst,
  diagSources,
};
