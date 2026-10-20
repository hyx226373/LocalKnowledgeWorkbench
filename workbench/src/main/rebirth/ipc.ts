import { REBIRTH_LINK_KINDS, safeName, type RebirthImportResult } from '../../shared/rebirth';
import { completeBlankFileName, type BlankFileCreated } from '../../shared/blankFile';
import { resolveTargetDir, writeUniqueFileWithContent } from '../service/blankFile';
import fs from 'node:fs';
import path from 'node:path';
import { RebirthRepository } from './repository';
import type { TaskPlaybookInput } from '../../shared/ctxPlaybook';
export interface RebirthHost {
  rootEntryText?(agentId?: string, target?: string): Promise<string>;
  /** 当前工作区剧本。缺省或关闭时创建链接与现在一致。 */
  loadPlaybookPaste?(): Promise<TaskPlaybookInput | null>;
  pickFolder?(): Promise<string|null>;
  pickCover?(): Promise<string|null>;
  pickJson(): Promise<string|null>;
  saveFile(name:string): Promise<string|null>;
  copy(text:string):void;
  startDrag(file:string):void;
  exportToRoot?(input: { dir: string; name: string; content: string }): Promise<BlankFileCreated>;
}
/** 刚选的文件一律先过块数检查（忽略 confirmFewer），确认只能用回传的同一份文本重试。选文件导入待确认时带回已读内容，确认重试用这份文本，不再开文件框。 */
function withPicked(r:RebirthImportResult,picked:string):RebirthImportResult{return r.needsConfirm?{...r,pickedText:picked}:r;}
export function bindRebirthMethods(repo:RebirthRepository,host:RebirthHost):Record<string,(input?:any)=>unknown> {
  return {
    rebirthLinkText:async({kind,id,agentId,distillAgentId})=>{if(!(REBIRTH_LINK_KINDS as readonly string[]).includes(kind))throw new Error(`链接类型不合法：${String(kind)}`);const playbook=(kind==='create'||kind==='json')?await host.loadPlaybookPaste?.()??null:null;const wantRoot=['root','create','import','export'].includes(kind)||repo.settings().attachRootInfo||playbook?.enabled===true;const rootInfo=wantRoot?await (kind==='import'?host.rootEntryText?.(typeof agentId==='string'?agentId:undefined,repo.file(id)):host.rootEntryText?.(typeof agentId==='string'?agentId:undefined))??'':'';return {text:kind==='root'?rootInfo:repo.linkText(kind,id,rootInfo,'other',typeof distillAgentId==='string'?distillAgentId:undefined,playbook)};},
    rebirthCoverSet:async({id})=>{repo.file(id);const f=await host.pickCover?.();if(!f)return {canceled:true};repo.setCover(id,f);return {canceled:false};},
    rebirthCoverRemove:({id})=>repo.removeCover(id),
    rebirthImportInstruction:({id,mode})=>{if(mode==='file'&&host.rootEntryText)return host.rootEntryText(undefined,repo.file(id)).then(info=>({text:repo.linkText('import',id,info)}));return repo.importInstruction(id,mode);},
    rebirthMerge:async({id,text,pickFile,confirmFewer})=>{repo.file(id);if(pickFile){const file=await host.pickJson();if(!file)return null;const picked=fs.readFileSync(file,'utf8');return withPicked(repo.merge(id,picked),picked);}return repo.merge(id,text,{confirmFewer});},
    rebirthBackups:({id})=>{repo.file(id);return repo.backups(id);},
    rebirthRestore:({id,version})=>repo.restore(id,version),
    rebirthTree:()=>repo.tree(),
    rebirthFolderCreate:({folder})=>repo.folderCreate(folder),
    rebirthFolderRename:({folder,name})=>repo.folderRename(folder,name),
    rebirthFolderMove:({folder,parent})=>repo.folderMove(folder,parent),
    rebirthFolderDelete:({folder})=>repo.folderDelete(folder),
    rebirthMove:({id,folder})=>repo.move(id,folder),
    rebirthSettingsGet:()=>repo.settings(),
    rebirthSettingsSet:input=>repo.setSettings(input),
    rebirthExportFolder:async({folder})=>{repo.folderPath(folder);const dest=await host.pickFolder?.();if(!dest)return {canceled:true};repo.exportFolder(folder,dest);return {canceled:false,path:dest};},
    rebirthList:()=>repo.list(),
    rebirthRead:({id})=>repo.read(id),
    rebirthSaveBlocks:({id,blocks})=>repo.save(id,blocks),
    rebirthImport:({text,agent,confirmFewer,id})=>repo.import(text,agent,{confirmFewer,id}),
    rebirthImportJson:async(input)=>{const opts={confirmFewer:input?.confirmFewer,id:input?.id};if(input?.pickFile===true){const f=await host.pickJson();if(!f)return null;const picked=fs.readFileSync(f,'utf8');return withPicked(repo.import(picked,undefined,{id:opts.id}),picked);}return repo.import(input.text,input.agent,opts);},
    rebirthRename:({id,title})=>repo.rename(id,title),
    rebirthDelete:({id})=>repo.delete(id),
    rebirthSelectionGet:({id})=>repo.selection(id),
    rebirthSelectionSet:({id,selected,hidden,subSelected})=>repo.setSelection(id,selected,hidden,subSelected),
    rebirthNewLink:({agent,canWrite,mode})=>{const kind=mode==='json'?'json':'create';const plain=()=>({text:repo.newLink(agent,mode==='markdown'?false:canWrite!==false,mode)});if(!host.loadPlaybookPaste){if(!host.rootEntryText)return plain();return Promise.resolve(host.rootEntryText?.()??'').then(info=>({text:repo.linkText(kind,undefined,info,agent)}));}return Promise.resolve(host.loadPlaybookPaste()).then(async playbook=>{const on=playbook?.enabled===true;if(!on && !host.rootEntryText)return plain();const info=await (host.rootEntryText?.()??'');return {text:repo.linkText(kind,undefined,info||'',agent,undefined,on?playbook:null)};});},
    rebirthCopyLink:({id,mode})=>{const result=repo.copy(id,mode);return result;},
    rebirthExportFile:async({id})=>{const file=repo.drag(id);const dest=await host.saveFile(file.split(/[\\/]/).pop()!);if(!dest)return {canceled:true};fs.writeFileSync(dest,fs.readFileSync(file));return {canceled:false,path:dest};},
    rebirthExportRoot:async({id,dir,name}:{id:string;dir:string;name?:string})=>{
      repo.file(id);
      const d=repo.read(id);
      const defaultName=`R${d.meta.no}-${safeName(d.meta.title)}.md`;
      const fileName=(typeof name==='string'&&name.trim())?name.trim():defaultName;
      const content=repo.generate(id).text;
      if(host.exportToRoot){
        return await host.exportToRoot({dir,name:fileName,content});
      }
      const dirReal=resolveTargetDir(repo.dataDir,dir);
      const named=completeBlankFileName(fileName,'md');
      const written=writeUniqueFileWithContent(dirReal,named.stem,named.ext,content);
      return {
        resourceId:'',
        rootId:'',
        name:written.name,
        absPath:written.abs,
        placed:'indexed' as const,
        expandIds:[],
      };
    },
    rebirthDragOut:({id})=>{const file=repo.drag(id);repo.assertDragPath(file);host.startDrag(file);return true;},
    rebirthSkills:()=>repo.skills(),
    rebirthImportDistill:({text,agent,overwrite,rename,summary}:{text:string;agent?:string;overwrite?:boolean;rename?:string;summary?:boolean})=>repo.importDistillPaste(text,{agent,overwrite,rename,summary}),
    rebirthMembershipGet:()=>repo.membership(),
    rebirthMembershipEnsure:(input?:{workspaceIds?:unknown;currentId?:unknown})=>{
      const ids=Array.isArray(input?.workspaceIds)?input.workspaceIds.map(String):[];
      if(typeof input?.currentId==='string'&&input.currentId.trim())repo.setWorkspaceContext(input.currentId,null);
      return repo.ensureMembership(ids);
    },
    rebirthNoteWorkspace:(input?:{currentId?:unknown;workspaceIds?:unknown})=>{
      const ids=Array.isArray(input?.workspaceIds)?input.workspaceIds.map(String):null;
      const current=typeof input?.currentId==='string'?input.currentId:null;
      return {root:repo.setWorkspaceContext(current,ids)};
    },
    rebirthMembershipApply:(input?:{workspaceId?:unknown;checkedIds?:unknown})=>repo.applyMembership(String(input?.workspaceId??''),Array.isArray(input?.checkedIds)?input.checkedIds.map(String):[]),
    rebirthMembershipRemove:(input?:{workspaceId?:unknown;id?:unknown})=>{repo.removeMember(String(input?.workspaceId??''),String(input?.id??''));return {ok:true as const};},
    rebirthLibraryList:()=>repo.libraryList(),
  };
}
