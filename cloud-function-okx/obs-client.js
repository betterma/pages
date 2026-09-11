'use strict';

const https = require('https');
const crypto = require('crypto');

function cleanCredential(value) {
  let text = String(value || '')
    .replace(/^\uFEFF/, '')
    .trim()
    .replace(/^["']|["']$/g, '')
    .trim();
  // 误把整段 Authorization 贴进变量时去掉前缀
  if (/^OBS\s+/i.test(text)) {
    text = text.replace(/^OBS\s+/i, '').trim();
  }
  return text;
}

function obsConfig() {
  const bucket = String(process.env.OBS_BUCKET || 'mpctest').trim();
  const endpoint = String(
    process.env.OBS_ENDPOINT || 'obs.cn-north-4.myhuaweicloud.com',
  ).trim();
  const accessKey = cleanCredential(
    process.env.OBS_ACCESS_KEY || process.env.OBS_AK || '',
  );
  const secretKey = cleanCredential(
    process.env.OBS_SECRET_KEY || process.env.OBS_SK || '',
  );
  const publicBase =
    process.env.OBS_PUBLIC_BASE || `https://${bucket}.${endpoint}`;
  return { bucket, endpoint, accessKey, secretKey, publicBase };
}

function requestRaw(url, options = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(value);
    };

    const target = new URL(url);
    const timeoutMs = options.timeout || 20000;
    const request = https.request(
      target,
      {
        method: options.method || 'GET',
        headers: options.headers || {},
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const buffer = Buffer.concat(chunks);
          finish(null, {
            ok: response.statusCode >= 200 && response.statusCode < 300,
            status: response.statusCode,
            statusText: response.statusMessage || '',
            buffer,
            text: () => buffer.toString('utf8'),
          });
        });
        response.on('error', (error) => finish(error));
      },
    );
    request.on('error', (error) => finish(error));
    request.setTimeout(timeoutMs, () => {
      request.destroy();
      finish(new Error(`OBS request timeout after ${timeoutMs}ms: ${url}`));
    });
    if (options.body) request.write(options.body);
    request.end();
  });
}

function signObs({ method, contentType, date, resource, secretKey }) {
  const stringToSign = [method, '', contentType || '', date, resource].join(
    '\n',
  );
  return crypto
    .createHmac('sha1', secretKey)
    .update(stringToSign, 'utf8')
    .digest('base64');
}

async function getObjectJson(key) {
  const { publicBase } = obsConfig();
  const url = `${publicBase}/${key}?t=${Date.now()}`;
  console.log(`OBS GET ${url}`);
  const response = await requestRaw(url, { method: 'GET', timeout: 20000 });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(
      `OBS GET ${key} failed: ${response.status} ${response.text().slice(0, 200)}`,
    );
  }
  const text = response.text();
  if (!text.trim()) throw new Error(`OBS object empty: ${key}`);
  return JSON.parse(text);
}

async function putObjectJson(key, data) {
  const { bucket, endpoint, accessKey, secretKey } = obsConfig();
  if (!accessKey || !secretKey) {
    throw new Error('Missing OBS_ACCESS_KEY / OBS_SECRET_KEY');
  }
  if (/\s/.test(accessKey)) {
    throw new Error(
      'OBS_ACCESS_KEY 含空格，请只粘贴 Access Key Id（不要带 OBS 前缀或首尾空格）',
    );
  }

  const body = Buffer.from(JSON.stringify(data), 'utf8');
  const date = new Date().toUTCString();
  // 签名与 Header 必须完全一致；避免 charset 空格带来的兼容问题
  const contentType = 'application/json';
  const resource = `/${bucket}/${key}`;
  const signature = signObs({
    method: 'PUT',
    contentType,
    date,
    resource,
    secretKey,
  });

  // OBS 要求：Authorization 里 OBS 与 AK 之间有且仅有一个空格
  const authorization = `OBS ${accessKey}:${signature}`;
  if ((authorization.match(/ /g) || []).length !== 1) {
    throw new Error(
      `Authorization 空格数异常（AK 长度=${accessKey.length}），请检查 OBS_ACCESS_KEY`,
    );
  }

  const url = `https://${bucket}.${endpoint}/${key}`;
  console.log(
    `OBS PUT ${url} (${body.length} bytes) akLen=${accessKey.length}`,
  );
  const response = await requestRaw(url, {
    method: 'PUT',
    timeout: 30000,
    headers: {
      Date: date,
      'Content-Type': contentType,
      'Content-Length': String(body.length),
      Authorization: authorization,
      'User-Agent': 'okx-candles-obs',
    },
    body,
  });

  if (!response.ok) {
    throw new Error(
      `OBS PUT ${key} failed: ${response.status} ${response.text().slice(0, 300)}`,
    );
  }
  return true;
}

module.exports = {
  obsConfig,
  getObjectJson,
  putObjectJson,
  cleanCredential,
};
