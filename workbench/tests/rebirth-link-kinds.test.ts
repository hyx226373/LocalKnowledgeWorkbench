import { describe, it, expect } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { REBIRTH_LINK_KINDS } from '../src/shared/rebirth';
import { RebirthRepository } from '../src/main/rebirth/repository';
const src=(p:string)=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');
describe('link kinds',()=>{
  it('every renderer button kind is in the main whitelist',()=>{
    const files=['src/renderer/rebirth/client.ts','src/renderer/rebirth/Repository.tsx','src/renderer/rebirth/Transfer.tsx','src/renderer/agent-live/panel.tsx'];
    const used=new Set<string>();for(const f of files)for(const m of src(f).matchAll(/(?:copy|copyLink|linkText)\('([A-Za-z]+)'/g))used.add(m[1]);
    for(const m of src('src/renderer/rebirth/client.ts').matchAll(/exportWebOn\(\)\?'([A-Za-z]+)':'([A-Za-z]+)'/g)){used.add(m[1]);used.add(m[2]);}
    for(const k of ['create','json','import','export','exportWeb','importWeb','root'])expect(used.has(k)).toBe(true);
    for(const k of used)expect(REBIRTH_LINK_KINDS as readonly string[]).toContain(k);
  });
  it('every whitelisted kind produces text through the main handler',()=>{
    const data=fs.mkdtempSync(path.join(os.tmpdir(),'rlk-'));const repo=new RebirthRepository(data);
    const root=path.join(data,'rebirth');fs.mkdirSync(root,{recursive:true});fs.writeFileSync(path.join(root,'a.md'),'# t\n\n## 块\n正文\n');
    let t=1e12;repo.scan(t);repo.scan(t+2500);
    for(const k of REBIRTH_LINK_KINDS){if(k==='root')continue;const text=repo.linkText(k,'R1','');expect(text.length).toBeGreaterThan(10);}
    expect(()=>repo.linkText('exportJson')).toThrow();
    const web=repo.linkText('exportWeb','R1');expect(web.startsWith('Identity: restore working context')).toBe(true);expect(web).toContain('正文');expect(web).not.toContain('rebirth-out');
    const iw=repo.linkText('importWeb','R1');expect(iw).toContain('If unrelated');expect(iw).toContain('json');expect(iw).toContain('正文');
  });
});
