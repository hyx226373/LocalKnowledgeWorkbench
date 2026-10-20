import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RebirthRepository, newLink, filterExport } from '../src/main/rebirth/repository';
import { parseImport, parseJson, parseMarkdown, serializeMarkdown } from '../src/main/rebirth/format';
import { bindRebirthMethods } from '../src/main/rebirth/ipc';
const titles = ['任意标题', '[新类型] 原样标题', '另一个标题'];
const roots:string[]=[];
function repo() { const root=fs.mkdtempSync(path.join(os.tmpdir(),'rebirth-'));roots.push(root);return new RebirthRepository(root,vi.fn(),async file=>fs.rmSync(file,{recursive:true})); }
const md=`---\nlkw: rebirth/1\nagent: Codex\ntitle: 测试标题\n---\n## [背景] 留下\n可见事实\n## [决定] 不选\n机密未选\n## [资料] 隐藏\n机密隐藏\n`;
afterEach(()=>roots.splice(0).forEach(r=>fs.rmSync(r,{recursive:true,force:true})));
describe('重生格式与网页版 JSON §10',()=>{
 it('合法 json 转标准 md 往返并保留摘要和任意块',()=>{
   const json={lkw:'rebirth/1',agent:'ChatGPT',title:'网页',topic:'测试',created:'2026-10-16',blocks:titles.map(title=>({title,body:'事实\n### 普通标题',summary:'结论'}))};
   const doc=parseImport('```json\n'+JSON.stringify(json)+'\n```');
   expect(doc.meta.agent).toBe('chatgpt');expect(doc.blocks[0].body).toContain('> 摘要：结论');expect(parseMarkdown(serializeMarkdown(doc)).blocks).toEqual(doc.blocks);
   const r=repo(),{id}=r.import(JSON.stringify(json));expect(r.read(id).blocks).toEqual(doc.blocks);
 });
 it.each([
   ['{\n"lkw": ???\n}',/JSON 语法错误：第 2 行，第 \d+ 列/],
   ['{}',/缺少字段 title/],
   ['{"lkw":"rebirth/1"}',/缺少字段 title/],
   ['{"lkw":"rebirth/1","title":"a"}',/缺少字段 blocks/],
   ['{"lkw":"rebirth/1","title":"a","blocks":[]}',/blocks.*不能为空/],
   ['{"lkw":"rebirth/1","title":"a","blocks":[{"type":"错"}]}',/第 1 块 缺少 title/],
   ['{"lkw":"rebirth/1","title":"a","blocks":[{"type":"背景","title":"a"}]}',/第 1 块 缺少 body/],
 ])('中文错误 %s',(text,pattern)=>expect(()=>parseJson(text)).toThrow(pattern));
 it('带代码围栏 md 和任意标题前缀原样导入',()=>{
   const r=repo();const {id}=r.import('```markdown\n'+md+'```');expect(id).toBe('R1');expect(r.read(id).meta.agent).toBe('codex');
   const d=parseMarkdown(md.replace('[背景]','[新类型]'));expect(d.blocks[0].title).toBe('[新类型] 留下');expect(d.warnings).toBeUndefined();
 });
});
describe('导出版隔离 §6',()=>{
 it('null 默认全选，[] 全不选，隐藏永不导出',()=>{const r=repo(),{id}=r.import(md);expect(r.selection(id)).toEqual({selected:null,hidden:[]});expect(r.generate(id).text).toContain('机密未选');r.setSelection(id,[1,3],[3]);expect(r.generate(id).text).toContain('可见事实');expect(r.generate(id).text).not.toMatch(/机密未选|机密隐藏/);r.setSelection(id,[],[]);expect(r.generate(id).text).toBe('（未选择任何内容）');expect(r.copy(id,'file').empty).toBe(true);});
 it('过滤附件、各种嵌入引用、链接、原文件名路径；两种复制只用导出版',()=>{
  const r=repo(),{id}=r.import(md);const original=r.file(id);
  const dangerous=`\n![附件](attachment.pdf)\n![[secret.png]]\n<img src="secret.png">\n<iframe src="secret.html">SECRET_IFRAME</iframe>\n<embed src="secret.pdf">\n<object>SECRET_OBJECT</object>\n{{SECRET_INCLUDE}}\n<!-- include SECRET_COMMENT -->\n[文字](other-file.md)\n[锚点](#secret)\n${original}\n${path.basename(original)}\n`;
  const d=r.read(id);d.blocks[0].body+=dangerous;r.save(id,d.blocks);r.setSelection(id,[1,3],[3]);
  const out=r.generate(id);expect(path.dirname(out.file)).toBe(r.out);expect(out.text).toContain('文字');
  for(const text of [out.text,r.copy(id,'full').text,r.copy(id,'file').text]) for(const forbidden of ['机密未选','机密隐藏','attachment.pdf','secret.png','secret.html','secret.pdf','SECRET_',original,path.basename(original),'other-file.md','#secret'])expect(text).not.toContain(forbidden);
 });
 it('编辑、重排与外部变更重新生成，selection 持久化',()=>{
  const r=repo(),{id}=r.import(md);r.setSelection(id,[1],[3]);const d=r.read(id);r.save(id,[d.blocks[1],d.blocks[0],d.blocks[2]]);expect(r.selection(id)).toEqual({selected:[2],hidden:[3]});expect(r.generate(id).text).toContain('可见事实');
  const r2=new RebirthRepository(r.dataDir);expect(r2.selection(id)).toEqual(r.selection(id));
  fs.writeFileSync(r.file(id),fs.readFileSync(r.file(id),'utf8').replace('可见事实','已编辑事实'));r.scan(10000);r.scan(12001);expect(fs.readFileSync(path.join(r.out,id+'.out.md'),'utf8')).toContain('已编辑事实');
 });
 it('过滤引用式图片、引用定义、HTML 和跨文件 wiki 链接',()=>expect(filterExport('![图][a]\n[a]: /secret\n[[/secret/file|标签]]\n<!-- hidden -->\n<img src=x />',[])).toBe('标签'));
});
describe('仓库监听、编号和隔离',()=>{
 it('连续两秒大小 mtime 稳定后入库，忽略临时与隔离目录',()=>{
  const r=repo(),dir=path.join(r.root,'codex');fs.mkdirSync(dir);fs.writeFileSync(path.join(dir,'new.md'),md);fs.writeFileSync(path.join(dir,'ignored.md.tmp'),md);fs.writeFileSync(path.join(dir,'~ignored.md'),md);
  r.scan(0);r.scan(1999);expect(r.list().groups).toHaveLength(0);r.scan(2000);expect(r.list().groups[0].topics[0].items[0].id).toBe('R1');
  fs.writeFileSync(path.join(dir,'bad.md'),'错误');r.scan(3000);r.scan(5000);expect(r.list().quarantined).toEqual([]);expect(r.read('R2').blocks[0].body).toBe('错误');expect(fs.existsSync(path.join(dir,'bad.md'))).toBe(false);
  expect(r.import(md).id).toBe('R3');expect(new RebirthRepository(r.dataDir).import(md).id).toBe('R4');
 });
 it('标题重命名和系统回收站删除清除 selection、所有导出副本',async()=>{const r=repo(),{id}=r.import(md);r.drag(id);r.rename(id,'新名字');expect(path.basename(r.file(id))).toContain('新名字');expect(r.read(id).meta.title).toBe('新名字');await r.delete(id);expect(r.list().groups).toHaveLength(0);expect(fs.readdirSync(r.out)).toEqual([]);expect(JSON.parse(fs.readFileSync(path.join(r.root,'selection.json'),'utf8'))).toEqual({});});
});
describe('拖出、文件导出 §9 和三种新链接',()=>{
 it('拖出同步刷新，仅允许 rebirth-out 内真实文件，拒绝原文件和符号链接',()=>{
   const r=repo(),{id}=r.import(md);r.setSelection(id,[1],[3]);fs.writeFileSync(path.join(r.out,id+'.out.md'),'旧内容');const f=r.drag(id);expect(path.dirname(f)).toBe(r.out);expect(path.basename(f)).toBe('R1-测试标题.md');expect(fs.readFileSync(f,'utf8')).toBe(r.generate(id).text);expect(()=>r.assertDragPath(r.file(id))).toThrow('rebirth-out');fs.symlinkSync(r.file(id),path.join(r.out,'bad.md'));expect(()=>r.assertDragPath(path.join(r.out,'bad.md'))).toThrow();
 });
 it('IPC 导出和 startDrag 使用同一过滤内容，JSON 选择文件支持取消',async()=>{
   const r=repo(),{id}=r.import(md);r.setSelection(id,[1],[3]);const dest=path.join(r.dataDir,'saved.md'),startDrag=vi.fn();const api=bindRebirthMethods(r,{pickJson:async()=>null,saveFile:async()=>dest,copy:vi.fn(),startDrag});
   expect(await api.rebirthExportFile({id})).toEqual({canceled:false,path:dest});expect(fs.readFileSync(dest,'utf8')).toBe(r.generate(id).text);api.rebirthDragOut({id});const file=startDrag.mock.calls[0][0];expect(path.dirname(file)).toBe(r.out);expect(fs.readFileSync(file,'utf8')).toBe(r.generate(id).text);expect(await api.rebirthImportJson({pickFile:true})).toBeNull();
 });
 it.each(['file','markdown','json'])('新链接 %s 包含格式块清单与必选文件头',mode=>{const text=newLink('D:\\study_dev\\LocalKnowledgeWorkbench\\agent-data','codex',mode!=='markdown',mode);expect(text).toContain('概述');expect(text).toContain('overview');expect(text).toContain('来源对话');if(mode==='json')expect(text).toContain('fenced json object');});
});
