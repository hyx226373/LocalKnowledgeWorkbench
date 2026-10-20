import { beforeEach, afterEach, expect, it, vi } from 'vitest';
const fake=vi.hoisted(()=>({ handler:null as any, reduced:false }));
vi.mock('electron',()=>({
 ipcMain:{handle:(_channel:string,callback:unknown)=>{fake.handler=callback;}},
 systemPreferences:{getAnimationSettings:()=>({prefersReducedMotion:fake.reduced})},
 screen:{getDisplayMatching:()=>({id:1,workArea:{x:0,y:0,width:1920,height:1080}}),getAllDisplays:()=>[{id:1,workArea:{x:0,y:0,width:1920,height:1080}}],getPrimaryDisplay:()=>({id:1,workArea:{x:0,y:0,width:1920,height:1080}})},
}));
import { registerSidebarWindow } from '../src/main/sidebarWindow';
beforeEach(()=>{vi.useFakeTimers();fake.reduced=false;});
afterEach(()=>{vi.clearAllTimers();vi.useRealTimers();});
function setup(reduce=false){
 const values=new Map<string,unknown>([['settings.uiChrome',{reduceMotion:reduce}]]);
 let bounds={x:100,y:50,width:1200,height:800};let maximized=false;
 const win:any={webContents:{},getBounds:()=>({...bounds}),getNormalBounds:()=>({...bounds}),isMinimized:()=>false,isFullScreen:()=>false,restore:vi.fn(),setBounds:vi.fn((next:any)=>{bounds=next;}),getMinimumSize:()=>[600,400],setMinimumSize:vi.fn(),isMaximized:()=>maximized,unmaximize:vi.fn(()=>{maximized=false;}),maximize:vi.fn(()=>{maximized=true;}),setAlwaysOnTop:vi.fn(),isDestroyed:()=>false,on:vi.fn(),once:vi.fn(),minimize:vi.fn(),close:vi.fn()};
 const hide=vi.fn(),resume=vi.fn();
 registerSidebarWindow(()=>win,{get:async key=>values.get(key),set:async(key,value)=>{values.set(key,value);}},hide,resume);
 const call=(request:any)=>fake.handler({sender:win.webContents},request);
 return {win,call,values,hide,resume,bounds:()=>bounds};
}
it('enters instantly with reduceMotion, persists restore and restores original minimum and geometry',async()=>{
 const s=setup(true);await s.call({action:'enter',width:360});
 expect(s.bounds()).toEqual({x:100,y:50,width:360,height:800});expect(s.values.get('sidebarMode.active')).toBe(true);expect(s.hide).toHaveBeenCalledOnce();
 await s.call({action:'exit'});expect(s.bounds()).toEqual({x:100,y:50,width:1200,height:800});expect(s.win.setMinimumSize).toHaveBeenLastCalledWith(600,400);expect(s.resume).toHaveBeenCalledOnce();
});
it('uses system reduceMotion and remembers the pin',async()=>{
 fake.reduced=true;const s=setup();await s.call({action:'enter',width:720});expect(s.bounds().width).toBe(720);
 await s.call({action:'pin',pinned:true});expect(s.values.get('sidebarMode.pinned')).toBe(true);expect(s.win.setAlwaysOnTop).toHaveBeenLastCalledWith(true);
});
it('reverses from the current rectangle without overwriting the original restore',async()=>{
 const s=setup();const enter=s.call({action:'enter',width:360});await vi.advanceTimersByTimeAsync(80);
 const middle=s.bounds().width;expect(middle).toBeGreaterThan(360);expect(middle).toBeLessThan(1200);
 const exit=s.call({action:'exit'});await vi.advanceTimersByTimeAsync(220);await Promise.all([enter,exit]);
 expect(s.bounds().width).toBe(1200);expect((s.values.get('sidebarMode.restore') as any).width).toBe(1200);
});
it('unmaximizes before entering and maximizes after exit animation',async()=>{
 const s=setup(true);s.win.isMaximized=()=>true;
 await s.call({action:'enter',width:360});expect(s.win.unmaximize).toHaveBeenCalledOnce();expect(s.bounds().height).toBe(1080);
 await s.call({action:'exit'});expect(s.win.maximize).toHaveBeenCalledOnce();
});
it('re-enters during exit without replacing the full-window restore rectangle',async()=>{
 const s=setup(true);await s.call({action:'enter',width:360});
 s.values.set('settings.uiChrome',{reduceMotion:false});
 const exit=s.call({action:'exit'});await vi.advanceTimersByTimeAsync(80);
 const enter=s.call({action:'enter',width:360});await vi.advanceTimersByTimeAsync(220);await Promise.all([enter,exit]);
 expect((s.values.get('sidebarMode.restore') as any).width).toBe(1200);expect(s.bounds().width).toBe(360);
});
it('restores a minimized window before switching and ignores minimized resize requests',async()=>{
 const s=setup(true);await s.call({action:'enter',width:360});
 let minimized=true;
 s.win.isMinimized=()=>minimized;
 s.win.restore=vi.fn(()=>{minimized=false;});
 const before=s.values.get('sidebarMode.bounds');
 await s.call({action:'resize',width:1500});
 expect(s.values.get('sidebarMode.bounds')).toEqual(before);
 await s.call({action:'exit'});
 expect(s.win.restore).toHaveBeenCalledOnce();
 expect(s.bounds()).toEqual({x:100,y:50,width:1200,height:800});
});
it('corrects a native rounding offset and preserves geometry over repeated transitions',async()=>{
 const s=setup(true);
 const original=s.win.setBounds;
 let first=true;
 s.win.setBounds=vi.fn((target:any)=>{
  if(first){first=false;original({...target,height:target.height+2});}
  else original(target);
 });
 for(let n=0;n<20;n++){
  await s.call({action:'enter',width:360});
  expect(s.bounds().height).toBe(800);
  await s.call({action:'exit'});
  expect(s.bounds()).toEqual({x:100,y:50,width:1200,height:800});
 }
});
it('fits large requested widths within the work area and shifts x left',async()=>{
 const s=setup(true);await s.call({action:'enter',width:360});
 await s.call({action:'resize',width:1800});
 expect(s.bounds()).toEqual({x:100,y:50,width:1800,height:800});
 await s.call({action:'resize',width:4000});
 expect(s.bounds()).toEqual({x:0,y:50,width:1920,height:800});
});
