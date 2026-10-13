import { escapeHtml } from './html';

const ALIAS: Record<string, string> = {
  js: 'js', javascript: 'js', jsx: 'js', mjs: 'js', cjs: 'js',
  ts: 'ts', typescript: 'ts', tsx: 'ts',
  py: 'py', python: 'py',
  json: 'json',
  css: 'css',
  html: 'html', htm: 'html', xml: 'html', svg: 'html',
  sh: 'sh', bash: 'sh', shell: 'sh', zsh: 'sh', ps1: 'sh',
  sql: 'sql',
  c: 'c', h: 'c', cpp: 'cpp', cxx: 'cpp', cc: 'cpp', hpp: 'cpp',
  java: 'java', cs: 'java', go: 'go', rs: 'rust', rust: 'rust',
  tex: 'tex', latex: 'tex',
  yml: 'yaml', yaml: 'yaml', toml: 'yaml', ini: 'yaml',
  md: 'md', markdown: 'md',
};

const KEYWORDS: Record<string, string> = {
  js: 'const let var function return if else for while class import export from new async await try catch throw typeof instanceof of in break continue switch case default',
  ts: 'const let var function return if else for while class import export from new async await try catch throw typeof instanceof of in break continue switch case default type interface implements public private protected readonly enum extends',
  py: 'def class return if elif else for while import from as try except finally with yield lambda pass in not and or None True False',
  css: 'important',
  sh: 'if then else fi for while do done case esac in function return echo export local',
  sql: 'select from where and or not insert into update set delete create table join left right inner on as group by order limit values null',
  c: 'if else for while return struct const int void char long short unsigned signed sizeof switch case break continue typedef include',
  cpp: 'if else for while return struct const int void char long class public private protected new delete namespace using template typename auto include',
  java: 'if else for while return class public private protected new void int long boolean import package static final try catch throw extends implements',
  go: 'func return if else for range package import var const type struct interface go defer map',
  rust: 'fn let mut const if else for while loop return struct enum impl trait pub use mod match',
  yaml: 'true false null',
  json: '',
  html: '',
  tex: '',
  md: '',
};

export function normalizeLang(lang: string): string {
  const key = lang.trim().toLowerCase().split(/\s+/)[0] ?? '';
  return ALIAS[key] ?? key;
}

function keywordSet(lang: string): Set<string> | null {
  const words = KEYWORDS[lang];
  if (words == null) return null;
  return new Set(words.split(/\s+/).filter(Boolean));
}

function isWord(ch: string): boolean {
  return /[A-Za-z0-9_]/.test(ch);
}

/**
 * 不依赖 highlight.js。注释、字符串、数字、关键字包进 span。
 * 调用方要把结果放进 markdown-it 的 highlight（它不会再转义）。
 */
export function highlightCode(code: string, lang: string): string {
  const key = normalizeLang(lang);
  const keywords = keywordSet(key);
  const out: string[] = [];
  const n = code.length;
  let i = 0;
  const pushText = (s: string) => {
    if (s) out.push(escapeHtml(s));
  };
  const pushSpan = (cls: string, s: string) => {
    if (s) out.push(`<span class="${cls}">${escapeHtml(s)}</span>`);
  };
  while (i < n) {
    const ch = code[i];
    const next = code[i + 1] ?? '';
    if (key === 'html' && code.startsWith('<!--', i)) {
      const end = code.indexOf('-->', i + 4);
      const stop = end < 0 ? n : end + 3;
      pushSpan('kb-hl-comment', code.slice(i, stop));
      i = stop;
      continue;
    }
    if ((key === 'js' || key === 'ts' || key === 'css' || key === 'c' || key === 'cpp' || key === 'java' || key === 'go' || key === 'rust' || key === 'sql') && ch === '/' && next === '/') {
      const end = code.indexOf('\n', i);
      const stop = end < 0 ? n : end;
      pushSpan('kb-hl-comment', code.slice(i, stop));
      i = stop;
      continue;
    }
    if ((key === 'js' || key === 'ts' || key === 'css' || key === 'c' || key === 'cpp' || key === 'java' || key === 'go' || key === 'rust' || key === 'sql') && ch === '/' && next === '*') {
      const end = code.indexOf('*/', i + 2);
      const stop = end < 0 ? n : end + 2;
      pushSpan('kb-hl-comment', code.slice(i, stop));
      i = stop;
      continue;
    }
    if ((key === 'py' || key === 'sh' || key === 'yaml') && ch === '#') {
      const end = code.indexOf('\n', i);
      const stop = end < 0 ? n : end;
      pushSpan('kb-hl-comment', code.slice(i, stop));
      i = stop;
      continue;
    }
    if (key === 'sql' && ch === '-' && next === '-') {
      const end = code.indexOf('\n', i);
      const stop = end < 0 ? n : end;
      pushSpan('kb-hl-comment', code.slice(i, stop));
      i = stop;
      continue;
    }
    if (key === 'tex' && ch === '%' && (i === 0 || code[i - 1] !== '\\')) {
      const end = code.indexOf('\n', i);
      const stop = end < 0 ? n : end;
      pushSpan('kb-hl-comment', code.slice(i, stop));
      i = stop;
      continue;
    }
    if (key === 'tex' && ch === '\\' && /[A-Za-z]/.test(next)) {
      let j = i + 1;
      while (j < n && /[A-Za-z]/.test(code[j])) j++;
      pushSpan('kb-hl-keyword', code.slice(i, j));
      i = j;
      continue;
    }
    if (ch === '"' || ch === "'" || (ch === '`' && (key === 'js' || key === 'ts' || key === 'go'))) {
      let j = i + 1;
      while (j < n) {
        if (code[j] === '\\') {
          j += 2;
          continue;
        }
        if (code[j] === ch) {
          j++;
          break;
        }
        if (ch !== '`' && code[j] === '\n') break;
        j++;
      }
      pushSpan('kb-hl-string', code.slice(i, j));
      i = j;
      continue;
    }
    if (ch >= '0' && ch <= '9' && (i === 0 || !isWord(code[i - 1]))) {
      let j = i + 1;
      while (j < n && /[0-9._xXa-fA-F]/.test(code[j])) j++;
      pushSpan('kb-hl-number', code.slice(i, j));
      i = j;
      continue;
    }
    if (keywords && keywords.size && /[A-Za-z_]/.test(ch) && (i === 0 || !isWord(code[i - 1]))) {
      let j = i + 1;
      while (j < n && isWord(code[j])) j++;
      const word = code.slice(i, j);
      if (keywords.has(word)) pushSpan('kb-hl-keyword', word);
      else pushText(word);
      i = j;
      continue;
    }
    pushText(ch);
    i++;
  }
  return out.join('');
}
