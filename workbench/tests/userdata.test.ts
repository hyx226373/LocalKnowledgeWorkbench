// 应用数据目录：Windows 改用 %LOCALAPPDATA%，并从旧的 Roaming 目录一次性迁移（docs/07 §2）
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { migrateUserData, planUserDataDir, DATA_MARKER, MIGRATION_NOTE } from '../src/main/userDataDir';
import { tmpDir, write } from './helpers';

describe('数据目录规划', () => {
  const roaming = 'C:\\Users\\a\\AppData\\Roaming\\LocalKnowledgeWorkbench';
  it('Windows：LOCALAPPDATA\\LocalKnowledgeWorkbench，旧 Roaming 目录作为迁移来源', () => {
    expect(planUserDataDir({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' }, electronDefault: roaming })).toEqual({ dir: 'C:\\Users\\a\\AppData\\Local\\LocalKnowledgeWorkbench', migrateFrom: roaming });
  });
  it('KB_USER_DATA 优先且不迁移；其他平台保持默认', () => {
    expect(planUserDataDir({ platform: 'win32', env: { KB_USER_DATA: '/tmp/x', LOCALAPPDATA: 'C:\\L' }, electronDefault: roaming })).toEqual({ dir: path.resolve('/tmp/x'), migrateFrom: null });
    expect(planUserDataDir({ platform: 'linux', env: {}, electronDefault: '/home/a/.config/LocalKnowledgeWorkbench' })).toEqual({ dir: '/home/a/.config/LocalKnowledgeWorkbench', migrateFrom: null });
  });
});

describe('一次性迁移', () => {
  const mk = () => {
    const base = tmpDir('kbud-');
    const from = path.join(base, 'Roaming', 'LocalKnowledgeWorkbench');
    const to = path.join(base, 'Local', 'LocalKnowledgeWorkbench');
    write(path.join(from, DATA_MARKER), 'db');
    write(path.join(from, 'Partitions/kbweb.x/Cookies'), 'c');
    return { from, to };
  };
  it('新目录不存在 → 整体搬过去（rename），包括网页分区', () => {
    const { from, to } = mk();
    expect(migrateUserData(from, to)).toBe('renamed');
    expect(fs.readFileSync(path.join(to, DATA_MARKER), 'utf8')).toBe('db');
    expect(fs.existsSync(path.join(to, 'Partitions/kbweb.x/Cookies'))).toBe(true);
    expect(fs.existsSync(from)).toBe(false);
    // 第二次启动：没有可迁移的
    expect(migrateUserData(from, to)).toBe('none');
  });
  it('新目录是空目录 → 仍然迁移', () => {
    const { from, to } = mk();
    fs.mkdirSync(to, { recursive: true });
    expect(migrateUserData(from, to)).toBe('renamed');
  });
  it('新目录有非空内容（无元数据库）→ 复制，旧目录保留并留下说明', () => {
    const { from, to } = mk();
    write(path.join(to, 'Crashpad/x'), 'x');
    expect(migrateUserData(from, to)).toBe('copied');
    expect(fs.existsSync(path.join(to, DATA_MARKER))).toBe(true);
    expect(fs.existsSync(path.join(from, DATA_MARKER))).toBe(true);
    expect(fs.existsSync(path.join(from, MIGRATION_NOTE))).toBe(true);
  });
  it('新目录已有数据 → 不覆盖', () => {
    const { from, to } = mk();
    write(path.join(to, DATA_MARKER), 'new');
    expect(migrateUserData(from, to)).toBe('skipped-target-has-data');
    expect(fs.readFileSync(path.join(to, DATA_MARKER), 'utf8')).toBe('new');
  });
  it('旧目录没有元数据库 → 不迁移', () => {
    const base = tmpDir('kbud-');
    expect(migrateUserData(path.join(base, 'nope'), path.join(base, 'to'))).toBe('none');
  });
});
