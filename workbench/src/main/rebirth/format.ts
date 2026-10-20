const yaml = require('js-yaml') as {load:(text:string,options:{schema:unknown})=>unknown; JSON_SCHEMA:unknown};
import { rebirthFormat } from '../../shared/rebirthFormat';
import { type RebirthDocument } from '../../shared/rebirth';
import { parseCover } from './cover';
export function unwrap(text: string): string {
  return String(text).trim().replace(/^```(?:markdown|md|json)?\s*\n([\s\S]*?)\n```\s*$/i, '$1').replace(/^\uFEFF/, '');
}
export function agentName(value: unknown): string {
  const raw=value&&typeof value==='object'?Object.values(value).filter(v=>typeof v==='string').join(' '):value;
  const s = String(raw ?? '').trim().toLowerCase();
  return s && s !== '.' && s !== '..' && !/[\\/\x00-\x1f:]/.test(s) ? s : 'other';
}
function scalar(s: string): unknown {
  if (/^["\[{]/.test(s)) { try { return JSON.parse(s); } catch { if(s.startsWith('[')&&s.endsWith(']'))return s.slice(1,-1).split(',').map(v=>scalar(v.trim()));return s; } }
  return s.replace(/^'(.*)'$/, '$1');
}
export function parseMarkdown(input: string, filename = '未命名'): RebirthDocument {
  const text = unwrap(input).replace(/\r\n/g, '\n');
  const head = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(text);
  let meta: Record<string,unknown> = {};
  try {const parsed=yaml.load(head?.[1]??'',{schema:yaml.JSON_SCHEMA});if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed))meta=parsed as Record<string,unknown>;}catch { /* Incomplete legacy headers still use the tolerant line reader below. */ }
  let key='';
  const parsedHeader=Object.keys(meta).length>0;
  for (const line of (head?.[1] ?? '').split('\n')) {
    if(parsedHeader)break;
    const list=/^\s+-\s+(.*)$/.exec(line);
    if(list&&key) {if(!Array.isArray(meta[key]))meta[key]=[];(meta[key] as unknown[]).push(scalar(list[1]));continue;}
    const m=/^([^:#][^:]*):\s*(.*)$/.exec(line);
    if(m) {key=m[1].trim();meta[key]=scalar(m[2]);}
  }
  const field=(key:string)=>typeof meta[key]==='string'?meta[key] as string:'';
  const body = head ? text.slice(head[0].length) : text;
  const blocks = rebirthFormat.splitBlocks(body);
  const firstHeading = /^#{1,6} (.+)$/m.exec(body)?.[1]?.trim();
  return {meta:{...meta,agent:agentName(meta.agent),title:field('title').trim() || firstHeading || filename.replace(/\.md$/i, ''),topic:field('topic') || field('主题'),created:field('created') || field('创建时间') || pacificTime(),no:0,folder:field('folder')},blocks};
}

export function pacificTime(value?:string):string {
 const date=value?new Date(value):new Date();
 if(Number.isNaN(date.getTime()))return value ?? '';
 const parts=new Intl.DateTimeFormat('sv-SE',{timeZone:'America/Los_Angeles',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(date);
 return parts+' PT';
}
export function serializeMarkdown(doc: RebirthDocument): string {
  const m = doc.meta;
  const fields:Record<string,unknown> = {...m,lkw:'rebirth/1',来源对话:m['来源对话'] ?? m.title,创建时间:m['创建时间'] ?? pacificTime(m.created),归档位置:m['归档位置'] ?? m.folder ?? '',格式名:m['格式名'] ?? '默认'};
  delete fields.no; delete fields.cover;
  return `---\n${Object.entries(fields).map(([k,v])=>`${k}: ${JSON.stringify(v ?? '')}`).join('\n')}\n---\n${rebirthFormat.serialize(doc.blocks)}`;
}
/** Small JSON grammar walker used only to locate syntax errors when V8 omits position. */
function jsonErrorPosition(text: string): number {
  let i = 0;
  const fail = (): never => { throw i; };
  const ws = () => { while (/\s/.test(text[i] ?? '') && i < text.length) i++; };
  const string = () => {
    if (text[i++] !== '"') fail();
    while (i < text.length) {
      const c = text[i++];
      if (c === '"') return;
      if (c.charCodeAt(0) < 32) { i--; fail(); }
      if (c === '\\') {
        const esc = text[i++];
        if (esc === 'u') { for(let n=0;n<4;n++) { if(!/[0-9a-f]/i.test(text[i] ?? ''))fail();i++; } }
        else if (!esc || !'"\\/bfnrt'.includes(esc)) { i--; fail(); }
      }
    }
    fail();
  };
  const value = (): void => {
    ws(); const c = text[i];
    if(c === '"') {string();return;}
    if(c === '{') {i++;ws();if(text[i]==='}') {i++;return;}for(;;){ws();if(text[i]!=='"')fail();string();ws();if(text[i++]!==':'){i--;fail();}value();ws();if(text[i]==='}') {i++;return;}if(text[i++]!==','){i--;fail();}}}
    if(c === '[') {i++;ws();if(text[i]===']'){i++;return;}for(;;){value();ws();if(text[i]===']'){i++;return;}if(text[i++]!==','){i--;fail();}}}
    for(const literal of ['true','false','null'])if(text.startsWith(literal,i)){i+=literal.length;return;}
    const n = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i));
    if(n){i+=n[0].length;return;}fail();
  };
  try {value();ws();if(i!==text.length)fail();}catch(pos){return typeof pos==='number'?Math.min(pos,text.length):i;}
  return i;
}

export function parseJson(input: string): RebirthDocument {
  const text = unwrap(input);
  let obj: any;
  try { obj = JSON.parse(text); } catch (err) {
    const message = String((err as Error).message);
    const pos = Number(/position (\d+)/.exec(message)?.[1] ?? jsonErrorPosition(text));
    const before = text.slice(0,pos).split('\n');
    throw new Error(`JSON 语法错误：第 ${before.length} 行，第 ${before[before.length-1].length+1} 列（${message}）`);
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('JSON 必须是对象，缺少 title/blocks');
  for (const key of ['title','blocks']) if (!(key in obj)) throw new Error(`缺少字段 ${key}`);
  if (typeof obj.title !== 'string' || !obj.title.trim()) throw new Error('title 必须是非空字符串');
  if (obj.folder !== undefined && typeof obj.folder !== 'string') throw new Error('folder 必须是相对路径字符串');
  if (!Array.isArray(obj.blocks) || !obj.blocks.length) throw new Error('blocks 必须是非空数组，不能为空');
  parseCover(obj.cover);
  const blocks = obj.blocks.map((b: any,i: number) => {
    const prefix = `第 ${i+1} 块`;
    if (!b || typeof b !== 'object') throw new Error(`${prefix} 格式非法`);
    for (const k of ['title','body']) if (typeof b[k] !== 'string') throw new Error(`${prefix} 缺少 ${k} 或不是字符串`);
    if (b.summary !== undefined && typeof b.summary !== 'string') throw new Error(`${prefix} summary 必须是字符串`);
    return {idx:i+1,title:b.title,type:typeof b.type==='string'?b.type:'',body:(b.summary ? `> 摘要：${b.summary.replace(/[\r\n]/g,' ')}\n\n` : '')+b.body};
  });
  return {meta:{...Object.fromEntries(Object.entries(obj).filter(([k])=>!['blocks','title','cover'].includes(k))),agent:agentName(obj.agent),title:obj.title,topic:typeof obj.topic === 'string' ? obj.topic : String(obj['主题'] ?? ''),created:typeof obj.created === 'string' ? obj.created : typeof obj['创建时间']==='string'?obj['创建时间']:pacificTime(),no:0,cover:obj.cover,folder:typeof obj.folder === 'string' ? obj.folder : ''},blocks:rebirthFormat.splitBlocks(rebirthFormat.serialize(blocks))};
}
export function parseImport(text: string): RebirthDocument { return /^[{[]/.test(unwrap(text)) ? parseJson(text) : parseMarkdown(text); }
