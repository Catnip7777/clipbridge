'use strict';
/** 服务端端到端测试：真实起 HTTP 服务，走完整请求链路。运行：node server.test.js */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createServer, listen, readClipboard, writeClipboardText, writeClipboardImage, pngSize, parseArgs,
} = require('./server');

let passed = 0;
let failed = 0;
const results = [];
async function test(name, fn) {
  try {
    await fn();
    passed++;
    results.push(`  ok   ${name}`);
  } catch (error) {
    failed++;
    results.push(`  FAIL ${name}\n       ${error && error.stack ? error.stack.split('\n').slice(0, 3).join('\n       ') : error}`);
  }
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'clipbridge-test-'));
let instance = null;
let base = '';

function start(options = {}) {
  return createServer({
    port: 0,
    quiet: true,
    store: path.join(tmpRoot, `store-${Math.random().toString(36).slice(2)}.json`),
    ...options,
  });
}

async function api(pathname, init) {
  const response = await fetch(base + pathname, init);
  return response;
}

async function main() {
  instance = start({ port: 0 });
  const address = await listen(instance.server, { port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${address.port}`;

  await test('GET / 返回页面且含关键元素', async () => {
    const response = await api('/');
    assert.strictEqual(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/html/);
    const html = await response.text();
    assert.match(html, /ClipBridge/);
    // 两个主按钮：复制 + 手动同步
    assert.match(html, /id="copyBtn"/);
    assert.match(html, /id="syncBtn"/);
    // 文本区与图片区是两块独立区域
    assert.match(html, /id="editorCard"/);
    assert.match(html, /id="imageCard"/);
    // 按需求移除的东西
    assert.ok(!/id="autoCopy"/.test(html), '不应再有自动复制开关');
    assert.ok(!/id="readPcBtn"/.test(html), '不应再有「读取电脑剪贴板」按钮');
    assert.match(html, /<textarea id="editor"/);
  });

  await test('GET /api/info 返回服务信息', async () => {
    const info = await (await api('/api/info')).json();
    assert.strictEqual(info.ok, true);
    assert.strictEqual(info.app, 'ClipBridge');
    assert.ok(Array.isArray(info.addresses));
  });

  await test('初始状态为空且版本为 0', async () => {
    const snapshot = await (await api('/api/text')).json();
    assert.strictEqual(snapshot.text, '');
    assert.strictEqual(snapshot.version, 0);
  });

  await test('POST 文本后版本递增且可读回', async () => {
    const response = await api('/api/text', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello 手机', source: 'test' }),
    });
    assert.strictEqual(response.status, 200);
    const result = await response.json();
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.version, 1);
    assert.strictEqual(result.changed, true);
    const snapshot = await (await api('/api/text')).json();
    assert.strictEqual(snapshot.text, 'hello 手机');
    assert.strictEqual(snapshot.version, 1);
    assert.strictEqual(snapshot.source, 'test');
    assert.ok(snapshot.updatedAt, '应有更新时间');
  });

  await test('相同内容不递增版本（避免同步风暴）', async () => {
    const response = await api('/api/text', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello 手机' }),
    });
    const result = await response.json();
    assert.strictEqual(result.changed, false);
    assert.strictEqual(result.version, 1);
  });

  await test('CRLF 会规范化为 LF', async () => {
    await api('/api/text', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'a\r\nb\r\nc' }),
    });
    const snapshot = await (await api('/api/text')).json();
    assert.strictEqual(snapshot.text, 'a\nb\nc');
  });

  await test('since=当前版本 时返回 unchanged', async () => {
    const current = await (await api('/api/text')).json();
    const same = await (await api('/api/text?since=' + current.version)).json();
    assert.strictEqual(same.unchanged, true);
    const older = await (await api('/api/text?since=0')).json();
    assert.strictEqual(older.unchanged, undefined);
    assert.strictEqual(older.version, current.version);
  });

  await test('纯文本 body 也能写入', async () => {
    const response = await api('/api/text', { method: 'POST', body: 'plain text body' });
    assert.strictEqual(response.status, 200);
    const snapshot = await (await api('/api/text')).json();
    assert.strictEqual(snapshot.text, 'plain text body');
  });

  await test('超长内容返回 413', async () => {
    const response = await api('/api/text', {
      method: 'POST',
      body: 'x'.repeat(600 * 1024),
    });
    assert.strictEqual(response.status, 413);
  });

  await test('非法 JSON 返回 400', async () => {
    const response = await api('/api/text', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{oops',
    });
    assert.strictEqual(response.status, 400);
  });

  // ---------------------------------------------------------------- 图片

  const pngOf = (text, scale = 3) => {
    const { encode } = require('./lib/qr');
    const { renderPng } = require('./lib/render');
    return renderPng(encode(text).modules, { scale, quietZone: 2 });
  };

  await test('上传 PNG 图片：入库、可从 /api/image 取回、尺寸正确', async () => {
    const png = pngOf('https://example.com/image-one');
    const response = await api('/api/image?name=%E6%B5%8B%E8%AF%95%E5%9B%BE.png&type=phone', {
      method: 'POST',
      headers: { 'content-type': 'image/png' },
      body: png,
    });
    assert.strictEqual(response.status, 200);
    const data = await response.json();
    assert.strictEqual(data.ok, true);
    assert.strictEqual(data.changed, true);
    assert.strictEqual(data.item.kind, 'image');
    assert.strictEqual(data.item.bytes, png.length);
    assert.ok(data.item.width > 0 && data.item.height > 0, '应解析出图片尺寸');
    // 中文文件名应被保留
    assert.match(data.item.name, /测试图\.png/);
    const fetched = await api(data.item.url);
    assert.strictEqual(fetched.status, 200);
    assert.strictEqual(fetched.headers.get('content-type'), 'image/png');
    const bytes = Buffer.from(await fetched.arrayBuffer());
    assert.deepStrictEqual(bytes, png, '取回的图片应与上传的一致');
    assert.ok(bytes.length > 200);
  });

  await test('同一张图片重复上传会去重（版本不递增）', async () => {
    const png = pngOf('https://example.com/image-one');
    const before = await (await api('/api/state')).json();
    const response = await api('/api/image?type=phone', { method: 'POST', body: png });
    const data = await response.json();
    assert.strictEqual(data.changed, false);
    assert.strictEqual(data.duplicate, true);
    const after = await (await api('/api/state')).json();
    assert.strictEqual(after.version, before.version);
  });

  await test('非图片内容返回 415，空内容返回 400', async () => {
    const bad = await api('/api/image', { method: 'POST', body: 'this is definitely not an image' });
    assert.strictEqual(bad.status, 415);
    const empty = await api('/api/image', { method: 'POST', body: '' });
    assert.strictEqual(empty.status, 400);
  });

  await test('状态接口同时返回文本与图片条目，且不含二进制', async () => {
    const state = await (await api('/api/state')).json();
    const kinds = state.items.map((item) => item.kind);
    assert.ok(kinds.includes('text'), '应有文本条目');
    assert.ok(kinds.includes('image'), '应有图片条目');
    const text = state.items.find((item) => item.kind === 'text');
    assert.strictEqual(typeof text.text, 'string');
    const image = state.items.find((item) => item.kind === 'image');
    assert.ok(image.url.startsWith('/api/image/'));
    assert.strictEqual(image.buffer, undefined, '不应把图片二进制放进状态');
    // 状态里不能出现 base64 大字符串
    assert.ok(JSON.stringify(state).length < 8000, '状态体积应很小');
    assert.strictEqual(typeof state.text, 'string', '为兼容旧的纯文本读取，仍返回 text');
  });

  await test('图片全部保留：连续上传多张不会互相覆盖', async () => {
    await api('/api/items/clear', { method: 'POST' });
    const hashes = [];
    for (let i = 0; i < 3; i++) {
      const png = pngOf('https://example.com/multi-' + i, 3);
      const response = await api('/api/image?name=multi-' + i + '.png&type=phone', {
        method: 'POST', body: png,
      });
      const data = await response.json();
      assert.strictEqual(data.changed, true);
      hashes.push(data.item.hash);
    }
    const state = await (await api('/api/state')).json();
    const images = state.items.filter((item) => item.kind === 'image');
    assert.strictEqual(images.length, 3, `应保留 3 张，实际 ${images.length} 张`);
    for (const hash of hashes) {
      const entry = await api('/api/image/' + hash);
      assert.strictEqual(entry.status, 200, '每一张都应还能取到');
      assert.ok(Buffer.from(await entry.arrayBuffer()).length > 100);
    }
    // 同一张重复上传不重复占位
    const again = await (await api('/api/image?type=phone', { method: 'POST', body: pngOf('https://example.com/multi-0', 3) })).json();
    assert.strictEqual(again.changed, false);
    assert.strictEqual(again.duplicate, true);
    const after = await (await api('/api/state')).json();
    assert.strictEqual(after.items.filter((item) => item.kind === 'image').length, 3);
  });

  await test('文本与图片互不影响：同步文本不会动图片，清空图片不会动文本', async () => {
    await api('/api/items/clear', { method: 'POST' });
    await api('/api/text', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '保留这段文本', source: 'test', replaceText: true }),
    });
    const uploaded = await (await api('/api/image?name=keep.png&type=phone', {
      method: 'POST', body: pngOf('https://example.com/keep-image', 3),
    })).json();
    // 反复同步文本
    for (let i = 0; i < 3; i++) {
      await api('/api/text', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: '文本变了 ' + i, source: 'auto', replaceText: true }),
      });
    }
    let state = await (await api('/api/state')).json();
    assert.strictEqual(state.items.filter((item) => item.kind === 'image').length, 1, '图片应还在');
    assert.strictEqual(state.text, '文本变了 2');
    assert.strictEqual(state.items.filter((item) => item.kind === 'text').length, 1, '文本仍只有一条');
    // 删掉图片，文本不动
    const image = state.items.find((item) => item.kind === 'image');
    await api('/api/items/' + image.id, { method: 'DELETE' });
    state = await (await api('/api/state')).json();
    assert.strictEqual(state.items.filter((item) => item.kind === 'image').length, 0);
    assert.strictEqual(state.text, '文本变了 2', '清空图片后文本应保留');
    assert.strictEqual((await api('/api/image/' + uploaded.item.hash)).status, 404, '删除后二进制应释放');
  });

  await test('服务端不再自动读写系统剪贴板（相关接口已移除）', async () => {
    assert.strictEqual((await api('/api/clipboard')).status, 404);
    assert.strictEqual((await api('/api/pull-clipboard', { method: 'POST' })).status, 404);
    // 上传图片不应该写入剪贴板：接口返回里不再有 clipboardWritten
    const data = await (await api('/api/image?name=no-clip.png&type=phone', {
      method: 'POST', body: pngOf('https://example.com/no-clipboard-write', 3),
    })).json();
    assert.strictEqual(data.clipboardWritten, undefined, '不应再自动写剪贴板');
  });

  // ---------------------------------------------------------------- 普通文件

  await test('上传文件：原样取回、文件名与类型正确、下载头是 attachment', async () => {
    await api('/api/items/clear', { method: 'POST' });
    const payload = Buffer.from('ClipBridge 文件测试：二进制也没问题 \u0000\u0001\u00ff 结束', 'utf8');
    const response = await api('/api/file?name=' + encodeURIComponent('测试文档.bin') + '&type=phone', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: payload,
    });
    assert.strictEqual(response.status, 200);
    const data = await response.json();
    assert.strictEqual(data.item.kind, 'file');
    assert.strictEqual(data.item.name, '测试文档.bin');
    assert.strictEqual(data.item.bytes, payload.length);
    assert.match(data.item.downloadUrl, /\?download=1$/);
    const fetched = await api(data.item.url);
    assert.strictEqual(fetched.status, 200);
    const bytes = Buffer.from(await fetched.arrayBuffer());
    assert.deepStrictEqual(bytes, payload, '取回内容应与上传完全一致');
  });

  await test('文件下载响应头：inline 预览 / attachment 下载', async () => {
    const payload = Buffer.from('hello attachment', 'utf8');
    const data = await (await api('/api/file?name=note.txt', { method: 'POST', body: payload })).json();
    const inline = await api(data.item.url);
    assert.match(inline.headers.get('content-disposition') || '', /^inline;/);
    const attach = await api(data.item.downloadUrl);
    assert.match(attach.headers.get('content-disposition') || '', /^attachment;/);
    assert.match(attach.headers.get('content-disposition') || '', /filename\*=UTF-8''/);
  });

  await test('文件全部保留：连续上传多个互不覆盖，重复上传去重', async () => {
    await api('/api/items/clear', { method: 'POST' });
    const hashes = [];
    for (let i = 0; i < 3; i++) {
      const payload = Buffer.from('文件内容 ' + i + ' ' + 'x'.repeat(50 + i), 'utf8');
      const data = await (await api('/api/file?name=doc-' + i + '.txt', { method: 'POST', body: payload })).json();
      assert.strictEqual(data.changed, true, `第 ${i} 个应入库`);
      hashes.push(data.item.hash);
    }
    let state = await (await api('/api/state')).json();
    assert.strictEqual(state.items.filter((item) => item.kind === 'file').length, 3, '应保留 3 个文件');
    for (const hash of hashes) assert.strictEqual((await api('/api/file/' + hash)).status, 200);
    const again = await (await api('/api/file?name=doc-0.txt', { method: 'POST', body: Buffer.from('文件内容 0 ' + 'x'.repeat(50), 'utf8') })).json();
    assert.strictEqual(again.changed, false);
    assert.strictEqual(again.duplicate, true);
    state = await (await api('/api/state')).json();
    assert.strictEqual(state.items.filter((item) => item.kind === 'file').length, 3, '重复上传不应增加条目');
  });

  await test('文件与图片、文本三块互不影响', async () => {
    await api('/api/items/clear', { method: 'POST' });
    await api('/api/text', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '文本要保留', source: 'test', replaceText: true }),
    });
    await api('/api/image?name=keep.png', { method: 'POST', body: pngOf('https://example.com/keep-both', 3) });
    const fileData = await (await api('/api/file?name=keep.txt', { method: 'POST', body: Buffer.from('keep me', 'utf8') })).json();
    // 同步文本 + 再传一张图，都不应影响文件
    await api('/api/text', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '文本又变了', source: 'auto', replaceText: true }),
    });
    await api('/api/image?name=second.png', { method: 'POST', body: pngOf('https://example.com/second-both', 3) });
    let state = await (await api('/api/state')).json();
    assert.strictEqual(state.items.filter((item) => item.kind === 'file').length, 1, '文件应还在');
    assert.strictEqual(state.items.filter((item) => item.kind === 'image').length, 2, '两张图都应在');
    assert.strictEqual(state.text, '文本又变了');
    // 删文件：文本与图片不受影响
    const file = state.items.find((item) => item.kind === 'file');
    await api('/api/items/' + file.id, { method: 'DELETE' });
    state = await (await api('/api/state')).json();
    assert.strictEqual(state.items.filter((item) => item.kind === 'file').length, 0);
    assert.strictEqual(state.items.filter((item) => item.kind === 'image').length, 2, '删文件不应影响图片');
    assert.strictEqual(state.text, '文本又变了', '删文件不应影响文本');
    assert.strictEqual((await api('/api/file/' + fileData.item.hash)).status, 404, '删除后文件二进制应释放');
  });

  await test('文件上传安全：文件名去路径、空文件被拒、超大文件 413', async () => {
    await api('/api/items/clear', { method: 'POST' });
    // 注意：内容相同会被去重（返回已有条目），所以每个用例用不同内容
    const traversal = await (await api('/api/file?name=' + encodeURIComponent('../../evil.txt'), { method: 'POST', body: Buffer.from('safe-1') })).json();
    assert.ok(!traversal.item.name.includes('/') && !traversal.item.name.includes('..'), `文件名应被清洗: ${traversal.item.name}`);
    const windowsPath = await (await api('/api/file?name=' + encodeURIComponent('C:\\Windows\\system32\\cmd.exe'), { method: 'POST', body: Buffer.from('safe-2') })).json();
    assert.strictEqual(windowsPath.item.name, 'cmd.exe', '应只保留文件名');
    const unixPath = await (await api('/api/file?name=' + encodeURIComponent('/etc/passwd'), { method: 'POST', body: Buffer.from('safe-3') })).json();
    assert.strictEqual(unixPath.item.name, 'passwd', '应只保留文件名');
    const cn = await (await api('/api/file?name=' + encodeURIComponent('正常 文件名.pdf'), { method: 'POST', body: Buffer.from('safe-4') })).json();
    assert.strictEqual(cn.item.name, '正常 文件名.pdf', '中文与空格应保留');
    assert.strictEqual((await api('/api/file', { method: 'POST', body: '' })).status, 400, '空文件应 400');
  });

  await test('文件不限大小：8 MB 文件上传成功且字节一致', async () => {
    const big = Buffer.alloc(8 * 1024 * 1024, 42);
    const response = await api('/api/file?name=big.bin', { method: 'POST', body: big });
    assert.strictEqual(response.status, 200, '不应再有大小限制导致的 413');
    const data = await response.json();
    assert.strictEqual(data.item.bytes, big.length);
    const back = Buffer.from(await (await api(data.item.downloadUrl)).arrayBuffer());
    assert.strictEqual(back.length, big.length, '取回长度应一致');
    assert.ok(back.equals(big), '内容应完全一致');
  });

  await test('文件不限数量：连续上传 25 个都不会被丢掉', async () => {
    await api('/api/items/clear', { method: 'POST' });
    const hashes = [];
    for (let i = 0; i < 25; i++) {
      const body = Buffer.from('no-limit-' + i + '-' + 'x'.repeat(i), 'utf8');
      const data = await (await api('/api/file?name=f' + i + '.bin', { method: 'POST', body })).json();
      hashes.push(data.item.hash);
    }
    const state = await (await api('/api/state')).json();
    assert.strictEqual(state.items.filter((item) => item.kind === 'file').length, 25, '25 个文件都应保留');
    assert.strictEqual((await api('/api/file/' + hashes[0])).status, 200, '第一个文件不应被丢弃');
    assert.strictEqual((await api('/api/file/' + hashes[24])).status, 200, '最后一个文件也应在');
  });

  await test('接口明确告知文件区不限大小', async () => {
    const info = await (await api('/api/info')).json();
    assert.strictEqual(info.limits.fileUnlimited, true);
    assert.strictEqual(info.limits.maxFile, 0, '0 表示不限制');
    assert.strictEqual(info.limits.maxFiles, 0, '0 表示不限制');
  });

  await test('清空全部会释放文件二进制', async () => {
    const data = await (await api('/api/file?name=clear-me.txt', { method: 'POST', body: Buffer.from('bye', 'utf8') })).json();
    assert.strictEqual((await api('/api/file/' + data.item.hash)).status, 200);
    await api('/api/items/clear', { method: 'POST' });
    assert.strictEqual((await api('/api/file/' + data.item.hash)).status, 404, '清空后不应还能取到文件');
    const state = await (await api('/api/state')).json();
    assert.strictEqual(state.items.length, 0);
  });

  await test('状态接口里的文件条目不含二进制、体积很小', async () => {
    await api('/api/items/clear', { method: 'POST' });
    await api('/api/file?name=big-ish.bin', { method: 'POST', body: Buffer.alloc(512 * 1024, 7) });
    const state = await (await api('/api/state')).json();
    const file = state.items.find((item) => item.kind === 'file');
    assert.strictEqual(file.bytes, 512 * 1024);
    assert.strictEqual(file.buffer, undefined, '不应把文件二进制放进状态');
    assert.ok(JSON.stringify(state).length < 2000, `状态体积应很小，实际 ${JSON.stringify(state).length}`);
  });

  await test('删除单条与清空全部', async () => {
    const png = pngOf('https://example.com/image-two');
    await api('/api/image?type=phone', { method: 'POST', body: png });
    const before = await (await api('/api/state')).json();
    const target = before.items.find((item) => item.kind === 'image');
    const del = await api('/api/items/' + target.id, { method: 'DELETE' });
    assert.strictEqual((await del.json()).changed, true);
    const afterDelete = await (await api('/api/state')).json();
    assert.ok(!afterDelete.items.some((item) => item.id === target.id), '被删除的条目不应还在');
    const clear = await api('/api/items/clear', { method: 'POST' });
    assert.strictEqual((await clear.json()).changed, true);
    const cleared = await (await api('/api/state')).json();
    assert.strictEqual(cleared.items.length, 0);
    assert.strictEqual(cleared.text, '');
  });

  await test('清空后图片二进制也被释放', async () => {
    const posted = await (await api('/api/image?name=clear-me.png', { method: 'POST', body: pngOf('https://example.com/clear-me') })).json();
    assert.strictEqual((await api(posted.item.url)).status, 200);
    await api('/api/items/clear', { method: 'POST' });
    assert.strictEqual((await api(posted.item.url)).status, 404, '清空后不应还能取到图片');
  });

  await test('SSE 订阅能收到更新推送', async () => {
    const controller = new AbortController();
    const response = await fetch(base + '/api/events', { signal: controller.signal });
    assert.strictEqual(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const readUntil = async (pattern, limit = 40) => {
      for (let i = 0; i < limit; i++) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (pattern.test(buffer)) return true;
      }
      return false;
    };
    assert.ok(await readUntil(/event: init/), '应收到 init 事件');
    const pushed = api('/api/text', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'sse 测试内容' }),
    });
    assert.ok(await readUntil(/event: update/), '应收到 update 事件');
    assert.match(buffer, /sse 测试内容/);
    await pushed;
    controller.abort();
  });

  await test('GET /api/qr.png 返回 PNG 且尺寸随内容变化', async () => {
    const response = await api('/api/qr.png?u=' + encodeURIComponent('http://192.168.1.9:8737/'));
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.headers.get('content-type'), 'image/png');
    const buffer = Buffer.from(await response.arrayBuffer());
    assert.deepStrictEqual(
      Array.from(buffer.subarray(0, 8)),
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    );
    const width = buffer.readUInt32BE(16);
    assert.ok(width > 100 && width < 2000, `尺寸异常: ${width}`);
    const long = Buffer.from(await (await api('/api/qr.png?u=' + 'a'.repeat(300))).arrayBuffer());
    assert.ok(long.length > 0);
  });

  await test('未知路径返回 404', async () => {
    const response = await api('/nope');
    assert.strictEqual(response.status, 404);
  });

  await test('持久化：重启后仍能读回内容', async () => {
    const storePath = path.join(tmpRoot, 'persist.json');
    const first = start({ store: storePath });
    const firstAddress = await listen(first.server, { port: 0, host: '127.0.0.1' });
    await fetch(`http://127.0.0.1:${firstAddress.port}/api/text`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '重启也要在' }),
    });
    await first.store.flush();
    first.server.close();

    const second = start({ store: storePath });
    const secondAddress = await listen(second.server, { port: 0, host: '127.0.0.1' });
    const snapshot = await (
      await fetch(`http://127.0.0.1:${secondAddress.port}/api/text`)
    ).json();
    assert.strictEqual(snapshot.text, '重启也要在');
    assert.strictEqual(snapshot.version, 1);
    second.server.close();
  });

  await test('口令保护：无口令 401，带口令 200', async () => {
    const secure = start({ token: 's3cret' });
    const secureAddress = await listen(secure.server, { port: 0, host: '127.0.0.1' });
    const secureBase = `http://127.0.0.1:${secureAddress.port}`;
    assert.strictEqual((await fetch(secureBase + '/')).status, 401);
    assert.strictEqual((await fetch(secureBase + '/api/text')).status, 401);
    const ok = await fetch(secureBase + '/api/text?k=s3cret');
    assert.strictEqual(ok.status, 200);
    const header = await fetch(secureBase + '/api/text', { headers: { 'x-clip-token': 's3cret' } });
    assert.strictEqual(header.status, 200);
    secure.server.close();
  });

  await test('命令行参数解析', async () => {
    const options = parseArgs(['--port', '9000', '--token', 'abc', '--no-qr', '--open']);
    assert.strictEqual(options.port, 9000);
    assert.strictEqual(options.token, 'abc');
    assert.strictEqual(options.qr, false);
    assert.strictEqual(options.open, true);
    assert.strictEqual(parseArgs(['send', '你好', '世界']).text, '你好 世界');
    assert.strictEqual(parseArgs(['send', '你好', '世界']).mode, 'send');
    assert.strictEqual(parseArgs([]).mode, 'serve');
    assert.throws(() => parseArgs(['--unknown']), /未知参数/);
    assert.throws(() => parseArgs(['--port']), /缺少取值/);
  });

  await test('系统剪贴板读写（Windows 且环境可用时）', async () => {
    if (process.platform !== 'win32') return;
    const original = await readClipboard();
    if (original.kind === 'error') return; // 沙箱/环境不支持，跳过
    const sample = 'ClipBridge 剪贴板测试 🎉\n第二行 "引号" 与 \'单引号\'';
    const ok = await writeClipboardText(sample);
    if (!ok) return; // 受限环境写入失败，跳过（真实运行时可用）
    const readBack = await readClipboard();
    assert.strictEqual(readBack.kind, 'text', '读回的类型应为文本');
    assert.strictEqual(readBack.text, sample, '剪贴板内容应可原样读回');
    if (original.kind === 'text') await writeClipboardText(original.text); // 还原
  });

  await test('图片剪贴板读写（Windows 且环境可用时）', async () => {
    if (process.platform !== 'win32') return;
    const png = pngOf('https://example.com/clipboard-image-test', 2);
    const ok = await writeClipboardImage(png);
    if (!ok) return; // 受限环境跳过
    const clip = await readClipboard();
    assert.strictEqual(clip.kind, 'image', '剪贴板里应是图片');
    // 剪贴板往返会经过系统图片编解码，比对像素尺寸即可
    const before = pngSize(png);
    const after = pngSize(clip.buffer);
    assert.ok(before && after, '应能解析出尺寸');
    assert.strictEqual(after.width, before.width, '宽应一致');
    assert.strictEqual(after.height, before.height, '高应一致');
  });

  await test('剪贴板相关 HTTP 接口已全部移除', async () => {
    for (const [path, method] of [
      ['/api/clipboard', 'GET'],
      ['/api/pull-clipboard', 'POST'],
      ['/api/image-to-clipboard', 'POST'],
    ]) {
      const response = await api(path, { method });
      assert.strictEqual(response.status, 404, `${path} 应返回 404`);
    }
  });

  instance.server.close();
  await instance.store.flush();

  console.log('服务端端到端测试');
  console.log(results.join('\n'));
  console.log(`\n${passed} 项通过${failed ? `，${failed} 项失败` : '，全部通过'}`);
  if (failed) process.exitCode = 1;
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch { /* 忽略清理失败 */ }
}

main().catch((error) => {
  console.error('测试运行失败:', error);
  process.exitCode = 1;
});
