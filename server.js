'use strict';
/** 文本剪贴板桥：手机 <-> 电脑 通过浏览器同步文本与图片，零第三方依赖。 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const VERSION = '1.2.0';
const ROOT = __dirname;
const MAX_BYTES = 512 * 1024; // 单条文本上限
const MAX_IMAGE_BYTES = 12 * 1024 * 1024; // 单张图片上限
const MAX_IMAGES = 12; // 图片区最多保留几张（全部保留，超出才丢最早的）
const MAX_IMAGE_TOTAL_BYTES = 48 * 1024 * 1024; // 图片总内存上限
// 文件区不设大小/数量限制：只受机器内存约束
const MAX_FILE_BYTES = Infinity; // 单个文件上限（不限制）
const MAX_FILES = Infinity; // 文件区最多保留几个（不限制）
const MAX_FILE_TOTAL_BYTES = Infinity; // 文件总内存上限（不限制）
const DEFAULT_PORT = 8737;

// ---------------------------------------------------------------- 命令行参数

function parseArgs(argv) {
  const options = {
    port: DEFAULT_PORT,
    host: null,
    token: null,
    store: null,
    open: false,
    quiet: false,
    help: false,
    mode: 'serve',
    text: null,
  };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`参数 ${arg} 缺少取值`);
      return value;
    };
    switch (arg) {
      case '-p': case '--port': options.port = Number(next()); break;
      case '--host': options.host = next(); break;
      case '--token': options.token = next(); break;
      case '--store': options.store = next(); break;
      case '--open': options.open = true; break;
      case '-q': case '--quiet': options.quiet = true; break;
      case '-h': case '--help': options.help = true; break;
      case '--no-qr': options.qr = false; break;
      case 'send': options.mode = 'send'; break;
      case 'pull': options.mode = 'pull'; break;
      case 'clip': options.mode = 'clip'; break;
      case '--': rest.push(...argv.slice(i + 1)); i = argv.length; break;
      default:
        if (arg.startsWith('-')) throw new Error(`未知参数: ${arg}`);
        rest.push(arg);
    }
  }
  if (options.qr === undefined) options.qr = true;
  if (options.mode === 'send') options.text = rest.join(' ');
  return options;
}

const HELP = `ClipBridge ${VERSION} — 手机和电脑之间同步文本与图片

推荐用法（会自动体检环境、挑端口）:
  node start.js                启动网页服务
  node start.js --check        只体检，不启动
  node start.js --test         体检 + 跑自测
  Windows 上也可以直接双击「启动.cmd」

直接用本文件启动（跳过体检）:
  node server.js [选项]              启动网页服务（默认）
  node server.js send <文本>         把文本推送到共享文本区（手机端立刻可见）
  node server.js send -              从标准输入读取文本再推送
  node server.js pull                把文本写入电脑剪贴板（仅在你显式调用时）
  node server.js clip                监听本机剪贴板，变化即同步（Ctrl+C 退出）

选项:
  -p, --port <端口>    监听端口（默认 ${DEFAULT_PORT}）
      --host <地址>    监听地址（默认 0.0.0.0，即局域网可访问）
      --token <令牌>   访问口令，URL 形如 http://ip:端口/?k=令牌
      --store <路径>   状态文件（默认 ./data/clipboard.json，仅存文本）
      --no-qr          不打印二维码
      --open           启动后用默认浏览器打开本机页面
  -q, --quiet          安静模式
  -h, --help           显示帮助

图片与文件:
  文本区 / 图片区 / 文件区三块彼此独立，互不影响（拖入时图片自动进图片区、其余进文件区）。
  「选择图片」/「选择文件」可多选上传，全部保留、绝不覆盖前面的；电脑上点「下载」即存到下载目录。
  服务的默认行为不碰系统剪贴板（只有显式运行 clip / pull 才会）。
  内容只存在内存中，服务重启即清空。

提示: 手机与电脑连同一个 Wi-Fi，用手机相机扫终端里的二维码即可打开。`;

// ---------------------------------------------------------------- 工具函数

function getLanAddresses() {
  const result = [];
  for (const [name, entries] of Object.entries(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      // 排除虚拟机网卡，优先真实无线/有线网卡
      const virtual = /vmware|virtualbox|hyper-v|vethernet|loopback|bluetooth|docker|wsl/i.test(name);
      result.push({ name, address: entry.address, virtual });
    }
  }
  result.sort((a, b) => Number(a.virtual) - Number(b.virtual));
  return result;
}

function pickPrimaryAddress() {
  return getLanAddresses()[0]?.address ?? '127.0.0.1';
}

function safeStoragePath(custom) {
  if (!custom) return path.join(ROOT, 'data', 'clipboard.json');
  return path.isAbsolute(custom) ? custom : path.join(process.cwd(), custom);
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/** 从文件头判断图片类型，不信任客户端声明的 content-type。 */
function detectImageType(buffer) {
  if (buffer.length < 12) return null;
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return { type: 'png', mime: 'image/png', ext: '.png' };
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { type: 'jpeg', mime: 'image/jpeg', ext: '.jpg' };
  }
  if (buffer.subarray(0, 6).toString('ascii').match(/^GIF8[79]a$/)) {
    return { type: 'gif', mime: 'image/gif', ext: '.gif' };
  }
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return { type: 'webp', mime: 'image/webp', ext: '.webp' };
  }
  if (buffer[0] === 0x42 && buffer[1] === 0x4d) {
    return { type: 'bmp', mime: 'image/bmp', ext: '.bmp' };
  }
  return null;
}

/** 解析 PNG 尺寸（仅用于展示，失败返回 null）。 */
function pngSize(buffer) {
  if (buffer.length < 24) return null;
  if (buffer.subarray(0, 8).toString('binary') !== '\x89PNG\r\n\x1a\n') return null;
  if (buffer.subarray(12, 16).toString('ascii') !== 'IHDR') return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function isImageExtension(file) {
  return ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp'].includes(path.extname(file).toLowerCase());
}

// ---------------------------------------------------------------- 系统剪贴板桥

const isWindows = process.platform === 'win32';
const isMac = process.platform === 'darwin';
const PS_HELPER = path.join(ROOT, 'lib', 'clipboard-image.ps1');

function runCommand(command, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} 退出码 ${code}: ${stderr.trim() || stdout.trim()}`));
    });
    child.stdin.end(input);
  });
}

function runPowerShell(script, input) {
  return runCommand('powershell', [
    '-NoProfile', '-STA', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script,
  ], input);
}

/** 旧的纯文本读取（不依赖 WinForms，作为兜底）。 */
async function readClipboardText() {
  try {
    if (isWindows) {
      const out = await runPowerShell('Get-Clipboard -Raw -Format Text');
      return out.replace(/\r\n/g, '\n').replace(/\n$/, '');
    }
    if (isMac) return await runCommand('pbpaste', []);
    return await runCommand('xclip', ['-selection', 'clipboard', '-o']);
  } catch {
    return null;
  }
}

/** 把文本写入系统剪贴板；成功返回 true。 */
async function writeClipboardText(text) {
  try {
    if (isWindows) {
      // 用 Base64 传递，避免中文/引号/换行在命令行里被曲解
      const encoded = Buffer.from(text, 'utf8').toString('base64');
      const script =
        "$b=[Convert]::FromBase64String('" + encoded + "');" +
        'Set-Clipboard -Value ([Text.Encoding]::UTF8.GetString($b))';
      await runPowerShell(script);
      return true;
    }
    if (isMac) {
      await runCommand('pbcopy', [], text);
      return true;
    }
    await runCommand('xclip', ['-selection', 'clipboard', '-i'], text);
    return true;
  } catch {
    return false;
  }
}

/**
 * 读取系统剪贴板内容。
 * @returns {Promise<
 *   {kind:'text', text:string} |
 *   {kind:'files', paths:string[]} |
 *   {kind:'image', buffer:Buffer, mime:string} |
 *   {kind:'empty'} | {kind:'error', message:string}
 * >}
 */
async function readClipboard() {
  if (isWindows) {
    try {
      const out = await runPowerShell(`& '${PS_HELPER}' -Mode read`);
      const start = out.indexOf('{');
      const parsed = JSON.parse(start >= 0 ? out.slice(start) : out);
      if (parsed.kind === 'files') return { kind: 'files', paths: parsed.paths || [] };
      if (parsed.kind === 'image') {
        return { kind: 'image', buffer: Buffer.from(parsed.pngBase64 || '', 'base64'), mime: 'image/png' };
      }
      if (parsed.kind === 'text') return { kind: 'text', text: parsed.text || '' };
      if (parsed.kind === 'error') return { kind: 'error', message: parsed.message || '读取剪贴板失败' };
      return { kind: 'empty' };
    } catch (error) {
      // PowerShell 不可用时退回纯文本读取
      const text = await readClipboardText();
      if (text === null) return { kind: 'error', message: error.message };
      return text === '' ? { kind: 'empty' } : { kind: 'text', text };
    }
  }
  try {
    if (isMac) {
      const text = await runCommand('pbpaste', []);
      return text === '' ? { kind: 'empty' } : { kind: 'text', text };
    }
    const text = await runCommand('xclip', ['-selection', 'clipboard', '-o']);
    return text === '' ? { kind: 'empty' } : { kind: 'text', text };
  } catch {
    return { kind: 'empty' };
  }
}

/** 把 PNG 图片写入系统剪贴板（Windows）；成功返回 true。 */
async function writeClipboardImage(pngBuffer) {
  if (!isWindows) return false;
  try {
    const out = await runPowerShell(`& '${PS_HELPER}' -Mode write`, pngBuffer.toString('base64'));
    return out.trim().startsWith('ok');
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- 内容仓库

/** 内存中的共享内容仓库：文本 + 图片，全部随进程退出而消失。 */
class ClipStore {
  constructor(file, onChange) {
    this.file = file;
    this.onChange = onChange;
    this.items = [];
    this.version = 0;
    this.updatedAt = null;
    this.source = null;
    this.queue = Promise.resolve();
    this.counter = 0;
    this.load();
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.version = Number(parsed.version) || 0;
      if (typeof parsed.text === 'string' && parsed.text) {
        this.items.push({
          id: `t${this.version || 1}`,
          kind: 'text',
          text: parsed.text,
          bytes: Buffer.byteLength(parsed.text, 'utf8'),
          source: parsed.source || null,
          at: parsed.updatedAt || new Date().toISOString(),
        });
      }
    } catch {
      // 首次运行或文件损坏：以空内容启动
    }
  }

  schedulePersist() {
    const lastText = this.lastTextItem();
    this.queue = this.queue
      .then(async () => {
        await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
        await fs.promises.writeFile(this.file, JSON.stringify({
          text: lastText ? lastText.text : '',
          version: this.version,
          updatedAt: this.updatedAt,
          source: this.source,
        }, null, 2), 'utf8');
      })
      .catch(() => {});
    return this.queue;
  }

  lastTextItem() {
    for (let i = this.items.length - 1; i >= 0; i--) if (this.items[i].kind === 'text') return this.items[i];
    return null;
  }

  /** 是否存在与给定内容重复的条目（避免同一张图/同一段文字反复堆积）。 */
  hasDuplicate(item) {
    return this.items.some((existing) => {
      if (existing.kind !== item.kind) return false;
      if (existing.kind === 'text') return existing.text === item.text;
      return existing.hash === item.hash;
    });
  }

  /** 内容摘要，供客户端判断是否需要更新（不含图片/文件二进制）。 */
  snapshot(payloads) {
    const lastText = this.lastTextItem();
    return {
      version: this.version,
      updatedAt: this.updatedAt,
      source: this.source,
      text: lastText ? lastText.text : '',
      items: this.items.map((item) => {
        if (item.kind === 'image') {
          return {
            id: item.id,
            kind: 'image',
            hash: item.hash,
            name: item.name,
            mime: item.mime,
            bytes: item.bytes,
            width: item.width ?? null,
            height: item.height ?? null,
            paths: item.paths || [],
            url: `/api/image/${item.hash}`,
            phone: Boolean(item.phone),
            at: item.at,
            source: item.source,
          };
        }
        if (item.kind === 'file') {
          return {
            id: item.id,
            kind: 'file',
            hash: item.hash,
            name: item.name,
            mime: item.mime,
            bytes: item.bytes,
            ext: path.extname(item.name || '').replace('.', '').toLowerCase(),
            url: `/api/file/${item.hash}`,
            downloadUrl: `/api/file/${item.hash}?download=1`,
            at: item.at,
            source: item.source,
          };
        }
        return {
          id: item.id,
          kind: 'text',
          text: item.text,
          bytes: item.bytes,
          at: item.at,
          source: item.source,
        };
      }),
    };
  }

  nextId() {
    this.counter += 1;
    return `i${this.counter}`;
  }

  /** 追加文本条目；与已有文本重复则不新增（避免同步风暴）。 */
  addText(text, source) {
    const normalized = text.replace(/\r\n/g, '\n');
    const item = {
      id: this.nextId(),
      kind: 'text',
      text: normalized,
      bytes: Buffer.byteLength(normalized, 'utf8'),
      source: source || null,
      at: new Date().toISOString(),
    };
    if (this.hasDuplicate(item)) return { changed: false, duplicate: true, item };
    this.push(item);
    return { changed: true, item };
  }

  /**
   * 手动同步 / 自动发送用的语义：只更新"当前文本"。
   * 文本与图片互不影响：这里绝不触碰图片条目；文本也只保留一条。
   */
  updateCurrentText(text, source) {
    const normalized = text.replace(/\r\n/g, '\n');
    const texts = this.items.filter((item) => item.kind === 'text');
    const target = texts[texts.length - 1] || null;
    if (texts.length > 1) this.items = this.items.filter((item) => item.kind !== 'text' || item === target);
    if (target) {
      if (target.text === normalized) return { changed: false, duplicate: true, item: target };
      target.text = normalized;
      target.bytes = Buffer.byteLength(normalized, 'utf8');
      target.source = source || null;
      target.at = new Date().toISOString();
      this.bumpVersion(target);
      return { changed: true, item: target };
    }
    return this.addText(text, source);
  }

  /**
   * 追加图片条目：图片全部保留（不覆盖前面的）。
   * 同一张图重复上传只更新元数据；超过张数/容量上限时丢弃最早的那张。
   * @returns {{changed:boolean, duplicate:boolean, item:object, dropped:string[]}}
   */
  addImage({ buffer, hash, name, mime, phone, paths, source }) {
    const item = {
      id: this.nextId(),
      kind: 'image',
      hash,
      name: name || `image-${hash.slice(0, 8)}`,
      mime,
      bytes: buffer.length,
      width: pngSize(buffer)?.width ?? null,
      height: pngSize(buffer)?.height ?? null,
      phone: Boolean(phone),
      paths: paths || [],
      source: source || null,
      at: new Date().toISOString(),
    };
    // 同一张图重复上传：只更新路径等元数据，版本不动
    const existing = this.items.find((entry) => entry.kind === 'image' && entry.hash === hash);
    if (existing) {
      if (item.paths.length) existing.paths = item.paths;
      return { changed: false, duplicate: true, item: existing, dropped: [] };
    }
    this.push(item);
    return { changed: true, item, duplicate: false, dropped: this.trimImages() };
  }

  /**
   * 追加普通文件条目：与图片区逻辑一致 —— 文件全部保留（不覆盖前面的）、
   * 同一文件重复上传只更新元数据、超过数量/容量上限时丢弃最早的。
   * 与文本区、图片区互不影响。
   * @returns {{changed:boolean, duplicate:boolean, item:object, dropped:string[]}}
   */
  addFile({ buffer, hash, name, mime, source }) {
    const item = {
      id: this.nextId(),
      kind: 'file',
      hash,
      name: name || `file-${hash.slice(0, 8)}`,
      mime: mime || 'application/octet-stream',
      bytes: buffer.length,
      source: source || null,
      at: new Date().toISOString(),
    };
    const existing = this.items.find((entry) => entry.kind === 'file' && entry.hash === hash);
    if (existing) return { changed: false, duplicate: true, item: existing, dropped: [] };
    this.push(item);
    return { changed: true, item, duplicate: false, dropped: this.trimFiles() };
  }

  /**
   * 文件区不设上限：全部保留，永远不丢（上限为 Infinity 时这里直接返回空数组）。
   * 保留这个函数是为了让 addFile 的返回结构统一，将来想加限制也能一处改回。
   */
  trimFiles() {
    const dropped = [];
    if (!Number.isFinite(MAX_FILES) && !Number.isFinite(MAX_FILE_TOTAL_BYTES)) return dropped;
    const files = this.items.filter((entry) => entry.kind === 'file');
    let total = files.reduce((sum, entry) => sum + entry.bytes, 0);
    while (files.length - dropped.length > MAX_FILES
      || (total > MAX_FILE_TOTAL_BYTES && files.length - dropped.length > 1)) {
      const oldest = files.find((entry) => !dropped.includes(entry.hash));
      if (!oldest) break;
      dropped.push(oldest.hash);
      total -= oldest.bytes;
    }
    if (dropped.length) {
      this.items = this.items.filter((entry) => entry.kind !== 'file' || !dropped.includes(entry.hash));
    }
    return dropped;
  }

  /** 图片数量/总容量超限时，丢掉最早的几张，并返回其哈希（供释放二进制）。 */
  trimImages() {
    const images = this.items.filter((entry) => entry.kind === 'image');
    let total = images.reduce((sum, entry) => sum + entry.bytes, 0);
    const dropped = [];
    while (images.length - dropped.length > MAX_IMAGES
      || (total > MAX_IMAGE_TOTAL_BYTES && images.length - dropped.length > 1)) {
      const oldest = images.find((entry) => !dropped.includes(entry.hash));
      if (!oldest) break;
      dropped.push(oldest.hash);
      total -= oldest.bytes;
    }
    if (dropped.length) {
      this.items = this.items.filter((entry) => entry.kind !== 'image' || !dropped.includes(entry.hash));
    }
    return dropped;
  }

  push(item) {
    this.items.push(item);
    this.bumpVersion(item);
  }

  bumpVersion(item) {
    this.version += 1;
    this.updatedAt = item.at;
    this.source = item.source;
    this.schedulePersist();
    try {
      this.onChange?.({ ...this.snapshot(new Map()), changed: true, item });
    } catch {
      // 监听器出错不影响主流程
    }
  }

  clear(source) {
    if (this.items.length === 0) return { changed: false };
    this.items = [];
    this.version += 1;
    this.updatedAt = new Date().toISOString();
    this.source = source || null;
    this.schedulePersist();
    return { changed: true };
  }

  remove(id) {
    const index = this.items.findIndex((item) => item.id === id);
    if (index < 0) return { changed: false };
    const [removed] = this.items.splice(index, 1);
    this.version += 1;
    this.updatedAt = new Date().toISOString();
    this.schedulePersist();
    return { changed: true, item: removed };
  }

  lastImage() {
    for (let i = this.items.length - 1; i >= 0; i--) if (this.items[i].kind === 'image') return this.items[i];
    return null;
  }

  async flush() {
    await this.queue;
  }
}

/** 二进制仓库基类：按内容哈希在内存中保存，可整体或逐条释放。 */
class BlobBank {
  constructor(maxBytes) {
    this.map = new Map();
    this.order = [];
    this.bytes = 0;
    this.maxBytes = maxBytes;
  }

  put(entry) {
    const existing = this.map.get(entry.hash);
    if (existing) {
      if (entry.paths?.length) existing.paths = entry.paths;
      if (entry.phone) existing.phone = true;
      return existing;
    }
    this.map.set(entry.hash, entry);
    this.order.push(entry.hash);
    this.bytes += entry.buffer.length;
    return entry;
  }

  /** 释放指定条目的二进制；不传则清空全部。 */
  drop(hashes) {
    const list = hashes === undefined ? [...this.map.keys()] : hashes;
    for (const hash of list) {
      const entry = this.map.get(hash);
      if (!entry) continue;
      this.bytes -= entry.buffer.length;
      this.map.delete(hash);
      this.order = this.order.filter((item) => item !== hash);
    }
  }

  get(hash) {
    return this.map.get(hash) || null;
  }

  toBuffersMap() {
    const result = new Map();
    for (const [hash, entry] of this.map) result.set(hash, entry.buffer);
    return result;
  }

  clear() {
    this.map.clear();
    this.order = [];
    this.bytes = 0;
  }
}

/** 图片二进制仓库：支持多张，仅在内存中。 */
class ImageBank extends BlobBank {
  constructor(maxBytes = MAX_IMAGE_TOTAL_BYTES) {
    super(maxBytes);
  }
}

/** 普通文件二进制仓库：支持多个，仅在内存中。 */
class FileBank extends BlobBank {
  constructor(maxBytes = MAX_FILE_TOTAL_BYTES) {
    super(maxBytes);
  }
}

// ---------------------------------------------------------------- HTTP 服务

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

/** 读取请求体。maxBytes 传 Infinity 表示不限制大小（文件区就是这样）。 */
function readBody(req, maxBytes = MAX_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        // 继续读完请求体，避免直接断开连接导致客户端拿不到 413 响应
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      if (!tooLarge) chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) {
        reject(Object.assign(new Error('内容过大'), { statusCode: 413 }));
        return;
      }
      resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function createServer(options) {
  const bank = new ImageBank();
  const files = new FileBank();
  const clients = new Set();
  let store;
  // 说明：服务不会自动读写你的系统剪贴板。
  // 只有 CLI 子命令（clip / pull）在你明确调用时才会碰剪贴板。

  const log = (...args) => { if (!options.quiet) console.log(...args); };

  const summarize = () => store.snapshot(bank.toBuffersMap());

  store = new ClipStore(safeStoragePath(options.store));

  const broadcast = (event, data) => {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) {
      try { res.write(payload); } catch { clients.delete(res); }
    }
  };

  const publish = (extra = {}) => {
    const state = summarize();
    broadcast('update', { ...state, ...extra });
    return state;
  };

  /** 读取电脑剪贴板内容（供 CLI 的 clip / pull 子命令复用）。 */
  const readClipboardContent = () => readClipboard();

  /** 读取电脑剪贴板并作为新条目入库（只在 CLI 子命令里显式调用）。 */
  const importFromClipboard = async (source) => {
    const clip = await readClipboard();
    if (clip.kind === 'empty') return { ok: true, kind: 'empty', changed: false };
    if (clip.kind === 'error') return { ok: false, error: clip.message || '无法读取系统剪贴板' };
    if (clip.kind === 'text') {
      const result = store.updateCurrentText(clip.text, source || 'pc-clipboard');
      if (result.changed) publish({ reason: 'pull' });
      return { ok: true, kind: 'text', changed: result.changed, text: clip.text };
    }
    if (clip.kind === 'files') {
      const paths = clip.paths.filter((file) => fs.existsSync(file));
      const images = paths.filter(isImageExtension);
      if (images.length === 0) {
        const text = paths.join('\n');
        const result = store.updateCurrentText(text, source || 'pc-clipboard');
        if (result.changed) publish({ reason: 'pull' });
        return { ok: true, kind: 'text', changed: result.changed, text };
      }
      const results = [];
      for (const file of images) {
        let buffer;
        try {
          buffer = await fs.promises.readFile(file);
        } catch {
          continue;
        }
        if (buffer.length === 0 || buffer.length > MAX_IMAGE_BYTES) continue;
        const type = detectImageType(buffer) || { mime: 'image/png' };
        const hash = sha256(buffer);
        bank.put({ hash, buffer, mime: type.mime, name: path.basename(file), phone: false, at: Date.now() });
        results.push(store.addImage({
          buffer,
          hash,
          name: path.basename(file),
          mime: type.mime,
          paths: [file],
          source: source || 'pc-clipboard',
        }));
      }
      const changed = results.some((result) => result.changed);
      if (changed) publish({ reason: 'pull' });
      return { ok: true, kind: 'image', changed, count: results.length, paths: images };
    }
    if (clip.kind === 'image') {
      if (!clip.buffer.length || clip.buffer.length > MAX_IMAGE_BYTES) {
        return { ok: false, error: '剪贴板图片过大或为空' };
      }
      const hash = sha256(clip.buffer);
      const name = `clipboard-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
      bank.put({ hash, buffer: clip.buffer, mime: 'image/png', name, phone: false, at: Date.now() });
      const result = store.addImage({
        buffer: clip.buffer, hash, name, mime: 'image/png', source: source || 'pc-clipboard',
      });
      if (result.changed) publish({ reason: 'pull' });
      return { ok: true, kind: 'image', changed: result.changed };
    }
    return { ok: false, error: '未知的剪贴板内容' };
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = decodeURIComponent(url.pathname);

    // 口令校验（静态资源与 API 都需要）
    if (options.token) {
      const provided = url.searchParams.get('k') || req.headers['x-clip-token'];
      if (provided !== options.token) {
        if (pathname === '/' || pathname === '/index.html') {
          res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' });
          res.end('<meta charset="utf-8"><h3>需要访问口令</h3><p>请在网址后加上 <code>?k=你的令牌</code></p>');
          return;
        }
        json(res, 401, { error: '口令无效' });
        return;
      }
    }

    try {
      if (pathname === '/' || pathname === '/index.html') {
        const html = await fs.promises.readFile(path.join(ROOT, 'public', 'index.html'));
        res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' });
        res.end(html);
        return;
      }

      // ---------------- 状态

      if (pathname === '/api/text' || pathname === '/api/state') {
        if (req.method === 'GET') {
          const since = Number(url.searchParams.get('since'));
          const state = summarize();
          if (Number.isFinite(since) && since === state.version) {
            json(res, 200, { ...state, unchanged: true });
          } else {
            json(res, 200, state);
          }
          return;
        }
        if (req.method === 'POST' || req.method === 'PUT') {
          const raw = await readBody(req);
          let text = raw.toString('utf8');
          let source = 'web';
          let setClipboard = true;
          let replace = false;
          let replaceText = false;
          if ((req.headers['content-type'] || '').includes('application/json')) {
            let parsed;
            try {
              parsed = JSON.parse(text || '{}');
            } catch {
              json(res, 400, { error: 'JSON 解析失败' });
              return;
            }
            text = typeof parsed.text === 'string' ? parsed.text : '';
            source = typeof parsed.source === 'string' ? parsed.source : 'web';
            if (parsed.setClipboard === false) setClipboard = false;
            replace = parsed.replace === true;
            replaceText = parsed.replaceText === true;
          }
          if (typeof text !== 'string') {
            json(res, 400, { error: 'text 必须是字符串' });
            return;
          }
          if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) {
            json(res, 413, { error: '内容过大' });
            return;
          }
          let added;
          if (replaceText) {
            // 手动同步 / 自动发送：只更新文本区，图片区完全不受影响
            added = store.updateCurrentText(text, source);
          } else {
            if (replace) {
              store.clear(source);
              bank.clear();
            }
            added = store.addText(text, source);
          }
          const state = summarize();
          if (added.changed) broadcast('update', state);
          // 注意：不写系统剪贴板（用户明确要求不自动改动剪贴板）
          void setClipboard;
          json(res, 200, {
            ok: true,
            changed: added.changed,
            duplicate: Boolean(added.duplicate),
            version: state.version,
            text: state.text,
            item: added.item,
          });
          return;
        }
        res.writeHead(405, { allow: 'GET, POST' });
        res.end();
        return;
      }

      if (pathname === '/api/items/clear' && req.method === 'POST') {
        const result = store.clear('web');
        bank.clear(); // 连同图片/文件二进制一起释放
        files.clear();
        if (result.changed) publish({ reason: 'clear' });
        json(res, 200, { ok: true, ...result });
        return;
      }

      if (pathname.startsWith('/api/items/') && req.method === 'DELETE') {
        const id = pathname.slice('/api/items/'.length);
        const result = store.remove(id);
        if (result.changed) {
          if (result.item && result.item.kind === 'image') bank.drop([result.item.hash]);
          if (result.item && result.item.kind === 'file') files.drop([result.item.hash]);
          publish({ reason: 'remove' });
        }
        json(res, 200, { ok: true, ...result });
        return;
      }

      // ---------------- 图片

      if (pathname === '/api/image' && (req.method === 'POST' || req.method === 'PUT')) {
        const raw = await readBody(req, MAX_IMAGE_BYTES);
        if (!raw.length) {
          json(res, 400, { error: '空内容' });
          return;
        }
        const queryName = url.searchParams.get('name');
        const type = url.searchParams.get('type') || 'phone';
        const label = url.searchParams.get('label');
        const buffer = raw;
        let name = queryName || `upload-${Date.now()}`;
        const detected = detectImageType(buffer);
        if (!detected) {
          json(res, 415, { error: '不是可识别的图片格式（支持 PNG/JPEG/GIF/BMP/WebP）' });
          return;
        }
        if (!/\.(png|jpe?g|gif|bmp|webp)$/i.test(name)) name += detected.ext;
        const hash = sha256(buffer);
        const phone = type !== 'pc';
        // 图片与文本区互不影响：这里不会清掉文本，也不会自动写系统剪贴板
        bank.put({ hash, buffer, mime: detected.mime, name, phone, at: Date.now() });
        const result = store.addImage({
          buffer, hash, name, mime: detected.mime, phone, source: label || type,
        });
        if (result.dropped && result.dropped.length) bank.drop(result.dropped);
        const state = summarize();
        if (result.changed) broadcast('update', state);
        json(res, 200, {
          ok: true,
          changed: result.changed,
          duplicate: Boolean(result.duplicate),
          dropped: result.dropped || [],
          version: state.version,
          imageCount: state.items.filter((item) => item.kind === 'image').length,
          item: state.items.find((entry) => entry.id === result.item.id) || null,
        });
        return;
      }

      if (pathname.startsWith('/api/image/') && req.method === 'GET') {
        const hash = pathname.slice('/api/image/'.length).replace(/[^a-f0-9]/gi, '');
        const entry = bank.get(hash);
        if (!entry) {
          json(res, 404, { error: '图片不存在或已过期（服务重启后图片会清空）' });
          return;
        }
        const buffer = entry.buffer;
        res.writeHead(200, {
          'content-type': entry.mime,
          'content-length': buffer.length,
          'cache-control': 'no-store',
          'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(entry.name)}`,
        });
        res.end(buffer);
        return;
      }

      if (pathname === '/api/image-meta' && req.method === 'GET') {
        json(res, 200, { ok: true, bytes: bank.bytes, count: bank.map.size });
        return;
      }

      // ---------------- 普通文件（与图片区逻辑一致：多文件保留、可下载、可删除）

      if (pathname === '/api/file' && (req.method === 'POST' || req.method === 'PUT')) {
        // 文件不限制大小（MAX_FILE_BYTES = Infinity）
        const raw = await readBody(req, MAX_FILE_BYTES);
        if (!raw.length) {
          json(res, 400, { error: '空文件' });
          return;
        }
        const queryName = (url.searchParams.get('name') || '').trim();
        const source = url.searchParams.get('type') || 'phone';
        const mime = (req.headers['content-type'] || '').split(';')[0] || 'application/octet-stream';
        // 文件名只取末段（/ 和 \ 都当作分隔符，防路径穿越），再清掉控制字符
        const rawName = (queryName.split(/[\\/]/).pop() || '').replace(/[\u0000-\u001f<>:"|?*]/g, '_').slice(0, 180);
        const name = rawName || `file-${Date.now()}`;
        const hash = sha256(raw);
        files.put({ hash, buffer: raw, mime, name, at: Date.now() });
        const result = store.addFile({ buffer: raw, hash, name, mime, source });
        if (result.dropped && result.dropped.length) files.drop(result.dropped);
        const state = summarize();
        if (result.changed) broadcast('update', state);
        json(res, 200, {
          ok: true,
          changed: result.changed,
          duplicate: Boolean(result.duplicate),
          dropped: result.dropped || [],
          version: state.version,
          fileCount: state.items.filter((item) => item.kind === 'file').length,
          item: state.items.find((entry) => entry.id === result.item.id) || null,
        });
        return;
      }

      if (pathname.startsWith('/api/file/') && req.method === 'GET') {
        const hash = pathname.slice('/api/file/'.length).replace(/[^a-f0-9]/gi, '');
        const entry = files.get(hash);
        if (!entry) {
          json(res, 404, { error: '文件不存在或已过期（服务重启后会清空）' });
          return;
        }
        const download = url.searchParams.get('download') === '1';
        res.writeHead(200, {
          'content-type': entry.mime || 'application/octet-stream',
          'content-length': entry.buffer.length,
          'cache-control': 'no-store',
          'content-disposition': `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(entry.name)}`,
        });
        res.end(entry.buffer);
        return;
      }

      if (pathname === '/api/file-meta' && req.method === 'GET') {
        json(res, 200, { ok: true, bytes: files.bytes, count: files.map.size });
        return;
      }

      // ---------------- 事件流 / 二维码 / 信息

      if (pathname === '/api/events') {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        });
        res.write('retry: 2000\n\n');
        res.write(`event: init\ndata: ${JSON.stringify(summarize())}\n\n`);
        clients.add(res);
        const keepAlive = setInterval(() => {
          try { res.write(': ping\n\n'); } catch { /* 连接已断 */ }
        }, 20000);
        req.on('close', () => {
          clearInterval(keepAlive);
          clients.delete(res);
        });
        return;
      }

      if (pathname === '/api/qr.png') {
        const target = url.searchParams.get('u') || `http://${pickPrimaryAddress()}:${options.port}/`;
        const { encode } = require('./lib/qr');
        const { renderPng } = require('./lib/render');
        const { modules } = encode(target);
        const png = renderPng(modules, { scale: Number(url.searchParams.get('s')) || 6, quietZone: 3 });
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
        res.end(png);
        return;
      }

      if (pathname === '/api/info') {
        json(res, 200, {
          ok: true,
          app: 'ClipBridge',
          version: VERSION,
          port: options.port,
          addresses: getLanAddresses().map((a) => a.address),
          tokenRequired: Boolean(options.token),
          platform: process.platform,
          imageClipboardSupport: isWindows,
          limits: {
            maxText: MAX_BYTES,
            maxImage: MAX_IMAGE_BYTES,
            maxImages: MAX_IMAGES,
            maxImageTotal: MAX_IMAGE_TOTAL_BYTES,
            // 文件区不限制（Infinity 在 JSON 里会变成 null，这里显式给 0 表示"无限制"）
            maxFile: Number.isFinite(MAX_FILE_BYTES) ? MAX_FILE_BYTES : 0,
            maxFiles: Number.isFinite(MAX_FILES) ? MAX_FILES : 0,
            maxFileTotal: Number.isFinite(MAX_FILE_TOTAL_BYTES) ? MAX_FILE_TOTAL_BYTES : 0,
            fileUnlimited: true,
          },
        });
        return;
      }

      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
    } catch (error) {
      if (error.statusCode === 413) {
        json(res, 413, { error: '内容过大' });
        return;
      }
      json(res, 500, { error: String(error.message || error) });
    }
  });

  return {
    server,
    get store() { return store; },
    bank,
    files,
    log,
    importFromClipboard,
    readClipboardContent,
    summarize,
  };
}

function listen(server, options) {
  const host = options.host || '0.0.0.0';
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, host, () => resolve(server.address()));
  });
}

// ---------------------------------------------------------------- 网页服务模式

async function serve(options) {
  const created = createServer(options);
  const { server, store, log } = created;
  const address = await listen(server, options);
  const port = address.port;

  const addresses = getLanAddresses();
  const primary = addresses[0]?.address ?? '127.0.0.1';
  const tokenQuery = options.token ? `?k=${encodeURIComponent(options.token)}` : '';
  const lanUrl = `http://${primary}:${port}/${tokenQuery}`;
  const localUrl = `http://127.0.0.1:${port}/${tokenQuery}`;

  console.log(`\nClipBridge ${VERSION} 已启动（按 Ctrl+C 停止）`);
  console.log(`  本机访问: ${localUrl}`);
  for (const entry of addresses) {
    const tag = entry.virtual ? '（虚拟网卡，一般不用）' : '';
    console.log(`  手机访问: http://${entry.address}:${port}/${tokenQuery}  [${entry.name}]${tag}`);
  }
  if (!addresses.some((a) => !a.virtual)) {
    console.log('  ! 未发现可用的局域网网卡，请确认电脑已连接 Wi-Fi');
  }
  if (options.token) console.log(`  访问口令: ${options.token}`);
  console.log('  支持文本与图片；图片仅存在内存中，服务重启后清空');

  if (options.qr) {
    try {
      const { encode } = require('./lib/qr');
      const { renderTerminal } = require('./lib/render');
      const { modules } = encode(lanUrl);
      console.log('\n用手机相机扫码打开（同一 Wi-Fi 下）:\n');
      console.log(renderTerminal(modules, { quietZone: 2 }));
      console.log(`\n${lanUrl}\n`);
    } catch (error) {
      console.log(`  ! 二维码生成失败: ${error.message}`);
    }
  }

  if (store.items.length) {
    log(`已恢复上次的文本内容（${store.items.length} 条）`);
  }

  if (options.open) {
    const opener = isWindows ? ['cmd', ['/c', 'start', '', localUrl]]
      : isMac ? ['open', [localUrl]]
        : ['xdg-open', [localUrl]];
    try { spawn(opener[0], opener[1], { detached: true, stdio: 'ignore' }).unref(); } catch { /* 忽略 */ }
  }

  const shutdown = async () => {
    console.log('\n正在保存并退出…');
    server.close();
    await store.flush();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return { server, created };
}

// ---------------------------------------------------------------- 命令行子命令

async function commandSend(options) {
  let text = options.text ?? '';
  if (text === '-' || (options.text === '' && !process.stdin.isTTY)) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    text = Buffer.concat(chunks).toString('utf8');
  }
  if (!text) {
    console.error('没有要发送的文本。用法: node server.js send <文本>');
    process.exitCode = 1;
    return;
  }

  const created = createServer({ ...options, quiet: true });
  const { server, store } = created;
  await listen(server, options);
  const port = server.address().port;
  const result = store.addText(text, 'cli');
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/text`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, source: 'cli', setClipboard: false }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch (error) {
    console.error(`发送失败: ${error.message}`);
    process.exitCode = 1;
  } finally {
    await store.flush();
    server.close();
  }
  if (!process.exitCode) {
    console.log(`已发送 ${Buffer.byteLength(result.item.text, 'utf8')} 字节到共享剪贴板（${store.file}），手机端刷新即可看到`);
  }
}

async function commandPull(options) {
  const created = createServer({ ...options, quiet: true });
  const { server, store, bank } = created;
  await listen(server, options);
  const lastImage = store.lastImage();
  const lastText = store.lastTextItem();
  let ok = false;
  if (lastImage) {
    const blob = bank.get(lastImage.hash);
    if (lastImage.paths?.length) ok = await writeClipboardText(lastImage.paths.join('\n'));
    else if (blob) ok = await writeClipboardImage(blob.buffer);
    server.close();
    if (!ok) {
      console.error('写入本机剪贴板失败');
      process.exitCode = 1;
      return;
    }
    console.log(lastImage.paths?.length
      ? `已把 ${lastImage.paths.length} 个图片路径写入电脑剪贴板`
      : `已把图片（${humanSize(lastImage.bytes)}）写入电脑剪贴板`);
    return;
  }
  const text = lastText ? lastText.text : '';
  ok = await writeClipboardText(text);
  server.close();
  if (!ok) {
    console.error('写入本机剪贴板失败');
    process.exitCode = 1;
    return;
  }
  console.log(`已把共享剪贴板内容（${Buffer.byteLength(text, 'utf8')} 字节）写入电脑剪贴板`);
}

/** 监听本机剪贴板变化并同步到共享内容（文本与图片都支持）。这是显式启用的可选子命令。 */
async function commandClipWatch(options) {
  const created = createServer(options);
  const { server, store, log, importFromClipboard } = created;
  await listen(server, options);
  const port = server.address().port;
  console.log(`正在监听电脑剪贴板（文本 + 图片），变化后自动同步（Ctrl+C 退出，端口 ${port}）`);

  let lastKey = null;
  const poll = async () => {
    const clip = await readClipboard();
    let key = null;
    if (clip.kind === 'text') key = 'text:' + sha256(Buffer.from(clip.text, 'utf8'));
    else if (clip.kind === 'files') key = 'files:' + sha256(Buffer.from(clip.paths.join('\n'), 'utf8'));
    else if (clip.kind === 'image') key = 'image:' + sha256(clip.buffer);
    else return;
    if (key === lastKey) return;
    lastKey = key;
    const result = await importFromClipboard('pc-clipboard');
    if (result.ok && result.changed) {
      const kindLabel = result.kind === 'image' ? `图片 ${result.count ?? 1} 张` : '文本';
      log(`  ← 抓到剪贴板变化（${kindLabel}），已同步到手机端`);
    }
  };

  await poll();
  const timer = setInterval(poll, 1000);

  const stop = async () => {
    clearInterval(timer);
    server.close();
    await store.flush();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

// ---------------------------------------------------------------- 入口

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    console.error('用 --help 查看用法');
    process.exitCode = 1;
    return;
  }
  if (options.help) {
    console.log(HELP);
    return;
  }
  switch (options.mode) {
    case 'send': await commandSend(options); break;
    case 'pull': await commandPull(options); break;
    case 'clip': await commandClipWatch(options); break;
    default: await serve(options);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`启动失败: ${error.message}`);
    if (error.code === 'EADDRINUSE') {
      console.error(`端口 ${error.port} 已被占用，换一个：node server.js --port 8888`);
    }
    process.exitCode = 1;
  });
}

module.exports = {
  parseArgs,
  createServer,
  listen,
  ClipStore,
  ImageBank,
  FileBank,
  BlobBank,
  readClipboard,
  writeClipboardText,
  writeClipboardImage,
  detectImageType,
  pngSize,
  getLanAddresses,
  pickPrimaryAddress,
  MAX_BYTES,
  MAX_IMAGE_BYTES,
  MAX_IMAGES,
  MAX_IMAGE_TOTAL_BYTES,
  MAX_FILE_BYTES,
  MAX_FILES,
  MAX_FILE_TOTAL_BYTES,
  VERSION,
};
