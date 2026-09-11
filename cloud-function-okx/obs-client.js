'use strict';

const https = require('https');
const crypto = require('crypto');

function obsConfig() {
  const bucket = process.env.OBS_BUCKET || 'mpctest';
  const endpoint = process.env.OBS_ENDPOINT || 'obs.cn-north-4.myhuaweicloud.com';
  const accessKey = process.env.OBS_ACCESS_KEY || process.env.OBS_AK || '';
  const secretKey = process.env.OBS_SECRET_KEY || process.env.OBS_SK || '';
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
  const stringToSign = [method, '', contentType || '', date, resource].join('\n');
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

  const body = Buffer.from(JSON.stringify(data), 'utf8');
  const date = new Date().toUTCString();
  const contentType = 'application/json; charset=utf-8';
  const resource = `/${bucket}/${key}`;
  const signature = signObs({
    method: 'PUT',
    contentType,
    date,
    resource,
    secretKey,
  });

  const url = `https://${bucket}.${endpoint}/${key}`;
  console.log(`OBS PUT ${url} (${body.length} bytes)`);
  const response = await requestRaw(url, {
    method: 'PUT',
    timeout: 30000,
    headers: {
      Date: date,
      'Content-Type': contentType,
      'Content-Length': body.length,
      Authorization: `OBS ${accessKey}:${signature}`,
      'User-Agent': 'binance-radar-obs',
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
};
