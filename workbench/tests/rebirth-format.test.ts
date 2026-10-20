import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rebirthFormat, BUILTIN_FORMATS, formatInstruction, validateFormat, normalizeFormats } from '../src/shared/rebirthFormat';
import { parseMarkdown, parseJson, serializeMarkdown } from '../src/main/rebirth/format';
import { RebirthRepository } from '../src/main/rebirth/repository';
import { createLink, exportJsonLink, importLink } from '../src/main/rebirth/links';
import { prepareImport } from '../src/renderer/rebirth/logic';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));
function repository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rebirth-format-'));
  roots.push(root);
  return new RebirthRepository(root);
}

it('无类型前缀、无 frontmatter 的 md 正常入库、编辑保存、过滤导出', () => {
  const repo = repository();
  const { id } = repo.import('## 随手记录\n事实\n## 火星计划 🚀\n行动\n## [任何前缀] 原样\n备注');
  const doc = repo.read(id);
  expect(doc.meta.title).toBe('随手记录');
  expect(doc.blocks.map(b => b.title)).toEqual(['随手记录', '火星计划 🚀', '[任何前缀] 原样']);
  repo.save(id, [{ title: '重新编辑', body: '新内容' }, doc.blocks[1]]);
  repo.setSelection(id, [1], []);
  expect(repo.generate(id).text.trim()).toBe(rebirthFormat.serialize([{ title: '重新编辑', body: '新内容' }]).trim());
  expect(repo.generate(id).text).not.toContain('行动');
});

it('任意二级标题分块，一级/三级和代码围栏内的标题保持正文', () => {
  const text = '# 文档\n## 任意标题\n### 小节\n```md\n## 示例\n~~~\n```\n## [新种类] 标题\n正文\n~~~\n## 示例二\n```\n~~~\n## 最后';
  const blocks = rebirthFormat.splitBlocks(text);
  expect(blocks.map(b => b.title)).toEqual(['任意标题', '[新种类] 标题', '最后']);
  expect(blocks[0].body).toContain('## 示例');
  expect(blocks[1].body).toContain('## 示例二');
  expect(parseMarkdown(serializeMarkdown(parseMarkdown(text))).blocks).toEqual(blocks);
});

it('frontmatter 仅 title 即可，其余可选，缺失 title 取首标题或文件名', () => {
  expect(parseMarkdown('---\ntitle: 自定\n---\n## 内容\n正文').meta.title).toBe('自定');
  expect(parseMarkdown('---\nagent: Codex\n---\n# 文档\n## 内容\n正文').meta.title).toBe('文档');
  expect(parseMarkdown('## \n正文', 'fallback.md').meta.title).toBe('fallback');
});

it('扫描无前缀 md 不隔离，自动编号', () => {
  const repo = repository();
  fs.writeFileSync(path.join(repo.root, 'plain.md'), '## 新标题\n正文');
  repo.scan(0);
  repo.scan(2001);
  expect(repo.read('R1').blocks[0].title).toBe('新标题');
  expect(repo.list().quarantined).toEqual([]);
});

it('JSON 块仅需 title/body，渲染预检与主进程均接受，不校验旧 type', () => {
  for (const extra of [{}, { type: '完全自定' }]) {
    const text = JSON.stringify({ title: '网页版', blocks: [{ title: '随意', body: '内容', ...extra }] });
    expect(prepareImport(text)).toBe(text);
    expect(parseJson(text).blocks).toEqual([{ idx: 1, title: '随意', body: '内容',type: 'type' in extra ? extra.type : '' }]);
    const repo = repository();
    expect(repo.read(repo.import(text).id).blocks).toEqual(parseJson(text).blocks);
  }
});

it('所有格式链接从预设块清单生成标题和 type 要求', () => {
  const repo = repository();
  const { id } = repo.import('## 内容\n正文');
  const context = { root: repo.root };
  for (const text of [createLink(context), exportJsonLink(context), importLink(repo.file(id)), repo.importInstruction(id, 'json').text]) {
    for(const b of BUILTIN_FORMATS[0].blocks!) {expect(text).toContain(b.title);expect(text).toContain(b.type);}
  }
  expect(createLink(context)).toContain(rebirthFormat.linkFormatHint());
  expect(importLink(repo.file(id))).toContain(rebirthFormat.linkFormatHint());
  expect(exportJsonLink(context)).toContain('"type":"configured type"');
  expect(repo.importInstruction(id, 'json').text).toContain('nonempty array of {"title":"configured title"');
  expect(prepareImport('## 无前缀\n正文')).toBe('## 无前缀\n正文');
});

it('切换总结格式影响三种指令与导入合并，重启仍保留；解析始终宽松', () => {
  const repo = repository();
  const {id} = repo.import('## 任意标题\n正文');
  const custom = {id:'custom',name:'复盘',text:'先列事实，再列问题与下一步。',builtin:false};
  repo.setSettings({formats:[custom],activeFormat:custom.id});
  for (const kind of ['create','json','import']) expect(repo.linkText(kind,id)).toContain(custom.text);
  expect(repo.importInstruction(id,'file').text).toContain(custom.text);
  expect(repo.importInstruction(id,'json').text).toContain(custom.text);
  const reopened = new RebirthRepository(repo.dataDir);
  expect(reopened.settings().activeFormat).toBe(custom.id);
  expect(reopened.linkText('create')).toContain(custom.text);
  expect(reopened.read(id).blocks[0].title).toBe('任意标题');
  repo.setSettings({activeFormat:'heading2'});
  for (const kind of ['create','json','import']) {
    expect(repo.linkText(kind,id)).toContain(rebirthFormat.linkFormatHint());
    expect(repo.linkText(kind,id)).not.toContain(custom.text);
  }
});

it('内置格式不可通过设置删除、覆盖或伪造，自定义可以编辑重命名删除', () => {
  const repo = repository();
  const custom = {id:'custom',name:'名称',text:'说明',builtin:false};
  repo.setSettings({formats:[custom],activeFormat:custom.id});
  repo.setSettings({formats:[{...custom,name:'新名称',text:'新说明'}]});
  expect(repo.linkText('create')).toContain('新说明');
  const settings=repo.setSettings({formats:[{id:'heading2',name:'篡改',text:'篡改',builtin:false}],activeFormat:'custom'});
  expect(settings.formats).toEqual(normalizeFormats());
  expect(settings.activeFormat).toBe('default');
});

it('中文文件头、PT 时间和 type 往返，旧文档仍能读，导出不含头',()=>{
 const raw='---\n来源对话: 原对话\n创建时间: 2026-10-16 05:10 PT\n归档位置: 项目\n格式名: 编程\n主题: 测试\n标签: [代码, 测试]\n---\n## 自由标题\n<!-- type: code -->\n正文\n## 旧块\n旧内容';
 const doc=parseMarkdown(raw);expect(doc.meta['来源对话']).toBe('原对话');expect(doc.meta.created).toBe('2026-10-16 05:10 PT');expect(doc.meta.topic).toBe('测试');expect(doc.meta['标签']).toEqual(['代码','测试']);
 expect(doc.blocks.map(b=>b.type)).toEqual(['code','']);expect(doc.blocks[0].body).toBe('正文');
 expect(parseMarkdown(serializeMarkdown(doc)).meta['格式名']).toBe('编程');expect(parseMarkdown(serializeMarkdown(doc)).meta['标签']).toEqual(['代码','测试']);
 expect(parseMarkdown('---\nagent:\n  名字: Codex\n  模型: GPT\n标签:\n  - 代码\n---\n## 内容').meta['标签']).toEqual(['代码']);
 expect(parseMarkdown('旧内容').blocks[0].type).toBe('');
 expect(parseMarkdown('---\ntitle: "未闭引号\n---\n## 内容').meta.title).toBe('"未闭引号');
 const repo=repository();const {id}=repo.import(raw);expect(repo.generate(id).text).not.toContain('来源对话:');expect(repo.generate(id).text).not.toMatch(/^---/);
});
it('JSON 单向转换保留中文文件头与 type，旧 JSON 兼容',()=>{
 const doc=parseJson(JSON.stringify({title:'标题',来源对话:'链接',创建时间:'2026-10-16 05:10 PT',归档位置:'根目录',格式名:'默认',关联项目:'项目',blocks:[{title:'块',type:'overview',body:'正文'}]}));
 const md=serializeMarkdown(doc);expect(md).toContain('来源对话: "链接"');expect(md).toContain('## 块\n<!-- type: overview -->\n正文');expect(parseMarkdown(md).meta['关联项目']).toBe('项目');
 expect(parseJson('{"title":"旧","blocks":[{"title":"旧块","body":"正文"}]}').blocks[0].type).toBe('');
});
it('八种预设逐块拼装，旧 heading2 映射默认且旧自定义保留',()=>{
 expect(BUILTIN_FORMATS).toHaveLength(8);
 for(const f of BUILTIN_FORMATS)for(const b of f.blocks!){const text=formatInstruction(f);expect(text).toContain(b.title);expect(text).toContain(b.type);expect(text).toContain('evidence');}
 const repo=repository();expect(repo.setSettings({activeFormat:'heading2'}).activeFormat).toBe('default');
 const custom={id:'new',name:'自定',builtin:false,blocks:[{title:'块',type:'x',hint:'详细写'}]};expect(validateFormat(custom)).toBe('');
 for(const key of ['title','type','hint']) {const bad={...custom,blocks:[{...custom.blocks[0],[key]:''}]};expect(validateFormat(bad)).toBeTruthy();expect(()=>repo.setSettings({formats:[bad]})).toThrow('每块必须');}
 repo.setSettings({headerFields:['agent','标签'],formats:[custom],activeFormat:'new'});expect(repo.linkText('create')).toContain('agent, 标签');expect(repo.linkText('json')).toContain('标签: Small deduplicated string array');
 const reopened=new RebirthRepository(repo.dataDir);expect(reopened.settings().headerFields).toEqual(['agent','标签']);expect(reopened.linkText('create')).toContain('详细写');
});
