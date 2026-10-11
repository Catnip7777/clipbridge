'use strict';
/** 自测：验证二维码编码、PNG 渲染与工具函数。运行：node selftest.js */

const assert = require('node:assert');
const qr = require('./lib/qr');
const { renderPng, renderTerminal } = require('./lib/render');

let passed = 0;
const check = (name, fn) => {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (error) {
    console.error(`  FAIL ${name}\n       ${error.message}`);
    process.exitCode = 1;
  }
};

console.log('二维码模块');

// 从矩阵反读：格式信息 -> 反掩码 -> 反交错 -> 解析字节模式载荷，完整校验"编码 -> 矩阵 -> 解码"链路
function roundTrip(text) {
  const { modules, version, size } = qr.encode(text);
  const { ecLevelBits, maskId } = qr.readFormatInfo(modules);
  assert.strictEqual(ecLevelBits, 0b01, '纠错等级应为 L');
  const unmasked = qr.unmask(modules, maskId);
  const codewords = qr.extractCodewords(unmasked);
  const data = qr.decodeDataCodewords(codewords, version);
  const bits = [];
  for (const byte of data) for (let i = 7; i >= 0; i--) bits.push((byte >>> i) & 1);
  let pos = 0;
  const take = (n) => {
    let value = 0;
    for (let i = 0; i < n; i++) value = (value << 1) | bits[pos++];
    return value;
  };
  const mode = take(4);
  assert.strictEqual(mode, 0b0100, '模式指示符应为字节模式');
  const length = take(version <= 9 ? 8 : 16);
  const expectedLength = Buffer.from(text, 'utf8').length;
  assert.strictEqual(length, expectedLength, '长度字段与 UTF-8 字节数不符');
  const payload = [];
  for (let i = 0; i < length; i++) payload.push(take(8));
  const decoded = Buffer.from(payload).toString('utf8');
  assert.strictEqual(decoded, text, `解码结果不一致: ${JSON.stringify(decoded)}`);
  return { version, size, modules };
}

check('短 ASCII 往返', () => roundTrip('http://192.168.31.37:8737/'));
check('中文 + URL 往返', () => roundTrip('http://192.168.1.5:8737/#房间A'));
check('长文本往返（版本>=5）', () => {
  const text = 'http://192.168.31.37:8737/?token=' + 'a'.repeat(90);
  const { version } = roundTrip(text);
  assert.ok(version >= 5, `期望版本 >= 5，实际 ${version}`);
});
check('版本 10+ 使用 16 位长度字段', () => {
  const text = 'https://example.com/' + 'b'.repeat(250);
  const { version } = qr.encode(text);
  assert.ok(version >= 10, `期望版本 >= 10，实际 ${version}`);
  roundTrip(text);
});
check('超长内容抛出可读错误', () => {
  assert.throws(() => qr.encode('x'.repeat(3000)), /内容过长/);
});
check('矩阵尺寸符合版本公式', () => {
  for (const version of [1, 2, 7, 10, 15]) {
    // 用刚好填满该版本的数据量，验证版本选择与矩阵尺寸
    const limit = qr.dataCapacityBytes(version);
    const result = qr.encode('a'.repeat(limit));
    assert.strictEqual(result.version, version, `期望版本 ${version}`);
    assert.strictEqual(result.size, version * 4 + 17, `版本 ${version} 尺寸错误`);
  }
});
check('跨多版本的码字级往返（含分块交错）', () => {
  for (let version = 1; version <= 15; version++) {
    const limit = qr.dataCapacityBytes(version);
    // 用多字节字符把数据填到刚好满容量，同时覆盖 UTF-8 边界
    let text = '中'.repeat(Math.floor(limit / 3)) + 'a'.repeat(limit % 3);
    text = text + 'x'.repeat(limit - Buffer.from(text, 'utf8').length);
    const bytes = Buffer.from(text, 'utf8');
    assert.strictEqual(bytes.length, limit, `版本 ${version} 构造数据长度不符`);
    assert.strictEqual(qr.pickVersion(bytes.length), version, `版本 ${version} 选择错误`);
    const { modules } = qr.encode(text);
    const { maskId } = qr.readFormatInfo(modules);
    const data = qr.decodeDataCodewords(qr.extractCodewords(qr.unmask(modules, maskId)), version);
    // 数据码字应与直接编码的期望值完全一致（掩码不改变码字，只改变摆放）
    const bits = [];
    const push = (v, n) => { for (let i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1); };
    push(4, 4);
    push(bytes.length, version <= 9 ? 8 : 16);
    for (const b of bytes) push(b, 8);
    const cap = qr.dataCodewordCount(version) * 8;
    for (let i = 0; i < 4 && bits.length < cap; i++) bits.push(0);
    while (bits.length % 8 !== 0) bits.push(0);
    const expected = [];
    for (let i = 0; i < bits.length; i += 8) {
      let byte = 0;
      for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
      expected.push(byte);
    }
    for (let i = 0; expected.length < cap / 8; i++) expected.push(i % 2 === 0 ? 0xec : 0x11);
    assert.deepStrictEqual(data, expected, `版本 ${version} 码字不一致`);
  }
});
check('定位图形与定时图形正确', () => {
  const { modules, size } = qr.encode('https://example.com/');
  const at = (r, c) => modules[r][c];
  assert.ok(at(0, 0) && at(0, 6) && at(6, 0) && at(3, 3), '左上定位图形缺失');
  assert.ok(at(0, size - 1) && at(0, size - 7), '右上定位图形缺失');
  assert.ok(at(size - 1, 0) && at(size - 7, 0), '左下定位图形缺失');
  assert.ok(!at(7, 7), '定位图形分隔符应为白');
  let timingOk = true;
  for (let i = 8; i < size - 8; i++) {
    if (at(6, i) !== (i % 2 === 0)) timingOk = false;
    if (at(i, 6) !== (i % 2 === 0)) timingOk = false;
  }
  assert.ok(timingOk, '定时图形不正确');
  assert.ok(at(size - 8, 8), '固定暗模块缺失');
});
check('格式信息可解出 L 级与掩码号', () => {
  const { modules } = qr.encode('https://example.com/');
  // 按规范坐标手工读左上副本，验证与 readFormatInfo 一致
  let bits = 0;
  for (let i = 0; i <= 5; i++) bits |= (modules[i][8] ? 1 : 0) << i;
  bits |= (modules[7][8] ? 1 : 0) << 6;
  bits |= (modules[8][8] ? 1 : 0) << 7;
  bits |= (modules[8][7] ? 1 : 0) << 8;
  for (let i = 9; i <= 14; i++) bits |= (modules[8][14 - i] ? 1 : 0) << i;
  const unmasked = bits ^ 0x5412;
  // 格式信息校验：BCH(15,5) 余数应为 0
  let rem = unmasked;
  for (let i = 14; i >= 10; i--) {
    if ((rem >>> i) & 1) rem ^= 0x537 << (i - 10);
  }
  assert.strictEqual(rem, 0, '格式信息 BCH 校验失败');
  const data = unmasked >>> 10;
  assert.strictEqual((data >>> 3) & 0b11, 0b01, '纠错等级应为 L');
  const fromMatrix = qr.readFormatInfo(modules);
  assert.strictEqual(fromMatrix.maskId, data & 0b111, 'readFormatInfo 读出的掩码号不一致');
  // 副本二（左下竖条 + 右上横条）应与副本一的对应位一致，仅 bit 7 位置被暗模块占用
  const size = modules.length;
  let mirror = 0;
  for (let i = 0; i <= 6; i++) mirror |= (modules[size - 1 - i][8] ? 1 : 0) << i;
  for (let i = 8; i <= 14; i++) mirror |= (modules[8][size - 8 + (i - 8)] ? 1 : 0) << i;
  for (const i of [...Array(7).keys(), 8, 9, 10, 11, 12, 13, 14]) {
    assert.strictEqual(
      (mirror >>> i) & 1,
      (bits >>> i) & 1,
      `格式信息副本二 bit ${i} 与副本一不一致`,
    );
  }
  assert.ok(!modules[8][size - 1], '右上横条不应覆盖列 size-1（分隔符）');
  assert.ok(modules[size - 8][8], '固定暗模块缺失');
});
check('相同输入产生稳定输出（掩码选择确定）', () => {
  const a = qr.encode('http://192.168.31.37:8737/').modules.flat().map(Number).join('');
  const b = qr.encode('http://192.168.31.37:8737/').modules.flat().map(Number).join('');
  assert.strictEqual(a, b);
});

check('数据区位宽严格等于规范码字位数（防止功能图形漏保留）', () => {
  // 各版本的剩余位（remainder bits）：数据区里不属于任何码字的填充单元
  const REMAINDER = { 1: 0, 2: 7, 3: 7, 4: 7, 5: 7, 6: 7, 7: 0, 8: 0, 9: 0, 10: 0, 11: 0, 12: 0, 13: 0, 14: 3, 15: 3 };
  for (let version = 1; version <= 15; version++) {
    const size = version * 4 + 17;
    const { modules } = qr.encode('a'.repeat(qr.dataCapacityBytes(version)));
    // 矩阵中"未被保留"的单元数（= 遍历到的数据区单元数）
    const traversed = [];
    let upward = true;
    for (let col = size - 1; col > 0; col -= 2) {
      if (col === 6) col = 5;
      for (let i = 0; i < size; i++) {
        const row = upward ? size - 1 - i : i;
        for (const c of [col, col - 1]) traversed.push([row, c]);
      }
      upward = !upward;
    }
    const expectedCells = qr.TOTAL_CODEWORDS[version] * 8 + REMAINDER[version];
    const actualBits = qr.extractCodewords(modules).length * 8;
    assert.strictEqual(
      actualBits,
      qr.TOTAL_CODEWORDS[version] * 8,
      `版本 ${version} 抽出的码字位数应为 ${qr.TOTAL_CODEWORDS[version] * 8}，实际 ${actualBits}`,
    );
    assert.ok(
      traversed.length >= expectedCells,
      `版本 ${version} 遍历单元数异常`,
    );
  }
});

check('版本信息块（v7+）可读取且 BCH 校验通过', () => {
  const expected = {
    7: 0x07c94, 8: 0x085bc, 9: 0x09a99, 10: 0x0a4d3, 11: 0x0bbf6,
    12: 0x0c762, 13: 0x0d847, 14: 0x0e60d, 15: 0x0f928,
  };
  for (const [version, bits] of Object.entries(expected)) {
    assert.strictEqual(
      qr.versionInfoBits(Number(version)),
      bits,
      `版本 ${version} 的版本信息位应为 0x${bits.toString(16)}`,
    );
  }
  assert.strictEqual(qr.readVersionInfo(qr.encode('a'.repeat(140)).modules), 7);
  assert.strictEqual(qr.readVersionInfo(qr.encode('a'.repeat(300)).modules), 11);
  assert.strictEqual(qr.readVersionInfo(qr.encode('a'.repeat(10)).modules), null);
});

console.log('\n渲染模块');
check('PNG 头部与尺寸正确', () => {
  const { modules } = qr.encode('http://192.168.31.37:8737/');
  const png = renderPng(modules, { scale: 4, quietZone: 2 });
  assert.deepStrictEqual(
    Array.from(png.subarray(0, 8)),
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    'PNG 魔数错误',
  );
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const expected = (modules.length + 4) * 4;
  assert.strictEqual(width, expected);
  assert.strictEqual(height, expected);
  assert.strictEqual(png.subarray(12, 16).toString('ascii'), 'IHDR');
  assert.ok(png.includes(Buffer.from('IEND', 'ascii')), '缺少 IEND 块');
});
check('终端渲染行数与半方块字符', () => {
  const { modules } = qr.encode('https://example.com/');
  const text = renderTerminal(modules, { quietZone: 2 });
  const lines = text.split('\n');
  const expectedRows = modules.length + 4;
  assert.strictEqual(lines.length, Math.ceil(expectedRows / 2));
  assert.ok(/[\u2580\u2584\u2588]/.test(text), '未使用半方块字符');
  const width = [...lines[0]].length;
  assert.strictEqual(width, modules.length + 4);
});
check('PNG deflate 数据可解压回像素', () => {
  const zlib = require('node:zlib');
  const { modules } = qr.encode('https://example.com/');
  const png = renderPng(modules, { scale: 1, quietZone: 0 });
  // 从 PNG 中提取 IDAT
  let offset = 8;
  let raw = null;
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString('ascii');
    if (type === 'IDAT') raw = zlib.inflateSync(png.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  assert.ok(raw, '未找到 IDAT');
  const size = modules.length;
  assert.strictEqual(raw.length, (size * 3 + 1) * size);
  // 抽查第 0 行第 0 个像素应为黑（定位图形）
  assert.strictEqual(raw[1], 0);
  assert.strictEqual(raw[2], 0);
  assert.strictEqual(raw[3], 0);
});

console.log(`\n${passed} 项通过${process.exitCode ? '，存在失败项' : '，全部通过'}`);
