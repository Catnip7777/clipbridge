'use strict';
/**
 * 探测当前运行环境允许哪些子进程 stdio 方式。
 * 用途：判断"读系统剪贴板"是否可用（它依赖捕获 PowerShell 的输出）。
 * 运行：node scripts/probe-stdio.js
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const out = path.join(os.tmpdir(), 'clipbridge-stdio-probe.txt');
const results = [];

function probe(name, options) {
  const result = spawnSync('powershell', ['-NoProfile', '-Command', 'Write-Output clipbridge-probe'], {
    windowsHide: true,
    ...options,
  });
  const detail = result.error ? `${result.error.code || result.error.message}` : 'ok';
  results.push(`  ${result.error ? 'FAIL' : 'ok  '} ${name} — ${detail}`);
}

probe('pipe 捕获输出（服务读剪贴板用的就是这种）', { stdio: ['ignore', 'pipe', 'pipe'] });
probe('inherit 直接继承', { stdio: 'inherit' });
probe('ignore 丢弃输出', { stdio: ['ignore', 'ignore', 'ignore'] });
probe('file 重定向到文件', {
  stdio: ['ignore', fs.openSync(out, 'w'), 'ignore'],
});

console.log(results.join('\n'));
console.log('\n说明：若只有 pipe 失败，说明当前沙箱禁止管道 stdio；');
console.log('     服务在普通终端里运行不受此限制（读剪贴板、CLI 子命令都需要它）。');
try { fs.unlinkSync(out); } catch { /* 忽略 */ }
