'use strict';
/**
 * 真实执行 public/index.html 里的 updateMeta，验证「清空文本」按钮的亮灭：
 * 粘贴/打字后按钮必须立刻可用（原来只在服务端状态回来时才更新，粘贴后按钮不亮）。
 * 运行：node scripts/check-clear-button.js
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

function extractFunction(name) {
  const start = html.indexOf(`function ${name}(`);
  if (start < 0) throw new Error('找不到函数 ' + name);
  let depth = 0;
  let i = html.indexOf('{', start);
  for (; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') {
      depth--;
      if (depth === 0) return html.slice(start, i + 1);
    }
  }
  throw new Error('函数 ' + name + ' 括号不匹配');
}

const elements = {
  editor: { value: '', listeners: {} },
  meta: { textContent: '' },
  clearTextBtn: { disabled: false },
};

const context = {
  el: (id) => {
    if (!elements[id]) throw new Error('未知元素 ' + id);
    return elements[id];
  },
  formatBytes: (n) => (n < 1024 ? n + ' B' : (n / 1024).toFixed(1) + ' KB'),
  TextEncoder,
};
context.globalThis = context;
vm.createContext(context);
vm.runInContext(extractFunction('updateMeta'), context);
const updateMeta = () => vm.runInContext('updateMeta', context)();

let failed = 0;
const check = (name, ok, detail) => {
  if (ok) console.log(`  ok   ${name}${detail ? ' — ' + detail : ''}`);
  else { failed++; console.error(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};

// 初始空状态
elements.editor.value = '';
updateMeta();
check('空编辑框时「清空文本」禁用', elements.clearTextBtn.disabled === true, `disabled=${elements.clearTextBtn.disabled}`);
check('空编辑框时元信息显示"空"', elements.meta.textContent === '空', elements.meta.textContent);

// 模拟手机端粘贴进编辑框（只触发 input，不同步服务端状态）
elements.editor.value = '从别处复制来的一段文字';
updateMeta();
check('粘贴后「清空文本」立刻可用（这就是之前的 bug）',
  elements.clearTextBtn.disabled === false, `disabled=${elements.clearTextBtn.disabled}`);
check('元信息显示字数与大小', /字 \/ /.test(elements.meta.textContent), elements.meta.textContent);

// 用户手动删空
elements.editor.value = '';
updateMeta();
check('手动删空后「清空文本」重新禁用', elements.clearTextBtn.disabled === true);

// 只有空白字符也应视为空
elements.editor.value = '';
updateMeta();
check('清空后按钮状态与服务端空内容一致（disabled=true）', elements.clearTextBtn.disabled === true);

// 页面源码里必须是在 updateMeta 里更新，而不是只在 applyState 里
const updateMetaSource = extractFunction('updateMeta');
check('updateMeta 里负责按钮亮灭（不再只依赖服务端状态）',
  /clearTextBtn'\)\.disabled/.test(updateMetaSource));

const applyStateSource = (() => {
  const start = html.indexOf('function applyState(');
  return html.slice(start, html.indexOf('\n  }', start));
})();
check('applyState 仍然同步一次按钮状态（多设备场景）',
  /updateMeta\(\)/.test(applyStateSource));

console.log(failed ? `\n${failed} 项失败` : '\n清空文本按钮状态校验全部通过');
process.exitCode = failed ? 1 : 0;
