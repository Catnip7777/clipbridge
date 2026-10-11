'use strict';
/**
 * 校验启动状态：编辑框不预填内容、只有灰色占位提示。
 * 默认**非破坏性**：先存下当前内容，测试完还原。
 * 用法：
 *   node scripts/check-startup.js [baseUrl]            非破坏性校验
 *   node scripts/check-startup.js [baseUrl] --reset     校验后清空（只用于你确实想重置时）
 */
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const reset = args.includes('--reset');
const base = args.find((arg) => arg.startsWith('http')) || 'http://127.0.0.1:8737';

const post = (body) => fetch(base + '/api/text', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});
const state = async () => (await fetch(base + '/api/state')).json();

(async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const match = html.match(/<textarea id="editor"[\s\S]{0,120}?placeholder="([^"]+)"/);
  console.log('编辑框占位提示:', match ? match[1] : '(未找到)');
  console.log('页面里是否残留欢迎文字:', /欢迎使用 ClipBridge/.test(html) ? '有（需清理）' : '没有 ✓');

  const before = await state();
  console.log('当前共享文本长度:', (before.text || '').length, '| 条目:', before.items.map((i) => i.kind).join(',') || '(空)');

  // 模拟"输入/粘贴"：写入一段哨兵文本，确认不会被预填内容干扰
  const sentinel = 'ClipBridge 自检哨兵 ' + Date.now();
  await post({ text: sentinel, source: 'paste', replaceText: true });
  const after = await state();
  const clean = after.text === sentinel;
  console.log('写入哨兵后读回是否一致:', clean ? '一致 ✓' : `不一致（读到 ${JSON.stringify(after.text.slice(0, 30))}）`);

  // 还原：默认恢复原内容；--reset 时才清空
  if (reset) {
    await post({ text: '', source: 'manual', replaceText: true });
    console.log('已按 --reset 清空共享文本');
  } else if ((before.text || '').length) {
    await post({ text: before.text, source: before.source || 'restore', replaceText: true });
    const restored = await state();
    console.log('已还原原来的文本:', restored.text === before.text ? '成功 ✓' : '失败');
  } else {
    await post({ text: '', source: 'manual', replaceText: true });
    console.log('原本就是空的，保持空状态');
  }

  process.exitCode = clean ? 0 : 1;
})();
