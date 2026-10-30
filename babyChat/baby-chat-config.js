/**
 * 网页侧密钥（按你的要求可明文放这里；勿把含真实 Key 的文件发到公开无关仓库以外也无所谓）。
 * 填好后刷新页面即可：解析在浏览器完成，打开不必输密码。
 */
(function (global) {
  "use strict";

  global.BabyChatConfig = {
    // 阿里云百炼 API Key（LLM + ASR）
    DASHSCOPE_API_KEY:
      "sk-ws-H.YIRXLXP.0yhi.MEQCIGIKp1KW7y0f2EAcy4sftTWDJlEl-IqAGQEm6_Ix7pWcAiBIyffPTIbiXVFeHr_mnIWPKrS24V3WbJKgMYJTTmQsbQ",
    // 可选：覆盖默认模型
    BABY_LLM_MODEL: "qwen-plus",
    BABY_ASR_MODEL: "qwen3-asr-flash",
    DASHSCOPE_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    // GitHub 写入 Token（推荐填写；空则首次会走保险库解锁并记住到本机）
    GITHUB_TOKEN: "",
    GITHUB_REPO: "betterma/pages",
  };
})(typeof window !== "undefined" ? window : globalThis);
