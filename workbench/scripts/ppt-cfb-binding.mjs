import { readFileSync } from 'node:fs';

// ppt.js 在严格模块里把 CFB / cptable 当成隐式全局。
// Worker 包是 "use strict"，未声明赋值会在加载时抛 ReferenceError，docx 也打不开。
// 在 make_ppt 里补上 var，赋值落在函数作用域，require('cfb') 的结果仍给后面的 CFB.read 用。

export function bindPptCfb(source) {
  const needle = '(function make_ppt(PPT) {';
  if (!source.includes(needle)) return source;
  if (source.includes('function make_ppt(PPT) {\nvar CFB;')) return source;
  return source.replace(needle, `${needle}\nvar CFB;\nvar cptable;`);
}

function pptFile(id) {
  return String(id).split('?')[0].replaceAll('\\', '/');
}

export function pptCfbBinding() {
  return {
    name: 'ppt-cfb-binding',
    enforce: 'pre',
    load(id) {
      const file = pptFile(id);
      if (!file.endsWith('/ppt/ppt.js')) return null;
      return bindPptCfb(readFileSync(file, 'utf8'));
    },
    transform(code, id) {
      const file = pptFile(id);
      if (!file.endsWith('/ppt/ppt.js') && !code.includes('(function make_ppt(PPT) {')) return null;
      const next = bindPptCfb(code);
      return next === code ? null : { code: next, map: null };
    },
  };
}
