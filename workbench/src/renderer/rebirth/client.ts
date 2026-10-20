import { sessionActiveAgentId } from '../agent-panel/client';
import { kb } from '../kb';
import type { RebirthApi as SharedIPC, RebirthSettings, RebirthLinkKind } from '../../shared/rebirth';
import type { Tree } from './types';
export type LinkKind = RebirthLinkKind;
export type ArchiveSettings = RebirthSettings & { attachRootInfo?:boolean; archive?:{mode:'ai'|'dir';allowNewFolder:boolean;dir:string}; rootDir?:string };
type RebirthIPC = Omit<SharedIPC,'rebirthSettingsGet'|'rebirthSettingsSet'> & {
 rebirthLinkText(input:{kind:LinkKind;id?:string;agentId?:string;distillAgentId?:string}):Promise<{text:string}>;
 rebirthSettingsGet():Promise<ArchiveSettings>;
 rebirthSettingsSet(input:ArchiveSettings):Promise<ArchiveSettings>;
};
const EXPORT_WEB_KEY='rebirth-export-web';
export function exportWebOn():boolean{try{return localStorage.getItem(EXPORT_WEB_KEY)==='1';}catch{return false;}}
export function setExportWeb(on:boolean):void{try{localStorage.setItem(EXPORT_WEB_KEY,on?'1':'0');}catch{/* ignore */}}
/** 普通导出=路径指令；网页版导出=导出版全文。 */
export function importKind():'import'|'importWeb'{return exportWebOn()?'importWeb':'import';}
export function exportKind():'export'|'exportWeb'{return exportWebOn()?'exportWeb':'export';}
/** Never fall back to legacy IPCs: some older versions write the clipboard. */
export async function linkText(kind:LinkKind,id?:string):Promise<string> {
 const sessionAgent=sessionActiveAgentId();
 const agentId=kind==='root'?sessionAgent:undefined;
 const distillAgentId=kind==='create'||kind==='json'?sessionAgent:undefined;
 const result=await call('rebirthLinkText',{kind,...(id?{id}:{}),...(typeof agentId==='string'&&agentId?{agentId}:{}),...(typeof distillAgentId==='string'&&distillAgentId?{distillAgentId}:{})});
 if(!result || typeof result.text!=='string' || !result.text.trim())throw Error('链接文本为空');
 return result.text;
}
export async function copyLink(kind:LinkKind,id?:string):Promise<void> {
 const text=await linkText(kind,id);
 await navigator.clipboard.writeText(text);
}
export function available(name:keyof RebirthIPC):boolean { return typeof (kb as unknown as Partial<RebirthIPC>)?.[name] === 'function'; }
export function call<K extends keyof RebirthIPC>(name:K,...args:Parameters<RebirthIPC[K]>):ReturnType<RebirthIPC[K]> {
 const api=kb as unknown as RebirthIPC; const fn=api?.[name];
 if(typeof fn!=='function') {
  const error=new Error(`当前版本未连接 ${name}，请更新主进程后重试。`);
  if(name==='rebirthDragOut'||name==='onRebirthChanged')throw error;
  return Promise.reject(error) as ReturnType<RebirthIPC[K]>;
 }
 return (fn as Function).apply(api,args);
}
export async function tree():Promise<Tree> {
 if(available('rebirthTree')) {
  const result=await call('rebirthTree');
  const adapt=(f:import('../../shared/rebirth').RebirthFolder):import('./types').Folder=>({path:f.folder,name:f.name,items:f.items,children:f.folders.map(adapt)});
  return {folders:result.root.folders.map(adapt),items:result.root.items,quarantined:result.quarantined};
 }
 if(available('rebirthList')) { const old=await call('rebirthList'); return {folders:[],items:old.groups.flatMap(g=>g.topics.flatMap(t=>t.items.map(i=>({...i,agent:g.agent})))),quarantined:old.quarantined}; }
 return {folders:[],items:[],quarantined:[]};
}
export function subscribe(fn:()=>void):()=>void { return available('onRebirthChanged')?call('onRebirthChanged',fn):()=>{}; }
