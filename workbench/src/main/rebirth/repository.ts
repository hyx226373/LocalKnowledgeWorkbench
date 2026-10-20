import { LINK_PROMPTS } from '../../shared/linkPrompts';
import { exportBlocks, migrateSubs, splitSubBlocks } from '../../shared/rebirthSubblocks';
import { rebirthFormat, normalizeFormats, activeFormatText, validateFormat, OPTIONAL_HEADER_FIELDS } from '../../shared/rebirthFormat';
import { defaultSettings, normalizeSettings, pickAgent, strongestTier, tierFor, highInboxBlock } from '../../shared/aiWriteChannel';
import { composeDistillLink, defaultDistillTemplate, distillLandingLine, formatDistillAttachments, normalizeDistillTemplate, normalizeSkillAttach, rewriteDistillBody, type DistillAttachment } from '../../shared/skillDistill';
import { composePlaybookSection, composeTaskLink, type PlaybookMaterialRef, type PlaybookTier, type TaskPlaybookInput } from '../../shared/ctxPlaybook';
import { frontmatterHasSkillMarker, splitDistillPaste, type SkillLibraryView } from '../../shared/skillLibrary';
import { readSkillText, skillLibraryView, writeSkillLibrary } from '../skills/library';
import {createLink,exportJsonLink,importLink,exportLink, exportWebLink, importWebLink} from './links';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { parseCover, readCoverFile } from './cover';
import path from 'node:path';
import { atomicWriteText, isInside } from '../agentPanel/fsio';
import { agentName, parseImport, parseMarkdown, serializeMarkdown } from './format';
import { copyAgentRepoSet } from './copyRepo';
import { type RebirthDocument, type RebirthList, type RebirthSelection, type RebirthBlock, type RebirthSettings, type RebirthFolder, type RebirthTree, type RebirthImportResult, rebirthFewerBlocksHold, safeName } from '../../shared/rebirth';
import { emptyMembership, membershipForNewFile, migrateMembership, normalizeMembership, planMembershipChange, uniqIds, type LibraryFile, type LibraryPreview, type MembershipFile, type MembershipItem } from '../../shared/rebirthMembership';
export { safeName };
export function filterExport(input: string, originals: string[]): string {
  let s = input.replace(/<(img|iframe|embed|object)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,'')
    .replace(/<(?:img|iframe|embed|object)\b[^>]*\/?\s*>/gi,'')
    .replace(/<!--\s*include\b[\s\S]*?-->/gi,'').replace(/<!--[\s\S]*?-->/g,'')
    .replace(/!\[\[[\s\S]*?\]\]/g,'').replace(/!\[[^\]]*\]\([^\n]*?\)(?:\))?/g,'')
    .replace(/!\[[^\]]*\](?:\[[^\]]*\])?/g,'').replace(/\{\{[\s\S]*?\}\}/g,'')
    .replace(/\[([^\]]*)\]\([^\n]*?\)(?:\))?/g,'$1').replace(/\[([^\]]+)\]\[[^\]]*\]/g,'$1')
    .replace(/^\s*\[[^\]]+\]:.*$/gm,'').replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,(_m,a,b) => b || '')
    .replace(/<[^>]+>/g,'');
  for (const original of originals) {
    for (const value of [original,original.replace(/\\/g,'/'),original.replace(/\//g,'\\'),path.basename(original),encodeURI(original)]) {
      if (value) s = s.split(value).join('');
    }
  }
  // Remove remaining repository paths and reference-style attachment definitions.
  return s.replace(/(?:[A-Za-z]:[\\/]|\/)[^\s<>"`]*[\\/]rebirth[\\/][^\s<>"`]*/gi,'').trim();
}
export class RebirthRepository {
  root: string;
  private controlRoot: string;
  readonly out: string;
  private settingsValue: RebirthSettings = {mode:'manual',folder:'',missingFolder:'root',generateCover:false,formats:normalizeFormats(),activeFormat:'default'};
  private selections: Record<string,RebirthSelection> = {};
  private registered: Record<string,string> = {};
  private coverOrigins: Record<string,string> = {};
  private pending = new Map<string,{stamp:string;since:number}>();
  private known = new Map<string,string>();
  private coverStamp = '';
  private timer?: ReturnType<typeof setInterval>;
  private membershipDoc: MembershipFile = emptyMembership();
  private membershipReady = false;
  private pendingMembers: Record<string, MembershipItem> = {};
  private activeWorkspaceId: string | null = null;
  private knownWorkspaceIds: string[] = [];
  private workspaceListKnown = false;
  private pullingWorkspace = false;
  private workspaceEpoch = 0;
  private workspacePulledAt = 0;
  constructor(readonly dataDir: string, private changed: () => void = () => {}, private trash?: (file:string)=>Promise<void>, private hooks?: { onNeedWorkspace?: (apply: (current: string | null, workspaceIds: string[] | null) => void) => void }) {
    this.root = path.resolve(dataDir,'rebirth'); this.controlRoot=this.root; this.settingsValue.archive={mode:'dir',allowNewFolder:false,dir:this.root}; this.out = path.join(dataDir,'rebirth-out');
    fs.mkdirSync(this.root,{recursive:true}); fs.mkdirSync(this.out,{recursive:true});
    try {
      const index=JSON.parse(fs.readFileSync(path.join(this.root,'index.json'),'utf8'));
      this.coverOrigins=index.coverOrigins ?? {};
      this.registered=index.items ?? Object.fromEntries(this.files().flatMap(f=>{const id=/^R[1-9]\d*(?=-)/.exec(path.basename(f))?.[0];return id?[[id,path.relative(this.root,f)]]:[];}));
      this.persistIndex();
    } catch { /* new repository */ }
    try { this.settingsValue = this.validateSettings(JSON.parse(fs.readFileSync(path.join(this.controlRoot,'settings.json'),'utf8'))); } catch { /* defaults */ }
    if(this.settingsValue.archive?.mode==='dir'){this.root=this.settingsValue.archive.dir;fs.mkdirSync(this.root,{recursive:true});try{this.registered=JSON.parse(fs.readFileSync(path.join(this.root,'index.json'),'utf8')).items??{};}catch{this.registered={};}}
    for(const [id,rel] of Object.entries(this.registered)){const file=path.join(this.root,rel);if(fs.existsSync(file)&&this.files().includes(file)){const current=path.join(this.backupDir(id),'current.txt');if(!fs.existsSync(current))this.baseline(id,fs.readFileSync(file,'utf8'));}}
    try { this.selections = JSON.parse(fs.readFileSync(path.join(this.root,'selection.json'),'utf8')); } catch { /* first run */ }
    this.loadMembership();
    this.requestWorkspace();
  }
  /** 换工作区只改“生成来源”用的当前区，不搬重生根。workspaceIds 非空时补做一次性迁移。 */
  setWorkspaceContext(current: string | null, workspaceIds: readonly string[] | null): string {
    this.workspaceEpoch += 1;
    this.adoptWorkspace(current, workspaceIds);
    return this.root;
  }
  private adoptWorkspace(current: string | null, workspaceIds: readonly string[] | null): void {
    this.activeWorkspaceId = typeof current === 'string' && current.trim() ? current.trim() : null;
    if (!workspaceIds) return;
    this.knownWorkspaceIds = uniqIds(workspaceIds);
    this.workspaceListKnown = true;
    this.workspacePulledAt = Date.now();
    if (!this.membershipReady) this.ensureMembership(this.knownWorkspaceIds);
  }
  private requestWorkspace(): void {
    if (!this.hooks?.onNeedWorkspace || this.pullingWorkspace) return;
    if (this.workspaceListKnown && Date.now() - this.workspacePulledAt < 5000) return;
    const epoch = this.workspaceEpoch;
    this.pullingWorkspace = true;
    try {
      this.hooks.onNeedWorkspace((current, ids) => {
        this.pullingWorkspace = false;
        if (epoch !== this.workspaceEpoch || !ids) return;
        this.adoptWorkspace(current, ids);
      });
    } catch {
      this.pullingWorkspace = false;
    }
  }
  private membershipPath(): string { return path.join(this.root, 'membership.json'); }
  private loadMembership(): void {
    try {
      this.membershipDoc = normalizeMembership(JSON.parse(fs.readFileSync(this.membershipPath(), 'utf8')));
      this.membershipReady = true;
      this.pendingMembers = {};
      this.workspaceListKnown = true;
    } catch {
      this.membershipDoc = emptyMembership();
      this.membershipReady = false;
    }
  }
  private persistMembership(): void {
    atomicWriteText(this.membershipPath(), JSON.stringify({ v: 1, items: this.membershipDoc.items }));
  }
  membership(): MembershipFile {
    const items: MembershipFile['items'] = {};
    for (const [id, item] of Object.entries(this.membershipDoc.items)) items[id] = { origin: item.origin, members: [...item.members] };
    return { v: 1, items };
  }
  ensureMembership(workspaceIds: readonly string[]): MembershipFile {
    const ids = uniqIds(workspaceIds);
    this.knownWorkspaceIds = ids;
    this.workspaceListKnown = true;
    this.workspacePulledAt = Date.now();
    if (!this.membershipReady) {
      const migrated = migrateMembership(Object.keys(this.registered), ids);
      for (const [id, item] of Object.entries(this.pendingMembers)) migrated.items[id] = { origin: item.origin, members: [...item.members] };
      this.pendingMembers = {};
      this.membershipDoc = migrated;
      this.membershipReady = true;
      this.persistMembership();
    }
    return this.membership();
  }
  private noteNewMember(id: string): void {
    const row = membershipForNewFile(this.activeWorkspaceId);
    if (!this.membershipReady) {
      this.pendingMembers[id] = row;
      if (this.workspaceListKnown) this.ensureMembership(this.knownWorkspaceIds);
      return;
    }
    this.membershipDoc = { v: 1, items: { ...this.membershipDoc.items, [id]: row } };
    this.persistMembership();
  }
  private dropMember(id: string): void {
    delete this.pendingMembers[id];
    if (!this.membershipDoc.items[id]) return;
    const items = { ...this.membershipDoc.items };
    delete items[id];
    this.membershipDoc = { v: 1, items };
    if (this.membershipReady) this.persistMembership();
  }
  applyMembership(workspaceId: string, checkedIds: readonly string[]): { added: string[]; removed: string[] } {
    if (!this.membershipReady) {
      if (!this.workspaceListKnown) throw new Error('成员清单还没就绪');
      this.ensureMembership(this.knownWorkspaceIds);
    }
    const plan = planMembershipChange(this.membershipDoc, workspaceId, checkedIds, Object.keys(this.registered));
    this.membershipDoc = plan.next;
    this.persistMembership();
    this.changed();
    return { added: plan.added, removed: plan.removed };
  }
  removeMember(workspaceId: string, id: string): void {
    const ws = workspaceId.trim();
    if (!ws) throw new Error('没有当前工作区');
    if (!/^R[1-9]\d*$/.test(id)) throw new Error('重生编号不合法');
    if (!this.membershipReady) {
      if (!this.workspaceListKnown) throw new Error('成员清单还没就绪');
      this.ensureMembership(this.knownWorkspaceIds);
    }
    const item = this.membershipDoc.items[id];
    if (!item || !item.members.includes(ws)) return;
    const keep = Object.keys(this.registered).filter((other) => other !== id && (this.membershipDoc.items[other]?.members ?? []).includes(ws));
    this.applyMembership(ws, keep);
  }
  libraryList(): LibraryFile[] {
    const out: LibraryFile[] = [];
    for (const id of Object.keys(this.registered)) {
      const item = this.membershipDoc.items[id] ?? { origin: null, members: [] as string[] };
      let title = id;
      let fileName = path.basename(this.registered[id] || `${id}.md`);
      let bytes = 0;
      let mtimeMs = 0;
      let folder = '';
      let missing = false;
      try {
        const file = this.file(id);
        const st = fs.statSync(file);
        const doc = this.read(id);
        title = doc.meta.title || fileName;
        fileName = path.basename(file);
        bytes = st.size;
        mtimeMs = st.mtimeMs;
        folder = doc.meta.folder ?? '';
      } catch {
        missing = true;
      }
      out.push({ id, title, fileName, origin: item.origin, members: [...item.members], bytes, mtimeMs, missing, folder });
    }
    out.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
    return out;
  }
  readPreview(id: string): LibraryPreview {
    const file = this.file(id);
    const st = fs.statSync(file);
    let text = fs.readFileSync(file, 'utf8');
    const cap = 200_000;
    if (text.length > cap) text = text.slice(0, cap) + '\n\n…（预览已截断）';
    const doc = this.read(id);
    return { id, title: doc.meta.title, fileName: path.basename(file), text, bytes: st.size, mtimeMs: st.mtimeMs, origin: this.membershipDoc.items[id]?.origin ?? null };
  }
  private reloadCatalog(): void {
    try {
      const index = JSON.parse(fs.readFileSync(path.join(this.root, 'index.json'), 'utf8')) as { items?: Record<string, string>; coverOrigins?: Record<string, string> };
      this.registered = index.items ?? {};
      this.coverOrigins = index.coverOrigins ?? {};
    } catch {
      this.registered = {};
      this.coverOrigins = {};
    }
    try { this.selections = JSON.parse(fs.readFileSync(path.join(this.root, 'selection.json'), 'utf8')); } catch { this.selections = {}; }
    this.loadMembership();
  }
  private backupDir(id:string):string { if(!/^R[1-9]\d*$/.test(id))throw new Error('重生编号不合法'); const dir=path.join(this.dataDir,'rebirth-backup',id);fs.mkdirSync(dir,{recursive:true});return dir; }
  private baseline(id:string,text:string):void { atomicWriteText(path.join(this.backupDir(id),'current.txt'),text); }
  private backup(id:string,text?:string):void {
    const dir=this.backupDir(id);if(text===undefined){const current=path.join(dir,'current.txt');if(!fs.existsSync(current))return;text=fs.readFileSync(current,'utf8');}
    const versions=this.backups(id);if(versions.length && fs.readFileSync(path.join(dir,versions[0].version),'utf8')===text)return;
    let version=new Date().toISOString().replace(/[:.]/g,'-');while(fs.existsSync(path.join(dir,version+'.md')))version+='-1';atomicWriteText(path.join(dir,version+'.md'),text);
  }
  backups(id:string):{version:string}[] {return fs.readdirSync(this.backupDir(id)).filter(f=>/^[\dT-Z-]+\.md$/.test(f)).sort().reverse().map(version=>({version}));}
  restore(id:string,version:string):void {
    if(!this.backups(id).some(v=>v.version===version))throw new Error('备份版本不存在');
    const text=fs.readFileSync(path.join(this.backupDir(id),version),'utf8');const doc=parseMarkdown(text);doc.meta.folder=this.relative(path.dirname(this.file(id)));this.replace(id,serializeMarkdown(doc));
  }
  private replace(id:string,text:string):void {
    const file=this.file(id);this.backup(id,fs.readFileSync(file,'utf8'));atomicWriteText(file,text);this.baseline(id,text);this.known.set(file,this.stamp(file));this.pending.delete(file);this.generate(id);this.changed();
  }
  merge(id:string,text:string,opts?:{confirmFewer?:boolean}):RebirthImportResult {
    const raw=text.trim().replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i,'$1');
    if(!raw.startsWith('{'))throw new Error('导入合并需要重生 JSON');
    return this.replaceImported(id,parseImport(raw),opts?.confirmFewer);
  }
  /** 覆盖已有 id。块数变少且未确认时只返回 needsConfirm，不写文件、备份、索引或勾选。 */
  private replaceImported(id:string,doc:RebirthDocument,confirmFewer?:boolean):RebirthImportResult {
    this.folderPath(doc.meta.folder??'',false);
    const current=this.read(id);
    const hold=rebirthFewerBlocksHold({hasExisting:true,oldBlocks:current.blocks.length,newBlocks:doc.blocks.length,id,title:current.meta.title,confirmFewer});
    if(hold)return hold;
    doc.meta.no=Number(id.slice(1));doc.meta.folder=current.meta.folder;
    // A replacement has new block identities. Keep an empty selection empty; never expose new blocks implicitly.
    const sel=this.selection(id);this.replace(id,serializeMarkdown(doc));this.selections[id]={selected:sel.selected===null?null:[],hidden:[]};this.persistSelection();this.generate(id);this.changed();
    return {id};
  }
  importInstruction(id:string,mode:'file'|'json'):{text:string} {
    if(mode==='file')return {text:this.linkText('import',id)};
    if(mode!=='json')throw new Error('导入模式不合法');
    return {text:this.linkText('importWeb',id)};
  }
  start(): void { this.scan(); this.timer = setInterval(()=>this.scan(),400); this.timer.unref(); }
  close(): void { if (this.timer) clearInterval(this.timer); }
  private files(dir = this.root): string[] {
    return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e => {
      if (e.name.startsWith('~') || e.name.endsWith('~') || e.name.endsWith('.tmp') || ['_quarantine','_out'].includes(e.name)) return [];
      const file = path.join(dir,e.name);
      if (e.isSymbolicLink()) return [];
      return e.isDirectory() ? this.files(file) : e.isFile() && /\.md$/i.test(e.name) ? [file] : [];
    });
  }
  private stamp(file:string): string { const s=fs.statSync(file); return `${s.size}:${s.mtimeMs}`; }
  scan(now = Date.now()): void {
    this.requestWorkspace();
    const files = this.files();
    for (const file of files) {
      try {
        const stamp = this.stamp(file);
        const existing=Object.keys(this.registered).find(id=>path.join(this.root,this.registered[id])===file);
        if(existing && this.known.get(file)!==stamp)this.backup(existing);
        if (this.known.get(file) === stamp) continue;
        if (path.basename(file) === 'SKILL.md') { this.known.set(file, stamp); this.pending.delete(file); this.changed(); continue; }
        const prev = this.pending.get(file);
        if (!prev || prev.stamp !== stamp) { this.pending.set(file,{stamp,since:now}); continue; }
        if (now-prev.since < 2000) continue;
        const raw = fs.readFileSync(file,'utf8');
        if (frontmatterHasSkillMarker(raw)) { this.known.set(file, stamp); this.pending.delete(file); this.changed(); continue; }
        const doc = parseMarkdown(raw,path.basename(file));
        this.folderPath(doc.meta.folder ?? '',false);
        const match = /^R([1-9]\d*)-/.exec(path.basename(file));
        const id=match ? `R${match[1]}` : '';
        const registered=this.registered[id];
        if (!registered || (path.join(this.root,registered)!==file && fs.existsSync(path.join(this.root,registered)))) { this.store(doc,file); } else { this.registered[id]=path.relative(this.root,file);this.persistIndex();this.known.set(file,stamp); this.baseline(id,fs.readFileSync(file,'utf8')); this.generate(id); this.changed(); }
        this.pending.delete(file);
      } catch (err) {
        // Keep a registered document in place after an invalid external write so its backups remain recoverable.
        const existing=Object.keys(this.registered).find(id=>path.join(this.root,this.registered[id])===file);
        if(existing){this.backup(existing);this.pending.delete(file);this.known.set(file,this.stamp(file));this.changed();continue;}
        const dir=path.join(this.root,'_quarantine'); fs.mkdirSync(dir,{recursive:true});
        const dest=path.join(dir,`${Date.now()}-${path.basename(file)}`);
        try { fs.renameSync(file,dest); atomicWriteText(dest+'.reason.txt',String((err as Error).message)); this.pending.delete(file); this.known.delete(file); this.changed(); } catch { /* removed during scan */ }
      }
    }
    const coverStamp=Object.keys(this.registered).flatMap(id=>{
      try { const file=this.file(id);
      const origin=this.coverOrigins[id];
      if(origin){const source=path.resolve(this.root,origin);if(isInside(this.root,source)&&source!==file){this.folderPath(this.relative(path.dirname(source)));this.moveCovers(source,file);}}
      this.normalizeCovers(file);return this.covers(file).map(f=>f+':'+this.stamp(f)); }catch{return [];}
    }).join('|');
    if(coverStamp!==this.coverStamp){this.coverStamp=coverStamp;this.changed();}
    for (const file of this.known.keys()) if (!files.includes(file)) { const id=/^R\d+/.exec(path.basename(file))?.[0]; this.known.delete(file); if(id && !this.files().some(f=>path.basename(f).startsWith(id+'-'))) { delete this.registered[id];delete this.coverOrigins[id];this.persistIndex();delete this.selections[id]; this.persistSelection(); this.dropMember(id); this.removeOutputs(id); } this.changed(); }
  }
  private nextNo(): number {
    let no=0;
    try { no=Number(JSON.parse(fs.readFileSync(path.join(this.root,'index.json'),'utf8')).lastNo)||0; } catch { /* new */ }
    for(const id of Object.keys(this.registered)) no=Math.max(no,Number(id.slice(1))||0);
    this.persistIndex(no+1); return no+1;
  }
  private persistIndex(lastNo?:number):void {
    if(lastNo===undefined){try{lastNo=Number(JSON.parse(fs.readFileSync(path.join(this.root,'index.json'),'utf8')).lastNo)||0;}catch{lastNo=0;}}
    atomicWriteText(path.join(this.root,'index.json'),JSON.stringify({lastNo,items:this.registered,coverOrigins:this.coverOrigins}));
  }
  private register(id:string,file:string):void {this.registered[id]=path.relative(this.root,file);this.persistIndex();}
  private filename(doc:RebirthDocument): string { return `R${doc.meta.no}-${new Date().toISOString().replace(/[-:]/g,'').slice(0,15).replace('T','-')}-${safeName(doc.meta.title)}.md`; }
  private store(doc:RebirthDocument, source?:string): {id:string} {
    const cover=parseCover(doc.meta.cover);
    doc.meta.no=this.nextNo(); doc.meta.agent=agentName(doc.meta.agent);
    const folder=source&&this.settingsValue.archive?.mode==='dir'?this.relative(path.dirname(source)):this.archiveFolder(doc.meta.folder ?? ''); doc.meta.folder=folder;
    const dir=this.folderPath(folder); const file=path.join(dir,this.filename(doc));
    atomicWriteText(file,serializeMarkdown(doc)); if(source && source!==file) fs.unlinkSync(source);
    if(source&&source!==file){
      const origin=path.relative(this.root,source);
      // A reused inbox filename belongs to its most recent import.
      for(const id of Object.keys(this.coverOrigins))if(this.coverOrigins[id]===origin)delete this.coverOrigins[id];
      this.coverOrigins[`R${doc.meta.no}`]=origin;
    }
    this.known.set(file,this.stamp(file)); if(source) this.moveCovers(source,file);this.normalizeCovers(file);if(cover)this.writeCover(file,cover); const id=`R${doc.meta.no}`; this.register(id,file);this.baseline(id,fs.readFileSync(file,'utf8'));this.noteNewMember(id);this.generate(id); this.changed(); return {id};
  }
  import(text:string,agent?:string,opts?:{confirmFewer?:boolean;id?:string}): RebirthImportResult {
    const doc=parseImport(text); if(agent) doc.meta.agent=agentName(agent);
    // 带已有 id 才是覆盖；没有目标时始终新建，块数再少也不确认。
    if(opts?.id)return this.replaceImported(opts.id,doc,opts.confirmFewer);
    return this.store(doc);
  }
  file(id:string): string {
    if(!/^R[1-9]\d*$/.test(id)) throw new Error('重生编号不合法');
    const rel=this.registered[id];const file=rel ? path.resolve(this.root,rel) : ''; if(!file || !isInside(this.root,file) || !this.files().includes(file) || !path.basename(file).startsWith(id+'-')) throw new Error('重生文件不存在'); return file;
  }
  read(id:string): RebirthDocument { const d=parseMarkdown(fs.readFileSync(this.file(id),'utf8')); d.meta.no=Number(id.slice(1)); d.meta.folder=this.relative(path.dirname(this.file(id))); return d; }
  selection(id:string): RebirthSelection { this.file(id); const s=this.selections[id]; return {selected:s?.selected == null ? null : [...s.selected],hidden:[...(s?.hidden ?? [])],...(s?.subSelected?{subSelected:structuredClone(s.subSelected)}:{})}; }
  private persistSelection():void { atomicWriteText(path.join(this.root,'selection.json'),JSON.stringify(this.selections)); }
  setSelection(id:string,selected:number[]|null,hidden:number[],subSelected?:Record<number,number[]>):void {
    const n=this.read(id).blocks.length;
    const valid=(a:unknown):a is number[] => Array.isArray(a) && a.every(i=>Number.isInteger(i) && i>0 && i<=n);
    if((selected!==null && !valid(selected)) || !valid(hidden)) throw new Error('块号必须是有效的正整数数组');
    if(subSelected!==undefined){if(!subSelected||typeof subSelected!=='object'||Array.isArray(subSelected))throw new Error('小块勾选格式非法');for(const [key,ids] of Object.entries(subSelected)){const block=this.read(id).blocks.find(b=>b.idx===Number(key));if(!block||!Array.isArray(ids)||ids.some(i=>!Number.isInteger(i)||i<1||i>splitSubBlocks(block).items.length))throw new Error('小块号无效');}}
    this.selections[id]={...(subSelected?{subSelected:structuredClone(subSelected)}:{}),selected:selected===null ? null : [...new Set(selected)],hidden:[...new Set(hidden)]}; this.persistSelection(); this.generate(id); this.changed();
  }
  save(id:string,blocks:Omit<RebirthBlock,'idx'>[]):void {
    if(!Array.isArray(blocks)||!blocks.length) throw new Error('至少需要一块');
    blocks.forEach((b,i)=>{if(!b||typeof b.title!=='string'||typeof b.body!=='string') throw new Error(`第 ${i+1} 块格式非法`);});
    const doc=this.read(id); const old=doc.blocks; const sel=this.selection(id);
    doc.blocks=blocks.map((b,i)=>({...b,idx:i+1}));
    // Retain selection across reorder by matching block contents; edits retain their slot.
    const used=new Set<number>(); const mapping=doc.blocks.map((b,i)=>{let j=old.findIndex((o,k)=>!used.has(k)&&o.title===b.title&&o.body===b.body); if(j<0 && !used.has(i))j=i; if(j>=0)used.add(j);return j+1;});
    this.selections[id]={selected:sel.selected===null?null:mapping.flatMap((k,i)=>sel.selected!.includes(k)?[i+1]:[]),hidden:mapping.flatMap((k,i)=>sel.hidden.includes(k)?[i+1]:[]),...(sel.subSelected||blocks.some(b=>b.subOrigins)?{subSelected:Object.fromEntries(doc.blocks.map((b,i)=>[b.idx,old[mapping[i]-1]?migrateSubs(old[mapping[i]-1],b,sel,blocks[i].subOrigins):splitSubBlocks(b).items.map(s=>s.idx)]))}:{})};
    this.backup(id,fs.readFileSync(this.file(id),'utf8')); atomicWriteText(this.file(id),serializeMarkdown(doc));this.baseline(id,serializeMarkdown(doc)); this.known.set(this.file(id),this.stamp(this.file(id))); this.persistSelection(); this.generate(id); this.changed();
  }
  generate(id:string): {file:string;text:string;empty:boolean} {
    const doc=this.read(id),s=this.selection(id);
    const originals=this.files();
    const blocks=exportBlocks(doc.blocks,s);
    const text=blocks.length ? rebirthFormat.serialize(blocks.map(b=>({...b,body:filterExport(b.body,originals),title:filterExport(b.title,originals)}))).trim()+'\n' : '（未选择任何内容）';
    const file=path.join(this.out,id+'.out.md'); atomicWriteText(file,text); return {file,text,empty:!blocks.length};
  }
  assertDragPath(file:string):void {
    if(!isInside(this.out,path.resolve(file))||!isInside(fs.realpathSync(this.out),fs.realpathSync(file))||fs.lstatSync(file).isSymbolicLink()||!fs.statSync(file).isFile()) throw new Error('拖出只允许 rebirth-out 内的导出版');
  }
  drag(id:string):string { const out=this.generate(id); const d=this.read(id); const file=path.join(this.out,`R${d.meta.no}-${safeName(d.meta.title)}.md`); atomicWriteText(file,out.text); this.assertDragPath(file); return file; }
  copy(id:string,mode:'file'|'full'): {text:string;empty:boolean} {
    if(!['file','full'].includes(mode))throw new Error('复制模式不合法');
    const out=this.generate(id); return {text:mode==='file'?this.linkText('export',id):exportWebLink(out.text),empty:out.empty};
  }
  rename(id:string,title:string):void { if(typeof title!=='string'||!title.trim())throw new Error('标题不能为空'); const doc=this.read(id),old=this.file(id); doc.meta.title=title.trim(); const dest=path.join(path.dirname(old),this.filename(doc)); atomicWriteText(dest,serializeMarkdown(doc)); if(dest!==old)fs.unlinkSync(old); this.moveCovers(old,dest); this.known.delete(old); this.known.set(dest,this.stamp(dest)); this.register(id,dest);this.baseline(id,serializeMarkdown(doc));this.removeOutputs(id);this.generate(id);this.changed(); }
  private removeOutputs(id:string):void { for(const f of fs.readdirSync(this.out))if(f===id+'.out.md'||f.startsWith(id+'-'))fs.unlinkSync(path.join(this.out,f)); }
  async delete(id:string):Promise<void> { if(!this.trash) throw new Error('系统回收站不可用'); const file=this.file(id); for(const cover of this.covers(file)) await this.trash(cover); await this.trash(file); await this.trash(this.backupDir(id)); delete this.registered[id];delete this.coverOrigins[id];this.persistIndex();delete this.selections[id];this.persistSelection();this.dropMember(id);this.removeOutputs(id);this.changed(); }
  private relative(file:string):string { return path.relative(this.root,file).split(path.sep).join('/'); }
  folderPath(folder:string, mustExist=true):string {
    if(typeof folder!=='string' || /[\\:\x00-\x1f]/.test(folder) || path.posix.isAbsolute(folder) || folder.split('/').some(p=>p==='..'||p==='.'||p.startsWith('~')||['_quarantine','_out'].includes(p)) || (folder!=='' && folder.split('/').some(p=>!p || /[<>"|?*]/.test(p) || /[. ]$/.test(p)))) throw new Error('文件夹路径不安全：必须为相对路径，禁止 .. 与绝对路径');
    const dest=path.resolve(this.root,folder);
    let cursor=this.root;
    for(const part of folder.split('/').filter(Boolean)) {cursor=path.join(cursor,part);if(fs.existsSync(cursor) && (fs.lstatSync(cursor).isSymbolicLink() || !fs.statSync(cursor).isDirectory())) throw new Error('文件夹路径不能包含符号链接或文件');}
    if(!isInside(this.root,dest) || (mustExist&&!fs.existsSync(dest))) throw new Error('文件夹不存在');
    return dest;
  }
  private validateSettings(value:Partial<RebirthSettings>):RebirthSettings {
    if(!value || (value.mode!==undefined&&!['manual','ai'].includes(value.mode)) || (value.missingFolder!==undefined&&!['root','create'].includes(value.missingFolder))) throw new Error('归档设置不合法');
    const archive=value.archive; if(archive && !['ai','dir'].includes(archive.mode))throw new Error('归档设置不合法');
    for(const f of value.formats??[]) {if(!normalizeFormats().some(b=>b.id===f.id) && f.id!=='heading2' && f.blocks && validateFormat(f))throw new Error(validateFormat(f));}
    const formats=normalizeFormats(value.formats??this.settingsValue.formats);
    const active=value.activeFormat??this.settingsValue.activeFormat;
    const skillDistill=value.skillDistill===undefined?this.settingsValue.skillDistill===true:value.skillDistill===true;
    const skillAttach=normalizeSkillAttach(value.skillAttach===undefined?this.settingsValue.skillAttach:value.skillAttach);
    return {headerFields:OPTIONAL_HEADER_FIELDS.filter(k=>(value.headerFields??this.settingsValue.headerFields??[]).includes(k)),formats,activeFormat:formats.some(f=>f.id===active)?active:formats[0].id,mode:value.mode??'manual',folder:value.folder??'',missingFolder:value.missingFolder??'root',generateCover:value.generateCover===true,attachRootInfo:value.attachRootInfo===true,skillDistill,skillAttach,archive:archive?{mode:archive.mode,allowNewFolder:archive.allowNewFolder===true,dir:path.resolve(archive.dir||this.controlRoot)}:undefined};
  }
  settings():RebirthSettings {return {...this.settingsValue,rootDir:this.root,defaultDir:this.controlRoot,formats:normalizeFormats(this.settingsValue.formats),attachRootInfo:this.settingsValue.attachRootInfo??false,skillDistill:this.settingsValue.skillDistill===true,skillAttach:normalizeSkillAttach(this.settingsValue.skillAttach),archive:this.settingsValue.archive?{...this.settingsValue.archive}:undefined};}
  setSettings(value:Partial<RebirthSettings>):RebirthSettings {
    const nextSettings=this.validateSettings(value);
    const next=nextSettings.archive?.mode==='dir'?nextSettings.archive.dir:this.controlRoot;
    const prev=this.root;
    const pending={...this.pendingMembers};
    const ready=this.membershipReady;
    if(next!==prev){
      if(ready)this.persistMembership();
      copyAgentRepoSet(prev,next);
    }
    this.settingsValue=nextSettings;
    this.persistSettings();
    if(next!==prev){
      this.root=next;
      this.known.clear();
      this.pending.clear();
      this.reloadCatalog();
      if(!ready){this.membershipReady=false;this.pendingMembers=pending;}
    }
    this.changed();
    return this.settings();
  }
  private persistSettings():void {atomicWriteText(path.join(this.controlRoot,'settings.json'),JSON.stringify(this.settingsValue));}
  private archiveFolder(proposed:string):string {
    // Validate even in manual mode, so malicious frontmatter never enters the repository.
    const dest=this.folderPath(proposed,false);
    if(this.settingsValue.archive?.mode==='dir')return '';
    if(!this.settingsValue.archive && this.settingsValue.mode==='manual') {this.folderPath(this.settingsValue.folder);return this.settingsValue.folder;}
    if(fs.existsSync(dest)) return proposed;
    if(this.settingsValue.archive?this.settingsValue.archive.allowNewFolder:this.settingsValue.missingFolder==='create') {fs.mkdirSync(dest,{recursive:true});return proposed;}
    return '';
  }
  private covers(file:string):string[] {const base=file.slice(0,-3);return ['png','jpg','webp','url'].flatMap(ext=>[base+'.cover.'+ext,base+'.'+ext]).filter(f=>fs.existsSync(f)&&!fs.lstatSync(f).isSymbolicLink()&&fs.statSync(f).isFile());}
  private normalizeCovers(file:string):void {
    const base=file.slice(0,-3);
    for(const ext of ['png','jpg','webp']) {
      const plain=base+'.'+ext,target=base+'.cover.'+ext;
      if(fs.existsSync(plain)&&!fs.lstatSync(plain).isSymbolicLink()&&fs.statSync(plain).isFile()&&!fs.existsSync(target))fs.renameSync(plain,target);
    }
  }
  private writeCover(file:string,cover:{ext:string;bytes:Buffer}|{url:string}):void {
    const base=file.slice(0,-3);
    // Write replacement first so a failed write preserves the current cover.
    const dest=base+'.cover.'+('url' in cover?'url':cover.ext);
    const tmp=dest+'.'+randomUUID()+'.tmp';
    try{fs.writeFileSync(tmp,'url' in cover?cover.url:cover.bytes,{flag:'wx'});fs.renameSync(tmp,dest);}finally{if(fs.existsSync(tmp))fs.unlinkSync(tmp);}
    for(const old of this.covers(file))if(old!==dest)fs.unlinkSync(old);
  }
  cover(id:string):string|undefined {
    const file=this.file(id);
    for(const f of this.covers(file)) {
      if(f.endsWith('.url'))continue; // URL is recorded only; never auto-fetch remote images.
      try {const {ext,bytes}=readCoverFile(f);return `data:image/${ext==='jpg'?'jpeg':ext};base64,${bytes.toString('base64')}`;}catch{/* invalid image: show themed placeholder */}
    }
  }
  setCover(id:string,source:string):void {const file=this.file(id),cover=readCoverFile(source);this.writeCover(file,cover);this.changed();}
  async removeCover(id:string):Promise<void> {
    if(!this.trash)throw new Error('系统回收站不可用');
    for(const f of this.covers(this.file(id)))await this.trash(f);this.changed();
  }
  private moveCovers(from:string,to:string):void {if(from===to)return;for(const f of this.covers(from))fs.renameSync(f,to.slice(0,-3)+f.slice(from.length-3));}
  move(id:string,folder:string):void {
    const old=this.file(id),dir=this.folderPath(folder),dest=path.join(dir,path.basename(old));if(old===dest)return;
    if(fs.existsSync(dest))throw new Error('目标文件已存在');
    const doc=this.read(id);doc.meta.folder=folder;atomicWriteText(dest,serializeMarkdown(doc));this.moveCovers(old,dest);fs.unlinkSync(old);
    this.known.delete(old);this.known.set(dest,this.stamp(dest));this.register(id,dest);this.baseline(id,serializeMarkdown(doc));this.removeOutputs(id);this.generate(id);this.changed();
  }
  private folderIds(dir:string):string[] {return Object.entries(this.registered).filter(([,rel])=>isInside(dir,path.resolve(this.root,rel))).map(([id])=>id);}
  folderCreate(folder:string):void {if(!folder)throw new Error('不能新建根目录');const dest=this.folderPath(folder,false);if(fs.existsSync(dest))throw new Error('文件夹已存在');fs.mkdirSync(dest,{recursive:true});this.changed();}
  folderRename(folder:string,name:string):void {if(typeof name!=='string'||!name||name.includes('/'))throw new Error('文件夹名称不合法');this.relocateFolder(folder,path.posix.join(path.posix.dirname(folder)==='.'?'':path.posix.dirname(folder),name));}
  folderMove(folder:string,parent:string):void {this.folderPath(parent);this.relocateFolder(folder,path.posix.join(parent,path.posix.basename(folder)));}
  private relocateFolder(folder:string,next:string):void {
    if(!folder)throw new Error('不能移动根目录');const from=this.folderPath(folder),to=this.folderPath(next,false);
    if(from===to)return;if(isInside(from,to))throw new Error('不能移入自身或子孙文件夹');if(fs.existsSync(to))throw new Error('目标文件夹已存在');
    const ids=this.folderIds(from);
    fs.renameSync(from,to);
    if(this.settingsValue.folder===folder||this.settingsValue.folder.startsWith(folder+'/')) {this.settingsValue.folder=next+this.settingsValue.folder.slice(folder.length);this.persistSettings();}
    for(const id of ids){this.register(id,path.join(to,path.relative(from,path.join(this.root,this.registered[id]))));const file=this.file(id),doc=this.read(id);atomicWriteText(file,serializeMarkdown(doc));this.known.set(file,this.stamp(file));this.register(id,file);this.baseline(id,serializeMarkdown(doc));this.removeOutputs(id);this.generate(id);}
    this.changed();
  }
  async folderDelete(folder:string):Promise<void> {
    if(!folder)throw new Error('不能删除根目录');if(!this.trash)throw new Error('系统回收站不可用');const dir=this.folderPath(folder);
    const ids=this.folderIds(dir);await this.trash(dir);
    for(const id of ids){await this.trash(this.backupDir(id));delete this.registered[id];delete this.coverOrigins[id];this.persistIndex();delete this.selections[id];this.dropMember(id);this.removeOutputs(id);}this.persistSelection();
    if(this.settingsValue.folder===folder||this.settingsValue.folder.startsWith(folder+'/')){this.settingsValue.folder='';this.persistSettings();}this.changed();
  }
  tree():RebirthTree {
    const all=this.list();const items=all.groups.flatMap(g=>g.topics.flatMap(t=>t.items.map(i=>({...i,agent:g.agent,topic:t.topic}))));
    const walk=(dir:string):RebirthFolder=>({folder:this.relative(dir),name:dir===this.root?'重生仓库':path.basename(dir),folders:fs.readdirSync(dir,{withFileTypes:true}).filter(e=>e.isDirectory()&&!e.isSymbolicLink()&&!['_quarantine','_out'].includes(e.name)&&!e.name.startsWith('~')).sort((a,b)=>a.name.localeCompare(b.name)).map(e=>walk(path.join(dir,e.name))),items:items.filter(i=>path.dirname(this.file(i.id))===dir).map(i=>({...i,folder:this.relative(dir)}))});
    return {root:walk(this.root),quarantined:all.quarantined};
  }
  exportFolder(folder:string,destination:string):void {
    const dir=this.folderPath(folder);const dest=path.resolve(destination);
    if(isInside(this.root,dest)||isInside(this.out,dest))throw new Error('导出位置不能位于仓库或导出版目录内');
    const planned:{file:string;text:string}[]=[];const dirs:string[]=[];
    const check=(target:string):void=>{
      let ancestor=target;while(!fs.existsSync(ancestor)){const parent=path.dirname(ancestor);if(parent===ancestor)break;ancestor=parent;}
      const actual=path.resolve(fs.realpathSync(ancestor),path.relative(ancestor,target));
      if(isInside(fs.realpathSync(this.root),actual)||isInside(fs.realpathSync(this.out),actual))throw new Error('导出位置不能位于仓库或导出版目录内');
      let cursor=target;while(cursor!==path.dirname(cursor)){if(fs.existsSync(cursor)&&fs.lstatSync(cursor).isSymbolicLink())throw new Error('导出目标不能包含符号链接');cursor=path.dirname(cursor);}
    };
    const walk=(source:string,target:string):void=>{
      check(target);if(fs.existsSync(target)&&!fs.statSync(target).isDirectory())throw new Error('导出目录被文件占用');dirs.push(target);
      for(const e of fs.readdirSync(source,{withFileTypes:true})){
        if(e.isSymbolicLink()||e.name.startsWith('~')||['_quarantine','_out'].includes(e.name))continue;
        const f=path.join(source,e.name);if(e.isDirectory()){walk(f,path.join(target,e.name));continue;}
        const id=/^R[1-9]\d*(?=-)/.exec(e.name)?.[0];if(!id||!e.name.endsWith('.md')||this.registered[id]!==path.relative(this.root,f))continue;
        const doc=this.read(id),file=path.join(target,`R${doc.meta.no}-${safeName(doc.meta.title)}.md`);check(file);
        if(fs.existsSync(file))throw new Error('导出文件已存在，请选择空目录');planned.push({file,text:this.generate(id).text});
      }
    };
    walk(dir,dest);for(const d of dirs)fs.mkdirSync(d,{recursive:true});for(const f of planned)atomicWriteText(f.file,f.text);
  }
  private writeChannelSettings() {
    try { return normalizeSettings(JSON.parse(fs.readFileSync(path.join(this.dataDir,'ai-write','channel.json'),'utf8'))); }
    catch { return defaultSettings(); }
  }
  linkText(kind:string,id?:string,rootInfo='',agent='other',distillAgentId?:string,playbook?:TaskPlaybookInput|null):string {
    const folders:string[]=[];const visit=(n:RebirthFolder)=>{for(const f of n.folders){folders.push(f.folder);visit(f);}};visit(this.tree().root);
    const channel=this.writeChannelSettings();
    let tier=channel.linkItems.length?strongestTier(channel.linkItems.map(item=>tierFor(item.path,channel))):channel.defaultTier;
    // The channel renderer emits a JSON-quoted inbox descriptor, never an original-root fallback.
    const inboxLine=/^Inbox scope: (.+)$/m.exec(rootInfo)?.[1];
    let inbox='';try { if(inboxLine){const value:unknown=JSON.parse(inboxLine);if(typeof value==='string'&&path.isAbsolute(value))inbox=value;} } catch { /* unavailable */ }
    if(inbox)tier='high';
    const high=tier==='high';
    let inboxTarget='';try{const line=/^Inbox target: (.+)$/m.exec(rootInfo)?.[1];if(line){const value:unknown=JSON.parse(line);if(typeof value==='string'&&inbox&&isInside(inbox,path.resolve(value))&&path.resolve(value)!==path.resolve(inbox))inboxTarget=value;}}catch{/* missing mapping */}
    if(high && (kind==='create'||kind==='import'||kind==='export') && !inbox)return 'Write channel: high. Stop: request a supplied inbox and explicitly mapped target; no file operation is authorized.';
    if(high && (kind==='import'||kind==='export')&&!inboxTarget)return 'Write channel: high. Stop: request the explicitly mapped inbox copy for this record; never infer an original path.';
    const hostChannel=/^Write channel:/.test(rootInfo);
    const channelText=high?(kind==='json'?'Write channel: high. Web delivery uses conversation and pasted evidence only; no local file access.':highInboxBlock(inbox,rootInfo.includes('Inbox copies are incomplete'))):hostChannel?rootInfo:LINK_PROMPTS[tier];
    const distill=this.settingsValue.skillDistill===true && (kind==='create'||kind==='json');
    const playbookOn=(kind==='create'||kind==='json') && playbook?.enabled===true && playbook.state?.enabled===true;
    const c={formatName:normalizeFormats(this.settingsValue.formats).find(f=>f.id===this.settingsValue.activeFormat)?.name,headerFields:this.settingsValue.headerFields,root:this.root,formatText:activeFormatText(this.settingsValue),agent:agentName(agent),generateCover:this.settingsValue.generateCover,archive:this.settingsValue.archive??(this.settingsValue.mode==='ai'?{mode:'ai' as const,allowNewFolder:this.settingsValue.missingFolder==='create',dir:this.root}:undefined),folders,rootInfo:!high&&!hostChannel&&this.settingsValue.attachRootInfo?rootInfo:''};
    if(high && /(?:[A-Za-z]:[\\/]|(?:^|[\s"'=])\/[A-Za-z0-9])/m.test(c.formatText))return 'Write channel: high. Stop: configured format contains paths; supply a path-free compatible format.';
    if(kind==='import')return channelText+'\n\n'+importLink(high?inboxTarget:this.file(id!),activeFormatText(this.settingsValue),{high});
    if(kind==='export')return exportLink(high?inboxTarget:this.generate(id!).file);
    if(kind==='importWeb'){const old=fs.readFileSync(this.file(id!),'utf8');if(high && /(?:[A-Za-z]:[\\/]|(?:^|[\s"'=])\/[A-Za-z0-9])/m.test(old))return 'Write channel: high. Stop: the old record contains original paths. Supply a path-redacted complete record before web merging; do not discard unknown metadata.';return importWebLink(old,activeFormatText(this.settingsValue));}
    if(kind==='exportWeb')return exportWebLink(this.generate(id!).text);
    if(kind!=='create'&&kind!=='json')throw new Error('链接类型不合法');
    if(high){c.root=kind==='json'?'.':inbox;c.archive={mode:'dir',allowNewFolder:false,dir:c.root};c.folders=[];c.rootInfo='';}
    const renderOptions={high,...(high&&kind==='json'?{destination:'(relative logical destination)'}:{})};
    const body=kind==='create'?createLink(c,renderOptions):exportJsonLink(c,renderOptions);
    if(!distill && !playbookOn)return channelText+'\n\n'+body;
    if(!playbookOn)return composeDistillLink({kind,body,rootInfo:channelText,template:pickAgent(channel,distillAgentId).distill||defaultDistillTemplate(),tier,skillsDir:path.join(this.dataDir,'skills'),attached:this.distillAttachments()});
    const linkKind=kind==='json'?'json':'create';
    const skillsDir=path.join(this.dataDir,'skills');
    const attached=distill?this.distillAttachments():[];
    const skillFull=attached.filter(item=>item.body).map(item=>item.name);
    const materials=this.playbookMaterials(playbook!,tier);
    const section=composePlaybookSection({state:playbook!.state,materials,tier,skillFullNames:skillFull});
    const selectedTemplate=normalizeDistillTemplate(pickAgent(channel,distillAgentId).distill||defaultDistillTemplate());
    const template=selectedTemplate===defaultDistillTemplate()?selectedTemplate:defaultDistillTemplate()+'\nCustom questions (configuration; stop if incompatible):\n'+(high?'Omitted in high scope.':selectedTemplate);
    return composeTaskLink({
      writeChannel:channelText,
      distill:distill?{landing:distillLandingLine(tier,skillsDir),template,attached:high&&attached.length?'Skill attachments omitted: original paths cannot be safely preserved.':formatDistillAttachments(attached),body:rewriteDistillBody(linkKind,body)}:null,
      playbookText:section.text,
      plainBody:body,
    });
  }
  private playbookMaterials(playbook:TaskPlaybookInput,tier:PlaybookTier):PlaybookMaterialRef[] {
    return playbook.materials.map(item=>{
      if(tier==='high')return {...item,text:undefined};
      if(item.text)return item;
      if(!wantsPlaybookText(playbook.state,item))return item;
      const text=readBoundedText(item.absPath);
      return text?{...item,text}:item;
    });
  }
  skills(): SkillLibraryView { return skillLibraryView(this.dataDir, this.root); }
  private distillAttachments(): DistillAttachment[] {
    if (this.settingsValue.skillDistill !== true) return [];
    const wanted = normalizeSkillAttach(this.settingsValue.skillAttach);
    if (!wanted.length) return [];
    const ready = new Map(this.skills().ready.map((row) => [row.name, row]));
    const out: DistillAttachment[] = [];
    for (const ref of wanted) {
      const row = ready.get(ref.name);
      if (!row) continue;
      const item: DistillAttachment = { name: row.name, whenToUse: row.whenToUse };
      if (ref.full) {
        const body = readSkillText(this.dataDir, row.name);
        if (body) item.body = body.trimEnd();
      }
      out.push(item);
    }
    return out;
  }
  importDistillPaste(text: string, opts?: { agent?: string; overwrite?: boolean; rename?: string; summary?: boolean; now?: () => Date }): { id?: string; skill?: { ok: true; name: string; overwritten: boolean } | { ok: false; reason: string; name?: string; conflict?: boolean } } {
    const parts = splitDistillPaste(text);
    let id: string | undefined;
    if (opts?.summary !== false) {
      if (!parts.summary.trim()) throw new Error('请粘贴 json 或 md 内容');
      id = this.import(parts.summary, opts?.agent).id;
    }
    if (!parts.skill && !parts.files.length && !parts.errors.length) return { ...(id ? { id } : {}) };
    if (parts.errors.length || !parts.skill) return { ...(id ? { id } : {}), skill: { ok: false, reason: parts.errors[0] || '没有 skill 块' } };
    const written = writeSkillLibrary(this.dataDir, parts.skill, parts.files, { overwrite: opts?.overwrite, rename: opts?.rename, now: opts?.now });
    if (!written.ok) return { ...(id ? { id } : {}), skill: written };
    return { ...(id ? { id } : {}), skill: { ok: true, name: written.name, overwritten: written.overwritten } };
  }
  newLink(agent:string,canWrite=true,mode?:string):string {return this.linkText(mode==='json'?'json':'create',undefined,'',agent);}
  list():RebirthList {
    const groups:RebirthList['groups']=[];
    for(const f of this.files()) {const id=/^R[1-9]\d*(?=-)/.exec(path.basename(f))?.[0];if(!id || this.registered[id]!==path.relative(this.root,f))continue;try{const d=this.read(id),s=this.selection(id);let g=groups.find(g=>g.agent===d.meta.agent);if(!g)groups.push(g={agent:d.meta.agent,topics:[]});let t=g.topics.find(t=>t.topic===d.meta.topic);if(!t)g.topics.push(t={topic:d.meta.topic,items:[]});t.items.push({id,no:d.meta.no,title:d.meta.title,blocks:d.blocks.length,selectedCount:exportBlocks(d.blocks,s).length,created:d.meta.created,cover:this.cover(id)});}catch{/* watcher quarantines */}}
    for(const g of groups)for(const t of g.topics)t.items.sort((a,b)=>b.no-a.no);
    const q=path.join(this.root,'_quarantine');const quarantined=fs.existsSync(q)?fs.readdirSync(q).filter(f=>f.endsWith('.reason.txt')).map(f=>({name:f.slice(0,-11),reason:fs.readFileSync(path.join(q,f),'utf8')})):[];
    return {groups,quarantined};
  }
}
export function newLink(root:string,agent:string,canWrite=true,mode?:string):string {const c={root:path.resolve(root,'rebirth'),agent:agentName(agent)};return mode==='json'?exportJsonLink(c):createLink(c);}

function wantsPlaybookText(state: TaskPlaybookInput['state'], item: PlaybookMaterialRef): boolean {
  const slot = state.slots.find((row) => row.id === item.slotId);
  if (!slot || !item.slotId) return false;
  const mount = item.mount ?? slot.mount;
  if (mount === 'manual' && !state.manualIds.includes(item.materialId)) return false;
  if (mount === 'auto' || mount === 'agent') return false;
  const delivery = item.delivery ?? slot.delivery;
  return delivery === 'full' || delivery === 'summary';
}

function readBoundedText(absPath: string): string | null {
  if (!absPath) return null;
  try {
    const st = fs.statSync(absPath);
    if (!st.isFile() || st.size > 64 * 1024) return null;
    const buf = fs.readFileSync(absPath);
    if (buf.includes(0)) return null;
    return buf.toString('utf8');
  } catch {
    return null;
  }
}
