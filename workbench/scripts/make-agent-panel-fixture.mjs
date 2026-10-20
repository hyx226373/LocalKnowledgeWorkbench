#!/usr/bin/env node
/**
 * 生成 Agent 面板验收用的测试根目录。
 * 不预置任何对话。对话由 agent 自己建档。
 *
 *   node scripts/make-agent-panel-fixture.mjs <输出根目录>
 *
 * 多给的参数会被忽略。脚本不再往 agent-data 写示例对话。
 */
import fs from 'node:fs';
import path from 'node:path';

const [rootDir] = process.argv.slice(2);
if (!rootDir || rootDir.startsWith('-')) {
  console.error('用法: node scripts/make-agent-panel-fixture.mjs <输出根目录>');
  process.exit(1);
}

function writeFile(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text.endsWith('\n') ? text : `${text}\n`, 'utf8');
}

writeFile(path.join(rootDir, '笔记.md'), '# 笔记\n\n面板验收用的一篇笔记。\n');
writeFile(path.join(rootDir, '待办.txt'), '1. 看对话存档\n2. 设上下文底座\n');
writeFile(path.join(rootDir, '说明.md'), '# 说明\n\n这个目录是测试根，不是 agent-data。\n');
writeFile(path.join(rootDir, '资料', '摘录.md'), '# 摘录\n\n子文件夹里的一篇。\n');
writeFile(path.join(rootDir, '资料', '草稿.txt'), '草稿，不必给 agent。\n');
writeFile(path.join(rootDir, '资料', '子', '备忘.md'), '# 备忘\n\n更深一层。\n');

console.log(`测试根: ${path.resolve(rootDir)}`);
console.log('未预置对话');
