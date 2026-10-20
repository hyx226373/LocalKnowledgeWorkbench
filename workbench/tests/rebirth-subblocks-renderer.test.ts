import {beforeEach,expect,it,vi} from 'vitest';
import type {ReactElement} from 'react';
const state=vi.hoisted(()=>({index:0,values:[] as any[]}));
vi.mock('react',async original=>({...await original<typeof import('react')>(),useState:(initial:unknown)=>{const i=state.index++;return [i in state.values?state.values[i]:initial,(v:unknown)=>{state.values[i]=v;}];}}));
import {BlockCheckbox,SubBlocks} from '../src/renderer/rebirth/SubBlocks';
const block={idx:1,title:'块',body:'说明\n\n### 甲\n内容甲\n\n### 乙\n内容乙'};
const selection={selected:[1],hidden:[],subSelected:{1:[2]}};
function nodes(node:any):ReactElement<any>[] {return Array.isArray(node)?node.flatMap(nodes):node&&typeof node==='object'&&node.props?[node,...nodes(node.props.children)]:[];}
beforeEach(()=>{state.index=0;state.values=[];});
it('大块 checkbox ref 将 DOM indeterminate 设为 true，切回全选时清除',()=>{
 const onChange=vi.fn();const el=BlockCheckbox({block,selection,busy:false,onChange});const dom={indeterminate:false};(el.props.ref as Function)(dom);expect(dom.indeterminate).toBe(true);expect(el.props.checked).toBe(false);
 el.props.onChange({target:{checked:true}});expect(onChange).toHaveBeenCalledWith(true);
 const all=BlockCheckbox({block,selection:{selected:null,hidden:[]},busy:false,onChange});(all.props.ref as Function)(dom);expect(dom.indeterminate).toBe(false);expect(all.props.checked).toBe(true);
});
function setup(body=block.body){const props={block:{...block,body},selection,busy:false,render:(s:string)=>s,persist:vi.fn(async()=>{}),save:vi.fn(async(_block:typeof block & {subOrigins?:number[]})=>{}),mark:vi.fn(async()=>{}),unmark:vi.fn(async()=>{}),isMarked:(s:string)=>s.includes('内容乙')};const render=()=>{state.index=0;return nodes(SubBlocks(props));};const find=(label:string,index=0)=>render().filter(n=>n.type==='button'&&(n.props.children===label||n.props['aria-label']===label))[index];const click=(label:string,index=0)=>{let b=find(label,index);if(!b){find('更多',index).props.onClick();b=find(label,0);}b.props.onClick();};return {props,render,click};}
it('引言无 checkbox，小块勾选与标红调用正确文本，排序携带原序号',async()=>{
 const {props,render,click}=setup();const inputs=render().filter(n=>n.type==='input');expect(inputs).toHaveLength(2);expect(inputs[0].props.checked).toBe(false);expect(inputs[1].props.checked).toBe(true);
 inputs[0].props.onChange({target:{checked:true}});await vi.waitFor(()=>expect(props.persist).toHaveBeenCalledWith({...selection,subSelected:{1:[2,1]}}));
 click('标红',0);await vi.waitFor(()=>expect(props.mark).toHaveBeenCalledWith('### 甲\n内容甲'));expect(render().filter(n=>n.type==='button'&&n.props['aria-label']==='移除标红')).toHaveLength(1);expect(render().filter(n=>n.type==='button'&&n.props['aria-label']==='标红')).toHaveLength(1);expect(render().some(n=>n.props.className==='rb-sub marked')).toBe(true);
 click('下移');await vi.waitFor(()=>expect(props.save).toHaveBeenCalledWith(expect.objectContaining({subOrigins:[2,1]})));
});
it('删除需要内联确认，编辑 textarea 保存保留引言和来源',async()=>{
 const {props,render,click}=setup();click('删除条目');expect(props.save).not.toHaveBeenCalled();expect(render().some(n=>n.props.role==='dialog')).toBe(false);click('确认删除');await vi.waitFor(()=>expect(props.save).toHaveBeenCalledWith(expect.objectContaining({body:'说明\n\n### 乙\n内容乙',subOrigins:[2]})));
 click('编辑条目',1);render().find(n=>n.type==='textarea')!.props.onChange({target:{value:'### 乙\n改完'}});click('保存条目');await vi.waitFor(()=>expect(props.save).toHaveBeenCalledWith(expect.objectContaining({body:'说明\n\n### 甲\n内容甲\n\n### 乙\n改完',subOrigins:[1,2]})));
});
it.each(['### 甲\n正文','旧段一\n\n旧段二','- 甲\n- 乙'])('添加条目保持旧条目可选，提交来源 0 默认勾选：%s',async body=>{
 const {props,render,click}=setup(body);click('添加条目');render().find(n=>n.type==='textarea')!.props.onChange({target:{value:'新增\n续行'}});click('添加并勾选');await vi.waitFor(()=>expect(props.save).toHaveBeenCalled());const sent=props.save.mock.calls[0][0] as any;expect(sent.subOrigins.at(-1)).toBe(0);expect(sent.body).toContain(body.startsWith('###')?'### 新条目\n新增\n续行':'- 新增\n  续行');if(body.startsWith('旧'))expect(sent.body).toContain('- 旧段一\n\n- 旧段二');
});
it('保存失败保留内联输入并显示错误',async()=>{
 const {props,render,click}=setup();props.save.mockRejectedValueOnce(new Error('写入失败'));click('编辑条目');click('保存条目');await vi.waitFor(()=>expect(render().some(n=>n.props.role==='alert'&&String(n.props.children).includes('写入失败'))).toBe(true));expect(render().some(n=>n.type==='textarea')).toBe(true);
});
