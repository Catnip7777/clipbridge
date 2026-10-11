'use strict';
/**
 * 在最小 DOM 桩上真实执行 public/index.html 里的 renderThumb，
 * 校验缩略图结构：文件名 + 大小 + 直接下载 + 删除，以及点击行为。
 * 运行：node scripts/check-thumb.js
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');

/** 抽出 renderThumb 函数源码 */
function extractFunction(name) {
  const start = html.indexOf(`function ${name}(`);
  if (start < 0) throw new Error('找不到函数 ' + name);
  let depth = 0;
  let i = html.indexOf('{', start);
  const bodyStart = i;
  for (; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') {
      depth--;
      if (depth === 0) return html.slice(start, i + 1);
    }
  }
  void bodyStart;
  throw new Error('函数 ' + name + ' 括号不匹配');
}

// ---------------------------------------------------------------- 极简 DOM 桩

class El {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.attributes = {};
    this.listeners = {};
    this.style = {};
    this.className = '';
    this._text = '';
    this.parent = null;
  }

  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text || this.children.map((c) => c.textContent).join(''); }
  set href(value) { this.attributes.href = value; }
  get href() { return this.attributes.href; }
  set src(value) { this.attributes.src = value; }
  set title(value) { this.attributes.title = value; }
  set type(value) { this.attributes.type = value; }
  set alt(value) { this.attributes.alt = value; }
  set loading(value) { this.attributes.loading = value; }

  appendChild(child) { child.parent = this; this.children.push(child); return child; }
  setAttribute(name, value) { this.attributes[name] = value; }
  getAttribute(name) { return this.attributes[name]; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  removeChild(child) { this.children = this.children.filter((c) => c !== child); }

  /** 深度优先查找 */
  find(predicate) {
    if (predicate(this)) return this;
    for (const child of this.children) {
      const hit = child.find ? child.find(predicate) : null;
      if (hit) return hit;
    }
    return null;
  }

  all(predicate, out = []) {
    if (predicate(this)) out.push(this);
    for (const child of this.children) if (child.all) child.all(predicate, out);
    return out;
  }
}

const documentStub = {
  createElement: (tag) => new El(tag),
};

// ---------------------------------------------------------------- 执行

const context = {
  document: documentStub,
  console,
  // renderThumb / renderFileRow 依赖的辅助函数（与页面实现保持一致）
  asset: (pathname) => String(pathname).split('?')[0],
  formatBytes: (n) => {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(2) + ' MB';
  },
  sourceLabel: () => '手机',
  timeAgo: () => '刚刚',
  api: async () => ({ ok: true, json: async () => ({}) }),
  refresh: async () => {},
  toast: () => {},
  openViewer: () => { context.__viewerOpened = true; },
  __viewerOpened: false,
};
context.globalThis = context;
vm.createContext(context);
vm.runInContext(extractFunction('renderThumb'), context);

const item = {
  id: 'i9',
  kind: 'image',
  hash: 'abc',
  name: 'ymx可爱捏.png',
  mime: 'image/png',
  bytes: 86016,
  width: 800,
  height: 600,
  paths: [],
  url: '/api/image/abc',
  source: 'phone',
  at: new Date().toISOString(),
};

const cell = vm.runInContext('renderThumb', context)(item);
let failed = 0;
const check = (name, ok, detail) => {
  if (ok) console.log(`  ok   ${name}${detail ? ' — ' + detail : ''}`);
  else { failed++; console.error(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};

check('缩略图根节点带 thumb 类', /(^|\s)thumb(\s|$)/.test(cell.className), cell.className);

const img = cell.find((n) => n.tagName === 'IMG');
check('包含图片元素且指向图片接口',
  Boolean(img) && img.attributes.src === '/api/image/' + item.hash,
  img && img.attributes.src);

const overlay = cell.find((n) => /(^|\s)overlay(\s|$)/.test(n.className));
check('缩略图上有文件名 + 大小的浮层', Boolean(overlay));

const fname = overlay && overlay.find((n) => /(^|\s)fname(\s|$)/.test(n.className));
const fsize = overlay && overlay.find((n) => /(^|\s)fsize(\s|$)/.test(n.className));
check('浮层显示文件名', Boolean(fname) && fname.textContent === 'ymx可爱捏.png', fname && fname.textContent);
check('浮层显示大小', Boolean(fsize) && fsize.textContent === '84.0 KB', fsize && fsize.textContent);

const download = cell.find((n) => /(^|\s)act(\s|$)/.test(n.className) && /(^|\s)dl(\s|$)/.test(n.className));
check('缩略图上有直接下载入口', Boolean(download) && download.tagName === 'A', download && download.tagName);
check('下载入口带 download 文件名', Boolean(download) && download.getAttribute('download') === 'ymx可爱捏.png',
  download && download.getAttribute('download'));

const remove = cell.find((n) => /(^|\s)rm(\s|$)/.test(n.className));
check('缩略图上有删除按钮', Boolean(remove) && remove.tagName === 'BUTTON');

// 点击缩略图 → 打开大图
for (const fn of cell.listeners.click || []) fn();
check('点击缩略图会打开大图预览', context.__viewerOpened === true);

// 点击下载不应冒泡（否则会同时打开大图）
context.__viewerOpened = false;
const stopped = { stopPropagation: () => { stopped.called = true; } };
for (const fn of download.listeners.click || []) fn(stopped);
check('点下载不会顺带打开大图', stopped.called === true && context.__viewerOpened === false);

// ---------------------------------------------------------------- 文件行（renderFileRow）

vm.runInContext(extractFunction('renderFileRow'), context);
const fileItem = {
  id: 'f1',
  kind: 'file',
  hash: 'deadbeef',
  name: '季度报表.xlsx',
  mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  bytes: 2 * 1024 * 1024 + 512 * 1024,
  ext: 'xlsx',
  url: '/api/file/deadbeef',
  downloadUrl: '/api/file/deadbeef?download=1',
  source: 'phone',
  at: new Date().toISOString(),
};
const row = vm.runInContext('renderFileRow', context)(fileItem);

check('文件行根节点带 filerow 类', /(^|\s)filerow(\s|$)/.test(row.className), row.className);
const icon = row.find((n) => /(^|\s)ficon(\s|$)/.test(n.className));
check('有类型图标且显示扩展名', Boolean(icon) && icon.textContent === 'xlsx', icon && icon.textContent);
const nameEl = row.find((n) => /(^|\s)fname2(\s|$)/.test(n.className));
check('显示文件名', Boolean(nameEl) && nameEl.textContent === '季度报表.xlsx', nameEl && nameEl.textContent);
const subEl = row.find((n) => /(^|\s)fsub(\s|$)/.test(n.className));
check('副标题显示大小与来源',
  Boolean(subEl) && /2\.50 MB/.test(subEl.textContent) && /手机/.test(subEl.textContent),
  subEl && subEl.textContent);
const dl = row.find((n) => n.tagName === 'A');
check('下载链接指向 downloadUrl', Boolean(dl) && dl.href === '/api/file/deadbeef', dl && dl.href);
check('下载链接带 download 文件名', Boolean(dl) && dl.getAttribute('download') === '季度报表.xlsx',
  dl && dl.getAttribute('download'));
const rm = row.find((n) => n.tagName === 'BUTTON');
check('有删除按钮', Boolean(rm) && rm.textContent === '删除', rm && rm.textContent);

console.log(failed ? `\n${failed} 项失败` : '\n缩略图 + 文件行结构校验全部通过');
process.exitCode = failed ? 1 : 0;
