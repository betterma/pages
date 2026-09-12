'use strict';

const https = require('https');
const crypto = require('crypto');
const zlib = require('zlib');

const CHART = {
  width: 640,
  height: 320,
  padTop: 36,
  padRight: 12,
  padBottom: 16,
  padLeft: 12,
  interval: process.env.PIN_CHART_INTERVAL || '4h',
  limit: Number(process.env.PIN_CHART_LIMIT || 42),
  bg: [244, 245, 243, 255],
  up: [113, 139, 136, 255],
  down: [141, 119, 113, 255],
  grid: [216, 221, 218, 255],
  text: [40, 50, 58, 255],
  pin: [90, 106, 104, 255],
};

// Minimal 5x7 glyphs for chart titles (A-Z 0-9 . + - % space).
const GLYPHS = {
  ' ': [0, 0, 0, 0, 0, 0, 0],
  '.': [0, 0, 0, 0, 0, 4, 4],
  '+': [0, 4, 4, 31, 4, 4, 0],
  '-': [0, 0, 0, 31, 0, 0, 0],
  '%': [17, 18, 4, 8, 17, 17, 0],
  0: [14, 17, 19, 21, 25, 17, 14],
  1: [4, 12, 4, 4, 4, 4, 14],
  2: [14, 17, 1, 2, 4, 8, 31],
  3: [31, 2, 4, 2, 1, 17, 14],
  4: [2, 6, 10, 18, 31, 2, 2],
  5: [31, 16, 30, 1, 1, 17, 14],
  6: [6, 8, 16, 30, 17, 17, 14],
  7: [31, 1, 2, 4, 8, 8, 8],
  8: [14, 17, 17, 14, 17, 17, 14],
  9: [14, 17, 17, 15, 1, 2, 12],
  A: [14, 17, 17, 31, 17, 17, 17],
  B: [30, 17, 17, 30, 17, 17, 30],
  C: [14, 17, 16, 16, 16, 17, 14],
  D: [30, 17, 17, 17, 17, 17, 30],
  E: [31, 16, 16, 30, 16, 16, 31],
  F: [31, 16, 16, 30, 16, 16, 16],
  G: [14, 17, 16, 19, 17, 17, 14],
  H: [17, 17, 17, 31, 17, 17, 17],
  I: [14, 4, 4, 4, 4, 4, 14],
  J: [1, 1, 1, 1, 17, 17, 14],
  K: [17, 18, 20, 24, 20, 18, 17],
  L: [16, 16, 16, 16, 16, 16, 31],
  M: [17, 27, 21, 21, 17, 17, 17],
  N: [17, 25, 21, 19, 17, 17, 17],
  O: [14, 17, 17, 17, 17, 17, 14],
  P: [30, 17, 17, 30, 16, 16, 16],
  Q: [14, 17, 17, 17, 21, 18, 13],
  R: [30, 17, 17, 30, 20, 18, 17],
  S: [14, 17, 16, 14, 1, 17, 14],
  T: [31, 4, 4, 4, 4, 4, 4],
  U: [17, 17, 17, 17, 17, 17, 14],
  V: [17, 17, 17, 17, 17, 10, 4],
  W: [17, 17, 17, 21, 21, 21, 10],
  X: [17, 17, 10, 4, 10, 17, 17],
  Y: [17, 17, 10, 4, 4, 4, 4],
  Z: [31, 1, 2, 4, 8, 16, 31],
};

function requestText(url) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const request = https.request(
      target,
      { method: 'GET' },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          resolve({
            ok: response.statusCode >= 200 && response.statusCode < 300,
            status: response.statusCode,
            text: Buffer.concat(chunks).toString('utf8'),
          });
        });
        response.on('error', reject);
      },
    );
    request.on('error', reject);
    request.setTimeout(20000, () => {
      request.destroy();
      reject(new Error(`timeout ${url}`));
    });
    request.end();
  });
}

async function fetchKlines(symbol, interval, limit) {
  const query = new URLSearchParams({
    symbol: String(symbol).toUpperCase(),
    interval,
    limit: String(limit),
  });
  const endpoints = [
    `https://data-api.binance.vision/api/v3/klines?${query}`,
    `https://api.binance.com/api/v3/klines?${query}`,
  ];
  let lastError = null;
  for (const endpoint of endpoints) {
    try {
      const response = await requestText(endpoint);
      if (!response.ok) {
        lastError = new Error(`klines ${response.status}`);
        continue;
      }
      const raw = JSON.parse(response.text);
      return raw.map((item) => ({
        open: Number(item[1]),
        high: Number(item[2]),
        low: Number(item[3]),
        close: Number(item[4]),
      }));
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('fetch klines failed');
}

function createPixels(width, height, rgba) {
  const pixels = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    const o = i * 4;
    pixels[o] = rgba[0];
    pixels[o + 1] = rgba[1];
    pixels[o + 2] = rgba[2];
    pixels[o + 3] = rgba[3];
  }
  return pixels;
}

function setPixel(pixels, width, height, x, y, rgba) {
  const ix = Math.round(x);
  const iy = Math.round(y);
  if (ix < 0 || iy < 0 || ix >= width || iy >= height) return;
  const o = (iy * width + ix) * 4;
  pixels[o] = rgba[0];
  pixels[o + 1] = rgba[1];
  pixels[o + 2] = rgba[2];
  pixels[o + 3] = rgba[3];
}

function fillRect(pixels, width, height, x, y, w, h, rgba) {
  const x0 = Math.max(0, Math.floor(x));
  const y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(width, Math.ceil(x + w));
  const y1 = Math.min(height, Math.ceil(y + h));
  for (let py = y0; py < y1; py += 1) {
    for (let px = x0; px < x1; px += 1) {
      setPixel(pixels, width, height, px, py, rgba);
    }
  }
}

function drawLine(pixels, width, height, x0, y0, x1, y1, rgba) {
  let xa = Math.round(x0);
  let ya = Math.round(y0);
  const xb = Math.round(x1);
  const yb = Math.round(y1);
  const dx = Math.abs(xb - xa);
  const dy = Math.abs(yb - ya);
  const sx = xa < xb ? 1 : -1;
  const sy = ya < yb ? 1 : -1;
  let err = dx - dy;
  while (true) {
    setPixel(pixels, width, height, xa, ya, rgba);
    if (xa === xb && ya === yb) break;
    const e2 = 2 * err;
    if (e2 > -dy) {
      err -= dy;
      xa += sx;
    }
    if (e2 < dx) {
      err += dx;
      ya += sy;
    }
  }
}

function drawText(pixels, width, height, x, y, text, rgba, scale) {
  const s = scale || 2;
  let cursor = x;
  String(text || '')
    .toUpperCase()
    .split('')
    .forEach((ch) => {
      const glyph = GLYPHS[ch] || GLYPHS[' '];
      for (let row = 0; row < 7; row += 1) {
        const bits = glyph[row];
        for (let col = 0; col < 5; col += 1) {
          if (bits & (1 << (4 - col))) {
            fillRect(
              pixels,
              width,
              height,
              cursor + col * s,
              y + row * s,
              s,
              s,
              rgba,
            );
          }
        }
      }
      cursor += 6 * s;
    });
}

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i += 1) {
    c ^= buf[i];
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
  }
  return ~c >>> 0;
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(width, height, pixels) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0;
    pixels.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }
  const compressed = zlib.deflateSync(raw);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function renderCandlesPixels(candles, options) {
  const width = CHART.width;
  const height = CHART.height;
  const pixels = createPixels(width, height, CHART.bg);
  const title = options && options.title ? String(options.title) : '';
  const pinPrice = options && Number(options.pinPrice);

  if (title) {
    drawText(pixels, width, height, 12, 10, title, CHART.text, 2);
  }

  if (!candles || !candles.length) {
    drawText(pixels, width, height, 12, height / 2, 'NO DATA', CHART.down, 2);
    return { width, height, pixels };
  }

  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  let max = Math.max(...highs);
  let min = Math.min(...lows);
  if (Number.isFinite(pinPrice)) {
    max = Math.max(max, pinPrice);
    min = Math.min(min, pinPrice);
  }
  const range = max - min || max * 0.01 || 1;
  const chartW = width - CHART.padLeft - CHART.padRight;
  const chartH = height - CHART.padTop - CHART.padBottom;
  const slot = chartW / candles.length;
  const bodyW = Math.max(2, slot * 0.55);
  const yOf = (price) =>
    CHART.padTop + ((max - price) / range) * chartH;

  // grid lines
  for (let i = 0; i <= 4; i += 1) {
    const y = CHART.padTop + (chartH * i) / 4;
    drawLine(
      pixels,
      width,
      height,
      CHART.padLeft,
      y,
      width - CHART.padRight,
      y,
      CHART.grid,
    );
  }

  if (Number.isFinite(pinPrice)) {
    const y = yOf(pinPrice);
    drawLine(
      pixels,
      width,
      height,
      CHART.padLeft,
      y,
      width - CHART.padRight,
      y,
      CHART.pin,
    );
  }

  candles.forEach((candle, index) => {
    const x = CHART.padLeft + slot * index + slot / 2;
    const up = candle.close >= candle.open;
    const color = up ? CHART.up : CHART.down;
    drawLine(
      pixels,
      width,
      height,
      x,
      yOf(candle.high),
      x,
      yOf(candle.low),
      color,
    );
    const y1 = yOf(candle.open);
    const y2 = yOf(candle.close);
    const top = Math.min(y1, y2);
    const bodyH = Math.max(1, Math.abs(y2 - y1));
    fillRect(pixels, width, height, x - bodyW / 2, top, bodyW, bodyH, color);
  });

  return { width, height, pixels };
}

function pngFromPixels(width, height, pixels) {
  const png = encodePng(width, height, pixels);
  return {
    buffer: png,
    base64: png.toString('base64'),
    md5: crypto.createHash('md5').update(png).digest('hex'),
  };
}

function renderCandlesPng(candles, options) {
  const frame = renderCandlesPixels(candles, options);
  return pngFromPixels(frame.width, frame.height, frame.pixels);
}

function stitchFramesVertically(frames, gap) {
  const list = (frames || []).filter(Boolean);
  if (!list.length) return null;
  const gapPx = Number.isFinite(gap) ? Math.max(0, gap) : 10;
  const width = Math.max(...list.map((f) => f.width));
  const height =
    list.reduce((sum, f) => sum + f.height, 0) + gapPx * (list.length - 1);
  const pixels = createPixels(width, height, CHART.bg);
  let yOffset = 0;
  list.forEach((frame, index) => {
    for (let y = 0; y < frame.height; y += 1) {
      for (let x = 0; x < frame.width; x += 1) {
        const src = (y * frame.width + x) * 4;
        const dst = ((yOffset + y) * width + x) * 4;
        pixels[dst] = frame.pixels[src];
        pixels[dst + 1] = frame.pixels[src + 1];
        pixels[dst + 2] = frame.pixels[src + 2];
        pixels[dst + 3] = frame.pixels[src + 3];
      }
    }
    yOffset += frame.height;
    if (index < list.length - 1 && gapPx > 0) {
      fillRect(pixels, width, height, 0, yOffset, width, gapPx, [232, 234, 232, 255]);
      yOffset += gapPx;
    }
  });
  return pngFromPixels(width, height, pixels);
}

async function buildSymbolChart(symbol, options) {
  const interval = (options && options.interval) || CHART.interval;
  const limit = (options && options.limit) || CHART.limit;
  const candles = await fetchKlines(symbol, interval, limit);
  const label = String(symbol || '').replace(/USDT$/i, '');
  const change = options && options.change;
  const changeText = Number.isFinite(change)
    ? `${change > 0 ? '+' : ''}${change.toFixed(2)}%`
    : '';
  const rank = options && options.rank;
  const rankText = Number.isFinite(rank) ? `#${rank} ` : '';
  const title = `${rankText}${label} ${interval.toUpperCase()} ${changeText}`.trim();
  return renderCandlesPng(candles, {
    title,
    pinPrice: options && options.pinPrice,
  });
}

async function buildTopChartsCollage(rows, options) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return null;
  const frames = await Promise.all(
    list.map(async (row, index) => {
      try {
        const interval = (options && options.interval) || CHART.interval;
        const limit = (options && options.limit) || CHART.limit;
        const candles = await fetchKlines(row.symbol, interval, limit);
        const label = String(row.symbol || '').replace(/USDT$/i, '');
        const changeText = Number.isFinite(row.change)
          ? `${row.change > 0 ? '+' : ''}${row.change.toFixed(2)}%`
          : '';
        const title = `#${index + 1} ${label} ${String(interval).toUpperCase()} ${changeText}`.trim();
        return renderCandlesPixels(candles, {
          title,
          pinPrice: row.pinPrice,
        });
      } catch (error) {
        console.warn(
          `collage chart failed ${row.symbol}`,
          error.message || error,
        );
        return null;
      }
    }),
  );
  const valid = frames.filter(Boolean);
  if (!valid.length) return null;
  return stitchFramesVertically(valid, 12);
}

module.exports = {
  fetchKlines,
  renderCandlesPng,
  renderCandlesPixels,
  stitchFramesVertically,
  buildSymbolChart,
  buildTopChartsCollage,
  CHART,
};
