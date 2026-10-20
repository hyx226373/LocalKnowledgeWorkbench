import {afterEach,expect,it,vi} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
vi.mock('electron',()=>({clipboard:{writeText:vi.fn()}}));
import {clipboard} from 'electron';
import {RebirthRepository} from '../src/main/rebirth/repository';
import {bindRebirthMethods} from '../src/main/rebirth/ipc';
import {rootEntryLink} from '../src/main/rebirth/links';
import {resolveAgentDataRoot} from '../src/main/agentPanel/paths';
const dirs:string[]=[];
afterEach(()=>{for(const d of dirs.splice(0))fs.rmSync(d,{recursive:true,force:true});vi.clearAllMocks();});
it('五种文本首句、绝对路径，所有生成 IPC 均不写剪贴板；指定目录递归稳定监听',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'r18-links-'));dirs.push(dir);
 const repo=new RebirthRepository(path.join(dir,'data'));
 const target=path.join(dir,'specified');repo.setSettings({...repo.settings(),archive:{mode:'dir',allowNewFolder:false,dir:target},attachRootInfo:true});
 expect(fs.existsSync(target)).toBe(true);
 fs.mkdirSync(path.join(target,'sub'));fs.writeFileSync(path.join(target,'sub/new.md'),'---\nlkw: rebirth/1\ntitle: 测试\n---\n## [背景] 内容\n事实');
 repo.scan(0);repo.scan(2000);expect(repo.read('R1').meta.title).toBe('测试');
 const entry=path.join(dir,'live/ENTRY.md'),root=path.join(dir,'project');
 const api=bindRebirthMethods(repo,{rootEntryText:async()=>rootEntryLink([root],entry),copy:clipboard.writeText,pickJson:async()=>null,saveFile:async()=>null,startDrag:vi.fn()});
 const cases=[['create','Write channel: fast.',target],['json','Write channel: fast.',target],['import','Write channel: fast.',repo.file('R1')],['export','Identity: restore working context',path.join(repo.out,'R1.out.md')],['root','Identity: use LKW navigation',entry]];
 for(const [kind,first,absolute] of cases){const result=await api.rebirthLinkText({kind,id:'R1'}) as {text:string};expect(result.text).toContain(first);expect(result.text).toContain(absolute);expect(result.text).not.toContain('未配置');}
 expect((await api.rebirthLinkText({kind:'create'}) as {text:string}).text).toContain(root);
 api.rebirthNewLink({agent:'codex'});api.rebirthCopyLink({id:'R1',mode:'file'});api.rebirthImportInstruction({id:'R1',mode:'file'});expect(clipboard.writeText).not.toHaveBeenCalled();
 const reload=new RebirthRepository(repo.dataDir);expect(reload.file('R1')).toBe(repo.file('R1'));
});
it('默认数据目录和环境覆盖不存在时自动创建',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'r18-default-'));dirs.push(dir);
 const resolved=resolveAgentDataRoot({KB_APP_DIR:dir})!;expect(resolved.root).toBe(path.join(dir,'agent-data'));expect(fs.existsSync(resolved.root)).toBe(true);
 const repo=new RebirthRepository(resolved.root);expect(fs.existsSync(repo.root)).toBe(true);
 const override=path.join(dir,'custom');expect(resolveAgentDataRoot({KB_AGENT_DATA:override})!.root).toBe(override);expect(fs.existsSync(override)).toBe(true);
});
