'use strict';
/**
 * 校验双击启动入口（.cmd）是否可靠，重点是"不闪退"：
 *  - .cmd 内容必须是纯 ASCII（cmd.exe 用 OEM 代码页解析，中文会导致语法错乱后直接退出）
 *  - 必须有 cd /d "%~dp0"、pause、node 存在性与版本检查
 *  - 中文入口 启动.cmd 只做转发
 *  - 文件名/内容编码正确（可被 cmd 读取、无 BOM 问题）
 * 运行：node scripts/check-cmd.js
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
let failed = 0;
const check = (name, ok, detail) => {
  if (ok) console.log(`  ok   ${name}${detail ? ' — ' + detail : ''}`);
  else { failed++; console.error(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};

const startCmdPath = path.join(ROOT, 'start.cmd');
const zhCmdPath = path.join(ROOT, '启动.cmd');

// ---------------------------------------------------------------- start.cmd

if (!fs.existsSync(startCmdPath)) {
  check('start.cmd 存在', false);
} else {
  const buffer = fs.readFileSync(startCmdPath);
  const text = buffer.toString('utf8');
  check('start.cmd 存在', true, `${buffer.length} 字节`);

  // 1) 纯 ASCII：这是"闪退"的根因，必须守住
  const nonAscii = [...text].filter((char) => char.charCodeAt(0) > 0x7f);
  check('内容为纯 ASCII（防止 cmd 编码错乱导致闪退）',
    nonAscii.length === 0,
    nonAscii.length ? `发现 ${nonAscii.length} 个非 ASCII 字符: ${[...new Set(nonAscii)].slice(0, 10).join('')}` : '无');

  // 2) 不能有 BOM（cmd 会把 BOM 当命令）
  check('没有 UTF-8 BOM',
    !(buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf));

  // 3) 换行用 CRLF（老版本 cmd 对 LF 处理不友好）
  const lfOnly = text.split('\n').filter((line, index, all) => index < all.length - 1 && !line.endsWith('\r'));
  check('换行是 CRLF', lfOnly.length === 0, lfOnly.length ? `${lfOnly.length} 行是裸 LF` : 'ok');

  // 4) 关键保障
  check('先切到脚本所在目录', /cd \/d "%~dp0"/.test(text));
  check('检查 node 是否存在', /where node/.test(text));
  check('检查 Node 主版本号（避免旧版直接崩）', /NODEMAJOR/.test(text) && /LSS/.test(text));
  check('无论成功失败都会 pause（窗口不闪退）', /pause/.test(text));
  check('把参数透传给 start.js', /node start\.js %\*/.test(text));
  check('用 endlocal 收尾', /endlocal/.test(text));
  // 双保险：pause 必须在所有分支之后
  const pauseIndex = text.lastIndexOf('pause');
  const gotoDoneCount = (text.match(/goto done/g) || []).length;
  check('存在统一收尾标签 :done', /:done/.test(text), `${gotoDoneCount} 处跳转`);
  check('pause 位于收尾段（不会被跳过）',
    pauseIndex > text.indexOf(':done'),
    `pause@${pauseIndex}, :done@${text.indexOf(':done')}`);
}

// ---------------------------------------------------------------- 中文入口

if (!fs.existsSync(zhCmdPath)) {
  check('中文入口 启动.cmd 存在', false);
} else {
  const text = fs.readFileSync(zhCmdPath, 'utf8');
  check('中文入口 启动.cmd 存在', true);
  check('中文入口只转发给 start.cmd', /call "%~dp0start\.cmd"/.test(text));
  const nonAscii = [...text].filter((char) => char.charCodeAt(0) > 0x7f).length;
  check('中文入口正文也尽量 ASCII（注释除外）', nonAscii <= 40, `非 ASCII ${nonAscii} 个（仅注释）`);
}

// ---------------------------------------------------------------- 与 start.js 的衔接

const startJs = fs.readFileSync(path.join(ROOT, 'start.js'), 'utf8');
check('start.js 有 require.main 保护（可被测试 require）', /require\.main === module/.test(startJs));
check('start.js 会检查 Node 版本', /MIN_NODE_MAJOR/.test(startJs));
check('start.js 会在启动前体检', /runCheck/.test(startJs));
check('start.js 端口冲突会自动换端口', /findPort/.test(startJs));
check('start.js 接受 .cmd 传来的 nopause 参数', /case 'nopause'/.test(startJs));

// 真跑一遍 .cmd（nopause 标记由 cmd 自己消化）
const { spawnSync } = require('node:child_process');
const probe = spawnSync('cmd', ['/c', 'start.cmd --help nopause'], { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
if (probe.error && probe.error.code === 'EPERM') {
  console.log('  skip 真跑 cmd（当前环境禁止管道 stdio）');
} else {
  const output = (probe.stdout || '') + (probe.stderr || '');
  check('cmd 能跑通并打印中文帮助（编码正常）',
    /ClipBridge 启动器/.test(output) && /体检/.test(output),
    output.split('\n').filter(Boolean).slice(1, 2).join(''));
  check('cmd 传参给 start.js 正常（--help 生效）', !/未知参数/.test(output));
}

const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
check('npm start 指向启动器', packageJson.scripts.start === 'node start.js', packageJson.scripts.start);

console.log(failed ? `\n${failed} 项失败` : '\n双击入口校验全部通过');
process.exitCode = failed ? 1 : 0;
