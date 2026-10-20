import {it,expect} from 'vitest';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {RebirthRepository} from '../src/main/rebirth/repository';
const mk=(allow:boolean)=>{const d=fs.mkdtempSync(path.join(os.tmpdir(),'aij-'));const r=new RebirthRepository(d);r.setSettings({...r.settings(),archive:{mode:'ai',allowNewFolder:allow,dir:''},mode:'ai',missingFolder:allow?'create':'root'});r.folderCreate('项目');return r;};
const json=(folder:string)=>JSON.stringify({title:'t',folder,blocks:[{title:'a',body:'b'}]});
it('AI 决定：网页版指令要求 folder 并附文件夹树',()=>{const t=mk(true).linkText('json');expect(t).toContain('top-level folder');expect(t).toContain('项目');});
it('AI 决定：按 folder 归档，不存在按允许新建处理，非法路径拒收',()=>{
 const r=mk(true);const a=r.import(json('项目'));expect(path.basename(path.dirname(r.file(a.id)))).toBe('项目');
 const b=r.import(json('新的/子'));expect(r.file(b.id)).toContain(path.join('新的','子'));
 const r2=mk(false);const c=r2.import(json('不存在'));expect(path.dirname(r2.file(c.id))).toBe(r2.settings().rootDir);
 expect(()=>r2.import(json('../逃逸'))).toThrow();
});
