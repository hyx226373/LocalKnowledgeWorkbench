import {expect,it,vi} from 'vitest';
import type {ReactElement} from 'react';
const state=vi.hoisted(()=>({first:null as unknown,saved:[] as any[],pick:vi.fn(async()=>'D:\\picked')}));
vi.mock('react',async o=>{let n=0;return {...await o<typeof import('react')>(),useEffect:()=>{},useState:(init:unknown)=>{const v=n++%6===0?state.first:init;return [v,vi.fn()];}};});
vi.mock('../src/renderer/kb',()=>({kb:{pickFolder:state.pick,rebirthSettingsSet:async(v:any)=>{state.saved.push(v);return v;}}}));
vi.mock('../src/renderer/rebirth/client',()=>({call:async(_m:string,v:any)=>{state.saved.push(v);return v;}}));
import {RebirthSettingsPane} from '../src/renderer/settings/RebirthSettingsPane';
const nodes=(node:any):ReactElement<any>[]=>{if(Array.isArray(node))return node.flatMap(nodes);if(!node||typeof node!=='object')return [];return [node,...nodes(node.props?.children)];};
it('指定目录用选文件夹按钮（记住上次位置）并可恢复默认',async()=>{
 state.first={mode:'manual',folder:'',missingFolder:'root',defaultDir:'C:\\app\\agent-data\\rebirth',archive:{mode:'dir',allowNewFolder:false,dir:'D:\\old'}};
 const all=nodes(RebirthSettingsPane());
 expect(all.some(n=>n.type==='input'&&n.props.value==='D:\\old')).toBe(false);
 all.find(n=>n.props?.['data-testid']==='rebirth-archive-dir-pick')!.props.onClick();
 await vi.waitFor(()=>expect(state.saved.at(-1)?.archive?.dir).toBe('D:\\picked'));
 expect(state.pick).toHaveBeenCalledWith({dialogKey:'dialogLastDir.archiveLocation',title:'选择归档目录'});
 all.find(n=>n.props?.['data-testid']==='rebirth-archive-dir-clear')!.props.onClick();
 await vi.waitFor(()=>expect(state.saved.at(-1)?.archive?.dir).toBe(''));
});
