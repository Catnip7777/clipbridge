'use strict';
/**
 * 零依赖 QR 码编码器（字节模式，纠错等级 L，版本 1-15 自动选择）。
 * 只实现生成 URL 所需的最小功能，但严格遵循 ISO/IEC 18004 的布局与掩码规则。
 */

const EC_CODEWORDS_PER_BLOCK = {
  // version: [L]  (仅用 L 级)
  1: [7], 2: [10], 3: [15], 4: [20], 5: [26], 6: [18], 7: [20], 8: [24], 9: [30],
  10: [18], 11: [20], 12: [24], 13: [26], 14: [30], 15: [22],
};

const EC_BLOCKS = {
  1: [1], 2: [1], 3: [1], 4: [1], 5: [1], 6: [2], 7: [2], 8: [2], 9: [2],
  10: [4], 11: [4], 12: [4], 13: [4], 14: [4], 15: [6],
};

const ALIGNMENT_PATTERN_POSITIONS = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34],
  7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
  11: [6, 30, 54], 12: [6, 32, 58], 13: [6, 34, 62], 14: [6, 26, 46, 66],
  15: [6, 26, 48, 70],
};

const TOTAL_CODEWORDS = {
  1: 26, 2: 44, 3: 70, 4: 100, 5: 134, 6: 172, 7: 196, 8: 242, 9: 292,
  10: 346, 11: 404, 12: 466, 13: 532, 14: 581, 15: 655,
};

const ECC_LEVEL_L_BITS = 0b01; // 格式信息里的纠错等级编码

// ---------------------------------------------------------------- GF(256) 运算

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(function initGaloisField() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d; // 本原多项式 x^8 + x^4 + x^3 + x^2 + 1
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

function rsGeneratorPoly(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= gfMul(poly[j], 1);
      next[j + 1] ^= gfMul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

function rsEncode(data, ecCount) {
  const gen = rsGeneratorPoly(ecCount);
  const res = new Array(ecCount).fill(0);
  for (const byte of data) {
    const factor = byte ^ res[0];
    res.shift();
    res.push(0);
    for (let i = 0; i < ecCount; i++) res[i] ^= gfMul(gen[i + 1], factor);
  }
  return res;
}

// ---------------------------------------------------------------- 数据编码

function utf8Bytes(text) {
  return Array.from(Buffer.from(text, 'utf8'));
}

function pickVersion(byteLength) {
  // 字节模式：4bit 模式 + 8bit 长度（版本 1-9）或 16bit 长度（版本 10+），
  // 另需可截断的终止符与字节对齐余量；容量按"数据码字"计
  for (let version = 1; version <= 15; version++) {
    const capacityBits = dataCodewordCount(version) * 8;
    const headerBits = 4 + (version <= 9 ? 8 : 16);
    // 至少留 3bit：保证模式+长度+数据后仍有终止符（必要时截断）与对齐空间
    const neededBits = headerBits + byteLength * 8 + 3;
    if (neededBits <= capacityBits) return version;
  }
  throw new Error(`内容过长（${byteLength} 字节），二维码最多支持版本 15`);
}

/** 数据区能容纳的原始字节数（已按规范扣除模式指示符、长度字段与终止符开销）。 */
function dataCapacityBytes(version) {
  const headerBits = 4 + (version <= 9 ? 8 : 16);
  return Math.floor((dataCodewordCount(version) * 8 - headerBits - 3) / 8);
}

function dataCodewordCount(version) {
  const ecPerBlock = EC_CODEWORDS_PER_BLOCK[version][0];
  const blockCount = EC_BLOCKS[version][0];
  return TOTAL_CODEWORDS[version] - ecPerBlock * blockCount;
}

function buildCodewords(bytes, version) {
  const totalCodewords = TOTAL_CODEWORDS[version];
  const ecPerBlock = EC_CODEWORDS_PER_BLOCK[version][0];
  const blockCount = EC_BLOCKS[version][0];
  const dataCodewords = totalCodewords - ecPerBlock * blockCount;

  const bits = [];
  const push = (value, length) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };

  push(0b0100, 4); // 字节模式
  push(bytes.length, version <= 9 ? 8 : 16);
  for (const b of bytes) push(b, 8);

  const capacityBits = dataCodewords * 8;
  for (let i = 0; i < 4 && bits.length < capacityBits; i++) bits.push(0); // 终止符
  while (bits.length % 8 !== 0) bits.push(0); // 补齐到字节

  const data = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
    data.push(byte);
  }
  const padBytes = [0xec, 0x11];
  for (let i = 0; data.length < dataCodewords; i++) data.push(padBytes[i % 2]);

  // 分块 + 交错
  const shortBlockLen = Math.floor(dataCodewords / blockCount);
  const longBlockCount = dataCodewords % blockCount;
  const dataBlocks = [];
  const ecBlocks = [];
  let offset = 0;
  for (let i = 0; i < blockCount; i++) {
    const len = shortBlockLen + (i >= blockCount - longBlockCount ? 1 : 0);
    const block = data.slice(offset, offset + len);
    offset += len;
    dataBlocks.push(block);
    ecBlocks.push(rsEncode(block, ecPerBlock));
  }

  const result = [];
  const maxDataLen = Math.max(...dataBlocks.map((b) => b.length));
  for (let i = 0; i < maxDataLen; i++) {
    for (const block of dataBlocks) if (i < block.length) result.push(block[i]);
  }
  for (let i = 0; i < ecPerBlock; i++) {
    for (const block of ecBlocks) result.push(block[i]);
  }
  return result;
}

// ---------------------------------------------------------------- 矩阵构建

/** 版本信息（版本 7 及以上）：6 位版本号 + 12 位 BCH(18,6) 校验，生成多项式 0x1F25。 */
function versionInfoBits(version) {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (version << 12) | rem;
}

function createMatrix(version, options = {}) {
  const size = version * 4 + 17;
  const drawDarkModule = options.drawDarkModule !== false;
  const modules = Array.from({ length: size }, () => new Array(size).fill(false));
  const reserved = Array.from({ length: size }, () => new Array(size).fill(false));

  const setFunction = (row, col, dark) => {
    if (row < 0 || col < 0 || row >= size || col >= size) return;
    modules[row][col] = dark;
    reserved[row][col] = true;
  };

  // 定位图形（三个角）+ 分隔符
  // 注意：区域要覆盖到 row/col 8（含分隔符），否则会漏保留 9x9 角落的外圈单元
  const drawFinder = (top, left) => {
    for (let r = -1; r <= 8; r++) {
      for (let c = -1; c <= 8; c++) {
        const rr = top + r;
        const cc = left + c;
        if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
        if (r === 8 || c === 8) {
          setFunction(rr, cc, false); // 分隔符（浅色）
          continue;
        }
        const inRing =
          (c === 0 || c === 6) || (r === 0 || r === 6); // 7x7 外圈（r/c 均已限定在 0..6）
        const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        setFunction(rr, cc, inRing || inCore);
      }
    }
  };
  drawFinder(0, 0);
  drawFinder(0, size - 7);
  drawFinder(size - 7, 0);

  // 校正图形：逐格判断，与定位图形重叠的单元保持定位图形形状，其余照常绘制
  const positions = ALIGNMENT_PATTERN_POSITIONS[version];
  for (const row of positions) {
    for (const col of positions) {
      for (let r = -2; r <= 2; r++) {
        for (let c = -2; c <= 2; c++) {
          const rr = row + r;
          const cc = col + c;
          if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
          // 三个角的 9x9 区域已被定位图形/分隔符/格式信息占用
          const inCorner =
            (rr <= 8 && cc <= 8) ||
            (rr <= 8 && cc >= size - 9) ||
            (rr >= size - 9 && cc <= 8);
          if (inCorner) continue;
          const isDark = Math.max(Math.abs(r), Math.abs(c)) !== 1;
          setFunction(rr, cc, isDark);
        }
      }
    }
  }

  // 定时图形最后绘制，保证行/列 6 上的交替图案完整（与参考实现一致）
  for (let i = 8; i < size - 8; i++) {
    const dark = i % 2 === 0;
    setFunction(i, 6, dark);
    setFunction(6, i, dark);
  }

  // 预留格式信息区（坐标与 drawFormatInfo / readFormatInfo 一一对应）
  // 副本一：列 8 的行 0..5、7、8；行 8 的列 0..5、7、8
  for (let i = 0; i <= 5; i++) {
    setFunction(i, 8, false);
    setFunction(8, i, false);
  }
  setFunction(7, 8, false);
  setFunction(8, 7, false);
  setFunction(8, 8, false);
  // 副本二：行 8 的列 size-8 .. size-1；列 8 的行 size-8 .. size-1
  for (let i = 0; i < 8; i++) {
    setFunction(8, size - 8 + i, false);
    setFunction(size - 8 + i, 8, false);
  }
  // 版本信息块（版本 >= 7）：左上角外的两个 3x6 区域，共 36 个单元
  if (version >= 7) {
    const bits = versionInfoBits(version);
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) === 1;
      const a = Math.floor(i / 3);
      const b = i % 3;
      setFunction(size - 11 + b, a, dark); // 左下角副本
      setFunction(a, size - 11 + b, dark); // 右上角副本
    }
  }

  // 固定的暗模块（(size-8, 8) 上就是副本二的 bit 7 位置，规范要求它恒为深色）
  if (drawDarkModule) setFunction(size - 8, 8, true);

  return { size, modules, reserved, setFunction };
}

function placeData(matrix, codewords) {
  const { size, modules, reserved } = matrix;
  let bitIndex = 0;
  const totalBits = codewords.length * 8;
  const nextBit = () => {
    if (bitIndex >= totalBits) return 0; // 剩余位按 0 填充
    const byte = codewords[bitIndex >> 3];
    const bit = (byte >>> (7 - (bitIndex & 7))) & 1;
    bitIndex++;
    return bit;
  };

  let upward = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col = 5; // 跳过定时图形列
    for (let i = 0; i < size; i++) {
      const row = upward ? size - 1 - i : i;
      for (const c of [col, col - 1]) {
        if (reserved[row][c]) continue;
        modules[row][c] = nextBit() === 1;
      }
    }
    upward = !upward;
  }
}

function maskCondition(maskId, r, c) {
  switch (maskId) {
    case 0: return (r + c) % 2 === 0;
    case 1: return r % 2 === 0;
    case 2: return c % 3 === 0;
    case 3: return (r + c) % 3 === 0;
    case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
    case 5: return ((r * c) % 2) + ((r * c) % 3) === 0;
    case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
    case 7: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
    default: return false;
  }
}

function applyMask(modules, reserved, maskId) {
  const size = modules.length;
  const masked = modules.map((row) => row.slice());
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (reserved[r][c]) continue;
      if (maskCondition(maskId, r, c)) masked[r][c] = !masked[r][c];
    }
  }
  return masked;
}

/** 从格式信息区读出纠错等级与掩码号（并对 BCH 校验位做一次校验）。 */
function readFormatInfo(modules) {
  const size = modules.length;
  let bits = 0;
  for (let i = 0; i <= 5; i++) bits |= (modules[i][8] ? 1 : 0) << i;
  bits |= (modules[7][8] ? 1 : 0) << 6;
  bits |= (modules[8][8] ? 1 : 0) << 7;
  bits |= (modules[8][7] ? 1 : 0) << 8;
  for (let i = 9; i <= 14; i++) bits |= (modules[8][14 - i] ? 1 : 0) << i;

  const unmasked = bits ^ 0x5412;
  let rem = unmasked;
  for (let i = 14; i >= 10; i--) if ((rem >>> i) & 1) rem ^= 0x537 << (i - 10);
  if (rem !== 0) throw new Error('格式信息校验失败');

  // 交叉校验另一份副本：左下竖条 i=0..6（i=7 位置是固定暗模块，不参与比对）+ 右上横条 i=8..14
  let mirror = 0;
  for (let i = 0; i <= 6; i++) mirror |= (modules[size - 1 - i][8] ? 1 : 0) << i;
  for (let i = 8; i <= 14; i++) mirror |= (modules[8][size - 8 + (i - 8)] ? 1 : 0) << i;
  const comparableMask = 0b111111101111111; // 跳过 bit 7
  if ((mirror & comparableMask) !== (bits & comparableMask)) {
    throw new Error('格式信息两份副本不一致');
  }
  if (!modules[size - 8][8]) throw new Error('固定暗模块缺失');

  const data = unmasked >>> 10;
  return { ecLevelBits: (data >>> 3) & 0b11, maskId: data & 0b111 };
}

/** 读取并校验版本信息块（版本 < 7 时返回 null）。 */
function readVersionInfo(modules) {
  const size = modules.length;
  const version = (size - 17) / 4;
  if (version < 7) return null;
  let bits = 0;
  for (let i = 0; i < 18; i++) {
    const a = Math.floor(i / 3);
    const b = i % 3;
    bits |= (modules[size - 11 + b][a] ? 1 : 0) << i;
  }
  let mirror = 0;
  for (let i = 0; i < 18; i++) {
    const a = Math.floor(i / 3);
    const b = i % 3;
    mirror |= (modules[a][size - 11 + b] ? 1 : 0) << i;
  }
  if (bits !== mirror) throw new Error('版本信息两份副本不一致');
  // BCH(18,6) 校验：整串对生成多项式取余应为 0
  let rem = bits;
  for (let i = 17; i >= 12; i--) if ((rem >>> i) & 1) rem ^= 0x1f25 << (i - 12);
  if (rem !== 0) throw new Error('版本信息校验失败');
  const decoded = bits >>> 12;
  if (decoded !== version) throw new Error(`版本信息与尺寸不符: ${decoded} != ${version}`);
  return decoded;
}

/** 返回去掉掩码后的矩阵（只翻转数据区，功能图形保持原样）。 */
function unmask(modules, maskId) {
  const version = (modules.length - 17) / 4;
  const reserved = createMatrix(version, { drawDarkModule: false }).reserved;
  return applyMask(modules, reserved, maskId);
}

function drawFormatInfo(modules, maskId) {
  const size = modules.length;
  const data = (ECC_LEVEL_L_BITS << 3) | maskId;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;

  const bit = (i) => ((bits >>> i) & 1) === 1;
  // 副本一（左上）：列 8 的行 0..5、7、8；行 8 的列 0..5、7、8
  for (let i = 0; i <= 5; i++) modules[i][8] = bit(i);
  modules[7][8] = bit(6);
  modules[8][8] = bit(7);
  modules[8][7] = bit(8);
  for (let i = 9; i <= 14; i++) modules[8][14 - i] = bit(i);
  // 副本二：左下竖条（i=0..7 → 行 size-1..size-8）+ 右上横条（i=8..14 → 列 size-8..size-2）
  for (let i = 0; i <= 7; i++) modules[size - 1 - i][8] = bit(i);
  for (let i = 8; i <= 14; i++) modules[8][size - 8 + (i - 8)] = bit(i);
  modules[size - 8][8] = true; // 固定暗模块
  return modules;
}

function penaltyScore(modules) {
  const size = modules.length;
  let score = 0;

  // 规则 1：连续同色 5 个以上
  const runScore = (line) => {
    let total = 0;
    let runLength = 1;
    for (let i = 1; i < line.length; i++) {
      if (line[i] === line[i - 1]) {
        runLength++;
        if (runLength === 5) total += 3;
        else if (runLength > 5) total += 1;
      } else {
        runLength = 1;
      }
    }
    return total;
  };
  for (let r = 0; r < size; r++) score += runScore(modules[r]);
  for (let c = 0; c < size; c++) score += runScore(modules.map((row) => row[c]));

  // 规则 2：2x2 同色块
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = modules[r][c];
      if (v === modules[r][c + 1] && v === modules[r + 1][c] && v === modules[r + 1][c + 1]) {
        score += 3;
      }
    }
  }

  // 规则 3：出现 1:1:3:1:1 类似的定位图形特征
  const patternA = [true, false, true, true, true, false, true, false, false, false, false];
  const patternB = [false, false, false, false, true, false, true, true, true, false, true];
  const matches = (line, start, pattern) => {
    for (let i = 0; i < pattern.length; i++) if (line[start + i] !== pattern[i]) return false;
    return true;
  };
  const lines = [];
  for (let r = 0; r < size; r++) lines.push(modules[r]);
  for (let c = 0; c < size; c++) lines.push(modules.map((row) => row[c]));
  for (const line of lines) {
    for (let i = 0; i + 11 <= line.length; i++) {
      if (matches(line, i, patternA) || matches(line, i, patternB)) score += 40;
    }
  }

  // 规则 4：暗模块比例偏离 50%
  let dark = 0;
  for (const row of modules) for (const v of row) if (v) dark++;
  const ratio = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(ratio - 50) / 5) * 10;
  return score;
}

/**
 * 生成二维码矩阵（布尔二维数组，true = 黑）。
 * @param {string} text
 * @returns {{ size: number, modules: boolean[][], version: number }}
 */
function encode(text) {
  const bytes = utf8Bytes(text);
  const version = pickVersion(bytes.length);
  const codewords = buildCodewords(bytes, version);
  const base = createMatrix(version);
  placeData(base, codewords);

  let best = null;
  for (let maskId = 0; maskId < 8; maskId++) {
    const masked = drawFormatInfo(applyMask(base.modules, base.reserved, maskId), maskId);
    const score = penaltyScore(masked);
    if (!best || score < best.score) best = { score, modules: masked };
  }
  return { size: base.size, modules: best.modules, version };
}

/** 供测试或高级用法：从矩阵反读码字（不做纠错），校验数据区布局是否正确。 */
function extractCodewords(modules) {
  const size = modules.length;
  const version = (size - 17) / 4;
  const reserved = createMatrix(version).reserved;
  const bits = [];
  let upward = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col = 5;
    for (let i = 0; i < size; i++) {
      const row = upward ? size - 1 - i : i;
      for (const c of [col, col - 1]) {
        if (reserved[row][c]) continue;
        bits.push(modules[row][c] ? 1 : 0);
      }
    }
    upward = !upward;
  }
  const codewords = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
    codewords.push(byte);
  }
  return codewords;
}

/** 反解数据码字（用于自测：验证编码 -> 矩阵 -> 解码能还原原文）。 */
function decodeDataCodewords(codewords, version) {
  const ecPerBlock = EC_CODEWORDS_PER_BLOCK[version][0];
  const blockCount = EC_BLOCKS[version][0];
  const totalCodewords = TOTAL_CODEWORDS[version];
  const dataCodewords = totalCodewords - ecPerBlock * blockCount;
  const shortBlockLen = Math.floor(dataCodewords / blockCount);
  const longBlockCount = dataCodewords % blockCount;
  const blockLengths = [];
  for (let i = 0; i < blockCount; i++) {
    blockLengths.push(shortBlockLen + (i >= blockCount - longBlockCount ? 1 : 0));
  }
  const blocks = blockLengths.map(() => []);
  let index = 0;
  for (let i = 0; i < Math.max(...blockLengths); i++) {
    for (let b = 0; b < blockCount; b++) {
      if (i < blockLengths[b]) blocks[b].push(codewords[index++]);
    }
  }
  return blocks.flat();
}

module.exports = {
  encode,
  extractCodewords,
  decodeDataCodewords,
  readFormatInfo,
  readVersionInfo,
  versionInfoBits,
  unmask,
  maskCondition,
  pickVersion,
  dataCapacityBytes,
  dataCodewordCount,
  EC_CODEWORDS_PER_BLOCK,
  EC_BLOCKS,
  TOTAL_CODEWORDS,
  ALIGNMENT_PATTERN_POSITIONS,
};
