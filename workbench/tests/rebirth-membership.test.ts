import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RebirthRepository } from '../src/main/rebirth/repository';
import { copyAgentRepoSet } from '../src/main/rebirth/copyRepo';
import {
  filterMemberTree,
  memberIdSet,
  membershipForNewFile,
  migrateMembership,
  planMembershipChange,
  rebirthRootAfterWorkspaceChange,
  sourceGroups,
  UNRECORDED_LABEL,
} from '../src/shared/rebirthMembership';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
function temp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-member-'));
  roots.push(dir);
  return dir;
}
const md = (title: string) => `---\nlkw: rebirth/1\nagent: Codex\ntitle: ${title}\n---\n## [背景] 留下\n正文\n`;
function mdFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string) => {
    for (const name of fs.readdirSync(current)) {
      const file = path.join(current, name);
      const st = fs.lstatSync(file);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        if (name.startsWith('~') || name === '_quarantine' || name === '_out') continue;
        walk(file);
      } else if (name.endsWith('.md')) out.push(file);
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out.sort();
}

describe('成员清单纯函数', () => {
  it('迁移：升级前文件对当时全部工作区可见，来源未记；新工作区看不到', () => {
    const file = migrateMembership(['R1', 'R2', 'nope'], ['ws-a', 'ws-b', 'ws-a']);
    expect(file).toEqual({
      v: 1,
      items: {
        R1: { origin: null, members: ['ws-a', 'ws-b'] },
        R2: { origin: null, members: ['ws-a', 'ws-b'] },
      },
    });
    expect([...memberIdSet(file, 'ws-a')].sort()).toEqual(['R1', 'R2']);
    expect([...memberIdSet(file, 'ws-c')]).toEqual([]);
    expect(membershipForNewFile('ws-a')).toEqual({ origin: 'ws-a', members: ['ws-a'] });
    expect(membershipForNewFile(null)).toEqual({ origin: null, members: [] });
    expect(membershipForNewFile('  ')).toEqual({ origin: null, members: [] });
  });

  it('过滤侧栏：只留当前工作区成员，空文件夹丢掉', () => {
    const allow = memberIdSet(migrateMembership(['R1'], ['ws-a']), 'ws-a');
    const filtered = filterMemberTree(
      [{ name: '日常', items: [{ id: 'R1' }, { id: 'R9' }], children: [{ name: '空', items: [{ id: 'R8' }] }] }],
      [{ id: 'R2' }],
      allow,
    );
    expect(filtered.items).toEqual([]);
    expect(filtered.folders).toEqual([{ name: '日常', items: [{ id: 'R1' }], children: [] }]);
  });

  it('加入去重、移出只改本工作区', () => {
    const base = migrateMembership(['R1'], ['ws-a']);
    base.items.R2 = membershipForNewFile('ws-a');
    const added = planMembershipChange(base, 'ws-b', ['R2', 'R2'], ['R1', 'R2']);
    expect(added.added).toEqual(['R2']);
    expect(added.removed).toEqual([]);
    expect(added.next.items.R2.members).toEqual(['ws-a', 'ws-b']);
    expect(added.next.items.R1.members).toEqual(['ws-a']);
    const again = planMembershipChange(added.next, 'ws-b', ['R2'], ['R1', 'R2']);
    expect(again.added).toEqual([]);
    expect(again.next.items.R2.members).toEqual(['ws-a', 'ws-b']);
    const removed = planMembershipChange(again.next, 'ws-b', [], ['R1', 'R2']);
    expect(removed.removed).toEqual(['R2']);
    expect(removed.next.items.R2.members).toEqual(['ws-a']);
    expect(removed.next.items.R1.members).toEqual(['ws-a']);
  });

  it('按来源分组：全部在最前，未记来源单独成组', () => {
    const groups = sourceGroups(
      [{ id: 'R1', origin: null }, { id: 'R2', origin: 'ws-a' }],
      [{ id: 'ws-a', name: 'A 工作区' }, { id: 'ws-b', name: 'B 工作区' }],
    );
    expect(groups[0]).toEqual({ key: 'all', label: '全部', ids: ['R1', 'R2'] });
    expect(groups.find((group) => group.key === 'ws:ws-a')).toEqual({ key: 'ws:ws-a', label: 'A 工作区', ids: ['R2'] });
    expect(groups.find((group) => group.key === 'ws:ws-b')?.ids).toEqual([]);
    expect(groups.at(-1)?.label).toBe(UNRECORDED_LABEL);
    expect(groups.at(-1)?.ids).toEqual(['R1']);
  });

  it('换工作区不改重生根', () => {
    expect(rebirthRootAfterWorkspaceChange('/data/rebirth', 'ws-b')).toBe('/data/rebirth');
    expect(rebirthRootAfterWorkspaceChange('/data/rebirth', null)).toBe('/data/rebirth');
  });
});

describe('成员清单与换地址', () => {
  it('仓库迁移、新文件只进当前区、加入不复制 md、移出不删文件、换区不搬根', () => {
    const dir = temp();
    const first = new RebirthRepository(dir);
    const oldId = first.import(md('升级前')).id;
    expect(fs.existsSync(path.join(first.root, 'membership.json'))).toBe(false);
    const repo = new RebirthRepository(dir);
    const root = repo.root;
    const oldFile = repo.file(oldId);
    repo.setWorkspaceContext(null, ['ws-a', 'ws-b']);
    expect(repo.root).toBe(root);
    expect(repo.membership().items[oldId]).toEqual({ origin: null, members: ['ws-a', 'ws-b'] });
    expect(rebirthRootAfterWorkspaceChange(repo.setWorkspaceContext('ws-a', ['ws-a', 'ws-b']), 'ws-b')).toBe(root);
    expect(repo.root).toBe(root);
    expect(repo.file(oldId)).toBe(oldFile);
    const fresh = repo.import(md('新建')).id;
    expect(repo.membership().items[fresh]).toEqual({ origin: 'ws-a', members: ['ws-a'] });
    expect(memberIdSet(repo.membership(), 'ws-b').has(fresh)).toBe(false);
    expect(memberIdSet(repo.membership(), 'ws-a').has(fresh)).toBe(true);
    expect(memberIdSet(repo.membership(), 'ws-c').has(oldId)).toBe(false);
    const before = mdFiles(repo.root).length;
    const keepB = [...memberIdSet(repo.membership(), 'ws-b'), fresh];
    const added = repo.applyMembership('ws-b', keepB);
    expect(added.added).toEqual([fresh]);
    expect(repo.membership().items[fresh].members).toEqual(['ws-a', 'ws-b']);
    expect(repo.applyMembership('ws-b', keepB).added).toEqual([]);
    expect(repo.membership().items[fresh].members).toEqual(['ws-a', 'ws-b']);
    expect(mdFiles(repo.root)).toHaveLength(before);
    const stay = keepB.filter((id) => id !== fresh);
    expect(repo.applyMembership('ws-b', stay).removed).toEqual([fresh]);
    expect(repo.membership().items[fresh].members).toEqual(['ws-a']);
    expect(fs.existsSync(repo.file(fresh))).toBe(true);
    expect(repo.setWorkspaceContext('ws-b', ['ws-a', 'ws-b'])).toBe(root);
    expect(repo.root).toBe(root);
    expect(fs.existsSync(oldFile)).toBe(true);
  });

  it('换地址整套复制，旧地址的库文件还在', () => {
    const dir = temp();
    const repo = new RebirthRepository(dir);
    repo.setWorkspaceContext('ws-a', ['ws-a']);
    const id = repo.import(md('搬家')).id;
    const src = repo.root;
    fs.writeFileSync(path.join(src, 'file-tags.json'), JSON.stringify({ v: 1, tags: [{ id: 't1', name: '晨间', ids: [id] }] }));
    const indexBefore = fs.readFileSync(path.join(src, 'index.json'));
    const memberBefore = fs.readFileSync(path.join(src, 'membership.json'), 'utf8');
    const tagsBefore = fs.readFileSync(path.join(src, 'file-tags.json'), 'utf8');
    const fileBefore = repo.file(id);
    const mdBefore = fs.readFileSync(fileBefore);
    const dest = path.join(dir, 'moved');
    repo.setSettings({ ...repo.settings(), archive: { mode: 'dir', allowNewFolder: false, dir: dest } });
    expect(repo.root).toBe(path.resolve(dest));
    expect(fs.readFileSync(path.join(src, 'index.json'))).toEqual(indexBefore);
    expect(fs.readFileSync(path.join(src, 'membership.json'), 'utf8')).toBe(memberBefore);
    expect(fs.readFileSync(path.join(src, 'file-tags.json'), 'utf8')).toBe(tagsBefore);
    expect(fs.readFileSync(fileBefore)).toEqual(mdBefore);
    expect(fs.existsSync(path.join(dest, 'index.json'))).toBe(true);
    expect(fs.readFileSync(path.join(dest, 'membership.json'), 'utf8')).toBe(memberBefore);
    expect(fs.readFileSync(path.join(dest, 'file-tags.json'), 'utf8')).toBe(tagsBefore);
    expect(mdFiles(dest).length).toBe(mdFiles(src).length);
    fs.appendFileSync(repo.file(id), '\n改了新地址');
    expect(fs.readFileSync(fileBefore)).toEqual(mdBefore);
    expect(repo.setWorkspaceContext('ws-b', ['ws-a', 'ws-b'])).toBe(path.resolve(dest));
  });

  it('扫描入库只记当前工作区；真删除走回收站回调并清掉全体成员', async () => {
    const dir = temp();
    const trashed: string[] = [];
    const repo = new RebirthRepository(dir, () => {}, async (file) => { trashed.push(file); });
    repo.setWorkspaceContext('ws-a', ['ws-a', 'ws-b']);
    const folder = path.join(repo.root, '日常');
    fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder, 'new.md'), md('扫描'));
    repo.scan(0);
    repo.scan(2000);
    const found = Object.entries(repo.membership().items).find(([, item]) => item.origin === 'ws-a');
    expect(found?.[1]).toEqual({ origin: 'ws-a', members: ['ws-a'] });
    expect(found && memberIdSet(repo.membership(), 'ws-b').has(found[0])).toBe(false);
    expect(mdFiles(repo.root)).toHaveLength(1);
    const id = found?.[0] ?? '';
    repo.applyMembership('ws-b', [id]);
    expect(repo.membership().items[id].members).toEqual(['ws-a', 'ws-b']);
    const file = repo.file(id);
    await repo.delete(id);
    expect(trashed).toContain(file);
    expect(fs.existsSync(file)).toBe(true);
    expect(repo.membership().items[id]).toBeUndefined();
  });

  it('copyAgentRepoSet 不改旧目录，没有 file-tags 时新目录也不凭空产生', () => {
    const parent = temp();
    const from = path.join(parent, 'from');
    const to = path.join(parent, 'to');
    fs.mkdirSync(path.join(from, '日常'), { recursive: true });
    fs.mkdirSync(path.join(from, '空文件夹'));
    fs.writeFileSync(path.join(from, '日常', 'R1-a.md'), 'hello');
    fs.writeFileSync(path.join(from, 'index.json'), '{"lastNo":1,"items":{"R1":"日常/R1-a.md"}}');
    fs.writeFileSync(path.join(from, 'membership.json'), '{"v":1,"items":{"R1":{"origin":null,"members":["ws-a"]}}}');
    fs.writeFileSync(path.join(from, 'settings.json'), '{"mode":"manual"}');
    const before = fs.readFileSync(path.join(from, '日常', 'R1-a.md'));
    copyAgentRepoSet(from, to);
    expect(fs.readFileSync(path.join(from, '日常', 'R1-a.md'))).toEqual(before);
    expect(fs.readFileSync(path.join(from, 'settings.json'), 'utf8')).toBe('{"mode":"manual"}');
    expect(fs.readFileSync(path.join(to, '日常', 'R1-a.md'), 'utf8')).toBe('hello');
    expect(fs.existsSync(path.join(to, 'index.json'))).toBe(true);
    expect(fs.existsSync(path.join(to, 'membership.json'))).toBe(true);
    expect(fs.existsSync(path.join(to, 'file-tags.json'))).toBe(false);
    expect(fs.existsSync(path.join(to, 'settings.json'))).toBe(false);
    expect(fs.existsSync(path.join(to, '空文件夹'))).toBe(true);
    expect(fs.existsSync(path.join(from, '空文件夹'))).toBe(true);
    fs.appendFileSync(path.join(to, '日常', 'R1-a.md'), '!');
    expect(fs.readFileSync(path.join(from, '日常', 'R1-a.md'))).toEqual(before);
  });
});

describe('review-fix: 换地址不覆盖新位置已有文件', () => {
  it('新位置有同名不同内容的文件时整体拒绝，什么都不写', async () => {
    const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'rv-copy-'));
    const from = path.join(base, 'a'), to = path.join(base, 'b');
    fs.mkdirSync(from); fs.mkdirSync(to);
    fs.writeFileSync(path.join(from, 'index.json'), '{"items":{}}');
    fs.writeFileSync(path.join(from, 'R1-x.md'), 'new');
    fs.writeFileSync(path.join(to, 'index.json'), 'USER');
    expect(() => copyAgentRepoSet(from, to)).toThrow(/已有同名文件/);
    expect(fs.readFileSync(path.join(to, 'index.json'), 'utf8')).toBe('USER');
    expect(fs.existsSync(path.join(to, 'R1-x.md'))).toBe(false);
    fs.writeFileSync(path.join(to, 'index.json'), '{"items":{}}');
    expect(copyAgentRepoSet(from, to)).toEqual(['R1-x.md']);
    fs.rmSync(base, { recursive: true, force: true });
  });
});
