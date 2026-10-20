import React from 'react';
import { Settings } from 'lucide-react';
import { openSettings } from '../settings/openSettings';
import { useEffect, useState } from 'react';
import { available, call, copyLink, subscribe, tree, exportKind, importKind, exportWebOn, setExportWeb, type LinkKind } from './client';
import { confirmFewerImport } from './importConfirm';
import { canMoveFolder, DRAG_MIME, folderPaths, prepareImport } from './logic';
import { SkillList } from './Skills';
import { dialogs } from '../ui/dialogs';
import { splitDistillPaste, type SkillLibraryView } from '../../shared/skillLibrary';
import type { SkillAttachRef } from '../../shared/skillDistill';
import { HINT_AGENT_REPO } from '../dnd/copy';
import { openRebirth } from './openDock';
import { kb } from '../kb';
import { useAgentLive } from '../agent-live/context';
import { filterMemberTree, memberIdSet, type MembershipFile } from '../../shared/rebirthMembership';
import type { Card, Folder, Tree } from './types';
import './styles.css';
type Target={id?:string;path?:string;name:string};
const repoMenuPoint={x:8,y:8};
function RbIc({d}:{d:string}){return <svg className="rb-ic" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d={d} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>;}
const RB_CHEV_OPEN='M3.5 6 L8 10.5 L12.5 6';
const RB_CHEV_CLOSED='M6 3.5 L10.5 8 L6 12.5';
const RB_FOLDER='M2 6 h4 l1.2-1.6 H14 V13 H2 Z';
const RB_FILE='M4 2.2 h5.2 L13 6 V13.8 H4 Z M9 2.5 V6 h3.2';
/** 侧栏订阅在首次渲染时绑定。这里记下最新工作区，避免换区后仍把来源写回旧区。 */
const liveWorkspace={id:'',gen:0};
export function Repository(){
 const [data,setData]=useState<Tree>({folders:[],items:[],quarantined:[]});
 const [error,setError]=useState(''),[notice,setNotice]=useState(''),[importing,setImporting]=useState(false),[text,setText]=useState(''),[webOpen,setWebOpen]=useState(false),[exportWeb,setExportWebState]=useState(exportWebOn()),[mergeId,setMergeId]=useState(''),[mergeText,setMergeText]=useState('');
 const [menu,setMenu]=useState<Target|null>(null),[action,setAction]=useState(''),[value,setValue]=useState(''),[closed,setClosed]=useState<string[]>([]),[skillOn,setSkillOn]=useState(false);
 const [skills,setSkills]=useState<SkillLibraryView>({ready:[],pending:[],misplaced:[]}),[attach,setAttach]=useState<SkillAttachRef[]>([]);
 let workspaceId='';
 try { workspaceId=useAgentLive()?.host.workspaceId()??''; }
 catch (err) { const message=err instanceof Error?err.message:String(err); if(!message.includes('useContext')&&!message.includes('Invalid hook call')) throw err; }
 liveWorkspace.id=workspaceId;
 const [membership,setMembership]=useState<MembershipFile|null>(null);
 const syncMembership=async()=>{
  if(typeof kb.listWorkspaces!=='function'||!available('rebirthMembershipEnsure'))return;
  const gen=++liveWorkspace.gen;
  const listed=await kb.listWorkspaces();
  if(gen!==liveWorkspace.gen)return;
  const ids=(Array.isArray(listed)?listed:[]).map(row=>row.id).filter((id):id is string=>typeof id==='string'&&id.length>0);
  const currentId=liveWorkspace.id||(typeof kb.getCurrentWorkspaceId==='function'?await kb.getCurrentWorkspaceId():'');
  if(gen!==liveWorkspace.gen)return;
  const file=await call('rebirthMembershipEnsure',{workspaceIds:ids,...(currentId?{currentId}:{})});
  if(gen!==liveWorkspace.gen)return;
  setMembership(file);
 };
 const refresh=async()=>{setData(await tree());try{const saved=await call('rebirthSettingsGet');setSkillOn(saved.skillDistill===true);setAttach(saved.skillAttach??[]);}catch{/* 未连接时保持当前勾选 */}try{setSkills(await call('rebirthSkills'));}catch{/* 旧主进程没有技能库清单 */}try{await syncMembership();}catch{/* 旧主进程没有成员清单 */}};
 const run=async(fn:()=>Promise<unknown>)=>{try{setError('');await fn();await refresh();}catch(e){setError(e instanceof Error?e.message:String(e));}};
 useEffect(()=>{void run(refresh);return subscribe(()=>void run(refresh));},[]);
 useEffect(()=>{const id=liveWorkspace.id;if(!id||!available('rebirthNoteWorkspace'))return;void run(async()=>{await call('rebirthNoteWorkspace',{currentId:id});await syncMembership();});},[workspaceId]);
 useEffect(()=>{if(!notice)return;const timer=setTimeout(()=>setNotice(''),2000);return()=>clearTimeout(timer);},[notice]);
 const copy=(kind:LinkKind,id?:string)=>void run(async()=>{await copyLink(kind,id);setNotice('已复制');});
 const move=async(payload:{id?:string;path?:string},to:string)=>{if(payload.path){if(!canMoveFolder(payload.path,to))throw Error('不能移入文件夹自身或子文件夹');await call('rebirthFolderMove',{folder:payload.path,parent:to});}else if(payload.id)await call('rebirthMove',{id:payload.id,folder:to});};
 const onRepoDragOver=(e:React.DragEvent)=>{e.preventDefault();if(!e.dataTransfer.types.includes(DRAG_MIME)){e.dataTransfer.dropEffect='none';return;}e.dataTransfer.dropEffect='move';};
 const drop=(e:React.DragEvent,to:string)=>{e.preventDefault();e.stopPropagation();const raw=e.dataTransfer.getData(DRAG_MIME);if(raw){void run(()=>move(JSON.parse(raw),to));return;}setError(HINT_AGENT_REPO);setNotice(HINT_AGENT_REPO);};
 const context=(e:React.MouseEvent,t:Target)=>{e.preventDefault();e.stopPropagation();repoMenuPoint.x=e.clientX||8;repoMenuPoint.y=e.clientY||8;setMenu(t);setAction('');setValue('');};
 const saveAttach=async(next:SkillAttachRef[])=>{const current=await call('rebirthSettingsGet');const saved=await call('rebirthSettingsSet',{...current,skillAttach:next});setAttach(saved.skillAttach??[]);setSkillOn(saved.skillDistill===true);};
 const toggleSkill=(name:string,on:boolean)=>{const prev=attach.find(item=>item.name===name);const rest=attach.filter(item=>item.name!==name);void run(()=>saveAttach(on?[...rest,prev?.full?{name,full:true}:{name}]:rest));};
 const toggleFull=(name:string,on:boolean)=>{const rest=attach.filter(item=>item.name!==name);void run(()=>saveAttach(on?[...rest,{name,full:true}]:[...rest,{name}]));};
 const landSkill=async(raw:string,decision?:{overwrite?:boolean;rename?:string})=>{const result=await call('rebirthImportDistill',{text:raw,summary:false,...decision});if(result.skill&&result.skill.ok===false&&result.skill.conflict){const overwrite=await dialogs.confirm({title:'同名 skill',body:`${result.skill.name??''}\n${result.skill.reason}\n覆盖会先备份旧目录。`,ok:'覆盖（先备份）',cancel:'另起名'});if(overwrite){await landSkill(raw,{overwrite:true});return;}const named=await dialogs.prompt({title:'另起名',fields:[{name:'name',label:'新的 skill 名称',placeholder:'english-id'}]});const rename=named?.name?.trim();if(!rename){setError(result.skill.reason);return;}await landSkill(raw,{rename});return;}if(result.skill&&result.skill.ok===false)setError(`总结已导入。skill 未写入：${result.skill.reason}`);};
 const importJson=async(raw:string)=>{const parts=splitDistillPaste(raw);const prepared=prepareImport(parts.summary);JSON.parse(prepared);const imported=await confirmFewerImport(confirmFewer=>call('rebirthImportJson',{text:prepared,...(confirmFewer?{confirmFewer:true}:{})}));if(!imported||imported.needsConfirm)return;if(parts.skill||parts.files.length||parts.errors.length)await landSkill(raw);setText('');setImporting(false);};
 const fileRow=(item:Card,depth:number)=><React.Fragment key={item.id}><div className="rb-tree-row" style={{paddingLeft:depth*16}} draggable onDragStart={e=>{e.stopPropagation();e.dataTransfer.setData(DRAG_MIME,JSON.stringify({id:item.id}));}} onContextMenu={e=>context(e,{id:item.id,name:item.title})}><button className="rb-tree-name" onClick={()=>openRebirth({id:item.id,title:item.title})}><span className="rb-tree-label"><RbIc d={RB_FILE}/> {item.title}.md</span></button><button className="rb-row-act" title={exportWeb?'网页版导入：复制原文全文+合并指令，AI 输出 json 后贴回旁边的「导入合并」框':'复制路径写回指令'} onClick={()=>{const k=importKind();copy(k,item.id);if(k==='importWeb'){setMergeId(item.id);setMergeText('');}}}>导入</button><button className="rb-row-act" title={exportWeb?'网页版导出：复制导出版全文；也可直接拖出导出版文件':'复制导出路径指令；也可直接拖出导出版文件'} draggable onDragStart={e=>{e.preventDefault();e.stopPropagation();void call('rebirthDragOut',{id:item.id});}} onClick={()=>copy(exportKind(),item.id)}>导出</button></div>{mergeId===item.id&&<div className="rb-inline rb-merge-pop" style={{marginLeft:depth*16}}><textarea aria-label="导入合并" placeholder="贴入网页版 AI 输出的 json，覆盖这份资料（旧版自动备份）" rows={3} value={mergeText} onChange={e=>setMergeText(e.target.value)}/><button onClick={()=>void run(async()=>{const merged=await confirmFewerImport(confirmFewer=>call('rebirthMerge',{id:item.id,text:mergeText,...(confirmFewer?{confirmFewer:true}:{})}));if(!merged||merged.needsConfirm)return;setMergeId('');setMergeText('');setNotice('已合并');})}>导入合并</button><button onClick={()=>setMergeId('')}>取消</button></div>}</React.Fragment>;
 const folderRow=(f:Folder,depth:number):React.ReactNode=><div key={f.path}><div className="rb-tree-row" style={{paddingLeft:depth*16}} draggable onDragStart={e=>{e.stopPropagation();e.dataTransfer.setData(DRAG_MIME,JSON.stringify({path:f.path}));}} onContextMenu={e=>context(e,{path:f.path,name:f.name})} onDragOver={onRepoDragOver} onDrop={e=>drop(e,f.path)}><button className="rb-tree-name" aria-expanded={!closed.includes(f.path)} onClick={()=>setClosed(closed.includes(f.path)?closed.filter(p=>p!==f.path):[...closed,f.path])}><span className="rb-tree-label"><RbIc d={closed.includes(f.path)?RB_CHEV_CLOSED:RB_CHEV_OPEN}/><RbIc d={RB_FOLDER}/> {f.name}</span></button></div>{!closed.includes(f.path)&&<>{f.children?.map(c=>folderRow(c,depth+1))}{f.items?.map(i=>fileRow(i,depth+1))}</>}</div>;
 const apply=async()=>{if(!menu)return;if(action==='create')await call('rebirthFolderCreate',{folder:[menu.path||'',value.trim()].filter(Boolean).join('/')});if(action==='rename'){if(menu.id)await call('rebirthRename',{id:menu.id,title:value.trim()});else await call('rebirthFolderRename',{folder:menu.path!,name:value.trim()});}if(action==='move')await move(menu,value);if(action==='delete'){if(menu.id)await call('rebirthDelete',{id:menu.id});else await call('rebirthFolderDelete',{folder:menu.path!});}setMenu(null);};
 const membershipPending=!!workspaceId&&!membership;
 const allow=membership&&workspaceId?memberIdSet(membership,workspaceId):null;
 const filtered=allow?filterMemberTree(data.folders,data.items,allow):{folders:data.folders,items:data.items};
 const shown:Tree=membershipPending?{folders:[],items:[],quarantined:data.quarantined}:{folders:filtered.folders as Folder[],items:filtered.items,quarantined:data.quarantined};
 const emptyPhysical=!data.items.length&&!data.folders.length;
 return <section className="rb rb-sidebar" aria-label="Agent 仓库"><div className="rb-heading" onDragOver={onRepoDragOver} onDrop={e=>drop(e,'')}><strong>Agent 仓库</strong><button type="button" className="rb-plus" title="点 + 打开全局 Agent 库" aria-label="添加 Agent 资料" onClick={()=>{void Promise.resolve(kb.openAgentPicker()).catch(e=>setError(e instanceof Error?e.message:String(e)));}}>+</button><span className="rb-head-btns"><label className="rb-check" title="勾选后，创建链接和网页版的「创建」会先提问，再在重生总结之外写一份可反复使用的 SKILL.md。只作用于这个仓库。"><input type="checkbox" checked={skillOn} onChange={e=>{const on=e.target.checked;void run(async()=>{const current=await call('rebirthSettingsGet');const saved=await call('rebirthSettingsSet',{...current,skillDistill:on});setSkillOn(saved.skillDistill===true);});}}/>skill蒸馏模式</label><button title="创建链接（首次导出）" onClick={()=>copy('create')}><span className="rb-full">创建链接（首次导出）</span><span className="rb-short">创建链接</span></button><button title="给网页版 AI 用：让它在回复里输出一段总结，再贴回来导入" aria-expanded={webOpen} onClick={()=>setWebOpen(!webOpen)}><RbIc d={webOpen?RB_CHEV_OPEN:RB_CHEV_CLOSED}/> 网页版</button><button type="button" title="打开重生仓库设置" aria-label="设置" onClick={()=>openSettings('rebirth')}><Settings size={12} aria-hidden="true" /><span className="rb-full">设置</span></button></span></div>
 {webOpen&&<div className="rb-tools rb-web rb-web-panel" role="group" aria-label="网页版"><button title="复制给网页版 AI 的指令：让它在回复里输出一段总结" onClick={()=>copy('json')}>创建</button><button title="粘贴或拖入网页版 AI 输出的总结，存进仓库" onClick={()=>setImporting(true)}>导入</button><label className="rb-check" title="勾上后文件树和编辑页的「导入」「导出」走网页版：复制全文给网页版 AI"><input type="checkbox" checked={exportWeb} onChange={e=>{setExportWeb(e.target.checked);setExportWebState(e.target.checked);}}/>导入导出用网页版</label></div>}
 {importing&&<div className="rb-inline rb-import"><textarea className="rb-import-text" aria-label="从网页版导入" placeholder="粘贴或拖入网页版 AI 输出的总结" rows={3} value={text} onChange={e=>setText(e.target.value)} onDragOver={e=>{e.preventDefault();e.stopPropagation();}} onDrop={e=>{e.preventDefault();e.stopPropagation();const f=e.dataTransfer.files[0];if(f)void f.text().then(setText);else setText(e.dataTransfer.getData('text/plain'));}}/><div className="rb-import-actions"><button onClick={()=>void run(()=>importJson(text))}>确定</button><button onClick={()=>setImporting(false)}>取消</button></div></div>}
 <div role="tree" aria-label="仓库文件树" onContextMenu={e=>context(e,{path:'',name:'根目录'})} onDragOver={onRepoDragOver} onDrop={e=>drop(e,'')}><div className="rb-tree-row"><span className="rb-tree-label"><RbIc d={RB_FOLDER}/> 根目录</span></div>{shown.folders.map(f=>folderRow(f,0))}{shown.items.map(i=>fileRow(i,0))}{!shown.items.length&&!shown.folders.length&&<small>{membershipPending?'正在读取本仓库的成员…':emptyPhysical?'空目录，右键新建文件夹或从网页版导入。':'这个工作区还没有加入 Agent 仓库。点「+」从全局库加入。'}</small>}</div>
 <SkillList skillOn={skillOn} skills={skills} attach={attach} onSkill={toggleSkill} onFull={toggleFull}/>
 {menu&&action==='create'&&<div className="kb-dialog-backdrop rb-folder-backdrop" onMouseDown={()=>setMenu(null)}><div className="kb-dialog rb-new-folder" role="dialog" aria-modal="true" aria-label="新建文件夹" onMouseDown={e=>e.stopPropagation()}><div className="kb-dialog-title"><span className="kb-dialog-title-text">新建文件夹</span></div><div className="kb-dialog-body"><label>输入文件夹名称<input className="kb-input" aria-label="文件夹名称" value={value} onChange={e=>setValue(e.target.value)}/></label></div><div className="kb-dialog-actions"><button type="button" className="kb-button kb-button--secondary" onClick={()=>setMenu(null)}>取消</button><button type="button" className="kb-button" disabled={!value.trim()} onClick={()=>void run(apply)}>确定</button></div></div></div>}
 {menu&&action!=='create'&&<div className="rb-ctx" role="group" aria-label={`${menu.name} 操作`} style={{left:repoMenuPoint.x,top:repoMenuPoint.y}}><div className="rb-tools">{!menu.id&&!menu.path&&<button onClick={()=>{setImporting(true);setMenu(null);}}>从网页版导入…</button>}{!menu.id&&<button onClick={()=>{setAction('create');setValue('');}}><RbIc d={RB_FOLDER}/>新建文件夹</button>}{(menu.id||menu.path)&&<><button onClick={()=>{setAction('rename');setValue(menu.name);}}>改名</button><button onClick={()=>{setAction('move');setValue('');}}>移动</button><div className="menu-sep" role="separator"/><button className="danger" onClick={()=>setAction('delete')}>删除</button></>}<button onClick={()=>setMenu(null)}>关闭</button></div>{action&&<>{action==='delete'?<span>移入回收站？</span>:action==='move'?<select aria-label="目标目录" value={value} onChange={e=>setValue(e.target.value)}><option value="">根目录</option>{folderPaths(data.folders).filter(p=>!menu.path||canMoveFolder(menu.path,p)).map(p=><option key={p}>{p}</option>)}</select>:<input aria-label="新名称" value={value} onChange={e=>setValue(e.target.value)}/>}<button disabled={action==='rename'&&!value.trim()} onClick={()=>void run(apply)}>确定</button></>}</div>}
 {data.quarantined.length>0&&<details><summary>未识别文件（{data.quarantined.length}）</summary>{data.quarantined.map(q=><p key={q.name}>{q.name}：{q.reason}</p>)}</details>}{error&&<p role="alert" className="rb-error">{error}</p>}{notice&&<span className="rb-toast" role="status">{notice}</span>}</section>;
}
