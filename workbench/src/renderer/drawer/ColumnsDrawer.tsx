import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { kb } from '../kb';
import { ModuleIcon } from './ModuleIcon';
import { SingleDrawer, type DrawerProps } from './Drawer';
import { DRAWER_MODULE_IDS, DRAWER_MODULE_LABEL, type DrawerModuleId } from './order';
import { clampColumnWidth, clampMainDragWidth, applyModuleClick, mainColumnViewport, moveModule, parseColumns, planColumnWidths, planMainColumns, planSidebarAutoWidth, type Columns } from '../../shared/sidebarLayout';
import './columns.css';
import { useSidebarPrefs, updateSidebarPrefs } from './sidebarPrefs';
const MODULE_MIME = 'application/x-kb-sidebar-module';
export function ColumnsDrawer(props: DrawerProps & { layoutSeed?: Columns }) {
 const prefs = useSidebarPrefs();
 const [draggingModule,setDraggingModule]=useState(false);
 useEffect(()=>{const clear=()=>setDraggingModule(false);window.addEventListener('dragend',clear);window.addEventListener('drop',clear);window.addEventListener('blur',clear);return()=>{window.removeEventListener('dragend',clear);window.removeEventListener('drop',clear);window.removeEventListener('blur',clear);};},[]);
 const [animateWidth, setAnimateWidth] = useState(false);
 const [frozenWidths,setFrozenWidths] = useState<number[]>([]);
 const mode = props.mode ?? 'main';
 const key = mode === 'main' ? 'drawer.columns' : 'sidebarMode.columns';
 const [layout,setLayout] = useState<Columns>(() => props.layoutSeed ?? ({v:1,cols:[{modules:[...props.selection],width:clampColumnWidth(props.width??360)}]}));
 const [ready,setReady] = useState(false);
 const ref = useRef<HTMLDivElement>(null);
 // Sidebar mode still uses the window width (the window is the column strip).
 // Main mode uses the `.main` content box: shell inset is outside the columns + reader pair.
 const readViewport = () => {
  const windowWidth = typeof window === 'undefined' ? 1920 : window.innerWidth;
  if (mode !== 'main') return windowWidth;
  const host = ref.current?.closest('.main') as HTMLElement | null;
  if (!host || typeof getComputedStyle !== 'function') return mainColumnViewport({ windowWidth });
  const style = getComputedStyle(host);
  return mainColumnViewport({
   windowWidth,
   mainClientWidth: host.clientWidth,
   paddingLeft: Number.parseFloat(style.paddingLeft),
   paddingRight: Number.parseFloat(style.paddingRight),
  });
 };
 const [viewport,setViewport] = useState(readViewport);
 const latest = useRef(props); latest.current=props;
 const layoutRef=useRef(layout);layoutRef.current=layout;
 useEffect(()=>{ let alive=true; void Promise.all([kb.getLayout(key),kb.getLayout('settings.drawerModules')]).then(([raw,old])=>{
  if(!alive)return; const value=parseColumns(raw,old); if(!raw)value.cols[0].width=clampColumnWidth(latest.current.width??360); setLayout(value); setReady(true); void kb.setLayout(key,value).catch(console.error);
  latest.current.onSelectionChange(value.cols.flatMap(c=>c.modules));
 }); return ()=>{alive=false;}; },[key]);
 useLayoutEffect(()=>{
  const apply=()=>setViewport(prev=>{const next=readViewport();return next===prev?prev:next;});
  apply();
  window.addEventListener('resize',apply);
  // Theme/inset changes resize `.main` without a window resize event.
  const host=mode==='main'?ref.current?.closest('.main'):null;
  const ro=host&&typeof ResizeObserver==='function'?new ResizeObserver(apply):null;
  if(host&&ro)ro.observe(host);
  return ()=>{window.removeEventListener('resize',apply);ro?.disconnect();};
 },[mode]);
 // Request native growth from the saved column sum. A read-back within 3px is not a new size.
 // Keep requested widths on narrow screens so moving to a larger display can restore them.
 useEffect(()=>{
  if(mode!=='sidebar'||!ready)return;
  const timer=setTimeout(()=>{
   const current=layoutRef.current;
   const saved=current.cols.map(c=>c.width);
   const avail=window.screen?.availWidth??Number.POSITIVE_INFINITY;
   const maximized=window.outerWidth>=avail&&window.outerHeight>=(window.screen?.availHeight??0);
   const plan=planSidebarAutoWidth(saved,viewport,{availWidth:avail,maximized});
   if(plan.resizeTo!=null){void kb.sidebarWindow({action:'resize',width:plan.resizeTo});return;}
   if(!plan.widths.some((w,i)=>w!==saved[i]))return;
   const next:Columns={v:1,cols:current.cols.map((c,i)=>({...c,width:plan.widths[i]}))};
   setLayout(next);void kb.setLayout(key,next).catch(console.error);
  },180);
  return()=>clearTimeout(timer);
 },[ready,mode,viewport,key]);
 // Existing shell commands may change selection; preserve assignments for selected modules.
 useEffect(()=>{ if(!ready)return;
  const selected=props.selection;
  setLayout(prev=>{
   if(prev.cols.flatMap(c=>c.modules).join(',')===selected.join(','))return prev;
   const cols=prev.cols.map(c=>({...c,modules:c.modules.filter(m=>selected.includes(m))}));
   const assigned=new Set(cols.flatMap(c=>c.modules));
   cols[0].modules.push(...selected.filter(m=>!assigned.has(m)));
   const next:Columns={v:1,cols:cols.filter(c=>c.modules.length)};
   if(!next.cols.length)next.cols=[{modules:[],width:360}];
   void kb.setLayout(key,next).catch(console.error); return next;
  });
 },[props.selection,ready,key]);
 const commit=(next:Columns, resize=false)=>{
  const animate=resize&&document.documentElement.getAttribute('data-reduce-motion')!=='true'&&!window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
  if(animate)setFrozenWidths(layout.cols.map(c=>c.width));
  setAnimateWidth(animate); if(animate)setTimeout(()=>setAnimateWidth(false),160);
  if(!next.cols.length) next={v:1,cols:[{modules:[],width:360}]};
  setLayout(next); props.onSelectionChange(next.cols.flatMap(c=>c.modules));
  void kb.setLayout(key,next).catch(console.error);
  if(mode==='sidebar')void kb.sidebarWindow({action:'resize',width:next.cols.reduce((n,c)=>n+c.width,0),animate:resize});
 };
 const close=(id:DrawerModuleId)=>commit({v:1,cols:layout.cols.map(c=>({...c,modules:c.modules.filter(m=>m!==id)})).filter(c=>c.modules.length)},true);
 const toggle=(next:DrawerModuleId[])=>{
  const all=layout.cols.flatMap(c=>c.modules); const removed=all.find(id=>!next.includes(id));
  if(removed){close(removed);return;}
  const added=next.find(id=>!all.includes(id));
  if(added)commit({v:1,cols:layout.cols.map((c,i)=>i?c:{...c,modules:[...c.modules,added]})});
 };
 const drop=(e:React.DragEvent,index:number)=>{setDraggingModule(false);const id=e.dataTransfer.getData(MODULE_MIME) as DrawerModuleId;if(!DRAWER_MODULE_IDS.includes(id))return;e.preventDefault();e.stopPropagation();commit(moveModule(layout,id,index),true);};
 const over=(e:React.DragEvent)=>{if(e.dataTransfer.types.includes(MODULE_MIME)){setDraggingModule(true);e.preventDefault();e.dataTransfer.dropEffect='move';}};
 const savedWidths=layout.cols.map(c=>c.width);
 const ribbon=mode==='main'&&prefs.categoriesLayout==='list'&&prefs.ribbonCollapsed;
 const mainPlan=mode==='main'?planMainColumns(savedWidths,viewport,{ribbonCollapsed:ribbon}):null;
 const widths=mode==='sidebar'?planColumnWidths(savedWidths,viewport,viewport).widths:mainPlan!.widths;
 const all=layout.cols.flatMap(c=>c.modules);
 return <div ref={ref} className="kb-columns" data-mode={mode} data-scroll={mainPlan?.scroll?'true':undefined} data-dragging-module={draggingModule||undefined} onDragEnter={over} onDragLeave={e=>{if(!e.currentTarget.contains(e.relatedTarget as Node))setDraggingModule(false);}} onDragEnd={()=>setDraggingModule(false)} data-width-animate={animateWidth} onDragOver={over} onDrop={e=>{if(e.clientX>=e.currentTarget.getBoundingClientRect().right-20)drop(e,layout.cols.length);}} style={{display:props.open?'flex':'none'}}>
  {layout.cols.map((col,index)=><div key={index} className="kb-column" style={{width:widths[index],['--kb-column-frozen-width' as string]:`${frozenWidths[index]??col.width}px`}} data-collapsed={widths[index]===44?true:undefined}>
   {widths[index]===44 ? <div className="kb-column-rail">{col.modules.map(id=><button key={id} title={DRAWER_MODULE_LABEL[id]} onClick={()=>{if(prefs.ribbonCollapsed){updateSidebarPrefs({ribbonCollapsed:false});return;}const next={v:1 as const,cols:[col,...layout.cols.filter((_,i)=>i!==index)]};commit(next);}}><ModuleIcon id={id}/></button>)}</div> : <>

   <div className="kb-column-drop-head" onDragOver={over} onDrop={e=>drop(e,index)} title="拖动分区到这里换列" />
   {index===0 && props.cardsCollapsed && <div className="kb-sidebar-card-strip">{DRAWER_MODULE_IDS.map(id=><button key={id} title={`${DRAWER_MODULE_LABEL[id]}　左键：第 1 栏　右键：第 2 栏　中键：第 3 栏`} aria-pressed={all.includes(id)} onClick={()=>commit(applyModuleClick(layout,id,0),true)} onMouseDown={e=>{if(e.button===1)e.preventDefault();}} onContextMenu={e=>{e.preventDefault();commit(applyModuleClick(layout,id,2),true);}} onAuxClick={e=>{if(e.button===1){e.preventDefault();commit(applyModuleClick(layout,id,1),true);}}}><ModuleIcon id={id}/></button>)}</div>}
   {/* Saved width, not the squeezed display width: the sash applies its delta to the stored width. The column CSS keeps the drawer inside the display width. */}
   <SingleDrawer {...props} width={mode==='main'?col.width:widths[index]} selection={col.modules} allSelection={all} hideCards={index>0||props.cardsCollapsed} onSelectionChange={next=>toggle(prefs.categoriesLayout==='grid'?next:[...all.filter(id=>!col.modules.includes(id)),...next])}
    onWidth={(width,animate)=>{
     const others=layout.cols.reduce((sum,c,i)=>i===index?sum:sum+(ribbon&&i===0?44:c.width),0);
     const nextWidth=mode==='main'?clampMainDragWidth(width,col.width,others,viewport):clampColumnWidth(width);
     const next={v:1 as const,cols:layout.cols.map((c,i)=>i===index?{...c,width:nextWidth}:c)};
     commit(next,animate);if(index===0)props.onWidth(nextWidth);
    }}
    onModuleClick={(id,button)=>commit(applyModuleClick(layout,id,button),true)} onModuleDragOver={over} onModuleDrop={e=>drop(e,index)}/>
   </>}
  </div>)}
  <div className="kb-column-new" aria-label={layout.cols.length>=3?'最多 3 列':'拖到这里拆成独立栏'} onDragOver={layout.cols.length<3?over:undefined} onDrop={e=>drop(e,layout.cols.length)}/>
 </div>;
}
