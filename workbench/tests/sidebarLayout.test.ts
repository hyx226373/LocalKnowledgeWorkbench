import { describe, it, expect } from 'vitest';
import { parseColumns, clampColumnWidth, visibleColumnWidths, enterBounds, exitBounds, motionDuration, moveModule, sidebarEase } from '../src/shared/sidebarLayout';
describe('r22 sidebar layout', () => {
 it('migrates old selection and falls back for unknown versions', () => {
  expect(parseColumns(null,['fav','root']).cols[0].modules).toEqual(['fav','root']);
  expect(parseColumns({v:9,cols:[]},['agent']).cols[0].modules).toEqual(['agent']);
 });
 it('limits columns and removes duplicate modules', () => {
  const c=parseColumns({v:1,cols:['root','fav','web','bench'].map(m=>({modules:[m],width:999}))});
  expect(c.cols).toHaveLength(3); expect(c.cols[0].width).toBe(999);
  expect(moveModule(c,'root',3)).toBe(c);
 });
 it('clamps widths and reserves 480 for main', () => {
  expect([clampColumnWidth(1),clampColumnWidth(999),clampColumnWidth(NaN)]).toEqual([240,999,360]);
  expect(visibleColumnWidths([{modules:[],width:360},{modules:[],width:360}],1000)).toEqual([360,44]);
 });
 const area={x:0,y:0,width:1920,height:1080};
 it('keeps left edge, shifts offscreen bounds and uses maximized work height', () => {
  expect(enterBounds({x:1800,y:40,width:1000,height:600},area)).toEqual({x:1560,y:40,width:360,height:600});
  expect(enterBounds({x:0,y:0,width:1920,height:1080},area,360,true).height).toBe(1080);
 });
 it('centers on primary when original display disappears', () => {
  expect(exitBounds({x:4000,y:0,width:1000,height:600,maximized:true,displayId:2},[],{id:1,workArea:area})).toEqual({x:460,y:240,width:1000,height:600});
 });
 it('chooses 200/160 or instant for either reduced motion preference', () => {
  expect(motionDuration(false,false)).toBe(200); expect(motionDuration(false,false,true)).toBe(160);
  expect(motionDuration(true,false)).toBe(0); expect(motionDuration(false,true)).toBe(0);
  expect(sidebarEase(.5)).toBeGreaterThan(.5);
 });
});
it('keeps overflow modules in the third column without losing user selection', () => {
 const layout=parseColumns({v:1,cols:['root','fav','web','bench'].map(id=>({modules:[id],width:300}))});
 expect(layout.cols[2].modules).toEqual(['web','bench']);
 expect(moveModule(layout,'root',1).cols.map(c=>c.modules)).toEqual([['fav','root'],['web','bench']]);
});
