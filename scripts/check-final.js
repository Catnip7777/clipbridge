'use strict';
/** 对正在运行的实例做最终确认（只读，不改任何内容）。 */
const base = process.argv[2] || 'http://127.0.0.1:8737';

(async () => {
  const response = await fetch(base + '/');
  const html = await response.text();
  const rows = [];
  const add = (name, ok, detail) => rows.push(`${ok ? '  ok  ' : '  FAIL'} ${name}${detail ? ' — ' + detail : ''}`);

  add('首页可访问', response.ok, `${response.status}, ${Buffer.byteLength(html)} 字节`);
  add('无乱码', !/\uFFFD/.test(html));
  add('清空按钮实时亮灭的修复已在线', /clearTextBtn'\)\.disabled = value\.length === 0/.test(html));
  add('自动发送开关在文本区（图片区之前）',
    html.indexOf('id="autoPush"') > 0 && html.indexOf('id="autoPush"') < html.indexOf('id="imageCard"'));
  const imageZone = html.slice(html.indexOf('id="imageCard"'), html.indexOf('id="fileCard"'));
  const fileZone = html.slice(html.indexOf('id="fileCard"'), html.indexOf('</main>'));
  add('图片区里没有开关', !/switch/.test(imageZone));
  add('文件区里没有开关', !/switch/.test(fileZone));
  add('图片通知条已移除', !/imageBanner/.test(html));
  add('缩略图文件名+大小浮层存在', /className = 'overlay'/.test(html) && /className = 'fname'/.test(html));
  add('缩略图可直接下载', /className = 'act dl'/.test(html));
  add('三块区域顺序为 文本 → 图片 → 文件',
    html.indexOf('id="editorCard"') < html.indexOf('id="imageCard"')
    && html.indexOf('id="imageCard"') < html.indexOf('id="fileCard"'));
  add('文件区就绪（选择文件 / 清空文件 / 文件行模板）',
    /id="pickFileBtn"/.test(html) && /id="clearFilesBtn"/.test(html)
    && /id="fileInputAny"/.test(html) && /filerow/.test(html) && /ficon/.test(html));

  const state = await (await fetch(base + '/api/state')).json();
  add('共享状态可读', typeof state.text === 'string',
    `版本 ${state.version}，文本 ${Buffer.byteLength(state.text, 'utf8')} 字节，图片 ${state.items.filter((i) => i.kind === 'image').length} 张，文件 ${state.items.filter((i) => i.kind === 'file').length} 个`);
  const info = await (await fetch(base + '/api/info')).json();
  add('服务端已支持文件区且不限大小',
    Boolean(info.limits && info.limits.fileUnlimited === true),
    info.limits
      ? (info.limits.fileUnlimited
        ? '文件不限大小 / 不限数量'
        : `单文件上限 ${(info.limits.maxFile / 1024 / 1024).toFixed(0)} MB，最多 ${info.limits.maxFiles} 个`)
      : '缺少 limits 字段');

  console.log(rows.join('\n'));
  const failed = rows.filter((line) => line.includes('FAIL')).length;
  console.log(failed ? `\n${failed} 项异常` : '\n最终确认全部通过');
  process.exitCode = failed ? 1 : 0;
})();
