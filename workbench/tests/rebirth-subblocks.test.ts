import {afterEach,expect,it,vi} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {splitSubBlocks,joinSubBlocks,selectedSubs,blockCheck,selectBlock,exportBlocks} from '../src/shared/rebirthSubblocks';
import {RebirthRepository} from '../src/main/rebirth/repository';
import {BUILTIN_FORMATS,formatInstruction} from '../src/shared/rebirthFormat';
import {bindRebirthMethods} from '../src/main/rebirth/ipc';
const b=(body:string)=>({idx:1,title:'大块',type:'todo',body});
const dirs:string[]=[];
afterEach(()=>dirs.splice(0).forEach(d=>fs.rmSync(d,{recursive:true,force:true})));
function fixture(body='引言\n\n### 甲\n甲正文\n\n### 乙\n乙正文'){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'r18s-'));dirs.push(dir);const repo=new RebirthRepository(dir);const {id}=repo.import('## 大块\n<!-- type: todo -->\n'+body+'\n\n## 空块\n');return {repo,id,dir};}
it('优先三级标题切分，引言不可独立勾选，列表留在所属小块内',()=>{
 const p=splitSubBlocks(b('引言一\n\n引言二\n\n### 甲\n- 一\n- 二\n\n### 乙\n正文'));
 expect(p.style).toBe('heading');expect(p.intro).toBe('引言一\n\n引言二');expect(p.items.map(i=>i.id)).toEqual(['1:1','1:2']);expect(p.items[0].body).toContain('- 二');
});
it('顶层列表连同缩进续行、嵌套列表、空行切分，支持三种列表标记',()=>{
 const p=splitSubBlocks(b('说明\n\n- 甲\n  续行\n  - 嵌套\n\n  第二段\n* 乙\n1. 丙'));
 expect(p.style).toBe('list');expect(p.intro).toBe('说明');expect(p.items).toHaveLength(3);expect(p.items[0].body).toBe('- 甲\n  续行\n  - 嵌套\n\n  第二段');
});
it('无标题/列表时按空行分段，围栏里的标题、列表和空行不参与切分',()=>{
 const p=splitSubBlocks(b('第一段\n续行\n\n```md\n### 示例\n- 示例\n\n代码\n```\n\n第三段'));
 expect(p.style).toBe('paragraph');expect(p.intro).toBe('');expect(p.items).toHaveLength(3);expect(p.items[1].body).toContain('\n\n代码');expect(splitSubBlocks(b('')).items).toEqual([]);
});
it('旧 selection 按大块全选解释，半选态、全选/全不选计算一致',()=>{
 const block=b('- 甲\n- 乙');const old={selected:[1],hidden:[]};expect(selectedSubs(block,old)).toEqual([1,2]);
 const partial={...old,subSelected:{1:[2]}};expect(blockCheck(block,partial)).toEqual({checked:false,indeterminate:true});
 expect(blockCheck(block,selectBlock(block,partial,true))).toEqual({checked:true,indeterminate:false});expect(blockCheck(block,selectBlock(block,partial,false))).toEqual({checked:false,indeterminate:false});
 expect(blockCheck(b(''),{selected:null,hidden:[]})).toEqual({checked:true,indeterminate:false});
});
it('旧 selection.json 重启兼容，IPC 小块勾选持久化并验证编号',async()=>{
 const {repo,id}=fixture();fs.writeFileSync(path.join(repo.root,'selection.json'),JSON.stringify({[id]:{selected:[1],hidden:[]}}));const next=new RebirthRepository(repo.dataDir);expect(next.generate(id).text).toContain('乙正文');
 const api=bindRebirthMethods(next,{copy:vi.fn(),pickJson:async()=>null,saveFile:async()=>null,startDrag:vi.fn()});await api.rebirthSelectionSet({id,selected:[1],hidden:[],subSelected:{1:[2]}});
 expect(new RebirthRepository(repo.dataDir).selection(id).subSelected).toEqual({1:[2]});expect(next.generate(id).text).not.toContain('甲正文');expect(()=>next.setSelection(id,null,[],{1:[3]})).toThrow('小块号');
});
it('导出仅保留选中条目，标题/type/引言条件保留，隐藏仍优先；网页与文件同源',()=>{
 const {repo,id}=fixture();repo.setSelection(id,[1],[],{1:[2]});const text=repo.generate(id).text;
 for(const expected of ['## 大块','<!-- type: todo -->','引言','### 乙','乙正文'])expect(text).toContain(expected);
 expect(text).not.toMatch(/### 甲|甲正文|空块/);expect(repo.linkText('exportWeb',id)).toContain(text);expect(fs.readFileSync(repo.generate(id).file,'utf8')).toBe(text);
 repo.setSelection(id,[1],[],{1:[]});expect(repo.generate(id).empty).toBe(true);repo.setSelection(id,[1],[1],{1:[2]});expect(repo.generate(id).empty).toBe(true);
 expect(exportBlocks([b('')],{selected:[1],hidden:[]})).toHaveLength(1);
});
it.each(['### 甲\n甲\n\n### 乙\n乙\n\n### 丙\n丙','- 甲\n- 乙\n- 丙','甲\n\n乙\n\n丙'])('编辑、排序、删除、添加后按来源迁移勾选并先备份：%s',body=>{
 const {repo,id}=fixture(body);repo.setSelection(id,[1],[],{1:[2]});
 let block=repo.read(id).blocks[0],p=splitSubBlocks(block);
 const save=(items:typeof p.items,origins:number[])=>{repo.save(id,[{...block,body:joinSubBlocks({...p,items}),subOrigins:origins},repo.read(id).blocks[1]]);block=repo.read(id).blocks[0];p=splitSubBlocks(block);};
 save([p.items[2],p.items[0],p.items[1]],[3,1,2]);expect(repo.selection(id).subSelected?.[1]).toEqual([3]);
 save(p.items.map((s,i)=>i===2?{...s,body:s.body+' 修改'}:s),[1,2,3]);expect(repo.selection(id).subSelected?.[1]).toEqual([3]);expect(repo.generate(id).text).toContain('修改');
 save([p.items[1],p.items[2]],[2,3]);expect(repo.selection(id).subSelected?.[1]).toEqual([2]);
 const newBody=p.style==='heading'?'### 新条目\n新增':p.style==='list'?'- 新增':'新增';save([...p.items,{idx:0,id:'new',body:newBody}],[1,2,0]);expect(repo.selection(id).subSelected?.[1]).toEqual([2,3]);
 save([p.items[0],p.items[2]],[1,3]);expect(repo.selection(id).subSelected?.[1]).toEqual([2]);expect(repo.generate(id).text).not.toContain('修改');expect(repo.backups(id).length).toBeGreaterThan(0);
});
it('旧全不选添加条目默认勾选，其他旧条目保持未选；大块重排保留细选',()=>{
 const {repo,id}=fixture('- 甲\n- 乙');repo.setSelection(id,[],[]);const blocks=repo.read(id).blocks;repo.save(id,[{...blocks[0],body:'- 甲\n- 乙\n- 新增',subOrigins:[1,2,0]},blocks[1]]);expect(repo.selection(id).subSelected?.[1]).toEqual([3]);
 const current=repo.read(id).blocks;repo.save(id,[current[1],current[0]]);expect(repo.selection(id).subSelected?.[2]).toEqual([3]);expect(repo.generate(id).text).toContain('新增');expect(repo.generate(id).text).not.toContain('- 甲');
});
it('整块编辑没有来源提示时按原文匹配迁移细选',()=>{
 const {repo,id}=fixture('- 甲\n- 乙\n- 丙');repo.setSelection(id,[1],[],{1:[2]});const blocks=repo.read(id).blocks;
 repo.save(id,[{...blocks[0],body:'- 丙\n- 甲\n- 乙 修改'},blocks[1]]);expect(repo.selection(id).subSelected?.[1]).toEqual([3]);
});
it('预设和自定义格式，以及创建/普通导入/网页创建导入均包含新句子',()=>{
 const sentence='body headings use ### or deeper.';const {repo,id}=fixture();
 for(const f of [...BUILTIN_FORMATS,{id:'custom',name:'自定',builtin:false,text:'任意格式'}]){expect(formatInstruction(f)).toContain(sentence);if(!f.builtin)repo.setSettings({formats:[f],activeFormat:f.id});for(const kind of ['create','json','import','importWeb'] as const)expect(repo.linkText(kind,id)).toContain(sentence);}
});
it('删除最后一个条目后留下的引言不会被隐式选中，编辑拆成多条继承原勾选',async()=>{
 const {composeSubEdit}=await import('../src/shared/rebirthSubblocks');const {repo,id}=fixture('说明\n\n### 甲\n甲');repo.setSelection(id,[1],[]);const blocks=repo.read(id).blocks;const p=splitSubBlocks(blocks[0]);
 repo.save(id,[composeSubEdit(blocks[0],p,[],[]),blocks[1]]);expect(repo.read(id).blocks[0].body).toBe('说明');expect(repo.generate(id).empty).toBe(true);
 const {repo:r,id:key}=fixture('甲\n\n乙');r.setSelection(key,[1],[],{1:[2]});const bs=r.read(key).blocks,parts=splitSubBlocks(bs[0]);r.save(key,[composeSubEdit(bs[0],parts,[parts.items[0],{...parts.items[1],body:'乙一\n\n乙二'}],[1,2]),bs[1]]);expect(r.selection(key).subSelected?.[1]).toEqual([2,3]);expect(r.generate(key).text).not.toContain('甲');
});
it('小块标红用正文偏移定位，排序后仍追随条目，删除条目后清理标红',async()=>{
 const {createAgentMarkStore}=await import('../src/main/agentMarks/store');const {repo,id,dir}=fixture('- 甲\n- 乙');const store=createAgentMarkStore(path.join(dir,'marks.json'));const block=repo.read(id).blocks[0];const text=splitSubBlocks(block).items[1].body;
 const source=fs.readFileSync(repo.file(id),'utf8'),start=source.indexOf(block.body)+block.body.indexOf(text);store.add({absPath:repo.file(id),text,startLine:1,endLine:1,startOffset:start,endOffset:start+text.length,rebirth:{id,no:1,title:'大块',blockIdx:1}});
 const refresh=()=>store.refreshRebirth(key=>{const d=repo.read(key),source=fs.readFileSync(repo.file(key),'utf8');return {file:repo.file(key),title:d.meta.title,source,blocks:d.blocks.map(b=>({...b,start:source.indexOf(b.body)}))};});
 repo.save(id,[{...block,body:'- 乙\n\n- 甲',subOrigins:[2,1]},repo.read(id).blocks[1]]);refresh();const mark=store.list()[0];expect(mark.text).toBe('- 乙');expect(fs.readFileSync(repo.file(id),'utf8').slice(mark.startOffset,mark.endOffset)).toBe('- 乙');
 repo.save(id,[{...block,body:'- 甲',subOrigins:[2]},repo.read(id).blocks[1]]);refresh();expect(store.list()).toEqual([]);
});
