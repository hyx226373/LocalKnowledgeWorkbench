// 第 9 轮 C：原位编辑服务层（保存前差异、冲突检测、恢复记录、撤销到上一版、编码/换行保持）
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { makeService, tmpDir, write } from './helpers';
import { TextEditService } from '../src/main/service/textEdit';
import { LocalFileOps } from '../src/main/backend/fileOps';
import { diffLines } from '../src/shared/textDiff';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function setup() {
  const { svc } = await makeService();
  cleanups.push(() => svc.close());
  const dir = tmpDir('kbedit-');
  write(path.join(dir, 'a.md'), '# 标题\n\n第一段\n第二段\n');
  write(path.join(dir, 'crlf.txt'), '甲\r\n乙\r\n');
  write(path.join(dir, 'bom.txt'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('带 BOM\n')]));
  write(path.join(dir, 'gbk.txt'), Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0x0d, 0x0a])); // “中文\r\n” GBK
  write(path.join(dir, 'gbk-bad.txt'), Buffer.from([0xd6, 0xd0, 0xff, 0xce, 0xc4])); // 含无效字节
  write(path.join(dir, 'be.txt'), Buffer.from([0xfe, 0xff, 0x4e, 0x2d, 0x00, 0x0a])); // UTF-16 BE “中\n”
  const root = svc.addRoot(dir);
  await svc.scanRoot(root.id);
  const te = new TextEditService(new LocalFileOps(svc));
  const rid = (rel: string) => svc.resourceIdFor(root.id, rel);
  return { svc, dir, te, rid };
}

describe('textDiff', () => {
  it('行级差异、上下文与省略', () => {
    const a = Array.from({ length: 20 }, (_, i) => `行${i + 1}`).join('\n');
    const b = a.replace('行10', '行十').replace('行20', '行20\n新增');
    const d = diffLines(a, b);
    expect(d.added).toBe(2);
    expect(d.removed).toBe(1);
    expect(d.lines.find((l) => l.kind === 'del')).toMatchObject({ a: 10, text: '行10' });
    expect(d.lines.some((l) => l.kind === 'gap')).toBe(true);
    expect(diffLines('x\r\ny', 'x\ny').identical).toBe(true);
  });
  it('超大中间段退化为整段替换（approximate）', () => {
    const d = diffLines('a\nb\nc', 'x\ny\nz', { maxCells: 4 });
    expect(d.approximate).toBe(true);
    expect([d.added, d.removed]).toEqual([3, 3]);
  });
});

describe('TextEditService', () => {
  it('保存：先预览差异；写入前内容进备份库并记 op_log；可撤销到上一版（多级）', async () => {
    const { te, dir, rid, svc } = await setup();
    const id = rid('a.md');
    const s0 = te.open(id);
    expect(s0.editable).toBe(true);
    const pv = te.previewSave(id, s0.text.replace('第一段', '第一段（改）'), s0.hash);
    expect(pv.conflict).toBe(false);
    expect([pv.diff.added, pv.diff.removed]).toEqual([1, 1]);
    const r1 = te.save(id, s0.text.replace('第一段', '第一段（改）'), s0.hash);
    expect(r1.status).toBe('saved');
    if (r1.status !== 'saved') return;
    const r2 = te.save(id, r1.snapshot.text + '第三段\n', r1.snapshot.hash);
    expect(r2.status).toBe('saved');
    expect(fs.readFileSync(path.join(dir, 'a.md'), 'utf8')).toContain('第三段');
    expect(te.history(id).map((h) => h.undone)).toEqual([false, false]);
    expect(svc.listOpsFor(id).filter((o) => o.op === 'write').every((o) => o.detail.beforeHash && o.detail.via === 'text-edit')).toBe(true);
    const u1 = te.undoLastSave(id);
    expect(u1.status).toBe('undone');
    expect(fs.readFileSync(path.join(dir, 'a.md'), 'utf8')).toBe('# 标题\n\n第一段（改）\n第二段\n');
    const u2 = te.undoLastSave(id);
    expect(u2.status).toBe('undone');
    expect(fs.readFileSync(path.join(dir, 'a.md'), 'utf8')).toBe('# 标题\n\n第一段\n第二段\n');
    expect(te.undoLastSave(id).status).toBe('nothing');
    // 资源 ID 不变
    expect(rid('a.md')).toBe(id);
  });

  it('外部修改 → 冲突，绝不静默覆盖；“保留我的”= 以外部版本哈希为基准再保存，外部版本可撤销找回', async () => {
    const { te, dir, rid } = await setup();
    const id = rid('a.md');
    const s0 = te.open(id);
    fs.writeFileSync(path.join(dir, 'a.md'), '外部软件写的\n');
    const pv = te.previewSave(id, '我的版本\n', s0.hash);
    expect(pv.conflict).toBe(true);
    const r = te.save(id, '我的版本\n', s0.hash);
    expect(r.status).toBe('conflict');
    expect(fs.readFileSync(path.join(dir, 'a.md'), 'utf8')).toBe('外部软件写的\n');
    if (r.status !== 'conflict') return;
    expect(r.disk.text).toBe('外部软件写的\n');
    expect(r.diff.added + r.diff.removed).toBeGreaterThan(0);
    // 保留我的
    const k = te.save(id, '我的版本\n', r.disk.hash);
    expect(k.status).toBe('saved');
    expect(fs.readFileSync(path.join(dir, 'a.md'), 'utf8')).toBe('我的版本\n');
    // 撤销 → 外部版本回来
    expect(te.undoLastSave(id).status).toBe('undone');
    expect(fs.readFileSync(path.join(dir, 'a.md'), 'utf8')).toBe('外部软件写的\n');
  });

  it('撤销时文件已被再次修改 → 返回冲突；force 时先备份当前内容再撤销', async () => {
    const { te, dir, rid } = await setup();
    const id = rid('a.md');
    const s0 = te.open(id);
    expect(te.save(id, 'v1\n', s0.hash).status).toBe('saved');
    fs.writeFileSync(path.join(dir, 'a.md'), '外部 v2\n');
    expect(te.undoLastSave(id).status).toBe('conflict');
    expect(fs.readFileSync(path.join(dir, 'a.md'), 'utf8')).toBe('外部 v2\n');
    expect(te.undoLastSave(id, true).status).toBe('undone');
    expect(fs.readFileSync(path.join(dir, 'a.md'), 'utf8')).toBe('# 标题\n\n第一段\n第二段\n');
  });

  it('保持换行（CRLF）与 BOM；GBK / UTF-16 BE 可编辑且按原编码写回；含无效字节的 GBK 只读；未改动不写盘', async () => {
    const { te, dir, rid, svc } = await setup();
    const c = te.open(rid('crlf.txt'));
    expect(c.eol).toBe('crlf');
    expect(c.text).toBe('甲\n乙\n');
    te.save(rid('crlf.txt'), '甲\n乙\n丙\n', c.hash);
    expect(fs.readFileSync(path.join(dir, 'crlf.txt'), 'utf8')).toBe('甲\r\n乙\r\n丙\r\n');
    const b = te.open(rid('bom.txt'));
    expect(b.encoding).toBe('utf-8-bom');
    te.save(rid('bom.txt'), '改了\n', b.hash);
    expect([...fs.readFileSync(path.join(dir, 'bom.txt')).subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const g = te.open(rid('gbk.txt'));
    expect(g).toMatchObject({ editable: true, encoding: 'gb18030', eol: 'crlf', text: '中文\n' });
    expect(te.save(rid('gbk.txt'), '中文\n改动😀\n', g.hash).status).toBe('saved');
    const gb = fs.readFileSync(path.join(dir, 'gbk.txt'));
    // 原有字符按 GBK 原字节写回、换行仍是 CRLF；GBK 之外的字符用 GB18030 四字节编码（不变成问号）
    expect([...gb.subarray(0, 6)]).toEqual([0xd6, 0xd0, 0xce, 0xc4, 0x0d, 0x0a]);
    expect([...gb.subarray(6, 10)]).toEqual([0xb8, 0xc4, 0xb6, 0xaf]); // “改动”
    expect(te.open(rid('gbk.txt'))).toMatchObject({ encoding: 'gb18030', text: '中文\n改动😀\n' });
    // 撤销回到原字节
    expect(te.undoLastSave(rid('gbk.txt')).status).toBe('undone');
    expect([...fs.readFileSync(path.join(dir, 'gbk.txt'))]).toEqual([0xd6, 0xd0, 0xce, 0xc4, 0x0d, 0x0a]);
    const bad = te.open(rid('gbk-bad.txt'));
    expect(bad.editable).toBe(false);
    expect(bad.readOnlyReason).toMatch(/GBK|编码无法可靠识别|往返/);
    expect(() => te.save(rid('gbk-bad.txt'), 'x', bad.hash)).toThrow(/GBK|编码无法可靠识别|往返/);
    const be = te.open(rid('be.txt'));
    expect(be).toMatchObject({ editable: true, encoding: 'utf-16be', text: '中\n' });
    te.save(rid('be.txt'), '中文\n', be.hash);
    expect([...fs.readFileSync(path.join(dir, 'be.txt'))]).toEqual([0xfe, 0xff, 0x4e, 0x2d, 0x65, 0x87, 0x00, 0x0a]);
    const n = svc.listOps(100).length;
    const a = te.open(rid('a.md'));
    expect(te.save(rid('a.md'), a.text, a.hash).status).toBe('unchanged');
    expect(svc.listOps(100).length).toBe(n);
  });

  it('编码往返不一致时明示只读，禁止静默改写字节（E10）', async () => {
    const { te, rid } = await setup();
    const bad = te.open(rid('gbk-bad.txt'));
    expect(bad.editable).toBe(false);
    expect(bad.readOnlyReason).toMatch(/编码无法可靠识别|GBK|往返/);
    expect(() => te.save(rid('gbk-bad.txt'), '覆盖', bad.hash)).toThrow();
  });
});
