import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LayoutGrid, Pin, PanelRightOpen } from 'lucide-react';
import { kb } from './kb';
import { pluginHost } from './plugin-host/host';
import { builtinThemePacks, themePackEntry } from './theme/packs';
import { BrandMark } from './theme/BrandMark';
import { applyAppearance, DEFAULT_APPEARANCE } from './theme/appearance';
import { CUSTOM_COLORS_KEY, parseCustomColors, setCustomColorOverlay } from './theme/customColors';
import { readUiSnapshot } from './layoutSnapshot';
import { Drawer } from './drawer';
import type { DrawerModuleId } from './drawer/order';
import { AppCtx, RootsSection, DirViewHost, FavoritesSection, WorkspaceRefs, SidebarPlugins, normalizeDirView, type Ctx } from './dir-view';
import type { Root, Favorite, WorkspaceRef } from '../shared/types';
import { DialogHost, dialogs } from './ui/dialogs';
import { webBridge, openUrl, openUrlPrompt } from './web-resources/webActions';
import { WebResourcesPanel } from './web-resources/WebResourcesPanel';
import { ModuleHead } from './drawer/ModuleHead';
import { AgentLiveProvider, AgentMaterialsSidebar, createIpcAgentLiveClient, type AgentLiveHost } from './agent-live';
import { useDragAutoScroll } from './dnd/autoScroll';
import { installDirViewDnd, setDndRoots } from './dnd/bridge';
import { setDndHost } from './dnd/session';
import { installNativeDragSession } from './nativeDrag/install';
import { createMountHost } from './agent-live/mountHost';
import { setNativeDragRootIndex } from './nativeDrag/paths';
export function SidebarTopbar({cardsCollapsed=false,onCards}: {cardsCollapsed?:boolean;onCards?:()=>void}) {
 const [pinned,setPinned]=useState(false);
 useEffect(()=>{void kb.getLayout('sidebarMode.pinned').then(v=>setPinned(v===true));},[]);
 const menuRef=useRef<HTMLDetailsElement>(null);
 useEffect(()=>{const close=(e:PointerEvent)=>{const m=menuRef.current;if(m?.open&&!m.contains(e.target as Node))m.removeAttribute('open');};window.addEventListener('pointerdown',close);return()=>window.removeEventListener('pointerdown',close);},[]);
 return <header className="kb-sidebar-topbar" onDoubleClick={e=>{if(!(e.target as HTMLElement).closest('button,summary,details'))window.dispatchEvent(new Event('kb:toggle-sidebar'));}}>
  <span className="kb-sidebar-brand" aria-label="本地知识工作台"><BrandMark size={20}/></span>
  <details ref={menuRef} className="kb-sidebar-actions"><summary aria-label="侧栏操作">…</summary><div className="kb-sidebar-actions-menu" onClick={e=>{if((e.target as HTMLElement).closest('button'))menuRef.current?.removeAttribute('open');}}>
  <button title="卡片" aria-label="展开或收起卡片" aria-expanded={!cardsCollapsed} onClick={onCards}><LayoutGrid size={16}/>卡片</button>
  <button title="置顶" aria-label="置顶" aria-pressed={pinned} onClick={()=>{setPinned(!pinned);void kb.sidebarWindow({action:'pin',pinned:!pinned});}}><Pin size={16}/>置顶</button>
  <button onClick={()=>window.dispatchEvent(new Event('kb:toggle-sidebar'))}><PanelRightOpen size={16}/>展开</button>
  </div></details>
 </header>;
}
function SidebarPluginList() {
 const [list,setList]=useState<{id:string;name:string;enabled:boolean}[]>([]);
 useEffect(()=>{let alive=true;void Promise.all([kb.listPlugins(),kb.listAdapterPlugins()]).then(([all,adapters])=>{
  const builtin:Record<string,string>={'builtin.workbench':'工作台','builtin.readers':'内置阅读器','builtin.formats':'格式支持','builtin.web-resources':'网络资料'};
  if(alive)setList(all.map(p=>({id:p.id,name:adapters.find(a=>a.id===p.id)?.name??pluginHost.get(p.id)?.manifest.name??builtin[p.id]??'已安装插件',enabled:p.enabled})));
 });return()=>{alive=false;};},[]);
 return <section className="kb-section kb-module"><ModuleHead title="插件" acts={<button onClick={()=>{sessionStorage.setItem('kb:sidebar-open',JSON.stringify({action:'plugins'}));window.dispatchEvent(new Event('kb:toggle-sidebar'));}}>管理插件…</button>}/>{list.map(p=><div className="kb-plugin-row" key={p.id}><span>{p.name}</span><span>{p.enabled?'已启用':'已停用'}</span></div>)}<SidebarPlugins/></section>;
}
export function SidebarShell() {
 useDragAutoScroll();
 const [roots,setRoots]=useState<Root[]>([]),[favorites,setFavorites]=useState<Favorite[]>([]),[refs,setRefs]=useState<WorkspaceRef[]>([]);
 const [ws,setWs]=useState(''),[selection,setSelection]=useState<DrawerModuleId[]>([]),[collapsed,setCollapsed]=useState(false);
 const [expanded,setExpanded]=useState(new Set<string>()),[version,setVersion]=useState(0),[dirView,setDirView]=useState(()=>normalizeDirView(null));
 const [notice,setNotice]=useState('');
 const [reduceMotion,setReduceMotion]=useState(false);
 const reload=useCallback(()=>{void Promise.all([kb.listRoots(),kb.listFavorites(),kb.getCurrentWorkspaceId()]).then(async([r,f,id])=>{setRoots(r);setFavorites(f);setWs(id);setDndRoots(r);setNativeDragRootIndex(r);setRefs(id?await kb.listWorkspaceRefs(id):[]);setVersion(v=>v+1);});},[]);
 useEffect(()=>{
  const snap=readUiSnapshot();
  if(snap?.customColors)setCustomColorOverlay(snap.customColors,{paint:false});
  applyAppearance(snap?.appearance??DEFAULT_APPEARANCE);
  if(snap?.expanded)setExpanded(new Set(snap.expanded));if(snap?.dirView)setDirView(normalizeDirView(snap.dirView));
  void (async()=>{const themes=[...builtinThemePacks(),...await kb.listThemePacks()].map((pack,i)=>themePackEntry(pack,i).entry);await pluginHost.load(themes);try{const parsed=parseCustomColors(await kb.getLayout(CUSTOM_COLORS_KEY));if(parsed)setCustomColorOverlay(parsed.enabled?parsed.vars:{},{paint:false});}catch{/* 保留快照覆盖 */}applyAppearance(snap?.appearance??DEFAULT_APPEARANCE);})();
  reload();void kb.getLayout('settings.uiChrome').then(raw=>{const reduced=!!(raw as {reduceMotion?:boolean}|null)?.reduceMotion;setReduceMotion(reduced);if(reduced)document.documentElement.setAttribute('data-reduce-motion','true');else document.documentElement.removeAttribute('data-reduce-motion');});void kb.getLayout('sidebarMode.cardsCollapsed').then(v=>setCollapsed(v===true));
  const cleanup=[installDirViewDnd(),installNativeDragSession(),kb.onFsChange(reload),kb.onRefsChange(reload),kb.onBeforeQuit(async()=>{})];
  kb.startupMark('interactive');kb.startupMark('visible-content-loaded');
  return()=>cleanup.forEach(off=>off());
 },[reload]);
 const open=useCallback((rid:string,title:string)=>{sessionStorage.setItem('kb:sidebar-open',JSON.stringify({rid,title}));window.dispatchEvent(new Event('kb:toggle-sidebar'));},[]);
 useEffect(()=>webBridge.attach({currentWorkspaceId:()=>ws,activeItem:()=>null,refsChanged:setRefs,openItem:(item,title)=>{sessionStorage.setItem('kb:sidebar-open',JSON.stringify({item,title}));window.dispatchEvent(new Event('kb:toggle-sidebar'));}}),[ws]);
 const ctx=useMemo<Ctx>(()=>({
  open,favIds:new Set(favorites.map(f=>f.resourceId)),toggleFav:rid=>{void (favorites.some(f=>f.resourceId===rid)?kb.removeFavorite(favorites.find(f=>f.resourceId===rid)!.id):kb.addFavorite(rid)).then(reload);},
  expanded,setExpanded:(id,on)=>setExpanded(prev=>{const next=new Set(prev);if(on)next.add(id);else next.delete(id);return next;}),
  fsVersion:version,fsEvents:[],activeResourceId:null,showIgnored:false,setShowIgnored:()=>{},
  refIds:new Set(refs.map(r=>r.resourceId)),toggleRef:rid=>{if(!ws)return;const has=refs.some(r=>r.resourceId===rid);void (has?kb.removeWorkspaceRef(ws,rid):kb.addWorkspaceRefs(ws,[rid])).then(reload,(e:unknown)=>setNotice(String((e as Error)?.message??e)));},workspaceId:ws,notify:setNotice,openWeb:(adapterId,url)=>url?openUrl(url,'tab',{adapterId}):openUrlPrompt(),
 }),[open,favorites,expanded,version,refs,ws,reload]);
 useEffect(()=>{setDndHost({workspaceId:()=>ws,isDirty:()=>false,reload,closePanels:async()=>{},open:async rid=>open(rid,(await kb.getResource(rid))?.name??'')});return()=>setDndHost(null);},[ws,reload,open]);
 const client=useMemo(()=>createIpcAgentLiveClient(kb),[]);
 const host=useMemo<AgentLiveHost>(()=>createMountHost({workspaceId:()=>ws,roots:()=>roots,selectedResourceIds:()=>[],fileItem:()=>null,activeFileItem:()=>null,hostedApp:()=>false,notify:setNotice,cache:new Map(),bump:()=>setVersion(v=>v+1)}),[ws,roots]);

 return <AppCtx.Provider value={ctx}><AgentLiveProvider client={client} host={host}>
  <div className="app kb-sidebar-shell" data-testid="sidebar-shell" data-motion={reduceMotion?'reduce':'on'}>
   <SidebarTopbar cardsCollapsed={collapsed} onCards={()=>{setCollapsed(!collapsed);void kb.setLayout('sidebarMode.cardsCollapsed',!collapsed);}}/>
   <Drawer mode="sidebar" open width={360} onWidth={()=>{}} selection={selection} onSelectionChange={setSelection} cardsCollapsed={collapsed} slots={{
    root:<><RootsSection roots={roots} reload={reload}/><DirViewHost roots={roots} favorites={favorites} reload={reload} refs={refs} openRids={new Set()} onRemove={r=>void kb.removeWorkspaceRef(ws,r.resourceId).then(reload)} onOpenAll={()=>refs.forEach(r=>open(r.resourceId,r.resourceId))} workspaceId={ws} phase="ready" dirView={dirView} setDirView={setDirView}/></>,
    fav:<FavoritesSection favorites={favorites}/>,
    web:<section className="kb-section kb-module"><ModuleHead title="网络资料" acts={<button onClick={()=>void openUrlPrompt()}>添加</button>}/><WebResourcesPanel/></section>,
    bench:<WorkspaceRefs refs={refs} openRids={new Set()} onRemove={r=>void kb.removeWorkspaceRef(ws,r.resourceId).then(reload)} onOpenAll={()=>refs.forEach(r=>open(r.resourceId,r.resourceId))} workspaceId={ws}/>,
    agent:<AgentMaterialsSidebar/>,plugin:<SidebarPluginList/>
   }}/>
   {notice&&<div role="status" onClick={()=>setNotice('')}>{notice}</div>}
   <DialogHost/>
  </div>
 </AgentLiveProvider></AppCtx.Provider>;
}
