import { useEffect, useState } from 'react';
import { call, type ArchiveSettings } from '../rebirth/client';
import type { RebirthFormatBlock } from '../../shared/rebirth';
import { kb } from '../kb';
import { DIALOG_LAST_DIR } from '../../shared/dialogLastDir';
import { normalizeFormats, BUILTIN_FORMAT, OPTIONAL_HEADER_FIELDS, validateFormat } from '../../shared/rebirthFormat';

export function RebirthSettingsPane() {
  const [settings, setSettings] = useState<ArchiveSettings | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [blocks,setBlocks] = useState<RebirthFormatBlock[]>([]);
  const [detail,setDetail] = useState('');
  useEffect(() => { void call('rebirthSettingsGet').then(setSettings).catch(e => setError(String(e))); }, []);
  const save = async (next: ArchiveSettings) => {
    setBusy(true); setError('');
    try { setSettings(await call('rebirthSettingsSet', next)); return true; }
    catch (e) { setError(String(e)); return false; }
    finally { setBusy(false); }
  };
  if (!settings) return <div className="kb-set-page"><h1>重生仓库</h1><p role="status">{error || '正在加载…'}</p></div>;
  const formats = normalizeFormats(settings.formats);
  const active = formats.find(f => f.id === settings.activeFormat) ?? formats[0];
  const archive = settings.archive ?? {mode: settings.mode === 'ai' ? 'ai' as const : 'dir' as const, allowNewFolder: settings.missingFolder === 'create', dir: settings.rootDir ?? ''};
  const saveArchive = (patch: Partial<typeof archive>) => {
    const next = {...archive, ...patch, mode: 'dir' as const};
    void save({...settings, archive: next, mode: 'manual', missingFolder: 'root'});
  };
  return (
    <div className="kb-set-page" data-testid="settings-rebirth">
      <h1>重生仓库</h1>
      <fieldset className="kb-set-card" disabled={busy}>
        <legend>仓库设置</legend>
        <label className="kb-field kb-set-switch-row"><input type="checkbox" checked={!!settings.generateCover} onChange={e => void save({...settings, generateCover:e.target.checked})}/>生成封面图</label>
        <label className="kb-field kb-set-switch-row"><input type="checkbox" checked={!!settings.attachRootInfo} onChange={e => void save({...settings, attachRootInfo:e.target.checked})}/>在导入链接里附带根目录和 AI 资料信息</label>
        <div className="kb-field">Agent 仓库地址</div>
        <p>更换地址会把文件、index.json、membership.json 和 file-tags.json（若有）整套复制到新地址。旧地址原样保留，不删除。</p>
        <div className="kb-field kb-set-path-row" data-testid="rebirth-archive-dir">
          <span>仓库地址</span>
          <span className="kb-agent-data-path" data-testid="rebirth-archive-dir-path">{archive.dir && archive.dir !== settings.defaultDir ? archive.dir : `默认：${settings.defaultDir ?? archive.dir}`}</span>
          <button type="button" className="kb-button kb-button--secondary" disabled={busy} data-testid="rebirth-archive-dir-pick" onClick={() => void (async () => { if (typeof kb.pickFolder !== 'function') { setError('无法打开目录选择框'); return; } const picked = await kb.pickFolder({ dialogKey: DIALOG_LAST_DIR.archiveLocation, title: '选择归档目录' }); if (picked) saveArchive({mode:'dir', dir:picked}); })()}>选择文件夹…</button>
          {archive.dir && archive.dir !== settings.defaultDir ? <button type="button" className="kb-button kb-button--secondary" disabled={busy} data-testid="rebirth-archive-dir-clear" onClick={() => saveArchive({dir:''})}>恢复默认</button> : null}
        </div>
        <p>当前目录：{archive.dir || settings.rootDir || ''}</p>
        <label className="kb-field">总结格式<select value={active.id} onChange={e => {setEditing(null);void save({...settings, activeFormat:e.target.value});}}>{formats.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}</select></label>
        <ol className="kb-set-format-list">{active.blocks?.map((b,i)=><li key={i}><strong>{b.title}</strong> · {b.type}：{b.hint}</li>)}</ol>
        {active.detail && <p>{active.detail}</p>}{active.text && <p>{active.text}</p>}
        <div className="kb-set-toolbar">
          <button type="button" className="kb-button kb-button--secondary" onClick={() => {setEditing('new');setName(active.name+' 副本');setBlocks((active.blocks??[]).map(b=>({...b})));setDetail(active.detail??active.text??'');}}>复制此预设</button>
          <button type="button" className="kb-button kb-button--secondary" onClick={() => {setEditing('new');setName('');setBlocks([]);setDetail('');}}>空白新建</button>
          <button type="button" className="kb-button kb-button--secondary" disabled={active.builtin} onClick={() => {setEditing(active.id);setName(active.name);setBlocks((active.blocks??[]).map(b=>({...b})));setDetail(active.detail??active.text??'');}}>编辑 / 重命名</button>
          <button type="button" className="kb-button kb-button--secondary" disabled={active.builtin} onClick={() => {setEditing(null);void save({...settings,formats:formats.filter(f => f.id !== active.id),activeFormat:BUILTIN_FORMAT.id});}}>删除格式</button>
        </div>
        {editing && <div className="kb-set-editor"><label className="kb-field">格式名称<input value={name} onChange={e => setName(e.target.value)}/></label>
          {blocks.map((b,i)=><div className="kb-set-block-edit" key={i}>{(['title','type','hint'] as const).map((key,j)=><label key={key}>{['块名','type','hint'][j]}<input aria-label={`第 ${i+1} 块 ${key}`} value={b[key]} onChange={e=>setBlocks(blocks.map((row,n)=>n===i?{...row,[key]:e.target.value}:row))}/></label>)}<button type="button" className="kb-button kb-button--secondary" disabled={i===0} onClick={()=>{const next=[...blocks];[next[i-1],next[i]]=[next[i],next[i-1]];setBlocks(next);}}>上移</button><button type="button" className="kb-button kb-button--secondary" disabled={i===blocks.length-1} onClick={()=>{const next=[...blocks];[next[i],next[i+1]]=[next[i+1],next[i]];setBlocks(next);}}>下移</button><button type="button" className="kb-button kb-button--secondary" onClick={()=>setBlocks(blocks.filter((_,n)=>n!==i))}>删除块</button></div>)}
          <button type="button" className="kb-button kb-button--secondary" onClick={()=>setBlocks([...blocks,{title:'',type:'',hint:''}])}>添加块</button>
          <label>详略说明<textarea value={detail} onChange={e=>setDetail(e.target.value)}/></label>
          <div className="kb-set-toolbar">
            <button type="button" className="kb-button" onClick={async () => {const id=editing === 'new' ? crypto.randomUUID() : editing;const next={id,name:name.trim(),blocks,detail,builtin:false};const issue=validateFormat(next);if(issue){setError(issue);return;}if(await save({...settings,formats:[...formats.filter(f => f.id !== id),next],activeFormat:id}))setEditing(null);}}>保存格式</button>
            <button type="button" className="kb-button kb-button--secondary" onClick={() => setEditing(null)}>取消</button>
          </div>
        </div>}
        <fieldset className="kb-set-checks"><legend>文件头可选字段</legend>{OPTIONAL_HEADER_FIELDS.map(field=><label key={field}><input type="checkbox" checked={settings.headerFields?.includes(field)??false} onChange={e=>void save({...settings,headerFields:e.target.checked?[...(settings.headerFields??[]),field]:(settings.headerFields??[]).filter(k=>k!==field)})}/>{field==='agent'?'agent（名字+模型）':field}</label>)}</fieldset>
      </fieldset>
      {error && <p className="kb-set-banner kb-set-banner--danger" role="alert">{error}</p>}
    </div>
  );
}
