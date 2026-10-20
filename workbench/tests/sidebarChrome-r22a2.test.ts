import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
const read=(p:string)=>readFileSync(new URL('../src/'+p,import.meta.url),'utf8');
it('gates drop highlights and clears module drag state',()=>{
 const css=read('renderer/drawer/columns.css');
 expect(css).toContain('.kb-columns[data-dragging-module=true] .kb-column-drop-head:hover');
 expect(css).not.toMatch(/^\.kb-column-(drop-head|new):hover/m);
 const columns=read('renderer/drawer/ColumnsDrawer.tsx');
 for(const event of ['onDragLeave','onDragEnd','onDragEnter'])expect(columns).toContain(event);
 expect(columns).toContain("window.addEventListener('blur',clear)");
});
it('removes split and close buttons and supports all card mouse buttons',()=>{
 const drawer=read('renderer/drawer/Drawer.tsx');
 const columns=read('renderer/drawer/ColumnsDrawer.tsx');
 expect(drawer).not.toContain('>拆成独立栏</button>');
 expect(drawer).not.toContain('>×</button>');
 expect(columns).not.toContain('>拆栏</button>');
 expect(columns).not.toContain('aria-label="关闭列"');
 for(const source of [read('renderer/drawer/cards.tsx'),columns]){
  for(const event of ['onMouseDown','onContextMenu','onAuxClick'])expect(source).toContain(event);
  expect(source).toContain('左键：第 1 栏');
 }
 expect(drawer).toContain('在第 2 栏打开');
 expect(drawer).toContain('在第 3 栏打开');
});
it('reserves overlay space at 48px with an accessible overflow menu',()=>{
 expect(read('renderer/drawer/columns.css')).toContain('env(titlebar-area-width, calc(100vw - 138px))');
 expect(read('renderer/drawer/columns.css')).toContain('height:48px; box-sizing:border-box');
 expect(read('renderer/SidebarShell.tsx')).toContain('<summary aria-label="侧栏操作">');
});
it('renders module heads without split/close controls in both modes',async()=>{
 const {createElement}=await import('react');
 const {renderToStaticMarkup}=await import('react-dom/server');
 const {SingleDrawer}=await import('../src/renderer/drawer/Drawer');
 const {ModuleHead}=await import('../src/renderer/drawer/ModuleHead');
 for(const mode of ['main','sidebar'] as const){
  const html=renderToStaticMarkup(createElement(SingleDrawer,{
   mode,open:true,selection:['root'],onSelectionChange:()=>{},onWidth:()=>{},onModuleClick:()=>{},
   slots:{root:createElement(ModuleHead,{title:'根目录'})},
  }));
  expect(html).not.toContain('拆成独立栏');
  expect(html).not.toContain('>×</button>');
  expect(html).toContain('data-testid="module-more"');
  expect(html).toContain('左键：第 1 栏');
 }
});
