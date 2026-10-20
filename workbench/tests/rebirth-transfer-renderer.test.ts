import {expect,it,vi} from 'vitest';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
const api=vi.hoisted(()=>({rebirthTree:vi.fn(),rebirthFolderCreate:vi.fn(),rebirthFolderMove:vi.fn(),rebirthSettingsGet:vi.fn(),rebirthSettingsSet:vi.fn(),rebirthImportJson:vi.fn()}));
vi.mock('../src/renderer/kb',()=>({kb:api}));
import {call,tree} from '../src/renderer/rebirth/client';
import {Transfer} from '../src/renderer/rebirth/Transfer';
it('共享按钮组提供卡片和打开页所需指令、合并、回退入口',()=>{const html=renderToStaticMarkup(React.createElement(Transfer,{id:'R1'}));for(const text of ['导入','导出','导入合并…','回退到版本…'])expect(html).toContain(text);});
it('已合并 A/B 文件树和写入参数适配实际主进程合同',async()=>{
 api.rebirthTree.mockResolvedValue({root:{folder:'',name:'重生仓库',items:[{id:'R1'}],folders:[{folder:'学习',name:'学习',items:[],folders:[]}]},quarantined:[]});expect(await tree()).toEqual({items:[{id:'R1'}],folders:[{path:'学习',name:'学习',items:[],children:[]}],quarantined:[]});
 await call('rebirthFolderCreate',{folder:'学习/项目'});expect(api.rebirthFolderCreate).toHaveBeenCalledWith({folder:'学习/项目'});
 await call('rebirthFolderMove',{folder:'学习/项目',parent:'目标'});expect(api.rebirthFolderMove).toHaveBeenCalledWith({folder:'学习/项目',parent:'目标'});
 api.rebirthSettingsGet.mockResolvedValue({mode:'manual',folder:'学习',missingFolder:'root'});expect(await call('rebirthSettingsGet')).toEqual({mode:'manual',folder:'学习',missingFolder:'root'});
 await call('rebirthSettingsSet',{mode:'ai',folder:'学习',missingFolder:'create'});expect(api.rebirthSettingsSet).toHaveBeenCalledWith({mode:'ai',folder:'学习',missingFolder:'create'});
 await call('rebirthImportJson',{pickFile:true});expect(api.rebirthImportJson).toHaveBeenCalledWith({pickFile:true});
});
