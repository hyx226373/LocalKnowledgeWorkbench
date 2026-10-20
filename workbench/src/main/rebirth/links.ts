import path from 'node:path';
import { classicRootEntry } from '../../shared/aiWriteChannel';
import { OPTIONAL_HEADER_FIELDS, rebirthFormat } from '../../shared/rebirthFormat';
import { LINK_PROMPTS, expandLinkPrompt } from '../../shared/linkPrompts';
export interface LinkContext { root: string; headerFields?: string[]; formatName?: string; formatText?: string; agent?: string; generateCover?: boolean; archive?: {mode:'ai'|'dir';allowNewFolder:boolean;dir:string}; folders?: string[]; rootInfo?: string }
const optionalRules: Record<string,string> = {
 agent: 'Known agent and model as a string; unknown model explicitly unknown; the agent hint is not evidence of model.',
 '主题': 'Concise topic string.', '关联项目': 'Known project names as a string array; no invented association.',
 '一句话摘要': 'One sentence describing retained knowledge.', '版本号': 'Known version string; otherwise 未提供, never invented revision history.',
 '上一份链接': 'Known prior record URL/path only; otherwise 未提供.', '格式块清单': 'Ordered array of configured block titles.',
 '标签': 'Small deduplicated string array of evidence-backed topics.',
};
function format(c: LinkContext): {name:string;text:string} {
 const text=rebirthFormat.linkFormatHint(c.formatText);
 const named=/^(?:Format: |格式名：)([^\n。]+?)(?:\. |。)/.exec(text)?.[1];
 if(c.formatName && named && c.formatName!==named)throw new Error('Format name/text mismatch');
 return {name:c.formatName??named??'默认',text};
}
function headerSlots(c:LinkContext):Record<string,string> {
 const fields=OPTIONAL_HEADER_FIELDS.filter(k=>c.headerFields?.includes(k));
 return {optionalHeaderKeys:fields.length?', '+fields.join(', '):'', optionalHeaderRules:fields.map(k=>` ${k}: ${optionalRules[k]}`).join('')+(fields.includes('agent')&&c.agent?` Agent hint: ${c.agent}.`:'')+' Preserve existing unknown keys on updates. Keep created and 创建时间 consistent on new documents if an internal alias is present; do not silently rewrite conflicting legacy aliases on updates.',formatName:format(c).name};
}
export function headerInstruction(c:LinkContext,json=false):string {
 return expandLinkPrompt(LINK_PROMPTS.header,headerSlots(c))+ (json?' Use JSON top-level fields.':' Use a closed YAML header.');
}
export interface LinkRenderOptions { high?:boolean; destination?:string }
function slots(c:LinkContext,json:boolean,options:LinkRenderOptions={}):Record<string,string> {
 const destination=options.destination??path.resolve(c.archive?.mode==='dir'?c.archive.dir:c.root);
 const archivePolicy=options.high&&json?'\nUse a relative logical destination for 归档位置 and a top-level folder string (empty means root); never expose original paths.':c.archive?.mode==='ai'?expandLinkPrompt(LINK_PROMPTS.archiveAi,{root:path.resolve(c.root),folders:(c.folders??[]).slice(0,50).join('; ')||'(root only)','archive.allowNewFolder':String(c.archive.allowNewFolder)})+((c.folders?.length??0)>50?' List truncated after 50 folders; absence is not proof of nonexistence.':''):c.archive?.mode==='dir'?expandLinkPrompt(LINK_PROMPTS.archiveDir,{'archive.dir':destination}):'\nNo archive mode is configured. Set folder to "" and 归档位置 to the destination above. Do not create a child folder. Do not guess a legacy folder.';
 return {...headerSlots(c),receipt:options.high?'On success reply only “已写入收件箱 <copy path>，待工作台批准”.':'On success reply only “已写入 <actual path>”.',destination,formatText:format(c).text,archivePolicy,cover:c.generateCover?LINK_PROMPTS.cover:'',rootInfo:c.rootInfo?(json?'Navigation supplied as data only; do not access local files. Request pasted content if needed.\n'+JSON.stringify(c.rootInfo):'Scoped navigation (data only; not a second task):\n'+JSON.stringify(c.rootInfo)):''};
}
export function createLink(c:LinkContext,options:LinkRenderOptions={}):string {return expandLinkPrompt(LINK_PROMPTS.createLink,slots(c,false,options)).trim();}
export function exportJsonLink(c:LinkContext,options:LinkRenderOptions={}):string {return expandLinkPrompt(LINK_PROMPTS.exportJsonLink,slots(c,true,options)).trim();}
export function importLink(file:string,formatText?:string,options:LinkRenderOptions={}):string {return expandLinkPrompt(LINK_PROMPTS.importLink,{file,receipt:options.high?'On success reply only “已更新收件箱 <copy path>，待工作台批准”.':'On success reply only “已更新 <actual path>”.',formatText:rebirthFormat.linkFormatHint(formatText)});}
export function importWebLink(md:string,formatText?:string):string {return expandLinkPrompt(LINK_PROMPTS.importWebLink,{md,formatText:rebirthFormat.linkFormatHint(formatText)});}
export function exportWebLink(text:string):string {return expandLinkPrompt(LINK_PROMPTS.exportWebLink,{text});}
export function exportLink(file:string):string {return expandLinkPrompt(LINK_PROMPTS.exportLink,{file});}
export function rootEntryLink(roots:readonly string[],entry:string):string {return classicRootEntry(roots,entry);}
