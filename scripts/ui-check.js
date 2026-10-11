'use strict';
/**
 * 静态检查网页 UI：内联脚本语法 + 脚本引用的 DOM id 是否存在 + 关键 API 是否齐全。
 * 运行：node scripts/ui-check.js
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');

let failed = 0;
const ok = (name) => console.log(`  ok   ${name}`);
const fail = (name, detail) => {
  failed++;
  console.error(`  FAIL ${name}${detail ? '\n       ' + detail : ''}`);
};

const match = html.match(/<script>([\s\S]*?)<\/script>/);
if (!match) {
  fail('内联脚本存在');
} else {
  const code = match[1];
  try {
    new vm.Script(code, { filename: 'index.html[inline]' });
    ok(`内联脚本语法正确（${code.split('\n').length} 行）`);
  } catch (error) {
    fail('内联脚本语法正确', error.message);
  }

  const ids = [...new Set([...code.matchAll(/el\(['"]([A-Za-z0-9_-]+)['"]\)/g)].map((m) => m[1]))];
  const missing = ids.filter((id) => !new RegExp(`id="${id}"`).test(html));
  if (missing.length) fail('脚本引用的 DOM id 都存在', `缺失: ${missing.join(', ')}`);
  else ok(`脚本引用的 ${ids.length} 个 DOM id 都存在`);

  // 必须提供的能力
  const requirements = [
    ['粘贴/输入文本', /<textarea id="editor"/],
    ['复制出去（写入本机剪贴板）', /id="copyBtn"/],
    ['手动同步按钮', /id="syncBtn"/],
    ['文本区清空按钮', /id="clearTextBtn"/],
    ['图片区清空按钮', /id="clearImagesBtn"/],
    ['自动发送开关', /id="autoPush"/],
    ['自动发送实现（停止输入后推送）', /setTimeout\(\(\) => \{ void doSync\('auto'\)/],
    ['文本区 / 图片区两块独立卡片', /id="editorCard"[\s\S]{0,4000}id="imageCard"/],
    ['二维码入口', /id="shareBtn"/],
  ];
  for (const [name, pattern] of requirements) {
    if (pattern.test(html)) ok(`包含能力：${name}`);
    else fail(`包含能力：${name}`);
  }

  // 不应该再有的东西（已按需求移除）
  const removed = [
    ['自动复制开关已移除', /id="autoCopy"/],
    ['清空不再二次确认', /confirm\(/],
    ['没有历史文本列表', /historyCount|histlabel|toggleHistory/],
    ['不再调用服务端读剪贴板接口', /api\/pull-clipboard|api\/clipboard/],
    ['图片上传不再自动写剪贴板', /clipboardWritten/],
  ];
  for (const [name, pattern] of removed) {
    if (!pattern.test(html)) ok(`已移除：${name}`);
    else fail(`已移除：${name}`);
  }

  // 图片相关能力
  const imageChecks = [
    ['选择图片上传', /<input type="file" id="fileInput" accept="image\/\*" multiple>/],
    ['上传处理', /addEventListener\('change'[\s\S]{0,120}uploadFiles/],
    ['拖拽上传', /addEventListener\('drop'[\s\S]{0,160}uploadFiles/],
    ['粘贴图片上传', /clipboardData[\s\S]{0,200}uploadFiles/],
    ['只挑图片文件（过滤非图片）', /type\.startsWith\('image\/'\)/],
    ['图片走二进制上传（不转 base64）', /body: file/],
    ['缩略图网格（一行可放多个）', /grid-template-columns: repeat\(auto-fill, minmax/],
    ['缩略图能看到预览图', /\.thumb img \{[\s\S]{0,80}object-fit: cover/],
    ['缩略图上有文件名 + 大小（半透明）', /\.thumb \.overlay|\.fname|\.fsize/],
    ['缩略图能直接下载', /class = 'act dl'|'act dl'/],
    ['缩略图操作按钮悬停/触摸时显示', /\.thumb:hover \.act|@media \(hover: none\)/],
    ['缩略图点击放大', /openViewer|showModal/],
    ['大图预览里也有保存入口', /保存图片/],
    ['显示电脑上的文件路径', /电脑上的路径/],
    ['启动时不预填内容（编辑框只有灰色占位提示）', /placeholder="[^"]+"[\s\S]{0,200}id="editor"|id="editor"[\s\S]{0,200}placeholder="/],
  ];
  for (const [name, pattern] of imageChecks) {
    if (pattern.test(html)) ok(`图片能力：${name}`);
    else fail(`图片能力：${name}`);
  }

  // 开关必须待在文本区里，图片区/文件区不出现设置项；三块区域顺序为 文本 -> 图片 -> 文件
  const editorCard = html.slice(html.indexOf('id="editorCard"'), html.indexOf('id="imageCard"'));
  const imageCard = html.slice(html.indexOf('id="imageCard"'), html.indexOf('id="fileCard"'));
  const fileCard = html.slice(html.indexOf('id="fileCard"'), html.indexOf('</main>'));
  if (/id="autoPush"/.test(editorCard)) ok('自动发送开关位于文本区');
  else fail('自动发送开关位于文本区');
  if (!/switch|autoPush/.test(imageCard)) ok('图片区里没有设置项');
  else fail('图片区里没有设置项');
  if (!/switch|autoPush/.test(fileCard)) ok('文件区里没有设置项');
  else fail('文件区里没有设置项');
  if (!/id="imageBanner"|收到新图片/.test(html)) ok('已移除：图片通知条');
  else fail('已移除：图片通知条');

  // 文件区能力（与图片区逻辑一致）
  const fileChecks = [
    ['文本 / 图片 / 文件 三块独立成卡',
      /id="editorCard"[\s\S]*id="imageCard"[\s\S]*id="fileCard"/],
    ['选择文件（不限类型、可多选）', /<input type="file" id="fileInputAny" multiple>/],
    ['文件走二进制上传', /uploadAnyFile[\s\S]{0,320}body: file/],
    ['拖入按类型自动分流（图片进图片区、其余进文件区）', /type\.startsWith\('image\/'\)[\s\S]{0,500}others/],
    ['文件行显示文件名与大小', /className = 'fname2'[\s\S]{0,240}className = 'fsub'/],
    ['文件行有类型图标', /className = 'ficon'/],
    ['单个文件可下载', /item\.downloadUrl/],
    ['单个文件可删除', /items\/' \+ encodeURIComponent\(item\.id\)/],
    ['可清空文件区', /id="clearFilesBtn"/],
    ['文件区说明了不限类型/不限大小', /不限制大小/],
  ];
  for (const [name, pattern] of fileChecks) {
    if (pattern.test(html)) ok(`文件能力：${name}`);
    else fail(`文件能力：${name}`);
  }

  // 移动端可用性
  const mobileChecks = [
    ['viewport 声明', /name="viewport"[^>]*width=device-width/],
    ['非安全上下文剪贴板兜底（execCommand）', /execCommand\('copy'\)/],
    ['安全上下文检查', /isSecureContext/],
    ['裁剪文本兜底（无法读剪贴板时提示手动复制）', /长按编辑框手动全选复制|手动复制|长按下面的内容/],
  ];
  for (const [name, pattern] of mobileChecks) {
    if (pattern.test(html)) ok(`移动端：${name}`);
    else fail(`移动端：${name}`);
  }
}

console.log(failed ? `\n${failed} 项失败` : '\nUI 检查全部通过');
process.exitCode = failed ? 1 : 0;
