'use strict';
/** 对正在运行的实例做一次自检（默认 http://127.0.0.1:8737）。 */
const base = process.argv[2] || 'http://127.0.0.1:8737';

function formatBytes(bytes) {
  if (bytes === undefined || bytes === null) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(2) + ' MB';
}

(async () => {
  const results = [];
  const add = (name, ok, detail) => results.push(`${ok ? '  ok  ' : '  FAIL'} ${name}${detail ? ' — ' + detail : ''}`);

  try {
    const response = await fetch(base + '/');
    const html = await response.text();
    add('首页可访问', response.ok && html.includes('ClipBridge'), `${response.status}, ${Buffer.byteLength(html)} 字节`);
    add('页面含深色模式与移动端适配', /prefers-color-scheme/.test(html) && /viewport-fit=cover/.test(html));
    add(
      '页面含核心按钮',
      ['copyBtn', 'syncBtn', 'clearTextBtn', 'clearImagesBtn', 'shareBtn'].every((id) => html.includes(`id="${id}"`)),
    );
    add('页面含图片上传入口', /id="fileInput"/.test(html) && /accept="image\/\*"/.test(html));
    add('已移除自动复制', !/id="autoCopy"/.test(html));
    add('已移除「读取电脑剪贴板」按钮', !/id="readPcBtn"/.test(html));
    add('文本区与图片区分离', /id="editorCard"/.test(html) && /id="imageCard"/.test(html));
  } catch (error) {
    add('首页可访问', false, error.message);
  }

  try {
    const info = await (await fetch(base + '/api/info')).json();
    add('服务信息接口', info.ok === true, `地址 ${info.addresses.join(', ')}:${info.port}`);
  } catch (error) {
    add('服务信息接口', false, error.message);
  }

  try {
    const current = await (await fetch(base + '/api/text')).json();
    add(
      '共享内容可读',
      typeof current.text === 'string',
      `版本 ${current.version}，${Buffer.byteLength(current.text, 'utf8')} 字节，来源 ${current.source || '-'}`,
    );
    console.log('  当前共享内容预览:', JSON.stringify(current.text.slice(0, 60)));
  } catch (error) {
    add('共享内容可读', false, error.message);
  }

  try {
    const png = Buffer.from(await (await fetch(base + '/api/qr.png?u=' + encodeURIComponent(base))).arrayBuffer());
    add('二维码接口', png.subarray(1, 4).toString('ascii') === 'PNG', `${png.length} 字节`);
  } catch (error) {
    add('二维码接口', false, error.message);
  }

  console.log(results.join('\n'));
  const failed = results.filter((line) => line.includes('FAIL')).length;
  console.log(failed ? `\n${failed} 项异常` : '\n实例自检全部通过');
  process.exitCode = failed ? 1 : 0;
})();
