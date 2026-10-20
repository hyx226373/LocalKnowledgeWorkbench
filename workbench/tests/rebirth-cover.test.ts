import {afterEach,describe,expect,it,vi} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {RebirthRepository} from '../src/main/rebirth/repository';
import {bindRebirthMethods} from '../src/main/rebirth/ipc';
import {parseImport} from '../src/main/rebirth/format';
import {DIALOG_LAST_DIR} from '../src/shared/dialogLastDir';
const roots:string[]=[];
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=','base64');
const data='data:image/png;base64,'+png.toString('base64');
const md='---\nlkw: rebirth/1\nagent: codex\ntitle: 封面测试\n---\n## [背景] 保留\n事实\n## [决定] 不选\n不许泄露\n';
const json=(cover:unknown=data)=>JSON.stringify({lkw:'rebirth/1',title:'封面测试',agent:'chatgpt',cover,blocks:[{type:'背景',title:'保留',body:'事实'},{type:'决定',title:'不选',body:'不许泄露'}]});
function fixture(){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rebirth-cover-'));roots.push(dir);const trashed:string[]=[];const changed=vi.fn();const repo=new RebirthRepository(dir,changed,async f=>{trashed.push(f);fs.renameSync(f,path.join(dir,'trash-'+trashed.length));});return {dir,repo,trashed,changed};}
afterEach(()=>{for(const root of roots.splice(0))fs.rmSync(root,{recursive:true,force:true});});
describe('封面与指令',()=>{
 it('默认关闭，设置落盘，三种新链接均受开关控制且保持 500 字限制',()=>{
  const {repo}=fixture();expect(repo.settings().generateCover).toBe(false);
  for(const mode of ['file','markdown','json'])expect(repo.newLink('codex',mode==='file',mode)).not.toContain('Optional cover');
  repo.folderCreate('学习/资料');repo.setSettings({...repo.settings(),mode:'ai',generateCover:true});
  const reloaded=new RebirthRepository(repo.dataDir);expect(reloaded.settings().generateCover).toBe(true);
  for(const mode of ['file','markdown','json']){const text=reloaded.newLink('codex',mode==='file',mode);expect(text).toContain('only if image generation is available');expect(text).toContain('same basename and directory');expect(text).toContain('optional cover string');expect(text).toContain('omit cover without blocking');}
  reloaded.setSettings({...reloaded.settings(),generateCover:false});expect(reloaded.newLink('codex')).not.toContain('Optional cover');
 });
 it('兼容没有开关的旧配置，默认仍关',()=>{const {repo}=fixture();repo.setSettings({mode:'manual',folder:'',missingFolder:'root'});expect(new RebirthRepository(repo.dataDir).settings().generateCover).toBe(false);});
 it('带围栏 json cover 落盘且树提供可展示 data URL，不把 base64 写进 md',()=>{
  const {repo}=fixture();const {id}=repo.import('```json\n'+json()+'\n```');const file=repo.file(id);
  expect(fs.readFileSync(file.slice(0,-3)+'.cover.png')).toEqual(png);expect(repo.tree().root.items[0].cover).toBe(data);
  expect(fs.readFileSync(file,'utf8')).not.toContain('base64');expect(parseImport(json()).blocks[0].body).toBe('事实');
 });
 it('网络封面仅记录 URL，不下载，不发送给 img 展示；跟随改名和回收',async()=>{
  const {repo,trashed}=fixture();const {id}=repo.import(json('https://example.invalid/cover.png'));const first=repo.file(id);const sidecar=first.slice(0,-3)+'.cover.url';
  expect(fs.readFileSync(sidecar,'utf8')).toBe('https://example.invalid/cover.png');expect(repo.cover(id)).toBeUndefined();expect(repo.generate(id).text).not.toContain('example.invalid');
  repo.rename(id,'远程链接');expect(fs.existsSync(sidecar)).toBe(false);const next=repo.file(id);expect(fs.readFileSync(next.slice(0,-3)+'.cover.url','utf8')).toContain('example.invalid');await repo.delete(id);expect(trashed).toEqual([next.slice(0,-3)+'.cover.url',next,path.join(repo.dataDir,'rebirth-backup',id)]);
 });
 it.each(['data:image/svg+xml;base64,PHN2Zy8+', 'data:image/png;base64,bm90LWFuLWltYWdl','file:///tmp/cover.png',42,'https://'])('拒绝无效封面且不产生半份入库 %s',cover=>{const {repo}=fixture();expect(()=>repo.import(json(cover))).toThrow(/cover|封面/);expect(repo.tree().root.items).toEqual([]);});
 it('同名收件图片随编号改名，后续图片变更发事件，移动与标题改名保留封面',()=>{
  const {repo,changed}=fixture();const incoming=path.join(repo.root,'incoming.md');fs.writeFileSync(incoming,md);fs.writeFileSync(incoming.slice(0,-3)+'.png',png);
  repo.scan(0);repo.scan(2000);const first=repo.file('R1');expect(fs.existsSync(incoming.slice(0,-3)+'.png')).toBe(false);expect(fs.readFileSync(first.slice(0,-3)+'.cover.png')).toEqual(png);
  changed.mockClear();fs.appendFileSync(first.slice(0,-3)+'.cover.png','changed');repo.scan(3000);expect(changed).toHaveBeenCalled();
  repo.folderCreate('目标');repo.move('R1','目标');repo.rename('R1','就地修改');expect(repo.read('R1').meta.title).toBe('就地修改');expect(repo.cover('R1')).toContain('data:image/png');expect(fs.existsSync(first)).toBe(false);
 });
 it('AI 稍后才写出的原同名图片在重启后也能关联',()=>{
  const {repo}=fixture();const incoming=path.join(repo.root,'later.md');fs.writeFileSync(incoming,md);repo.scan(0);repo.scan(2000);
  const reloaded=new RebirthRepository(repo.dataDir);fs.writeFileSync(incoming.slice(0,-3)+'.png',png);reloaded.scan(3000);expect(reloaded.cover('R1')).toBe(data);expect(fs.existsSync(incoming.slice(0,-3)+'.png')).toBe(false);
 });
 it('已有 md 后加入同名图片自动关联；移除与整份删除都走回收站',async()=>{
  const {repo,trashed}=fixture();const {id}=repo.import(md);const file=repo.file(id);fs.writeFileSync(file.slice(0,-3)+'.jpg',Buffer.from([255,216,255,0]));repo.scan(0);
  expect(repo.cover(id)).toContain('data:image/jpeg');await repo.removeCover(id);expect(trashed[0]).toBe(file.slice(0,-3)+'.cover.jpg');expect(repo.cover(id)).toBeUndefined();
  const cover=path.join(repo.dataDir,'new.png');fs.writeFileSync(cover,png);repo.setCover(id,cover);await repo.delete(id);expect(trashed.slice(1)).toEqual([file.slice(0,-3)+'.cover.png',file,path.join(repo.dataDir,'rebirth-backup',id)]);
 });
 it('更换封面 IPC 支持取消，过滤非法图片并保留旧封面，移除后刷新',async()=>{
  const {repo,dir}=fixture();const {id}=repo.import(json());let source:string|null=null;const host={pickCover:async()=>source,pickJson:async()=>null,saveFile:async()=>null,copy:vi.fn(),startDrag:vi.fn()};const api=bindRebirthMethods(repo,host);
  expect(await api.rebirthCoverSet({id})).toEqual({canceled:true});expect(repo.cover(id)).toBe(data);
  source=path.join(dir,'bad.png');fs.writeFileSync(source,'bad');await expect(api.rebirthCoverSet({id})).rejects.toThrow('封面');expect(repo.cover(id)).toBe(data);
  fs.writeFileSync(source,png);expect(await api.rebirthCoverSet({id})).toEqual({canceled:false});await api.rebirthCoverRemove({id});expect(repo.cover(id)).toBeUndefined();expect(DIALOG_LAST_DIR.rebirthCover).toBe('dialogLastDir.rebirthCover');
 });
 it('封面、未选块与原文件路径不进入导出版、两种链接、拖出和文件夹导出',()=>{
  const {repo,dir}=fixture();const {id}=repo.import(json());repo.setSelection(id,[1],[]);const file=repo.file(id);const cover=file.slice(0,-3)+'.cover.png';
  const text=repo.generate(id).text;const copies=[text,repo.copy(id,'file').text,repo.copy(id,'full').text,fs.readFileSync(repo.drag(id),'utf8')];const out=path.join(dir,'export');repo.exportFolder('',out);copies.push(fs.readFileSync(path.join(out,'R1-封面测试.md'),'utf8'));
  for(const value of copies)for(const secret of [file,cover,'不许泄露','data:image','base64',png.toString('base64')])expect(value).not.toContain(secret);
  expect(fs.readdirSync(out)).toEqual(['R1-封面测试.md']);
 });
 it('复用收件文件名时，迟到封面归属最新资料',()=>{
  const {repo}=fixture();const incoming=path.join(repo.root,'same.md');
  fs.writeFileSync(incoming,md);repo.scan(0);repo.scan(2000);
  fs.writeFileSync(incoming,md);repo.scan(3000);repo.scan(5000);
  fs.writeFileSync(incoming.slice(0,-3)+'.png',png);repo.scan(6000);
  expect(repo.cover('R1')).toBeUndefined();expect(repo.cover('R2')).toBe(data);
 });
 it('文件导出 IPC 只写过滤正文，无任何封面副本；新链接剪贴板也受开关控制',async()=>{
  const {repo,dir}=fixture();const {id}=repo.import(json());repo.setSelection(id,[1],[]);
  const destination=path.join(dir,'export.md'),copy=vi.fn();
  const api=bindRebirthMethods(repo,{pickJson:async()=>null,saveFile:async()=>destination,copy,startDrag:vi.fn()});
  await api.rebirthExportFile({id});expect(fs.readFileSync(destination,'utf8')).toBe(repo.generate(id).text);expect(fs.readFileSync(destination,'utf8')).not.toMatch(/base64|cover|不许泄露/);
  repo.setSettings({...repo.settings(),generateCover:true});
  for(const mode of ['file','markdown','json']){const result=api.rebirthNewLink({agent:'codex',mode}) as {text:string};expect(result.text).toContain('only if image generation is available');expect(copy).not.toHaveBeenCalled();}
 });
 it('符号链接图片不会被读取或关联',()=>{const {repo,dir}=fixture();const {id}=repo.import(md);const source=path.join(dir,'real.png');fs.writeFileSync(source,png);fs.symlinkSync(source,repo.file(id).slice(0,-3)+'.cover.png');expect(repo.cover(id)).toBeUndefined();expect(()=>repo.setCover(id,repo.file(id).slice(0,-3)+'.cover.png')).toThrow('封面');});
});
