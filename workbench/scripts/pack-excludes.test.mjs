import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PACK_EXCLUDE_GLOBS } from './pack-excludes.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

test('安装包文件列表排除重复的 @kb 依赖和 mermaid 整包', () => {
  for (const files of [pkg.build.files, pkg.build.win.files]) {
    for (const glob of PACK_EXCLUDE_GLOBS) assert.ok(files.includes(glob), glob);
    assert.ok(files.includes('node_modules/katex/dist/**'));
    assert.ok(files.includes('node_modules/pdfjs-dist/**'));
    assert.equal(files.includes('!node_modules/katex/**'), false);
    assert.equal(files.includes('!node_modules/better-sqlite3/**'), false);
    assert.equal(files.includes('!node_modules/pdfjs-dist/**'), false);
  }
  assert.equal(pkg.dependencies.katex, '0.19.0');
  assert.equal(pkg.devDependencies.mermaid, '12.1.0');
  assert.equal(pkg.dependencies.mermaid, undefined);
  assert.equal(pkg.dependencies['better-sqlite3'], '^13.0.3');
});

test('版式库打进 Worker，不另列 node_modules，dayjs 继续排除', () => {
  const bundled = ['exceljs', 'fflate', 'fast-xml-parser', 'buffer', 'cfb', 'word-extractor', 'xlsx', 'ppt'];
  for (const files of [pkg.build.files, pkg.build.win.files]) {
    assert.ok(files.includes('out/**'));
    assert.ok(files.includes('!node_modules/dayjs/**'));
    assert.equal(files.includes('node_modules/dayjs/**'), false);
    assert.ok(files.includes('node_modules/pdfjs-dist/**'));
    for (const name of bundled) {
      assert.equal(
        files.some((item) => item.includes(`node_modules/${name}`)),
        false,
        name,
      );
    }
  }
});
