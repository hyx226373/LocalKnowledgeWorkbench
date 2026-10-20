import {beforeEach,expect,it,vi} from 'vitest';
import type {ReactElement} from 'react';
const state=vi.hoisted(()=>({index:0,values:[] as unknown[],setters:[] as ReturnType<typeof vi.fn>[],api:{rebirthImportJson:vi.fn(),rebirthTree:vi.fn()}}));
vi.mock('react',async original=>({...await original<typeof import('react')>(),useEffect:()=>{},useState:(initial:unknown)=>{const index=state.index++;return [index in state.values?state.values[index]:initial,state.setters[index]??(state.setters[index]=vi.fn())];}}));
vi.mock('../src/renderer/kb',()=>({kb:state.api}));
import {Repository} from '../src/renderer/rebirth/Repository';
function nodes(node:unknown):ReactElement<any>[] {
 if(Array.isArray(node))return node.flatMap(nodes);
 if(!node||typeof node!=='object'||!('props' in node))return [];
 const element=node as ReactElement<any>;return [element,...nodes(element.props.children)];
}
beforeEach(()=>{state.index=0;state.values=[];state.setters=[];vi.clearAllMocks();state.api.rebirthImportJson.mockResolvedValue({id:'R1'});state.api.rebirthTree.mockResolvedValue({root:{folder:'',name:'根',items:[],folders:[]},quarantined:[]});});
const json='{"title":"主题","blocks":[{"title":"块","body":"正文"}]}';
function event(files:unknown[]=[],text=''){return {preventDefault:vi.fn(),stopPropagation:vi.fn(),dataTransfer:{files,getData:(type:string)=>type==='text/plain'?text:''}};}
it('r21 §7：Agent 仓库禁止外来拖入，标题行和树都不调用 JSON 导入',async()=>{
 const rendered=nodes(Repository());
 const heading=rendered.find(n=>n.props.className==='rb-heading')!;
 heading.props.onDrop?.(event([],json));
 const tree=rendered.find(n=>n.props.role==='tree')!;
 tree.props.onDrop?.(event([{name:'summary.json',text:async()=>json}]));
 await new Promise(r=>setTimeout(r,20));
 expect(state.api.rebirthImportJson).not.toHaveBeenCalled();
});
it('文件树空白处右键提供导入 json 内联入口',()=>{
 let rendered=nodes(Repository());
 rendered.find(n=>n.props.role==='tree')!.props.onContextMenu({preventDefault:vi.fn(),stopPropagation:vi.fn()});
 expect(state.setters[9]).toHaveBeenCalledWith({path:'',name:'根目录'});
 state.index=0;state.values[9]={path:'',name:'根目录'};
 rendered=nodes(Repository());
 rendered.find(n=>n.type==='button'&&n.props.children==='从网页版导入…')!.props.onClick();
 expect(state.setters[3]).toHaveBeenCalledWith(true);
 state.index=0;state.values[3]=true;
 expect(nodes(Repository()).find(n=>n.type==='textarea'&&n.props['aria-label']==='从网页版导入')).toBeDefined();
});

it('标题设置按钮通过应用设置入口定位重生仓库，每次点击都传入分类',async()=>{
 const {openSettingsRef,openSettings}=await import('../src/renderer/settings/openSettings');
 const previous=openSettingsRef.current;
 const handler=vi.fn();openSettingsRef.current=handler;
 try {
  const button=nodes(Repository()).find(n=>n.type==='button'&&n.props.title==='打开重生仓库设置')!;
  expect(button).toBeDefined();
  button.props.onClick();button.props.onClick();
  expect(handler.mock.calls).toEqual([['rebirth'],['rebirth']]);
  openSettings();
  expect(handler).toHaveBeenLastCalledWith(undefined);
 } finally {openSettingsRef.current=previous;}
});
it('网页版是抽屉：收起时没有创建/导入子按钮',()=>{
 const all=nodes(Repository());const t=(n:any)=>JSON.stringify(n.props.children);
 const head=all.find(n=>n.type==='button'&&t(n).includes('网页版'))!;expect(head).toBeDefined();expect(head.props['aria-expanded']).toBe(false);
 expect(all.some(n=>n.type==='button'&&n.props.children==='创建')).toBe(false);
});
