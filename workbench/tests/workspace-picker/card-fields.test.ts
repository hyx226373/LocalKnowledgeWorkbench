import fs from 'node:fs';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { DB_VERSION } from '../../src/main/service/db';
import {
  WORKSPACE_CARD_COLUMNS,
  WORKSPACE_CARD_FIELDS_MIGRATION_SQL,
  WORKSPACE_CARD_FIELDS_USER_VERSION,
  applyWorkspaceCardFieldsMigration,
  readWorkspaceCardFields,
  setWorkspaceThumbVersion,
  toWorkspaceListEntry,
  updateWorkspaceCardFields,
  type WorkspaceCardFields,
} from '../../src/main/service/workspaceCardFields';
import { makeService } from '../helpers';

const OLD_WORKSPACES_SQL = `
CREATE TABLE workspaces (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  project        TEXT NOT NULL DEFAULT '',
  layout_json    TEXT NOT NULL,
  layout_schema  INTEGER NOT NULL,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  last_opened_at INTEGER
);
`;

const DEFAULTS: WorkspaceCardFields = {
  purpose: '',
  tags: [],
  favorite: false,
  icon: null,
  accent: null,
  coverRef: null,
  thumbVersion: 0,
};

const opened: Database.Database[] = [];
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (opened.length) opened.pop()!.close();
  while (cleanups.length) await cleanups.pop()!();
});

function openOld(): Database.Database {
  const db = new Database(':memory:');
  opened.push(db);
  db.exec(OLD_WORKSPACES_SQL);
  return db;
}

function insertOld(db: Database.Database, id: string, lastOpened: number | null, updated = 20): void {
  db.prepare(
    'INSERT INTO workspaces(id, name, project, layout_json, layout_schema, created_at, updated_at, last_opened_at) VALUES (?,?,?,?,?,?,?,?)',
  ).run(id, '读文献', '论文', '{"schema":4,"dock":null}', 4, 10, updated, lastOpened);
}

function raw(db: Database.Database, id: string): Record<string, unknown> {
  return db.prepare('SELECT * FROM workspaces WHERE id=?').get(id) as Record<string, unknown>;
}

function info(db: Database.Database) {
  return db.prepare('PRAGMA table_info(workspaces)').all() as { cid: number; name: string; type: string; notnull: number; dflt_value: string | null; pk: number }[];
}

const legacy = {
  id: 'ws1',
  name: '读文献',
  project: '论文',
  layoutSchema: 4,
  rootIds: [] as string[],
  panelCount: 3,
  createdAt: 10,
  updatedAt: 999,
  lastOpenedAt: 30,
};

describe('工作区卡片字段', () => {
  it('下一档 user_version 是当前迁移条数 + 1，SQL 不碰旧列', () => {
    expect(WORKSPACE_CARD_FIELDS_USER_VERSION).toBe(DB_VERSION + 1);
    expect(WORKSPACE_CARD_FIELDS_USER_VERSION).toBe(6);
    expect(WORKSPACE_CARD_FIELDS_MIGRATION_SQL).not.toMatch(/last_opened_at|layout_json|catalog_id/i);
    for (const col of WORKSPACE_CARD_COLUMNS) expect(WORKSPACE_CARD_FIELDS_MIGRATION_SQL).toContain(col);
  });

  it('旧行在迁移前后都读出默认，且 last_opened_at 不变', () => {
    const db = openOld();
    insertOld(db, 'ws1', 30, 20);
    const beforeCols = info(db);
    const before = raw(db, 'ws1');
    expect(readWorkspaceCardFields(before)).toEqual(DEFAULTS);
    expect(toWorkspaceListEntry(legacy, before, { files: 1, webs: 2, apps: 0, panels: 3 })).toMatchObject({
      ...DEFAULTS,
      panelCount: 3,
      lastOpenedAt: 30,
      lastUsedAt: 30,
      updatedAt: 999,
      counts: { files: 1, webs: 2, apps: 0, panels: 3 },
    });
    expect(toWorkspaceListEntry(legacy, { updated_at: 999, name: '读文献' }, { files: 0, webs: 0, apps: 0, panels: 0 }).lastUsedAt).toBeNull();

    applyWorkspaceCardFieldsMigration(db);
    const after = raw(db, 'ws1');
    expect(after.purpose).toBe('');
    expect(after.tags_json).toBe('[]');
    expect(after.favorite).toBe(0);
    expect(after.icon).toBeNull();
    expect(after.accent).toBeNull();
    expect(after.cover_ref).toBeNull();
    expect(after.thumb_version).toBe(0);
    expect(after.last_opened_at).toBe(30);
    expect(after.layout_json).toBe(before.layout_json);
    expect(after.name).toBe('读文献');
    expect(readWorkspaceCardFields(after)).toEqual(DEFAULTS);
    expect(toWorkspaceListEntry({ ...legacy, lastOpenedAt: null }, { ...after, last_opened_at: null, updated_at: 999 }, { files: 0, webs: 0, apps: 0, panels: 0 }).lastUsedAt).toBeNull();

    const oldNames = ['id', 'name', 'project', 'layout_json', 'layout_schema', 'created_at', 'updated_at', 'last_opened_at'];
    const afterCols = info(db);
    for (const name of oldNames) expect(afterCols.find((c) => c.name === name)).toEqual(beforeCols.find((c) => c.name === name));
    expect(afterCols.map((c) => c.name)).toEqual([...oldNames, ...WORKSPACE_CARD_COLUMNS]);

    insertOld(db, 'ws2', null, 1);
    expect(readWorkspaceCardFields(raw(db, 'ws2'))).toEqual(DEFAULTS);
    expect(raw(db, 'ws2').last_opened_at).toBeNull();

    applyWorkspaceCardFieldsMigration(db);
    expect(readWorkspaceCardFields(raw(db, 'ws1'))).toEqual(DEFAULTS);
  });

  it('db.exec 整段 SQL 与 apply 得到相同列定义', () => {
    const viaApply = openOld();
    applyWorkspaceCardFieldsMigration(viaApply);
    const viaExec = openOld();
    viaExec.exec(WORKSPACE_CARD_FIELDS_MIGRATION_SQL);
    expect(info(viaExec)).toEqual(info(viaApply));
    insertOld(viaExec, 'ws1', 7);
    expect(readWorkspaceCardFields(raw(viaExec, 'ws1'))).toEqual(DEFAULTS);
  });

  it('半截列拒绝再迁移', () => {
    const db = openOld();
    db.exec(`ALTER TABLE workspaces ADD COLUMN purpose TEXT NOT NULL DEFAULT ''`);
    expect(() => applyWorkspaceCardFieldsMigration(db)).toThrow(/不完整/);
  });

  it('更新卡片字段不改 last_opened_at 与布局', () => {
    const db = openOld();
    insertOld(db, 'ws1', 30, 20);
    applyWorkspaceCardFieldsMigration(db);
    const before = raw(db, 'ws1');
    updateWorkspaceCardFields(db, 'ws1', {});
    expect(raw(db, 'ws1')).toEqual(before);

    const read = updateWorkspaceCardFields(db, 'ws1', {
      purpose: '一边看笔记',
      tags: ['论文', ' 对照 ', ''],
      favorite: true,
      icon: ' folder ',
      accent: ' #A1B2C3 ',
      coverRef: ' ws-cover.png ',
    });
    expect(read).toEqual({
      purpose: '一边看笔记',
      tags: ['论文', '对照'],
      favorite: true,
      icon: 'folder',
      accent: '#A1B2C3',
      coverRef: 'ws-cover.png',
      thumbVersion: 0,
    });
    const mid = raw(db, 'ws1');
    expect(mid.last_opened_at).toBe(30);
    expect(mid.name).toBe('读文献');
    expect(mid.project).toBe('论文');
    expect(mid.layout_json).toBe(before.layout_json);
    expect(mid.layout_schema).toBe(4);
    expect(mid.created_at).toBe(10);
    expect(mid.updated_at).not.toBe(20);
    expect(mid.tags_json).toBe('["论文","对照"]');
    expect(mid.favorite).toBe(1);

    updateWorkspaceCardFields(db, 'ws1', { favorite: false });
    const after = raw(db, 'ws1');
    expect(after.favorite).toBe(0);
    expect(after.purpose).toBe('一边看笔记');
    expect(after.cover_ref).toBe('ws-cover.png');
    expect(after.last_opened_at).toBe(30);

    updateWorkspaceCardFields(db, 'ws1', { coverRef: null, accent: null, icon: null });
    expect(readWorkspaceCardFields(raw(db, 'ws1'))).toMatchObject({ coverRef: null, accent: null, icon: null, purpose: '一边看笔记' });
    const cleared = raw(db, 'ws1');
    expect(cleared.last_opened_at).toBe(30);

    setWorkspaceThumbVersion(db, 'ws1', 2);
    const thumb = raw(db, 'ws1');
    expect(thumb.thumb_version).toBe(2);
    expect(thumb.last_opened_at).toBe(30);
    expect(thumb.updated_at).toBe(cleared.updated_at);
    expect(thumb.purpose).toBe('一边看笔记');

    expect(() => updateWorkspaceCardFields(db, 'missing', { purpose: 'x' })).toThrow(/不存在/);
  });

  it('封面拒绝绝对路径，非法强调色与超长字段整单不写', () => {
    const db = openOld();
    insertOld(db, 'ws1', 30, 20);
    applyWorkspaceCardFieldsMigration(db);
    updateWorkspaceCardFields(db, 'ws1', { purpose: '保留', accent: '#00ff00', coverRef: 'ok.png' });
    const stuck = raw(db, 'ws1');

    const covers = ['C:\\covers\\a.png', 'D:a.png', '\\\\server\\share\\a.png', '/home/me/a.png', '/Users/me/a.png', 'covers/a.png', 'covers\\a.png', '../a.png', '..', '.', ''];
    for (const coverRef of covers) {
      expect(() => updateWorkspaceCardFields(db, 'ws1', { purpose: '不应写入', coverRef }), coverRef).toThrow(/绝对路径/);
    }
    expect(raw(db, 'ws1')).toEqual(stuck);

    expect(() => updateWorkspaceCardFields(db, 'ws1', { accent: 'red' })).toThrow(/#RRGGBB/);
    expect(() => updateWorkspaceCardFields(db, 'ws1', { accent: '#abc' })).toThrow(/#RRGGBB/);
    expect(() => updateWorkspaceCardFields(db, 'ws1', { accent: '#GG0000' })).toThrow(/#RRGGBB/);
    expect(() => updateWorkspaceCardFields(db, 'ws1', { purpose: '测'.repeat(81) })).toThrow(/80/);
    expect(() => updateWorkspaceCardFields(db, 'ws1', { purpose: '😀'.repeat(81) })).toThrow(/80/);
    expect(() => updateWorkspaceCardFields(db, 'ws1', { tags: Array.from({ length: 9 }, (_, i) => `t${i}`) })).toThrow(/8/);
    expect(() => updateWorkspaceCardFields(db, 'ws1', { tags: ['一二三四五六七八九零一二三四五六七'] })).toThrow(/16/);
    expect(() => updateWorkspaceCardFields(db, 'ws1', { icon: 'C:\\icons\\a.png' })).toThrow(/路径/);
    expect(raw(db, 'ws1')).toEqual(stuck);

    updateWorkspaceCardFields(db, 'ws1', { purpose: '😀'.repeat(80), tags: ['😀'.repeat(16)] });
    expect(Array.from(String(raw(db, 'ws1').purpose))).toHaveLength(80);
    expect(readWorkspaceCardFields(raw(db, 'ws1')).tags).toEqual(['😀'.repeat(16)]);
    expect(raw(db, 'ws1').last_opened_at).toBe(30);

    db.prepare(`UPDATE workspaces SET purpose=?, tags_json=?, accent=?, cover_ref=?, icon=? WHERE id=?`).run(
      '测'.repeat(81),
      '{',
      'nope',
      'C:\\secret\\a.png',
      'D:\\icon.png',
      'ws1',
    );
    expect(readWorkspaceCardFields(raw(db, 'ws1'))).toMatchObject({
      purpose: '测'.repeat(80),
      tags: [],
      accent: null,
      coverRef: null,
      icon: null,
    });
  });
});

describe('布局 JSON 仍走现有校验', () => {
  it('saveWorkspaceLayout 拒绝绝对路径，且不改其通过路径', async () => {
    const { svc, dataDir } = await makeService();
    cleanups.push(async () => {
      await svc.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    });
    const id = svc.createWorkspace('卡片', '论文').id;
    const before = svc.getWorkspace(id);
    const clean = { schema: 4, dock: null, shell: { sidebarWidth: 280 } };
    const item = { itemId: 'x', sourceKind: 'file', adapterId: 'auto', ref: 'res-1', displayMode: 'in-app-reader' };
    expect(() => svc.saveWorkspaceLayout(id, { ...clean, shell: { sidebarWidth: 280, leaked: 'D:\\Example Docs\\a.pdf' } }, [])).toThrow(/绝对路径/);
    expect(svc.getWorkspace(id).layout).toEqual(before.layout);
    expect(() =>
      svc.saveWorkspaceLayout(id, clean, [{ ...item, state: { v: 1, data: { file: 'D:\\Example Docs\\a.pdf' } } }]),
    ).toThrow(/绝对路径/);
    expect(svc.getWorkspace(id).layout).toEqual(before.layout);
    expect(svc.getWorkspace(id).items).toEqual([]);
    svc.saveWorkspaceLayout(id, { ...clean, shell: { sidebarWidth: 281 } }, [item]);
    const saved = svc.getWorkspace(id);
    expect(saved.layout).toMatchObject({ schema: 4, shell: { sidebarWidth: 281 } });
    expect(saved.items.map((i) => i.ref)).toEqual(['res-1']);
    expect(JSON.stringify(saved)).not.toContain('Example Docs');
    expect(saved.lastOpenedAt).toBeNull();
  });
});
