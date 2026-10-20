import { describe,it,expect } from 'vitest';
import { selectedIds,reorder,folderPaths,canMoveFolder,importKind,prepareImport,safeFolder } from '../src/renderer/rebirth/logic';
import type { Block } from '../src/renderer/rebirth/types';
const blocks:Block[]=[{idx:1,type:'背景',title:'甲',body:'一'},{idx:2,type:'决定',title:'乙',body:'二'}];
describe('重生仓库渲染逻辑',()=>{
 it('null 默认全选，空数组保持全不选',()=>{expect(selectedIds(blocks,{selected:null,hidden:[]})).toEqual([1,2]);expect(selectedIds(blocks,{selected:[],hidden:[]})).toEqual([]);});
 it('手动排序不修改输入',()=>{expect(reorder(blocks,0,1).map(b=>b.idx)).toEqual([2,1]);expect(blocks[0].idx).toBe(1);expect(reorder(blocks,-1,1)).toEqual(blocks);});
 it('目录由用户树决定，禁止移入自身子孙',()=>{expect(folderPaths([{path:'学习',name:'学习',children:[{path:'学习/项目',name:'项目'}]}])).toEqual(['学习','学习/项目']);expect(canMoveFolder('学习','学习/项目')).toBe(false);expect(canMoveFolder('学习','学习')).toBe(false);expect(canMoveFolder('学习','学习资料')).toBe(true);});
 it('识别代码块 json 与 md',()=>{expect(importKind('```json\n{"lkw":"rebirth/1"}\n```')).toBe('json');expect(importKind('---\nlkw: rebirth/1')).toBe('md');});
 it('保留合法 json 和 md，显示具体错误',()=>{const doc={lkw:'rebirth/1',title:'测试',blocks:[{type:'背景',title:'背景',body:'正文'}]};expect(prepareImport('```json\n'+JSON.stringify(doc)+'\n```')).toBe(JSON.stringify(doc));expect(()=>prepareImport('{\n"x": }')).toThrow(/JSON 语法错误.*行/);expect(()=>prepareImport(JSON.stringify({...doc,blocks:[]}))).toThrow(/非空/);expect(()=>prepareImport(JSON.stringify({...doc,blocks:[{type:'错误'}]}))).toThrow(/第 1 块缺少 title/);expect(()=>prepareImport(JSON.stringify({...doc,blocks:[{title:'块标题'}]}))).toThrow(/第 1 块缺少 body/);expect(prepareImport('```md\n## 标题\n正文\n```')).toBe('## 标题\n正文');});
 it('folder 拒绝跨目录与绝对路径',()=>{for(const path of ['../secret','a/../b','/tmp','C:\\secret','a\\..\\b'])expect(safeFolder(path)).toBe(false);expect(safeFolder('学习/项目')).toBe(true);});
});
