'use strict';
/**
 * ClipBridge 启动器：先做环境体检，再自动挑端口/存储，最后启动服务并显示二维码。
 *
 * 用法:
 *   node start.js                 体检 + 启动（默认端口 8737，被占用时自动换）
 *   node start.js --check         只体检，不启动
 *   node start.js --test          体检 + 跑一遍自测，不启动
 *   node start.js --port 9000     指定端口（被占用时自动往后找）
 *   node start.js --token 口令    加访问口令
 *   node start.js --reset         启动前清空已保存的文本
 *   node start.js --no-qr         不打印二维码
 *   node start.js --no-open       不自动打开浏览器（默认也不打开；加了 --open 才打开）
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = __dirname;
const DEFAULT_PORT = 8737;
const PORT_TRIES = 12;
const MIN_NODE_MAJOR = 18;

// ---------------------------------------------------------------- 终端着色

const useColor = !process.env.NO_COLOR && (process.env.TERM !== 'dumb');
const paint = (code, text) => (useColor ? `\u001b[${code}m${text}\u001b[0m` : text);
const bold = (t) => paint('1', t);
const dim = (t) => paint('2', t);
const green = (t) => paint('32', t);
const yellow = (t) => paint('33', t);
const red = (t) => paint('31', t);
const cyan = (t) => paint('36', t);

// ---------------------------------------------------------------- 参数

function parseArgs(argv) {
  const options = {
    port: DEFAULT_PORT,
    token: null,
    check: false,
    test: false,
    reset: false,
    qr: true,
    open: false,
    host: null,
    store: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`参数 ${arg} 缺少取值`);
      return value;
    };
    switch (arg) {
      case '-p': case '--port': options.port = Number(next()); break;
      case '--token': options.token = next(); break;
      case '--host': options.host = next(); break;
      case '--store': options.store = next(); break;
      case '--check': options.check = true; break;
      case '--test': options.test = true; break;
      case '--reset': options.reset = true; break;
      case '--no-qr': options.qr = false; break;
      case '--open': options.open = true; break;
      // start.cmd 用它表示"由 .cmd 负责 pause"；直接跑 start.js 时出现也只是忽略
      case 'nopause': break;
      case '-h': case '--help': options.help = true; break;
      default: throw new Error(`未知参数: ${arg}`);
    }
  }
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
    throw new Error(`端口不合法: ${options.port}`);
  }
  return options;
}

// ---------------------------------------------------------------- 体检

const checks = [];
function record(level, title, detail) {
  checks.push({ level, title, detail });
  const mark = level === 'ok' ? green('  ✔') : level === 'warn' ? yellow('  !') : red('  ✘');
  console.log(`${mark} ${title}${detail ? dim(' — ' + detail) : ''}`);
}

function fileOk(relative) {
  return fs.existsSync(path.join(ROOT, relative));
}

async function portFree(port, host = '0.0.0.0') {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, host);
  });
}

async function findPort(preferred) {
  for (let i = 0; i < PORT_TRIES; i++) {
    const port = preferred + i;
    if (port > 65535) break;
    // eslint-disable-next-line no-await-in-loop
    if (await portFree(port)) return { port, shifted: i > 0, from: preferred };
  }
  return { port: 0, shifted: true, from: preferred, random: true };
}

/** 只读探测剪贴板能力：优先直接跑助手脚本，避免 Node→PowerShell 管道在此环境被限制。 */
function probeClipboardScript() {
  const helper = path.join(ROOT, 'lib', 'clipboard-image.ps1');
  if (process.platform !== 'win32') return { ok: false, reason: `当前系统 ${process.platform} 不支持写图片剪贴板（文本仍可用）` };
  try {
    const result = spawnSync('powershell', [
      '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', helper, '-Mode', 'read',
    ], { encoding: 'utf8', timeout: 15000, windowsHide: true });
    if (result.error) return { ok: false, reason: result.error.code || result.error.message };
    const out = (result.stdout || '').trim();
    const start = out.indexOf('{');
    if (start < 0) return { ok: false, reason: '助手脚本无输出' };
    const data = JSON.parse(out.slice(start));
    if (data.kind === 'error') return { ok: false, reason: data.message || '读取失败' };
    return { ok: true, kind: data.kind };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}

function probeStore(file) {
  try {
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, '.clipbridge-write-test');
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return { ok: true, file };
  } catch (error) {
    return { ok: false, file, reason: error.message };
  }
}

// ---------------------------------------------------------------- 主流程

/**
 * 只做体检（不启动服务）。可被测试直接调用。
 * @returns {Promise<{checks:Array, failed:Array, warned:Array, port:number, storePath:string}>}
 */
async function runCheck(options) {
  checks.length = 0;
  console.log(bold('\nClipBridge 启动检查'));
  console.log(dim('─'.repeat(46)));

  // 1) Node 版本
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= MIN_NODE_MAJOR) {
    record('ok', `Node 版本 ${process.versions.node}`, `需要 >= ${MIN_NODE_MAJOR}`);
  } else {
    record('fail', `Node 版本过低（${process.versions.node}）`, `请升级到 >= ${MIN_NODE_MAJOR}`);
  }

  // 2) 必需文件
  const required = ['server.js', 'lib/qr.js', 'lib/render.js', 'lib/clipboard-image.ps1', 'public/index.html'];
  const missing = required.filter((item) => !fileOk(item));
  if (missing.length === 0) record('ok', '必需文件齐全', required.length + ' 个');
  else record('fail', '缺少必需文件', missing.join(', '));

  // 3) 局域网地址
  try {
    // 延迟加载：体检阶段不启动服务
    const { getLanAddresses } = require('./server');
    const lanAddresses = getLanAddresses();
    const real = lanAddresses.filter((entry) => !entry.virtual);
    if (real.length) {
      record('ok', '找到可用局域网地址', real.map((entry) => `${entry.address} [${entry.name}]`).join('、'));
    } else {
      record('warn', '没找到真实局域网网卡', '请确认已连接 Wi-Fi/网线，否则手机连不上');
    }
    if (lanAddresses.some((entry) => entry.virtual)) {
      record('warn', '检测到虚拟网卡', lanAddresses.filter((e) => e.virtual).map((e) => e.address).join('、') + '（一般不用）');
    }
  } catch (error) {
    record('fail', '加载 server.js 失败', error.message);
  }

  // 4) 存储可写
  const storePath = options.store
    ? (path.isAbsolute(options.store) ? options.store : path.join(process.cwd(), options.store))
    : path.join(ROOT, 'data', 'clipboard.json');
  const storeProbe = probeStore(storePath);
  if (storeProbe.ok) record('ok', '状态文件可写', dim(storePath));
  else record('warn', '状态文件不可写（仍可运行，但不会保存文本）', storeProbe.reason);

  // 5) 剪贴板能力
  const clip = probeClipboardScript();
  if (clip.ok) {
    const labels = { text: '文本', image: '图片', files: '图片文件', empty: '空' };
    record('ok', '剪贴板助手可用', `当前剪贴板内容类型: ${labels[clip.kind] || clip.kind}`);
  } else {
    record('warn', '剪贴板助手不可用（网页/命令行仍可用）', clip.reason);
  }

  // 6) 端口
  let port = options.port;
  if (port === 0) {
    const picked = await findPort(DEFAULT_PORT);
    port = picked.port;
    record('ok', '端口', `自动选到 ${port}`);
  } else if (await portFree(port)) {
    record('ok', `端口 ${port} 可用`);
  } else {
    const picked = await findPort(port + 1);
    if (picked.random) {
      record('fail', `端口 ${port} 被占用`, '后续端口也都不可用，请用 --port 指定');
      port = 0;
    } else {
      record('warn', `端口 ${port} 被占用，已自动改用 ${picked.port}`, '想固定端口可先关掉占用它的程序');
      port = picked.port;
    }
  }

  const failed = checks.filter((item) => item.level === 'fail');
  const warned = checks.filter((item) => item.level === 'warn');
  console.log(dim('─'.repeat(46)));
  console.log(
    failed.length ? red(`体检未通过：${failed.length} 项失败`)
      : warned.length ? yellow(`体检通过，${warned.length} 项提醒（不影响使用）`)
        : green('体检全部通过'),
  );
  return { checks: checks.slice(), failed, warned, port, storePath };
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(red('参数错误: ') + error.message);
    console.error('用 node start.js --help 查看用法');
    process.exitCode = 1;
    return;
  }
  if (options.help) {
    console.log(`ClipBridge 启动器

  node start.js                 体检 + 启动（端口被占用会自动往后找）
  node start.js --check         只体检，不启动
  node start.js --test          体检 + 跑一遍自测，不启动
  node start.js --port 9000     指定端口
  node start.js --token 口令    加访问口令（URL 变为 ...?k=口令）
  node start.js --reset         启动前清空已保存的文本
  node start.js --no-qr         不打印二维码
  node start.js --open          启动后自动打开电脑上的页面
  node start.js --host 127.0.0.1  只允许本机访问`);
    return;
  }

  const report = await runCheck(options);
  const { failed, port, storePath } = report;

  // --reset：清空已保存的文本
  if (options.reset) {
    try {
      fs.mkdirSync(path.dirname(storePath), { recursive: true });
      fs.writeFileSync(storePath, JSON.stringify({ text: '', version: 0, updatedAt: null, source: null }, null, 2), 'utf8');
      console.log(yellow('已按 --reset 清空保存的文本'));
    } catch (error) {
      console.log(red('清空失败: ') + error.message);
    }
  }

  if (options.test) {
    console.log(bold('\n跑一遍自测'));
    const test = spawnSync(process.execPath, ['selftest.js'], { cwd: ROOT, stdio: 'inherit' });
    if (test.status === 0) console.log(green('自测通过'));
    else {
      console.log(red('自测失败'));
      process.exitCode = 1;
    }
    return;
  }

  if (options.check || failed.length) {
    if (options.check) console.log(dim('\n（--check 模式：不启动服务）'));
    if (failed.length) process.exitCode = 1;
    return;
  }

  // 交给 server.js 启动（把自动选好的端口传过去）
  const args = ['server.js', '--port', String(port)];
  if (options.token) args.push('--token', options.token);
  if (options.host) args.push('--host', options.host);
  if (options.store) args.push('--store', options.store);
  if (!options.qr) args.push('--no-qr');
  if (options.open) args.push('--open');

  console.log(dim(`\n启动: node ${args.join(' ')}\n`));
  const child = spawn(process.execPath, args, { cwd: ROOT, stdio: 'inherit' });
  child.on('exit', (code) => { process.exitCode = code === null ? 0 : code; });
  const forward = (signal) => () => { try { child.kill(signal); } catch { /* 已退出 */ } };
  process.on('SIGINT', forward('SIGINT'));
  process.on('SIGTERM', forward('SIGTERM'));
  void os;
  void cyan;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(red('启动器异常: ') + (error && error.stack ? error.stack : error));
    process.exitCode = 1;
  });
}

module.exports = {
  parseArgs,
  runCheck,
  findPort,
  portFree,
  probeStore,
  probeClipboardScript,
  DEFAULT_PORT,
  MIN_NODE_MAJOR,
};
