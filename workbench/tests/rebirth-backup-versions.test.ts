import { describe, it, expect } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { RebirthRepository } from '../src/main/rebirth/repository';
describe('external rewrite backups',()=>{
  it('keeps one version per external rewrite and restores any of them',()=>{
    const data=fs.mkdtempSync(path.join(os.tmpdir(),'rbk-'));const repo=new RebirthRepository(data);
    const root=path.join(data,'rebirth');fs.mkdirSync(root,{recursive:true});
    let t=1e12;const settle=()=>{repo.scan(t);t+=2500;repo.scan(t);t+=2500;};
    fs.writeFileSync(path.join(root,'a.md'),'# v0\n\n## 块\n内容0\n');settle();
    const file=fs.readdirSync(root).find(f=>/^R1-/.test(f))!;const full=path.join(root,file);
    for(let i=1;i<=3;i++){const st=fs.statSync(full);fs.writeFileSync(full,`# v${i}\n\n## 块\n内容${i}\n`);fs.utimesSync(full,st.atime,new Date(st.mtimeMs+i*5000));settle();}
    const vs=repo.backups('R1');const texts=vs.map(v=>fs.readFileSync(path.join(data,'rebirth-backup','R1',v.version),'utf8'));
    for(const n of [0,1,2])expect(texts.some(x=>x.includes(`内容${n}`))).toBe(true);
    const old=vs.find((_,i)=>texts[i].includes('内容1'))!;repo.restore('R1',old.version);
    expect(fs.readFileSync(full,'utf8')).toContain('内容1');
    expect(repo.backups('R1').some(v=>fs.readFileSync(path.join(data,'rebirth-backup','R1',v.version),'utf8').includes('内容3'))).toBe(true);
  });
});
