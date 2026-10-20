import { BrowserWindow, ipcMain, screen, systemPreferences } from 'electron';
import { enterBounds, exitBounds, fitBounds, motionDuration, sidebarEase, type Rect, type Restore } from '../shared/sidebarLayout';
import { nearlySameRect, shouldRecordBounds } from '../shared/sidebarWindow';
import type { SidebarWindowRequest } from '../shared/sidebarWindow';
type Port = { get(key:string):Promise<unknown>; set(key:string,value:unknown):Promise<unknown> };
export function registerSidebarWindow(getWindow:()=>BrowserWindow|null, store:Port, hide:()=>void, resume:()=>void) {
 let active=false, restore:Restore|null=null, timer:ReturnType<typeof setInterval>|undefined;
 let generation=0, initialized=false, animating=false, programmatic=0;
 let mainMinimum: number[] = [0,0];
 let finishPrevious: (()=>void)|undefined;
 let sidebarBounds: Rect|null=null, lastSet: Rect|null=null;
 const canRecord=(win:BrowserWindow)=>shouldRecordBounds({minimized:win.isMinimized(),maximized:win.isMaximized(),fullScreen:win.isFullScreen()});
 const readRect=(win:BrowserWindow):Rect=>{const bounds=win.getNormalBounds();return {x:bounds.x,y:bounds.y,width:bounds.width,height:bounds.height};};
 const copyRect=(rect:Rect):Rect=>({x:rect.x,y:rect.y,width:rect.width,height:rect.height});
 const logical=(saved:Rect|null, read:Rect)=>saved&&nearlySameRect(saved,read)?copyRect(saved):read;
 const setProgrammatic=(win:BrowserWindow,rect:Rect)=>{programmatic++;try{win.setBounds(rect);}finally{programmatic--;}};
 // One corrective setBounds. Fractional DPI can still disagree; never loop, and never store the read-back.
 const setExact=(win:BrowserWindow,target:Rect)=>{
  lastSet=target; setProgrammatic(win,target);
  if(!nearlySameRect(readRect(win),target,0))setProgrammatic(win,target);
 };
 const animate=(win:BrowserWindow,target:Rect,duration:number,from?:Rect)=>new Promise<void>(resolve=>{
  if(timer)clearInterval(timer); finishPrevious?.(); finishPrevious=resolve;
  const start=from??readRect(win), began=Date.now(); animating=true;
  const finish=()=>{if(timer)clearInterval(timer);timer=undefined;animating=false;finishPrevious=undefined;resolve();};
  if(!duration){setExact(win,target);finish();return;}
  timer=setInterval(()=>{if(win.isDestroyed()){finish();return;} const p=Math.min(1,(Date.now()-began)/duration);
   if(p===1){setExact(win,target);finish();return;}
   const t=sidebarEase(p), rect={} as Rect;
   for(const key of ['x','y','width','height'] as const)rect[key]=Math.round(start[key]+(target[key]-start[key])*t);
   setProgrammatic(win,rect);
  },8);
 });
 const rememberBounds=async(rect:Rect)=>{sidebarBounds=copyRect(rect);await store.set('sidebarMode.bounds',sidebarBounds);};
 const captureRestore=async(win:BrowserWindow)=>{
  const current=readRect(win), maximized=win.isMaximized(), displayId=screen.getDisplayMatching(current).id;
  if(!restore||!nearlySameRect(restore,current))restore={...current,maximized,displayId};
  else if(restore.maximized!==maximized||restore.displayId!==displayId)restore={...restore,maximized,displayId};
  else return;
  await store.set('sidebarMode.restore',restore);
 };
 const loadBounds=async()=>{
  if(sidebarBounds)return sidebarBounds;
  const saved=await store.get('sidebarMode.bounds') as Rect|undefined;
  if(!saved||!Number.isFinite(saved.x)||!Number.isFinite(saved.y)||!Number.isFinite(saved.width)||!Number.isFinite(saved.height))return undefined;
  sidebarBounds=copyRect(saved); return sidebarBounds;
 };
 ipcMain.handle('kb:sidebar-window',async(event,request:SidebarWindowRequest)=>{
  const win=getWindow();if(!win||win.isDestroyed()||event.sender!==win.webContents)throw new Error('窗口不可用');
  if(!request||!['initialize','enter','exit','resize','pin','minimize','close'].includes(request.action))throw new Error('未知窗口操作');
  const modeChange=request.action==='enter'||request.action==='exit';
  const token=modeChange?++generation:generation;
  const immediate=request.action==='resize'&&!request.animate;
  const prefs=immediate?null:await store.get('settings.uiChrome') as {reduceMotion?:boolean}|null;
  if(modeChange&&token!==generation)return;
  const system=systemPreferences.getAnimationSettings().prefersReducedMotion;
  const duration=motionDuration(!!prefs?.reduceMotion,system,request.action==='resize');
  if(request.action==='minimize'){win.minimize();return;}
  if(request.action==='close'){win.close();return;}
  if(request.action==='pin'){win.setAlwaysOnTop(!!request.pinned);await store.set('sidebarMode.pinned',!!request.pinned);return;}
  if(request.action==='initialize'){
   if(initialized)return; initialized=true;
   active=await store.get('sidebarMode.active')===true;
   restore=await store.get('sidebarMode.restore') as Restore|null;
   if(!active)return;
   win.setMinimumSize(260,100);win.setAlwaysOnTop(await store.get('sidebarMode.pinned')===true);hide();
   const saved=await loadBounds();
   if(saved){const fitted=fitBounds(saved,screen.getDisplayMatching(saved).workArea);sidebarBounds=fitted;setExact(win,fitted);if(!nearlySameRect(fitted,saved,0))await rememberBounds(fitted);}
   return;
  }
  if(modeChange&&win.isMinimized())win.restore();
  if(request.action==='resize'){
   if(!active||!canRecord(win)||!Number.isFinite(request.width))return;
   const read=readRect(win), base=logical(sidebarBounds,read), area=screen.getDisplayMatching(read).workArea;
   const target=fitBounds({...base,width:Math.max(260,request.width!)},area);
   await animate(win,target,request.animate?duration:0,base);
   if(canRecord(win)&&active&&token===generation&&lastSet&&nearlySameRect(lastSet,target,0))await rememberBounds(target);return;
  }
  if(request.action==='enter'){
   if(!active&&!animating){mainMinimum=win.getMinimumSize();await captureRestore(win);}
   active=true; win.setMinimumSize(260,100);if(win.isMaximized())win.unmaximize();
   hide(); win.setAlwaysOnTop(await store.get('sidebarMode.pinned')===true);
   await Promise.all([store.set('sidebarMode.active',true),store.set('ui.mode','sidebar')]);
   const saved=await loadBounds();
   const read=readRect(win), area=screen.getDisplayMatching(read).workArea;
   const origin=logical(restore,read);
   const target=enterBounds(origin,area,Number.isFinite(request.width)?request.width!:360,!!restore?.maximized,saved);
   await animate(win,target,duration,origin);
   if(token===generation&&canRecord(win)&&lastSet&&nearlySameRect(lastSet,target,0))await rememberBounds(target);
  }else{
   active=false;win.setAlwaysOnTop(false);win.setMinimumSize(mainMinimum[0],mainMinimum[1]);
   await Promise.all([store.set('sidebarMode.active',false),store.set('ui.mode','main')]);
   if(restore){
    const read=readRect(win), from=logical(sidebarBounds,read);
    const target=exitBounds(restore,screen.getAllDisplays(),screen.getPrimaryDisplay());
    await animate(win,target,duration,from);
    if(token===generation&&restore.maximized)win.maximize();
   }
   if(token===generation)resume();
  }
 });
 // Persist a real user move/resize. Ignore our own setBounds and DPI read-backs within 3px.
 const bind=setInterval(()=>{const win=getWindow();if(!win)return;clearInterval(bind);
  let pending:ReturnType<typeof setTimeout>|undefined;
  const save=()=>{if(programmatic>0||!active||animating||!canRecord(win))return;if(pending)clearTimeout(pending);pending=setTimeout(()=>{
   if(programmatic>0||!active||animating||win.isDestroyed()||!canRecord(win))return;
   const read=readRect(win);
   if((sidebarBounds&&nearlySameRect(sidebarBounds,read))||(lastSet&&nearlySameRect(lastSet,read)))return;
   sidebarBounds=read; void store.set('sidebarMode.bounds',copyRect(read));
  },100);};
  win.on('move',save);win.on('resize',save);
  win.once('closed',()=>{if(timer)clearInterval(timer);if(pending)clearTimeout(pending);});
 },50);bind.unref();
}
