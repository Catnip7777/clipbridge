'use strict';
/**
 * 校验页面布局与"不留历史"的展示规则：
 *  - 列表只渲染图片（缩略图网格），文本不出现
 *  - 服务端最多保留一条文本 + 一张图片
 * 运行：node scripts/check-layout.js
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { createServer, listen } = require('../server');
const { encode } = require('../lib/qr');
const { renderPng } = require('../lib/render');

/** 与 public/index.html 中 renderItems 完全相同的可见性规则：列表只渲染图片 */
function visibleItems(items) {
  return items.filter((item) => item.kind === 'image');
}

(async () => {
  const store = path.join(os.tmpdir(), 'cb-layout-' + Date.now() + '.json');
  const instance = createServer({ port: 0, host: '127.0.0.1', quiet: true, store });
  const address = await listen(instance.server, { port: 0, host: '127.0.0.1' });
  const base = 'http://127.0.0.1:' + address.port;
  const png = renderPng(encode('https://example.com/layout-check').modules, { scale: 3, quietZone: 2 });

  // 页面的"自动发送/手动同步"都是这个语义：replaceText=true（更新当前文本、保留图片）
  const post = (body) => fetch(base + '/api/text', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ replaceText: true, ...body }),
  });
  const state = async () => (await fetch(base + '/api/state')).json();

  let failed = 0;
  const check = (name, condition, detail) => {
    if (condition) console.log(`  ok   ${name}${detail ? ' — ' + detail : ''}`);
    else { failed++; console.error(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
  };

  // 场景 1：只有一条文本
  await post({ text: '唯一一条文本', replace: true });
  let current = await state();
  let visible = visibleItems(current.items);
  check('只有一条文本时，列表为空（页面只剩一个内容框）', visible.length === 0,
    `编辑框="${current.text.slice(0, 10)}" 列表=${visible.length} 项`);

  // 场景 2：文本 + 图片
  await fetch(base + '/api/image?name=layout.png&type=phone', { method: 'POST', body: png });
  current = await state();
  visible = visibleItems(current.items);
  check('文本 + 图片时，列表只显示图片', visible.length === 1 && visible[0].kind === 'image',
    visible.map((item) => item.kind).join(','));

  // 场景 3：同步新文本 —— 编辑框更新，列表仍只有图片
  await post({ text: '第二条文本' });
  current = await state();
  visible = visibleItems(current.items);
  const kinds = visible.map((item) => item.kind).join(',');
  check('同步新文本后，列表里仍然只有图片', kinds === 'image', `列表=${kinds}`);
  check('编辑框是最新那条文本', current.text === '第二条文本', `编辑框="${current.text}"`);
  check('服务端不留文本历史（只有一条文本）',
    current.items.filter((item) => item.kind === 'text').length === 1,
    `文本条目 ${current.items.filter((item) => item.kind === 'text').length} 条`);

  // 场景 4：连续同步多条文本，依旧只有一条文本 + 一张图片
  await post({ text: '第三条文本' });
  await post({ text: '第四条文本' });
  current = await state();
  visible = visibleItems(current.items);
  check('连续同步多条文本后，列表仍然只有图片',
    visible.every((item) => item.kind === 'image') && current.text === '第四条文本',
    `列表=${visible.map((item) => item.kind).join(',')} 编辑框="${current.text}"`);
  check('连续同步后服务端仍只有一条文本 + 一张图片',
    current.items.filter((item) => item.kind === 'text').length === 1 &&
    current.items.filter((item) => item.kind === 'image').length === 1,
    `条目 ${current.items.map((item) => item.kind).join(',')}`);

  // 场景 5：再传两张新图 —— 图片全部保留（不覆盖前面的）
  await fetch(base + '/api/image?name=second.png&type=phone', {
    method: 'POST',
    body: renderPng(encode('https://example.com/second-image').modules, { scale: 3, quietZone: 2 }),
  });
  await fetch(base + '/api/image?name=third.png&type=phone', {
    method: 'POST',
    body: renderPng(encode('https://example.com/third-image').modules, { scale: 3, quietZone: 2 }),
  });
  current = await state();
  visible = visibleItems(current.items);
  check('多张图片全部保留（不互相覆盖）',
    visible.length === 3,
    `列表=${visible.map((item) => item.name).join(',')}`);

  // 场景 6：同步文本不影响图片
  await post({ text: '同步文本后图片应还在' });
  current = await state();
  visible = visibleItems(current.items);
  check('同步文本后，图片区不受影响',
    visible.length === 3 && current.text === '同步文本后图片应还在',
    `图片 ${visible.length} 张，文本="${current.text}"`);

  // 场景 7：逐张删除图片，文本不受影响
  for (const item of visible) {
    await fetch(base + '/api/items/' + item.id, { method: 'DELETE' });
  }
  current = await state();
  visible = visibleItems(current.items);
  check('图片全部删除后，列表隐藏且文本保留',
    visible.length === 0 && current.text === '同步文本后图片应还在',
    `列表=${visible.length} 项，文本="${current.text}"`);

  instance.server.close();
  fs.rmSync(store, { force: true });
  console.log(failed ? `\n${failed} 项失败` : '\n布局逻辑全部通过');
  process.exitCode = failed ? 1 : 0;
})().catch((error) => {
  console.error('运行失败:', error);
  process.exitCode = 1;
});
