import {afterEach,expect,it,vi} from 'vitest';
import type {RebirthApi,RebirthFolder} from '../src/shared/rebirth';
const holder=vi.hoisted(()=>({kb:{} as Partial<RebirthApi>}));
vi.mock('../src/renderer/kb',()=>holder);
import {available,call,subscribe,tree} from '../src/renderer/rebirth/client';
afterEach(()=>{for(const key of Object.keys(holder.kb))delete (holder.kb as Record<string,unknown>)[key];});
it('共享主进程树转换为视图树，根与子目录卡片各出现一次',async()=>{
 const item={id:'R1',no:1,title:'标题',created:'2026-10-16',blocks:1,selectedCount:1};
 const root:RebirthFolder={folder:'',name:'根',items:[item],folders:[{folder:'资料',name:'资料',items:[{...item,id:'R2',cover:'data:image/png;base64,example'}],folders:[]}]};
 holder.kb.rebirthTree=vi.fn(async()=>({root,quarantined:[{name:'错误',reason:'格式'}]}));
 const result=await tree();expect(result.items.map(i=>i.id)).toEqual(['R1']);expect(result.folders[0].path).toBe('资料');expect(result.folders[0].items?.map(i=>i.id)).toEqual(['R2']);expect(result.folders[0].items?.[0].cover).toContain('data:image');expect(result.quarantined[0].reason).toBe('格式');
});
it('设置与文件夹方法原样发送实际签名，拖出同步返回',async()=>{
 const settings={mode:'manual',folder:'资料',missingFolder:'root',generateCover:true} as const;
 holder.kb.rebirthSettingsSet=vi.fn(async s=>s);holder.kb.rebirthFolderMove=vi.fn(async()=>{});holder.kb.rebirthImportJson=vi.fn(async()=>null);holder.kb.rebirthDragOut=vi.fn(()=>true);
 expect(await call('rebirthSettingsSet',settings)).toEqual(settings);await call('rebirthFolderMove',{folder:'资料',parent:'目标'});expect(holder.kb.rebirthFolderMove).toHaveBeenCalledWith({folder:'资料',parent:'目标'});
 expect(await call('rebirthImportJson',{pickFile:true})).toBeNull();expect(call('rebirthDragOut',{id:'R1'})).toBe(true);
});
it('旧列表仅降级为根卡片，不伪造 agent 目录；事件可解绑',async()=>{
 holder.kb.rebirthList=vi.fn(async()=>({groups:[{agent:'codex',topics:[{topic:'主题',items:[{id:'R1',no:1,title:'标题',blocks:1,selectedCount:1,created:'现在'}]}]}],quarantined:[]}));
 const result=await tree();expect(result.folders).toEqual([]);expect(result.items[0].agent).toBe('codex');const off=vi.fn();holder.kb.onRebirthChanged=vi.fn(()=>off);expect(subscribe(vi.fn())).toBe(off);
});
it('缺失 IPC 有明确错误，空仓库和缺失事件安全降级',async()=>{expect(available('rebirthCoverSet')).toBe(false);expect(()=>call('rebirthDragOut',{id:'R1'})).toThrow('未连接 rebirthDragOut');await expect(call('rebirthCoverSet',{id:'R1'})).rejects.toThrow('未连接 rebirthCoverSet');expect(await tree()).toEqual({folders:[],items:[],quarantined:[]});expect(()=>subscribe(vi.fn())()).not.toThrow();});
it('新文本接口仅生成文本，缺失时绝不调用旧链接接口',async()=>{
 const {linkText}=await import('../src/renderer/rebirth/client');
 const legacy=vi.fn();holder.kb.rebirthNewLink=legacy;holder.kb.rebirthCopyLink=legacy;
 await expect(linkText('create')).rejects.toThrow('未连接 rebirthLinkText');expect(legacy).not.toHaveBeenCalled();
 const generate=vi.fn(async()=>({text:'请立即执行：读取并更新这个文件。 /tmp/notes.md'}));
 Object.assign(holder.kb,{rebirthLinkText:generate});
 expect(await linkText('import','R1')).toContain('/tmp/notes.md');expect(generate).toHaveBeenCalledWith({kind:'import',id:'R1'});
});
it('五种链接都通过新文本协议且不触碰剪贴板',async()=>{
 const {linkText}=await import('../src/renderer/rebirth/client');
 const generate=vi.fn(async(input:{kind:string})=>({text:input.kind}));Object.assign(holder.kb,{rebirthLinkText:generate});
 for(const kind of ['create','json','import','export','root'] as const)expect(await linkText(kind)).toBe(kind);
 expect(generate).toHaveBeenCalledTimes(5);
});
