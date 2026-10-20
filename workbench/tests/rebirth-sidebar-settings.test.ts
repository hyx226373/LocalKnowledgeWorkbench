import {expect,it,vi} from 'vitest';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
vi.mock('../src/renderer/kb',()=>({kb:{}}));
vi.mock('../src/renderer/rebirth/openDock',()=>({openRebirth:vi.fn()}));
import {Repository} from '../src/renderer/rebirth/Repository';
import {SETTINGS_CATEGORIES} from '../src/renderer/settings/categories';
it('仓库组件只呈现标题与文件树，仅保留设置入口，设置内容和保存目录不再渲染',()=>{
 const html=renderToStaticMarkup(React.createElement(Repository));
 for(const label of ['Agent 仓库','skill蒸馏模式','创建链接（首次导出）','网页版','仓库文件树','打开重生仓库设置'])expect(html).toContain(label);
 expect(html.indexOf('skill蒸馏模式')).toBeLessThan(html.indexOf('创建链接（首次导出）'));
 expect(html).toContain('勾选后，创建链接和网页版的「创建」会先提问');
 for(const label of ['>仓库设置<','生成封面图','附带根目录','归档位置','总结格式','保存目录：','指定目录'])expect(html).not.toContain(label);
 expect(html).not.toContain('<textarea');
 expect(SETTINGS_CATEGORIES).toContainEqual({id:'rebirth',label:'重生仓库',needsData:false});
});
