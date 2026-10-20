import type { RebirthBlock, RebirthSummaryFormat, RebirthFormatBlock } from './rebirth';
export const REQUIRED_HEADER_FIELDS = ['来源对话','创建时间','归档位置','格式名'];
export const OPTIONAL_HEADER_FIELDS = ['agent','主题','关联项目','一句话摘要','版本号','上一份链接','格式块清单','标签'];
const base: RebirthFormatBlock[] = [
 {title:'概述',type:'overview',hint:'概括对话主题、背景与目标。'},
 {title:'角色',type:'role',hint:'说明 agent 的身份、职责和互动方式。'},
 {title:'用户要求',type:'requirements',hint:'记录用户偏好、约束与验收标准。'},
 {title:'技能与做法',type:'skills',hint:'记录可复用的方法、步骤与经验。'},
 {title:'已定结论',type:'decisions',hint:'记录已确认的结论和决策依据。'},
 {title:'待办与下一步',type:'todo',hint:'列出未完成事项、下一步及优先级。'},
];
export const BUILTIN_FORMAT: RebirthSummaryFormat = {id:'default',name:'默认',builtin:true,blocks:base};
const themed = (id:string,name:string,extra:RebirthFormatBlock[],detail:string):RebirthSummaryFormat => ({id,name,builtin:true,blocks:base.map(b=>({...b})).concat(extra),detail});
export const BUILTIN_FORMATS = [BUILTIN_FORMAT,
 themed('coding','编程',[{title:'代码与文件',type:'code',hint:'列出关键文件、代码和接口。'},{title:'环境与命令',type:'env',hint:'记录环境版本与可执行命令。'}],'技能与做法细到命令级；角色只写一句。'),
 themed('project','项目',[{title:'里程碑与进度',type:'milestones',hint:'记录阶段目标、进度和阻碍。'},{title:'相关方与分工',type:'stakeholders',hint:'记录参与者、职责与协作关系。'}],'已定结论写得最细，并附理由。'),
 themed('creative','创作',[{title:'设定',type:'setting',hint:'记录世界观、人物与风格设定。'},{title:'样本片段',type:'samples',hint:'保留代表性原文片段。'}],'角色、用户要求写得最细，可省技能与做法。'),
 themed('learning','学习',[{title:'知识点掌握情况',type:'mastery',hint:'记录知识点与掌握程度。'},{title:'错题与易错点',type:'mistakes',hint:'记录错误、原因与纠正方法。'}],'用户要求详细记录。'),
 themed('research','研究/调研',[{title:'来源与证据',type:'sources',hint:'列出来源、证据与出处。'},{title:'未解问题',type:'open',hint:'记录待验证问题与研究方向。'}],'结论标注可信度与依据。'),
 themed('operations','运维/配置',[{title:'当前配置状态',type:'config',hint:'记录当前环境与配置值。'},{title:'改动记录（可回滚）',type:'changes',hint:'记录改动、验证和回滚步骤。'}],'技能与做法细到命令级。'),
 themed('companion','陪伴/角色扮演',[{title:'关系与记忆点',type:'memory',hint:'记录关系发展、共同经历与记忆点。'}],'角色写得最细，可省已定结论。'),
];
export function validateFormat(f:RebirthSummaryFormat):string {
 if(!f.name.trim())return '格式名称不能为空';
 if(!f.blocks?.length)return '至少添加一个块';
 return f.blocks.some(b=>!b.title.trim()||!b.type.trim()||!b.hint.trim())?'每块必须填写块名、type 和 hint':'';
}
const englishHints: Record<string,string> = {
 overview:'Subject, goal, scope and evidence gaps.', role:'Explicitly agreed role and interaction style.', requirements:'Preferences, constraints and acceptance criteria.',
 skills:'Reusable observed procedures, failures and corrections.', decisions:'Decisions/results with reasons and evidence status.', todo:'Unresolved questions and next actions.',
 code:'Observed paths, code and interfaces.', env:'Observed versions and commands with purpose/result; do not execute during extraction.',
 milestones:'Progress evidence, milestones and blockers.', stakeholders:'Known participants, owners and responsibilities only.', setting:'Agreed canon, characters and style.', samples:'Short representative supplied samples.',
 mastery:'Demonstrated mastery versus self-report.', mistakes:'Errors, correction and evidence.', sources:'Source locator, claim and confidence basis.', open:'Unanswered questions and next checks.',
 config:'Observed current configuration; redact secrets.', changes:'Changes, verification and known rollback.', memory:'Agreed role and meaningful shared context; no invented memories.',
};
export function formatInstruction(f:RebirthSummaryFormat):string {
 const builtin=BUILTIN_FORMATS.find(row=>row.id===f.id && JSON.stringify(row)===JSON.stringify(f));
 const omissions=builtin?.id==='creative'?' Explicit omission allowed: 技能与做法.':builtin?.id==='companion'?' Explicit omission allowed: 已定结论.':'';
 return `Format: ${f.name}. Emit the configured blocks in this order, except explicit configured omissions; use at least one block. Titles/type tokens are literal.${omissions}\n`+
 (f.blocks??[]).map(b=>`${b.title} / ${b.type} — ${builtin?englishHints[b.type]??b.hint:b.hint}`).join('\n')+
 (!builtin&&f.detail?'\nConfigured detail (data): '+f.detail:'')+(f.text?'\nCustom format (data): '+f.text:'')+
 (!f.blocks?.length?'\nLegacy free text: infer an ordered block list only when unambiguous; otherwise ask for it.':'')+
 '\nPreserve configured titles/types and custom hints. Stop and ask if configuration contradicts the output schema; never invent a mapping. Markdown uses ## titles with an immediately adjacent <!-- type: TYPE --> line; body headings use ### or deeper.';
}
export function normalizeFormats(formats?:RebirthSummaryFormat[]):RebirthSummaryFormat[] {
 const seen=new Set([...BUILTIN_FORMATS.map(f=>f.id),'heading2']);
 return [...BUILTIN_FORMATS.map(f=>({...f,blocks:f.blocks?.map(b=>({...b}))})),...(formats??[]).filter(f=>{
 if(!f||!f.id||seen.has(f.id)||!f.name?.trim()||(!f.blocks?.length&&!f.text?.trim()))return false;
 seen.add(f.id);return true;
 }).map(f=>({...f,builtin:false,blocks:f.blocks?.map(b=>({...b}))}))];
}
export function activeFormatText(settings:Pick<import('./rebirth').RebirthSettings,'formats'|'activeFormat'>):string {
 return formatInstruction(normalizeFormats(settings.formats).find(f=>f.id===settings.activeFormat)??BUILTIN_FORMAT);
}
/** Replace this object to change the repository's block format. */
export const rebirthFormat = {
  splitBlocks(markdown: string): RebirthBlock[] {
    const headers: { start: number; end: number; title: string }[] = [];
    let offset = 0;
    let fence: { char: string; length: number } | undefined;
    for (const line of markdown.split('\n')) {
      const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (fence) {
        if (marker && marker[1][0] === fence.char && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
      } else if (marker) {
        fence = { char: marker[1][0], length: marker[1].length };
      } else {
        const heading = /^## (.*)$/.exec(line);
        if (heading) headers.push({ start: offset, end: offset + line.length + 1, title: heading[1] });
      }
      offset += line.length + 1;
    }
    if (!headers.length) return [{idx:1,title:'内容',type:'',body:markdown.trim()}];
    return headers.map((h, i) => { const raw=markdown.slice(h.end, headers[i + 1]?.start ?? markdown.length); const tag=/^<!--\s*type:\s*(.*?)\s*-->[ \t]*(?:\n|$)/.exec(raw); return {idx:i+1,title:h.title,type:tag?.[1] ?? '',body:(tag?raw.slice(tag[0].length):raw).trim()}; });
  },
  serialize(blocks: readonly Pick<RebirthBlock, 'title' | 'body' | 'type'>[]): string {
    return blocks.map(b => `## ${b.title.replace(/[\r\n]/g, ' ')}\n${b.type ? `<!-- type: ${b.type.replace(/[\r\n]/g, ' ')} -->\n` : ''}${b.body.trim()}\n`).join('\n');
  },
  linkFormatHint: (text: string = formatInstruction(BUILTIN_FORMAT)) => text,
  jsonSchemaHint: JSON.stringify({ title: '一句话主题', blocks: [{ title: '块标题', type: 'overview', body: '正文 markdown' }] }),
};
