import {afterEach,expect,it,vi} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {RebirthRepository} from '../src/main/rebirth/repository';
import {parseImport,parseMarkdown,serializeMarkdown} from '../src/main/rebirth/format';
import {bindRebirthMethods} from '../src/main/rebirth/ipc';
import {createAgentMarkStore} from '../src/main/agentMarks/store';
import {REBIRTH_METHODS} from '../src/shared/rebirth';
const roots:string[]=[];
const md='---\nlkw: rebirth/1\nagent: Codex\ntitle: 文件树\n---\n## [背景] 留下\n可见事实\n## [决定] 不选\n不许泄露\n';
function fixture(){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rebirth-tree-'));roots.push(dir);const trashed:string[]=[];const repo=new RebirthRepository(dir,vi.fn(),async file=>{trashed.push(file);fs.renameSync(file,path.join(dir,'trash-'+trashed.length));});return {repo,trashed,dir};}
afterEach(()=>{for(const root of roots.splice(0))fs.rmSync(root,{recursive:true,force:true});});
it('手动默认根、当前文件夹和 agent 无关，树含空文件夹和卡片元数据',()=>{
 const {repo}=fixture();const {id}=repo.import(md);expect(path.dirname(repo.file(id))).toBe(repo.root);
 repo.folderCreate('项目/资料');repo.folderCreate('空目录');repo.setSettings({mode:'manual',folder:'项目/资料',missingFolder:'root'});
 const next=repo.import(md).id;expect(repo.read(next).meta.folder).toBe('项目/资料');
 const tree=repo.tree();expect(tree.root.items[0].agent).toBe('codex');expect(tree.root.folders.find(f=>f.name==='项目')!.folders[0].items[0].id).toBe(next);
 expect(new RebirthRepository(repo.dataDir).settings()).toEqual(repo.settings());
});
it('卡片移动与重命名保留编号、封面、selection，清理旧拖出副本并刷新导出版',()=>{
 const {repo}=fixture();repo.folderCreate('目标');const {id}=repo.import(md);repo.setSelection(id,[1],[]);const old=repo.file(id);
 fs.writeFileSync(old.slice(0,-3)+'.cover.png','cover');repo.drag(id);repo.move(id,'目标');
 const moved=repo.file(id);expect(fs.existsSync(old)).toBe(false);expect(fs.readFileSync(moved.slice(0,-3)+'.cover.png','utf8')).toBe('cover');expect(repo.selection(id)).toEqual({selected:[1],hidden:[]});expect(fs.readdirSync(repo.out)).toEqual([id+'.out.md']);
 expect(repo.generate(id).text).not.toContain('不许泄露');repo.rename(id,'改名');expect(fs.existsSync(repo.file(id).slice(0,-3)+'.cover.png')).toBe(true);expect(repo.read(id).meta.folder).toBe('目标');
});
it('文件夹改名和移动禁止自身子孙，归档设置跟随；删除整夹走回收站并清理派生状态',async()=>{
 const {repo,trashed}=fixture();repo.folderCreate('甲/子');repo.folderCreate('乙');repo.setSettings({mode:'manual',folder:'甲/子',missingFolder:'root'});const {id}=repo.import(md);repo.setSelection(id,[],[2]);fs.writeFileSync(repo.file(id).slice(0,-3)+'.cover.webp','cover');
 expect(()=>repo.folderMove('甲','甲/子')).toThrow('自身或子孙');repo.folderRename('甲','新甲');expect(repo.settings().folder).toBe('新甲/子');repo.folderMove('新甲','乙');expect(repo.read(id).meta.folder).toBe('乙/新甲/子');expect(repo.selection(id).selected).toEqual([]);
 await repo.folderDelete('乙/新甲');expect(trashed).toEqual([path.join(repo.root,'乙/新甲'),path.join(repo.dataDir,'rebirth-backup',id)]);expect(fs.existsSync(path.join(trashed[0],'子'))).toBe(false);expect(fs.readdirSync(path.join(repo.dataDir,'trash-1/子')).some(f=>f.endsWith('.cover.webp'))).toBe(true);
 expect(repo.settings().folder).toBe('');expect(fs.readdirSync(repo.out)).toEqual([]);expect(JSON.parse(fs.readFileSync(path.join(repo.root,'selection.json'),'utf8'))).toEqual({});expect(()=>repo.file(id)).toThrow('不存在');
});
it('单文件删除连同封面走回收站',async()=>{const {repo,trashed}=fixture();const {id}=repo.import(md);const file=repo.file(id);fs.writeFileSync(file.slice(0,-3)+'.cover.jpg','x');await repo.delete(id);expect(trashed).toEqual([file.slice(0,-3)+'.cover.jpg',file,path.join(repo.dataDir,'rebirth-backup',id)]);});
it('AI folder 存在、缺失落根、缺失创建，JSON 和 md folder 往返',()=>{
 const {repo}=fixture();repo.folderCreate('已有');repo.setSettings({mode:'ai',folder:'',missingFolder:'root'});
 const text=md.replace('title: 文件树','folder: 已有\ntitle: 文件树');const id=repo.import(text).id;expect(repo.read(id).meta.folder).toBe('已有');expect(parseMarkdown(serializeMarkdown(repo.read(id))).meta.folder).toBe('已有');
 const json={lkw:'rebirth/1',title:'JSON',agent:'chatgpt',folder:'缺少/子',blocks:[{type:'背景',title:'题',body:'事实'}]};expect(parseImport(JSON.stringify(json)).meta.folder).toBe('缺少/子');
 expect(repo.read(repo.import(JSON.stringify(json)).id).meta.folder).toBe('');repo.setSettings({mode:'ai',folder:'',missingFolder:'create'});expect(repo.read(repo.import(JSON.stringify(json)).id).meta.folder).toBe('缺少/子');
});
it.each(['../外部','/tmp/外部','C:\\外部','a/../b','a\\b','_quarantine/a','_out/a','a//b'])('拒绝不安全 folder %s',folder=>{
 const {repo}=fixture();for(const mode of ['manual','ai'] as const){repo.setSettings({mode,folder:'',missingFolder:'create'});expect(()=>repo.import(md.replace('title: 文件树',`folder: ${JSON.stringify(folder)}\ntitle: 文件树`))).toThrow('路径');}expect(()=>repo.folderCreate(folder)).toThrow();
});
it('拒绝符号链接目录，递归扫描不穿透链接',()=>{const {repo,dir}=fixture();fs.mkdirSync(path.join(dir,'外部'));fs.symlinkSync(path.join(dir,'外部'),path.join(repo.root,'链接'),'dir');expect(()=>repo.folderCreate('链接/子')).toThrow('符号链接');expect(repo.tree().root.folders).toEqual([]);});
it('收件根目录稳定两秒后按设置归档，非法 folder 隔离并给原因',()=>{
 const {repo}=fixture();repo.folderCreate('收好');repo.setSettings({mode:'manual',folder:'收好',missingFolder:'root'});fs.writeFileSync(path.join(repo.root,'incoming.md'),md);repo.scan(0);repo.scan(2000);expect(repo.read('R1').meta.folder).toBe('收好');expect(fs.existsSync(path.join(repo.root,'incoming.md'))).toBe(false);
 fs.writeFileSync(path.join(repo.root,'evil.md'),md.replace('title: 文件树','folder: ../evil\ntitle: 文件树'));repo.scan(3000);repo.scan(5000);expect(repo.tree().quarantined[0].reason).toContain('路径不安全');
});
it('AI 三种新链接附缩进树、folder 提示与截断且≤500字，手动不附',()=>{
 const {repo}=fixture();repo.folderCreate('项目/资料');for(let i=0;i<55;i++)repo.folderCreate('目录'+i);
 for(const mode of ['file','markdown','json']){expect(repo.newLink('codex',mode==='file',mode)).not.toContain('文件夹树');repo.setSettings({mode:'ai',folder:'',missingFolder:'root'});const text=repo.newLink('codex',mode==='file',mode);expect(text).toContain('root-relative /-separated path');expect(text).toContain('List truncated after 50 folders');expect(text).not.toMatch(/背景\|决定|六种/);repo.setSettings({mode:'manual',folder:'',missingFolder:'root'});}
 expect(repo.newLink('codex')).toContain('Destination: '+path.join(repo.root));
});
it('文件夹导出递归只含已勾选内容，IPC 签名齐全并支持取消',async()=>{
 const {repo,dir}=fixture();repo.folderCreate('项目/子');repo.setSettings({mode:'manual',folder:'项目/子',missingFolder:'root'});const {id}=repo.import(md);repo.setSelection(id,[1],[]);fs.writeFileSync(repo.file(id).slice(0,-3)+'.cover.png','cover');const dest=path.join(dir,'导出');repo.exportFolder('项目',dest);const file=path.join(dest,'子/R1-文件树.md');expect(fs.readFileSync(file,'utf8')).toBe(repo.generate(id).text);expect(fs.readdirSync(path.dirname(file))).toEqual(['R1-文件树.md']);expect(()=>repo.exportFolder('',path.join(repo.root,'错误'))).toThrow('导出位置');
 const api=bindRebirthMethods(repo,{pickJson:async()=>null,saveFile:async()=>null,pickFolder:async()=>null,copy:vi.fn(),startDrag:vi.fn()});expect(Object.keys(api).sort()).toEqual([...REBIRTH_METHODS].sort());expect(await api.rebirthExportFolder({folder:'项目'})).toEqual({canceled:true});
});
it('标红按稳定编号追随路径和标题，块重排重新定位，删除移除引用且 signal 不含路径',()=>{
 const {repo,dir}=fixture();const {id}=repo.import(md);const store=createAgentMarkStore(path.join(dir,'marks.json'));store.add({absPath:repo.file(id),text:'可见事实',startLine:8,endLine:8,startOffset:0,endOffset:4,rebirth:{id,no:1,title:'文件树',blockIdx:1}});
 repo.folderCreate('移动');repo.move(id,'移动');repo.rename(id,'新标题');const doc=repo.read(id);repo.save(id,[doc.blocks[1],doc.blocks[0]]);
 store.refreshRebirth(key=>{const d=repo.read(key),source=fs.readFileSync(repo.file(key),'utf8');return {file:repo.file(key),title:d.meta.title,source,blocks:d.blocks.map(b=>({...b,start:source.indexOf(b.body)}))};});
 expect(store.list()[0].absPath).toBe(repo.file(id));expect(store.list()[0].rebirth).toEqual({id,no:1,title:'新标题',blockIdx:2});expect(store.signals()[0].absPath).toBe('');expect(JSON.stringify(store.signals())).not.toContain(repo.file(id));store.refreshRebirth(()=>null);expect(store.list()).toEqual([]);
});
it('文件夹导出拒绝回指仓库的符号链接和覆盖现有文件，失败前不写部分文件',()=>{
 const {repo,dir}=fixture();const {id}=repo.import(md);const link=path.join(dir,'导出链接');fs.symlinkSync(repo.root,link,'dir');expect(()=>repo.exportFolder('',link)).toThrow('导出位置');
 const dest=path.join(dir,'已有');fs.mkdirSync(dest);fs.writeFileSync(path.join(dest,'R1-文件树.md'),'用户内容');expect(()=>repo.exportFolder('',dest)).toThrow('已存在');expect(fs.readFileSync(path.join(dest,'R1-文件树.md'),'utf8')).toBe('用户内容');expect(repo.generate(id).text).toContain('可见事实');
});
it('收件文件伪装成 R 编号也重新编号；持久化索引在重启后识别已有卡片',()=>{
 const {repo}=fixture();repo.import(md);fs.writeFileSync(path.join(repo.root,'R999-伪装.md'),md);repo.scan(0);repo.scan(2000);expect(repo.read('R2').meta.title).toBe('文件树');expect(()=>repo.file('R999')).toThrow();
 const next=new RebirthRepository(repo.dataDir);next.scan(3000);next.scan(5000);expect(next.tree().root.items.map(i=>i.id)).toEqual(['R2','R1']);expect(next.import(md).id).toBe('R3');
});
