import {useRef,useState} from 'react';
import {call,copyLink,exportKind,importKind} from './client';
import {confirmFewerImport,confirmPickedImport} from './importConfirm';

/** 备份文件名里的时间。认不出就原样返回，避免时区把标签改丢。 */
export function backupVersionLabel(version: string): string {
  const m = /^(\d{4})-(\d\d)-(\d\d)T(\d\d)-(\d\d)-(\d\d)/.exec(version);
  if (!m) return version;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])).toLocaleString();
}

export function Transfer({id}:{id:string}) {
 const [dialog,setDialog]=useState<'merge'|null>(null),[text,setText]=useState(''),[error,setError]=useState(''),[versions,setVersions]=useState<{version:string}[]>([]);
 const versionRef=useRef<HTMLDetailsElement>(null);
 const run=async(fn:()=>Promise<unknown>)=>{try{setError('');await fn();}catch(e){setError(e instanceof Error?e.message:String(e));}};
 const [notice,setNotice]=useState('');
 const copy=async(kind:'import'|'importWeb'|'export'|'exportWeb')=>{await copyLink(kind,id);setNotice('已复制');setTimeout(()=>setNotice(''),2000);};
 const loadVersions=()=>run(async()=>{setVersions(await call('rebirthBackups',{id}));});
 const closeVersion=()=>{if(versionRef.current)versionRef.current.open=false;};
 return <span className="rb-transfer" onDoubleClick={e=>e.stopPropagation()} onDragStart={e=>e.stopPropagation()}>
 <button title="导入（勾选网页版时复制全文+合并指令，并打开「导入合并」框）" onClick={()=>void run(async()=>{const k=importKind();await copy(k);if(k==='importWeb')setDialog('merge');})}>导入</button><button title="导出（勾选「导出用网页版」时复制全文）；可拖出导出版文件" draggable onDragStart={e=>{e.preventDefault();e.stopPropagation();void call('rebirthDragOut',{id});}} onClick={()=>void run(()=>copy(exportKind()))}>导出</button>{notice&&<span className="rb-toast" role="status">{notice}</span>}
 <button onClick={()=>setDialog('merge')}>导入合并…</button>
 <details className="rb-version" ref={versionRef} onToggle={e=>{if(e.currentTarget.open)void loadVersions();}}>
  <summary>版本<span className="rb-caret" aria-hidden="true"/></summary>
  <div className="rb-version-menu" role="group" aria-label="选择备份版本">
   {versions.length===0&&<p>还没有备份版本。</p>}
   {versions.map(v=><button key={v.version} onClick={()=>void run(async()=>{await call('rebirthRestore',{id,version:v.version});closeVersion();})}>恢复 {backupVersionLabel(v.version)} 的版本</button>)}
   <button onClick={()=>void loadVersions()}>回退到版本…</button>
   <button onClick={()=>{closeVersion();setError('');}}>取消</button>
  </div>
 </details>
 {dialog==='merge'&&<div className="rb-inline rb-pop" role="group" aria-label="导入合并">
 <p>校验后整体替换这份资料，旧内容自动备份。</p><textarea aria-label="合并 JSON" value={text} onChange={e=>setText(e.target.value)}/><button onClick={()=>void run(async()=>{const r=await confirmFewerImport(confirmFewer=>call('rebirthMerge',{id,text,...(confirmFewer?{confirmFewer:true}:{})}));if(!r||r.needsConfirm)return;setDialog(null);setText('');})}>替换内容</button><button onClick={()=>void run(async()=>{const r=await confirmPickedImport(picked=>call('rebirthMerge',picked===undefined?{id,pickFile:true}:{id,text:picked,confirmFewer:true}));if(r&&!r.needsConfirm)setDialog(null);})}>选择 .json 文件…</button>
 <button onClick={()=>{setDialog(null);setError('');}}>取消</button>{error&&<p role="alert">{error}</p>}</div>}{!dialog&&error&&<p role="alert">{error}</p>}</span>;
}
