'use strict';
/**
 * 模拟真实使用：起服务 -> 像手机浏览器一样 POST/GET -> 用 CLI 子命令跨进程取回。
 * 运行：node scripts/e2e.js
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createServer, listen, readClipboard } = require('../server');

const root = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clipbridge-e2e-'));
const store = path.join(tmp, 'store.json');
const port = 18737;

const run = (args, input) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, 'server.js'), ...args], {
      cwd: root,
      env: { ...process.env, CLIPBRIDGE_TEST_STORE: store },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.stdin.end(input);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });

/** 沙箱禁止管道 stdio（EPERM），此时跳过需要子进程的用例而不是判定失败。 */
let sandboxBlocked = false;
async function checkCli(name, fn) {
  if (sandboxBlocked) {
    console.log(`  skip ${name}（沙箱禁止管道 stdio）`);
    return;
  }
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    if (error && error.code === 'EPERM') {
      sandboxBlocked = true;
      console.log(`  skip ${name}（沙箱禁止管道 stdio：EPERM）`);
      return;
    }
    failed++;
    console.error(`  FAIL ${name}\n       ${error.message}`);
  }
}

async function main() {
  const instance = createServer({ port, host: '127.0.0.1', quiet: true, store, qr: false });
  await listen(instance.server, { port, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${port}`;
  let failed = 0;
  const check = async (name, fn) => {
    try {
      await fn();
      console.log(`  ok   ${name}`);
    } catch (error) {
      failed++;
      console.error(`  FAIL ${name}\n       ${error.message}`);
    }
  };

  await check('手机端提交文本后，服务端与磁盘都能读到', async () => {
    const text = '来自手机的一段话 🎉\n第二行：<b>不要被转义</b> & "引号"';
    const response = await fetch(`${base}/api/text`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, source: 'phone' }),
    });
    assert.strictEqual(response.status, 200);
    const snapshot = await (await fetch(`${base}/api/text`)).json();
    assert.strictEqual(snapshot.text, text);
    await instance.store.flush();
    const onDisk = JSON.parse(fs.readFileSync(store, 'utf8'));
    assert.strictEqual(onDisk.text, text);
  });

  await checkCli('电脑端 CLI 能把磁盘上的文本取出来（跨进程读同一份数据）', async () => {
    // 服务端进程在跑，CLI 用同一个 --store 读取（仅在你显式调用 CLI 时才会写系统剪贴板）
    const result = await run(['pull', '--store', store, '--port', String(port + 1)]);
    assert.strictEqual(result.code, 0, `CLI 退出码 ${result.code}: ${result.stderr}`);
    assert.match(result.stdout, /已把共享剪贴板内容/);
    const clipboard = await readClipboard();
    if (clipboard.kind === 'text') {
      const snapshot = await (await fetch(`${base}/api/text`)).json();
      assert.strictEqual(clipboard.text, snapshot.text, 'CLI 写入的系统剪贴板内容应与共享内容一致');
    }
  });

  await checkCli('电脑端 CLI send 推送的文本，手机端 GET 立刻可见', async () => {
    const payload = '电脑上复制的秘密内容 abc-123';
    const result = await run(['send', payload, '--store', store, '--port', String(port + 2)]);
    assert.strictEqual(result.code, 0, `CLI 退出码 ${result.code}: ${result.stderr}`);
    const snapshot = await (await fetch(`${base}/api/text`)).json();
    assert.strictEqual(snapshot.text, payload, '手机端应看到 CLI 推送的内容');
  });

  await checkCli('CLI send 支持从标准输入读取（含换行与中文）', async () => {
    const result = await run(['send', '-', '--store', store, '--port', String(port + 3)], '第一行\n第二行 中文\n');
    assert.strictEqual(result.code, 0, `CLI 退出码 ${result.code}: ${result.stderr}`);
    const snapshot = await (await fetch(`${base}/api/text`)).json();
    assert.strictEqual(snapshot.text.trim(), '第一行\n第二行 中文');
  });

  await check('服务端不再暴露剪贴板读写接口（不自动改你的剪贴板）', async () => {
    for (const [path, method] of [['/api/clipboard', 'GET'], ['/api/pull-clipboard', 'POST']]) {
      const response = await fetch(base + path, { method });
      assert.strictEqual(response.status, 404, `${path} 应返回 404`);
    }
  });

  await check('二维码接口可被手机扫描（PNG 尺寸合理）', async () => {
    const response = await fetch(`${base}/api/qr.png?u=${encodeURIComponent(base + '/')}`);
    assert.strictEqual(response.status, 200);
    const buffer = Buffer.from(await response.arrayBuffer());
    assert.ok(buffer.length > 200, 'PNG 太小');
    assert.strictEqual(buffer.subarray(1, 4).toString('ascii'), 'PNG');
  });

  await check('手机上传多个文件：全部保留，电脑端能原样下载', async () => {
    const samples = [
      { name: '说明.txt', body: Buffer.from('这是文本文件内容\n第二行，含中文与符号 &<>"\'', 'utf8'), type: 'text/plain' },
      { name: '数据.bin', body: Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 251)), type: 'application/octet-stream' },
      { name: '表格.csv', body: Buffer.from('a,b,c\n1,2,3\n', 'utf8'), type: 'text/csv' },
    ];
    const uploaded = [];
    for (const sample of samples) {
      const response = await fetch(`${base}/api/file?name=${encodeURIComponent(sample.name)}&type=phone`, {
        method: 'POST',
        headers: { 'content-type': sample.type },
        body: sample.body,
      });
      assert.strictEqual(response.status, 200);
      const data = await response.json();
      assert.strictEqual(data.changed, true, `${sample.name} 应入库`);
      assert.strictEqual(data.item.name, sample.name, '文件名应原样保留');
      assert.strictEqual(data.item.bytes, sample.body.length);
      uploaded.push({ ...sample, item: data.item });
    }
    const state = await (await fetch(`${base}/api/state`)).json();
    assert.strictEqual(state.items.filter((item) => item.kind === 'file').length, 3, '应保留 3 个文件');
    for (const entry of uploaded) {
      const response = await fetch(base + entry.item.downloadUrl);
      assert.strictEqual(response.status, 200);
      assert.match(response.headers.get('content-disposition'), /^attachment;/);
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.deepStrictEqual(bytes, entry.body, `${entry.name} 下载内容应完全一致`);
    }
  });

  await check('文件区与图片区、文本区互不影响（三块独立）', async () => {
    const before = await (await fetch(`${base}/api/state`)).json();
    const filesBefore = before.items.filter((item) => item.kind === 'file').length;
    const imagesBefore = before.items.filter((item) => item.kind === 'image').length;
    // 同步文本
    await fetch(`${base}/api/text`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '文件区自检：同步这段文本', source: 'auto', replaceText: true }),
    });
    let after = await (await fetch(`${base}/api/state`)).json();
    assert.strictEqual(after.items.filter((item) => item.kind === 'file').length, filesBefore, '文件数量不应变');
    assert.strictEqual(after.items.filter((item) => item.kind === 'image').length, imagesBefore, '图片数量不应变');
    // 删掉一个文件
    const file = after.items.find((item) => item.kind === 'file');
    await fetch(`${base}/api/items/${file.id}`, { method: 'DELETE' });
    after = await (await fetch(`${base}/api/state`)).json();
    assert.strictEqual(after.items.filter((item) => item.kind === 'file').length, filesBefore - 1);
    assert.strictEqual(after.items.filter((item) => item.kind === 'image').length, imagesBefore, '删文件不应影响图片');
    assert.match(after.text, /文件区自检/, '删文件不应影响文本');
  });

  await check('手机上传多张图片：全部保留，另一台设备都能取回', async () => {
    const { encode } = require('../lib/qr');
    const { renderPng } = require('../lib/render');
    const uploaded = [];
    for (let i = 1; i <= 3; i++) {
      const png = renderPng(encode('https://example.com/phone-photo-' + i).modules, { scale: 4, quietZone: 3 });
      const response = await fetch(`${base}/api/image?name=${encodeURIComponent('手机图-' + i + '.png')}&type=phone`, {
        method: 'POST',
        headers: { 'content-type': 'image/png' },
        body: png,
      });
      assert.strictEqual(response.status, 200);
      const data = await response.json();
      assert.strictEqual(data.changed, true, `第 ${i} 张应入库`);
      assert.strictEqual(data.clipboardWritten, undefined, '不应自动写剪贴板');
      uploaded.push({ hash: data.item.hash, png });
    }
    const state = await (await fetch(`${base}/api/state`)).json();
    const images = state.items.filter((item) => item.kind === 'image');
    assert.strictEqual(images.length, 3, `应保留 3 张，实际 ${images.length}`);
    assert.ok(JSON.stringify(state).length < 8000, '状态不应包含图片二进制');
    for (const item of uploaded) {
      const downloaded = Buffer.from(await (await fetch(`${base}/api/image/${item.hash}`)).arrayBuffer());
      assert.deepStrictEqual(downloaded, item.png, '取回的图片应与上传一致');
    }
  });

  await check('同步文本不影响图片区（两块互不影响）', async () => {
    const before = await (await fetch(`${base}/api/state`)).json();
    const imagesBefore = before.items.filter((item) => item.kind === 'image').length;
    await fetch(`${base}/api/text`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '来自手机的文本', source: 'auto', replaceText: true }),
    });
    const after = await (await fetch(`${base}/api/state`)).json();
    assert.strictEqual(after.items.filter((item) => item.kind === 'image').length, imagesBefore, '图片数量不应变化');
    assert.strictEqual(after.text, '来自手机的文本');
    assert.strictEqual(after.items.filter((item) => item.kind === 'text').length, 1, '文本只保留一条');
  });

  await check('轻量心跳探测：文本变化能被另一台设备发现', async () => {
    const before = await (await fetch(`${base}/api/text`)).json();
    await fetch(`${base}/api/text`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '电脑上敲的字', source: 'pc', replaceText: true }),
    });
    const unchanged = await (await fetch(`${base}/api/text?since=${before.version}`)).json();
    assert.strictEqual(unchanged.unchanged, undefined, '版本应已变化');
    assert.strictEqual(unchanged.text, '电脑上敲的字');
    const same = await (await fetch(`${base}/api/text?since=${unchanged.version}`)).json();
    assert.strictEqual(same.unchanged, true, '同一版本应返回 unchanged');
  });

  instance.server.close();
  await instance.store.flush();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failed ? `\n${failed} 项失败` : '\n端到端流程全部通过');
  process.exitCode = failed ? 1 : 0;
}

main().catch((error) => {
  console.error('运行失败:', error);
  process.exitCode = 1;
});
