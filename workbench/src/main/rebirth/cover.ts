import fs from 'node:fs';
export const MAX_COVER_BYTES = 10 * 1024 * 1024;
export function imageExtension(bytes:Buffer):'png'|'jpg'|'webp' {
 if(!bytes.length||bytes.length>MAX_COVER_BYTES)throw new Error('封面图片大小须在 1 字节至 10 MB 之间');
 if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'png';
 if(bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return 'jpg';
 if(bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP')return 'webp';
 throw new Error('封面仅支持 PNG、JPG、WebP 图片');
}
export function parseCover(value:unknown):{ext:string;bytes:Buffer}|{url:string}|undefined {
 if(value===undefined)return;
 if(typeof value!=='string')throw new Error('cover 必须是图片 data URL 或 http(s) 链接');
 if(/^https?:\/\//i.test(value)){try{const u=new URL(value);if(!u.hostname)throw Error();return {url:u.href};}catch{throw new Error('cover 图片链接不合法');}}
 const match=/^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
 if(!match||match[2].length>Math.ceil(MAX_COVER_BYTES/3)*4)throw new Error('cover 必须是有效的 PNG、JPG、WebP base64 图片（≤10 MB）');
 const bytes=Buffer.from(match[2],'base64');const ext=imageExtension(bytes);
 if(bytes.toString('base64')!==match[2]||ext!==(match[1]==='jpeg'?'jpg':match[1]))throw new Error('cover 图片格式与内容不一致');
 return {ext,bytes};
}
export function readCoverFile(file:string):{ext:string;bytes:Buffer} {
 const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>MAX_COVER_BYTES)throw new Error('封面必须是 ≤10 MB 的图片文件');
 const bytes=fs.readFileSync(file);return {ext:imageExtension(bytes),bytes};
}
