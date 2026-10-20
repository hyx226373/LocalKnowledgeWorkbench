import { describe, expect, it } from 'vitest';
import { applyModuleClick, columnForButton, clampColumnWidth, parseColumns, planColumnWidths } from '../src/shared/sidebarLayout';

describe('r22-A2 columns',()=>{
 it('maps the three buttons and ignores unsupported buttons',()=>{
  expect([0,2,1,4].map(columnForButton)).toEqual([0,1,2,null]);
 });
 it('opens, toggles, moves, compacts and never creates more than three columns',()=>{
  let layout=parseColumns(null,['root']);
  layout=applyModuleClick(layout,'fav',2);
  expect(layout.cols.map(c=>c.modules)).toEqual([['root'],['fav']]);
  layout=applyModuleClick(layout,'web',1);
  expect(layout.cols.map(c=>c.modules)).toEqual([['root'],['fav'],['web']]);
  layout=applyModuleClick(layout,'root',2);
  expect(layout.cols.map(c=>c.modules)).toEqual([['fav','root'],['web']]);
  layout=applyModuleClick(layout,'root',0);
  expect(layout.cols.map(c=>c.modules)).toEqual([['fav'],['web']]);
  expect(applyModuleClick(parseColumns(null,['root']),'web',1).cols.map(c=>c.modules)).toEqual([['root'],['web']]);
  expect(applyModuleClick(layout,'fav',9)).toBe(layout);
  expect(applyModuleClick(parseColumns(null,['root']),'root',0).cols).toEqual([]);
 });
 it('has only a minimum and grows before shrinking',()=>{
  expect([900,1,NaN].map(clampColumnWidth)).toEqual([900,240,360]);
  expect(planColumnWidths([900,300],600,1920)).toEqual({windowWidth:1200,widths:[900,300],scroll:false});
  expect(planColumnWidths([300,300],1000,1920).widths).toEqual([300,700]);
 });
 it('shrinks proportionally above the floor and scrolls below it',()=>{
  const plan=planColumnWidths([900,480,240],500,1000);
  expect(plan.windowWidth).toBe(1000);
  expect(plan.widths.reduce((a,b)=>a+b,0)).toBeCloseTo(1000);
  expect((plan.widths[0]-240)/(plan.widths[1]-240)).toBeCloseTo(660/240);
  for(const windowWidth of [1,260,500,720,1000,2400]){
   const p=planColumnWidths([900,480,240],windowWidth,windowWidth);
   expect(p.widths).toHaveLength(3);
   expect(p.widths.every(w=>w>=240)).toBe(true);
   expect(p.scroll).toBe(windowWidth<720);
  }
 });
});
