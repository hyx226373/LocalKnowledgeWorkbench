import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeConsoleDraft } from '../src/main/console/draft';
import { parseConsoleDocument, executableIndex } from '../src/shared/consoleSchema';
import { makeService, tmpDir } from './helpers';

const RID = '11111111-1111-4111-8111-111111111111';

describe('writeConsoleDraft', () => {
  it('写成普通文件并经资源入库得到 resourceId', async () => {
    const { svc } = await makeService();
    const dir = tmpDir('kbconsole-');
    const root = svc.addRoot(dir, '样例');
    const written = writeConsoleDraft(svc, {
      rootId: root.id,
      relPath: '周复盘.kbconsole.md',
      title: '周复盘',
      description: '说明',
      items: [{ id: 'a', title: '笔记', order: 1, openAs: 'tab', ref: { type: 'resource', resourceId: RID } }],
    });
    const abs = path.join(dir, '周复盘.kbconsole.md');
    expect(fs.existsSync(abs)).toBe(true);
    expect(fs.readFileSync(abs, 'utf8')).toBe(written.text);
    const info = svc.getResource(written.resourceId);
    expect(info?.relPath).toBe('周复盘.kbconsole.md');
    expect(info?.exists).toBe(true);
    expect(executableIndex(parseConsoleDocument(svc.readText(written.resourceId).text))?.items[0].title).toBe('笔记');
    expect(() => writeConsoleDraft(svc, { rootId: root.id, relPath: '周复盘.kbconsole.md', title: '再写', items: [] })).toThrow(/不覆盖/);
    await svc.close();
  });
});
