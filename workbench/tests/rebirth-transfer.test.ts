import {afterEach,expect,it,vi} from 'vitest';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {RebirthRepository} from '../src/main/rebirth/repository';
import {bindRebirthMethods} from '../src/main/rebirth/ipc';
const dirs:string[]=[];const md='---\nlkw: rebirth/1\nagent: codex\ntitle: 原题\n---\n## [背景] 旧块\n旧内容\n## [资料] 私密\n隐藏内容';
function setup(){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'r17e-'));dirs.push(dir);const repo=new RebirthRepository(dir);const {id}=repo.import(md);return {repo,id,dir};}
afterEach(()=>dirs.splice(0).forEach(d=>fs.rmSync(d,{recursive:true,force:true})));
it('本地导入读原文且含中止条款；网页指令带原内容与完整 JSON 格式；导出共用过滤复制',async()=>{
 const {repo,id}=setup();repo.setSelection(id,[1],[2]);const copy=vi.fn();const api=bindRebirthMethods(repo,{copy,pickJson:async()=>null,saveFile:async()=>null,startDrag:vi.fn()});
 const local=api.rebirthImportInstruction({id,mode:'file'}) as {text:string};expect(local.text).toContain(repo.file(id));expect(local.text).toContain('stop and ask which subject should be updated');expect(copy).not.toHaveBeenCalled();
 const web=repo.importInstruction(id,'json').text;expect(web).toContain('隐藏内容');expect(web).toContain('nonempty array of {"title":"configured title","type":"configured type","body":"Markdown string"}');expect(web).toContain('stop and ask');
 const out=api.rebirthCopyLink({id,mode:'file'}) as {text:string};expect(out).toEqual(repo.copy(id,'file'));expect(out.text).not.toContain(repo.file(id));expect(repo.generate(id).text).not.toContain('隐藏内容');
});
it('外部直接覆盖在检测前已保留旧版，稳定后更新，重启仍可恢复并备份当前版',()=>{
 const {repo,id,dir}=setup();const old=fs.readFileSync(repo.file(id),'utf8');fs.writeFileSync(repo.file(id),old.replace('旧内容','外部更新后的内容'));repo.scan(0);expect(repo.backups(id)).toHaveLength(1);repo.scan(2000);expect(repo.generate(id).text).toContain('外部更新');
 const next=new RebirthRepository(dir);next.restore(id,next.backups(id)[0].version);expect(fs.readFileSync(next.file(id),'utf8')).toBe(old);expect(next.backups(id)).toHaveLength(2);
});
it('JSON 合并整体替换同一 id 与路径，校验失败不改变内容，文件选择取消不写入',async()=>{
 const {repo,id}=setup();const file=repo.file(id),old=fs.readFileSync(file,'utf8');repo.setSelection(id,[],[]);
 expect(()=>repo.merge(id,'{"lkw":"rebirth/1"}')).toThrow();expect(fs.readFileSync(file,'utf8')).toBe(old);expect(repo.backups(id)).toEqual([]);
 repo.merge(id,'```json\n'+JSON.stringify({lkw:'rebirth/1',title:'新题',agent:'chatgpt',blocks:[{type:'决定',title:'新块',body:'新全文',summary:'摘要'}]})+'\n```',{confirmFewer:true});expect(repo.file(id)).toBe(file);expect(repo.read(id).meta.title).toBe('新题');expect(repo.read(id).blocks[0].body).toContain('新全文');expect(repo.selection(id).selected).toEqual([]);expect(fs.readFileSync(path.join(repo.dataDir,'rebirth-backup',id,repo.backups(id)[0].version),'utf8')).toBe(old);
 const api=bindRebirthMethods(repo,{copy:vi.fn(),pickJson:async()=>null,saveFile:async()=>null,startDrag:vi.fn()});expect(await api.rebirthMerge({id,pickFile:true})).toBeNull();expect(()=>repo.restore(id,'../../evil')).toThrow();
});
it('就地编辑自动备份，回退后导出版同步',()=>{const {repo,id}=setup();const doc=repo.read(id);repo.save(id,doc.blocks.map(b=>({...b,body:'编辑内容'})));expect(repo.backups(id)).toHaveLength(1);repo.restore(id,repo.backups(id)[0].version);expect(repo.generate(id).text).toContain('旧内容');});
it('损坏的外部覆盖仍可从上一版恢复，临时不存在不会丢失备份',()=>{const {repo,id}=setup();fs.writeFileSync(repo.file(id),'不完整');repo.scan(0);repo.scan(2000);expect(repo.backups(id)).toHaveLength(1);repo.restore(id,repo.backups(id)[0].version);expect(repo.read(id).meta.title).toBe('原题');});
it('封面与备份跨资料和文件夹移动、改名后仍可恢复，删除时一起回收',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'r17merge-'));dirs.push(dir);const trashed:string[]=[];
 const repo=new RebirthRepository(dir,()=>{},async file=>{trashed.push(file);fs.renameSync(file,path.join(dir,'trash-'+trashed.length));});
 const {id}=repo.import(md);const image=Buffer.from([255,216,255,0]);fs.writeFileSync(repo.file(id).slice(0,-3)+'.cover.jpg',image);
 repo.save(id,repo.read(id).blocks.map(b=>({...b,body:'更新内容'})));const version=repo.backups(id)[0].version;
 repo.folderCreate('甲/子');repo.folderCreate('乙');repo.move(id,'甲/子');repo.rename(id,'改名');repo.folderRename('甲','新甲');repo.folderMove('新甲','乙');
 repo.restore(id,version);expect(repo.read(id).meta.folder).toBe('乙/新甲/子');expect(repo.generate(id).text).toContain('旧内容');expect(repo.cover(id)).toContain('data:image/jpeg');expect(repo.backups(id).some(v=>v.version===version)).toBe(true);
 const backup=path.join(dir,'rebirth-backup',id);await repo.folderDelete('乙/新甲');expect(trashed).toContain(backup);expect(fs.existsSync(backup)).toBe(false);expect(fs.existsSync(path.join(repo.out,id+'.out.md'))).toBe(false);
});
