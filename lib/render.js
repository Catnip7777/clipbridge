'use strict';
/** 把二维码矩阵渲染成 PNG（零依赖，使用 zlib + CRC32 手工组装 PNG）。 */

const zlib = require('node:zlib');

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

/**
 * @param {boolean[][]} modules 二维码矩阵，true = 黑
 * @param {object} [options]
 * @param {number} [options.scale=8] 每个模块的像素边长
 * @param {number} [options.quietZone=3] 静默区宽度（模块数）
 * @param {[number, number, number]} [options.dark=[0,0,0]]
 * @param {[number, number, number]} [options.light=[255,255,255]]
 * @returns {Buffer} PNG 数据
 */
function renderPng(modules, options = {}) {
  const scale = options.scale ?? 8;
  const quietZone = options.quietZone ?? 4;
  const dark = options.dark ?? [0, 0, 0];
  const light = options.light ?? [255, 255, 255];

  const moduleCount = modules.length;
  const dimension = (moduleCount + quietZone * 2) * scale;

  const raw = Buffer.alloc((dimension * 3 + 1) * dimension);
  let offset = 0;
  for (let y = 0; y < dimension; y++) {
    raw[offset++] = 0; // filter: none
    const moduleY = Math.floor(y / scale) - quietZone;
    for (let x = 0; x < dimension; x++) {
      const moduleX = Math.floor(x / scale) - quietZone;
      const inRange =
        moduleY >= 0 && moduleY < moduleCount && moduleX >= 0 && moduleX < moduleCount;
      const isDark = inRange && modules[moduleY][moduleX];
      const color = isDark ? dark : light;
      raw[offset++] = color[0];
      raw[offset++] = color[1];
      raw[offset++] = color[2];
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(dimension, 0);
  ihdr.writeUInt32BE(dimension, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * 渲染到终端：用半方块字符，一个字符高度容纳两行模块，UTF-8 终端里各平台宽度一致。
 * @param {boolean[][]} modules
 * @param {object} [options]
 * @param {number} [options.quietZone=2]
 * @param {boolean} [options.invert=false] 深色背景终端可反转
 */
function renderTerminal(modules, options = {}) {
  const quietZone = options.quietZone ?? 2;
  const invert = options.invert ?? false;
  const size = modules.length;
  const total = size + quietZone * 2;
  const at = (row, col) => {
    const r = row - quietZone;
    const c = col - quietZone;
    const dark = r >= 0 && r < size && c >= 0 && c < size ? modules[r][c] : false;
    return invert ? !dark : dark;
  };

  const lines = [];
  for (let row = 0; row < total; row += 2) {
    let line = '';
    for (let col = 0; col < total; col++) {
      const top = at(row, col);
      const bottom = row + 1 < total ? at(row + 1, col) : false;
      if (top && bottom) line += '\u2588'; // █
      else if (top) line += '\u2580'; // ▀
      else if (bottom) line += '\u2584'; // ▄
      else line += ' ';
    }
    lines.push(line);
  }
  return lines.join('\n');
}

module.exports = { renderPng, renderTerminal };
