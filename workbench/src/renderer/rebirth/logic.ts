import { blockCheck } from '../../shared/rebirthSubblocks';
import { rebirthFormat } from '../../shared/rebirthFormat';
import type { Block, Folder, Selection } from './types';
export const selectedIds=(blocks:Block[],s:Selection)=>blocks.filter(b=>{const check=blockCheck(b,s);return check.checked||check.indeterminate;}).map(b=>b.idx);
export function reorder<T>(rows:T[],from:number,to:number):T[] { const out=[...rows]; if(from<0||to<0||from>=out.length||to>=out.length)return out; out.splice(to,0,out.splice(from,1)[0]!); return out; }
export function folderPaths(folders:Folder[]):string[] { return folders.flatMap(f=>[f.path,...folderPaths(f.children||[])]); }
export function canMoveFolder(path:string,target:string):boolean { return path!==target&&!target.startsWith(path+'/'); }
export function importKind(text:string):'json'|'md' { return stripFence(text).startsWith('{')?'json':'md'; }
export function stripFence(text:string):string { return text.trim().replace(/^```(?:json|markdown|md)?\s*\n/i,'').replace(/\n```\s*$/,'').trim(); }
export const DRAG_MIME='application/x-lkw-rebirth';
export function prepareImport(input:string):string {
 const text=stripFence(input);
 if(!text)throw Error('请粘贴 json 或 md 内容');
 if(importKind(text)==='json'){
  let doc:Record<string,unknown>;
  try{doc=JSON.parse(text);}catch(e){const message=String(e);const pos=/position (\d+)/.exec(message);const before=text.slice(0,pos?Number(pos[1]):0);throw Error(`JSON 语法错误：第 ${before.split('\n').length} 行，第 ${(before.split('\n').pop()?.length||0)+1} 列。${message}`);}
  if(!doc||typeof doc!=='object'||Array.isArray(doc))throw Error('JSON 必须是对象');
  if(typeof doc.title!=='string'||!doc.title.trim())throw Error('缺少 title');
  if(!Array.isArray(doc.blocks)||doc.blocks.length===0)throw Error('blocks 必须是非空数组');
  doc.blocks.forEach((block:unknown,i:number)=>{if(!block||typeof block!=='object')throw Error(`第 ${i+1} 块格式错误`);const b=block as Record<string,unknown>;if(typeof b.title!=='string')throw Error(`第 ${i+1} 块缺少 title`);if(typeof b.body!=='string')throw Error(`第 ${i+1} 块缺少 body`);});
  if(doc.folder!==undefined&&(typeof doc.folder!=='string'||!safeFolder(doc.folder)))throw Error('folder 不允许绝对路径或 ..');
 } else { rebirthFormat.splitBlocks(text); }
 return text;
}
export function safeFolder(path:string):boolean{return !/^(?:[a-z]:|[\\/])/i.test(path)&&!path.split(/[\\/]/).some(p=>p==='..'||p==='.')&&!path.includes('\0');}
