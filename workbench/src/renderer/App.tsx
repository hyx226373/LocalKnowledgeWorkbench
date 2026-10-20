import React, { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { kb } from './kb';
import { loadKeybindings, getKeybindingsStore } from './keybindings/runtime';
import { matchKey } from './keybindings/match';
import { SidebarShell, SidebarTopbar } from './SidebarShell';
import { parseColumns } from '../shared/sidebarLayout';
import './drawer/columns.css';
const MainShell = lazy(() => import('./MainShell').then(m => ({ default: m.MainShell })));
export function App() {
 const [mode,setMode]=useState<'main'|'sidebar'|null>(null);
 const [transition,setTransition]=useState<{entering:boolean;width:number;sidebarWidth:number;sidebarHtml:string}|null>(null);
 const desired=useRef<'main'|'sidebar'>('main');
 const serial=useRef(0);
 useEffect(()=>{void loadKeybindings();let alive=true;void kb.getLayout('sidebarMode.active').then(async active=>{
  await kb.sidebarWindow({action:'initialize'});if(!alive)return;
  const value=active===true?'sidebar':'main';desired.current=value;setMode(value);
  if(value==='sidebar'){kb.startupMark('interactive');kb.startupMark('visible-content-loaded');}
 });return()=>{alive=false;};},[]);
 useEffect(()=>{
  const toggle=async()=>{
   const token=++serial.current;
   const entering=desired.current==='main';desired.current=entering?'sidebar':'main';
   if(entering){const detail:{wait?:Promise<unknown>}={};window.dispatchEvent(new CustomEvent('kb:before-sidebar',{detail}));await detail.wait;}
   if(token!==serial.current)return;
   const restore=await kb.getLayout('sidebarMode.restore') as {width?:number}|null;
   setTransition({entering,width:entering?window.innerWidth:restore?.width??1400,sidebarWidth:entering?360:window.innerWidth,sidebarHtml:entering?'':document.querySelector('[data-testid=sidebar-shell]')?.innerHTML??''});
   if(!entering){await import('./MainShell');if(token!==serial.current)return;setMode('main');await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));}
   const columns=parseColumns(await kb.getLayout('sidebarMode.columns'),await kb.getLayout('settings.drawerModules'));
   if(token!==serial.current)return;
   await kb.sidebarWindow({action:entering?'enter':'exit',width:columns.cols.reduce((n,c)=>n+c.width,0)});
   if(token===serial.current){setMode(entering?'sidebar':'main');setTransition(null);}
  };
  const event=()=>void toggle();
  const key=(e:KeyboardEvent)=>{const overrides=getKeybindingsStore().overrides;const binding=Object.prototype.hasOwnProperty.call(overrides,'workbench.sidebarMode')?overrides['workbench.sidebarMode']:'Ctrl+Alt+S';if(binding&&matchKey(e,binding)){e.preventDefault();e.stopImmediatePropagation();void toggle();}};
  window.addEventListener('kb:toggle-sidebar',event);window.addEventListener('keydown',key,true);
  return()=>{window.removeEventListener('kb:toggle-sidebar',event);window.removeEventListener('keydown',key,true);};
 },[]);
 if(mode===null)return null;
 return <>
  {mode==='sidebar'&&!transition ? <SidebarShell/> : <div style={{width:transition?.width??'100%',height:'100vh',overflow:'hidden'}}><Suspense fallback={null}><MainShell/></Suspense></div>}
  {transition && <div style={{position:'fixed',top:0,left:0,width:transition.sidebarWidth,height:transition.entering?40:'100vh',zIndex:10000,overflow:'hidden'}}>{transition.entering?<SidebarTopbar/>:<><SidebarTopbar/><div className="app kb-sidebar-shell kb-sidebar-transition-clone" inert dangerouslySetInnerHTML={{__html:transition.sidebarHtml}}/></>}</div>}
 </>;
}
