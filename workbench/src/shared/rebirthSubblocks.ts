import type { RebirthBlock, RebirthSelection } from './rebirth';
export interface SubBlock { id:string; idx:number; body:string }
export interface SubParts { style:'heading'|'list'|'paragraph'; intro:string; items:SubBlock[] }
/** Fence contents are opaque, including blank lines and apparent headings/list markers. */
export function splitSubBlocks(block:Pick<RebirthBlock,'idx'|'body'>):SubParts {
 const lines=block.body.trim().split('\n'); let fence:{char:string;length:number}|undefined;
 const visible=lines.map(line=>{const m=/^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);if(fence){if(m&&m[1][0]===fence.char&&m[1].length>=fence.length&&!m[2].trim())fence=undefined;return false;}if(m){fence={char:m[1][0],length:m[1].length};return false;}return true;});
 let starts=lines.flatMap((l,i)=>visible[i]&&/^###\s+/.test(l)?[i]:[]);let style:SubParts['style']='heading';
 if(!starts.length){style='list';starts=lines.flatMap((l,i)=>visible[i]&&/^(?:[-*] |\d+\. )/.test(l)?[i]:[]);}
 if(!starts.length){style='paragraph';starts=lines.flatMap((l,i)=>l.trim()&&(i===0||visible[i-1]&&!lines[i-1].trim())?[i]:[]);}
 const intro=style==='paragraph'?'':lines.slice(0,starts[0]??0).join('\n').trim();
 return {style,intro,items:starts.map((start,i)=>({id:`${block.idx}:${i+1}`,idx:i+1,body:lines.slice(start,starts[i+1]??lines.length).join('\n').trim()}))};
}
export function joinSubBlocks(parts:SubParts):string {return [parts.intro,...parts.items.map(s=>s.body)].filter(Boolean).join('\n\n');}
/** Preserve each entry's origin even when an edit splits it into several entries. */
export function composeSubEdit(block:RebirthBlock,parts:SubParts,items:SubBlock[],origins:number[]):RebirthBlock {
 const body=joinSubBlocks({...parts,items});
 let cursor=parts.intro.length;
 const ranges=items.map((item,i)=>{const start=body.indexOf(item.body,cursor);cursor=start+item.body.length;return {start,end:cursor,origin:origins[i]};});
 cursor=0;
 const subOrigins=splitSubBlocks({...block,body}).items.map(item=>{const start=body.indexOf(item.body,cursor);cursor=start+item.body.length;return ranges.find(r=>start>=r.start&&start<r.end)?.origin??-1;});
 return {...block,body,subOrigins};
}
export function selectedSubs(block:RebirthBlock,s:RebirthSelection):number[] {
 const items=splitSubBlocks(block).items;
 return s.subSelected?.[block.idx]!==undefined?items.filter(i=>s.subSelected![block.idx].includes(i.idx)).map(i=>i.idx):(s.selected===null||s.selected.includes(block.idx)?items.map(i=>i.idx):[]);
}
export function blockCheck(block:RebirthBlock,s:RebirthSelection):{checked:boolean;indeterminate:boolean} {
 const n=splitSubBlocks(block).items.length,k=selectedSubs(block,s).length;
 return n?{checked:k===n,indeterminate:k>0&&k<n}:{checked:s.selected===null||s.selected.includes(block.idx),indeterminate:false};
}
export function selectBlock(block:RebirthBlock,s:RebirthSelection,on:boolean):RebirthSelection {
 const selected=s.selected===null?null:on?[...new Set([...s.selected,block.idx])]:s.selected.filter(i=>i!==block.idx);
 return {...s,selected,subSelected:{...s.subSelected,[block.idx]:on?splitSubBlocks(block).items.map(i=>i.idx):[]}};
}
export function exportBlocks(blocks:RebirthBlock[],s:RebirthSelection):RebirthBlock[] {
 return blocks.flatMap(b=>{if(s.hidden.includes(b.idx))return [];const p=splitSubBlocks(b);if(!p.items.length)return (s.selected===null||s.selected.includes(b.idx))?[b]:[];const ids=selectedSubs(b,s);return ids.length?[{...b,body:joinSubBlocks({...p,items:p.items.filter(i=>ids.includes(i.idx))})}]:[];});
}
/** Match unchanged entries first so deletion and movement cannot steal an edited entry's slot. */
export function migrateSubs(old:RebirthBlock,next:RebirthBlock,s:RebirthSelection,origins?:number[]):number[] {
 const before=splitSubBlocks(old).items,after=splitSubBlocks(next).items,chosen=selectedSubs(old,s),used=new Set<number>();
 const mapping=after.map(a=>{const j=before.findIndex(b=>!used.has(b.idx)&&b.body===a.body);if(j<0)return 0;used.add(before[j].idx);return before[j].idx;});
 const remaining=before.filter(b=>!used.has(b.idx)).map(b=>b.idx);
 return after.flatMap((a,i)=>{const origin=origins?.[i]??(mapping[i]||remaining.shift()||0);return origin===0||chosen.includes(origin)?[a.idx]:[];});
}
