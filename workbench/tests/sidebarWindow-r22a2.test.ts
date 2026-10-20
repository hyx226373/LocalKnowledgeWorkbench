import { expect, it } from 'vitest';
import { enterBounds, exitBounds, fitBounds } from '../src/shared/sidebarLayout';
import { shouldRecordBounds } from '../src/shared/sidebarWindow';
it('records normal geometry only',()=>{
 expect(shouldRecordBounds({minimized:false,maximized:false,fullScreen:false})).toBe(true);
 for(const field of ['minimized','maximized','fullScreen'])expect(shouldRecordBounds({minimized:false,maximized:false,fullScreen:false,[field]:true})).toBe(false);
});
it('restores every coordinate without cumulative round-trip growth',()=>{
 const area={x:-1920,y:20,width:1920,height:1080};
 const original={x:-1600,y:50,width:1001,height:801};
 let bounds=original;
 for(let n=0;n<100;n++){
  const restore={...bounds,maximized:false,displayId:1};
  bounds=enterBounds(bounds,area,360);
  bounds=exitBounds(restore,[{id:1,workArea:area}],{id:1,workArea:area});
  expect(bounds).toEqual(original);
 }
 expect(fitBounds({x:0,y:0,width:200,height:80},{x:0,y:0,width:1000,height:1000})).toEqual({x:0,y:0,width:200,height:80});
});
