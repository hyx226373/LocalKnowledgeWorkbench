import { expect, it, vi } from 'vitest';
vi.mock('../src/renderer/kb',()=>({kb:{registerPlugin:async()=>({enabled:true})}}));
import { pluginHost } from '../src/renderer/plugin-host/host';
import { commands } from '../src/renderer/plugin-host/registry';
import { HOST_API_VERSION, type PluginModule } from '../src/renderer/plugin-host/types';
it('replaces callbacks after MainShell remount while preserving other plugins',async()=>{
 let first=0,second=0;
 const shell=(run:()=>void):PluginModule=>({manifest:{id:'builtin.workbench',name:'工作台',version:'1.0.0',engines:{workbench:`^${HOST_API_VERSION}`}},activate:api=>{api.commands.register({id:'sidebar.test.shell',title:'壳',run});}});
 await pluginHost.replaceWorkbench(shell(()=>{first++;}));commands.get('sidebar.test.shell')?.run();
 await pluginHost.replaceWorkbench(shell(()=>{second++;}));commands.get('sidebar.test.shell')?.run();
 expect([first,second]).toEqual([1,1]);expect(pluginHost.list().filter(p=>p.manifest.id==='builtin.workbench')).toHaveLength(1);expect(pluginHost.list().some(p=>p.manifest.id.includes('#dup'))).toBe(false);
});
