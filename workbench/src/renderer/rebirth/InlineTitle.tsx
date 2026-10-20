import { useState } from 'react';
/** Enter commits once; Escape cancels without touching the stored title. */
export function InlineTitle({title,onSave}:{title:string;onSave:(title:string)=>Promise<void>}) {
 const [draft,setDraft]=useState<string|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const save=async()=>{if(draft===null||busy)return;const next=draft.trim();if(!next){setError('标题不能为空');return;}setBusy(true);try{if(next!==title)await onSave(next);setDraft(null);setError('');}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}};
 return <span className="rb-inline-title" onClick={e=>e.stopPropagation()} onDoubleClick={e=>e.stopPropagation()} onDragStart={e=>{e.preventDefault();e.stopPropagation();}}>
 {draft===null?<button className="rb-title" title="点击编辑标题" onClick={()=>{setDraft(title);setError('');}}>{title}</button>:<input className="rb-title-input" autoFocus aria-label="编辑资料标题" value={draft} disabled={busy} onFocus={e=>e.currentTarget.select()} onChange={e=>setDraft(e.target.value)} onKeyDown={e=>{if(e.nativeEvent.isComposing)return;if(e.key==='Enter'){e.preventDefault();void save();}if(e.key==='Escape'){e.preventDefault();setDraft(null);setError('');}}} onBlur={()=>{if(!busy){setDraft(null);setError('');}}}/>}
 {error&&<span role="alert" className="rb-error">{error}</span>}
 </span>;
}
