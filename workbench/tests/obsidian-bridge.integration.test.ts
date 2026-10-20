/**
 * 用临时目录模拟中转库和工作台 md。不启动 Electron，不写 obsidian.json，不写正式用户库。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ObsidianBridge } from '../src/main/obsidianBridge/service';
import type { WorkbenchRoot } from '../src/main/obsidianBridge/files';
import { defaultRelayVaultDir } from '../src/shared/obsidianBridge/vault';
import { JUNCTION_WARNING } from '../src/shared/obsidianBridge/types';

const TOOLS = path.resolve('/workspace/ob-plugin/lkw-bridge/tools');
const temps: string[] = [];

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function filesNamed(dir: string, name: string): string[] {
  const out: string[] = [];
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.name.toLowerCase() === name.toLowerCase()) out.push(abs);
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

async function loadCore(): Promise<{
  defaultVaultDir(env?: NodeJS.ProcessEnv, home?: string): string;
  appendCloseRecord(opts: { vaultRoot: string; record: { relayRel: string; reason: string; ts: string } }): { appended: boolean };
  readCrossVolumeJunction(vaultRoot: string): boolean;
}> {
  const href = pathToFileURL(path.join(TOOLS, 'relay-core.mjs')).href;
  return import(href) as ReturnType<typeof loadCore>;
}

describe('中转库集成', () => {
  afterEach(() => {
    for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('初始化、打开、关闭清理和改名改写都不动原文件名', async () => {
    const home = tempDir('lkw-home-');
    const userData = tempDir('lkw-ud-');
    const vault = path.join(tempDir('lkw-vault-parent-'), 'LKW-Relay-Vault');
    const notes = tempDir('lkw-notes-');
    const env = { HOME: home, USERPROFILE: home, LKW_BRIDGE_TOOLS: TOOLS };
    const core = await loadCore();
    expect(core.defaultVaultDir(env, home)).toBe(defaultRelayVaultDir(env, home));

    let roots: WorkbenchRoot[] | null = null;
    const opened: string[] = [];
    const bridge = new ObsidianBridge({
      userDataDir: userData,
      env,
      home,
      toolsDir: TOOLS,
      pollMs: 60_000,
      listRoots: async () => roots,
      openExternal: async (uri) => {
        opened.push(uri);
      },
    });

    const foreign = path.join(tempDir('lkw-foreign-'), 'AlreadyVault');
    fs.mkdirSync(path.join(foreign, '.obsidian'), { recursive: true });
    bridge.setVaultDir(foreign);
    const refusedInit = await bridge.initRelay();
    expect(refusedInit.ok).toBe(false);
    expect(refusedInit.message || '').toMatch(/已经是别的|没有改动|请换/);
    expect(filesNamed(foreign, 'obsidian.json')).toEqual([]);
    bridge.setVaultDir(vault);
    const created = await bridge.initRelay();
    expect(created.ok).toBe(true);
    expect(created.pluginInstalled).toBe(true);
    expect(created.instructions).toContain('打开文件夹作为库');
    expect(created.instructions).toContain(vault);
    expect(filesNamed(vault, 'obsidian.json')).toEqual([]);
    expect(filesNamed(userData, 'obsidian.json')).toEqual([]);

    const settings = bridge.getSettings();
    expect(settings.crossVolumeJunction).toBe(false);
    expect(settings.vaultReady).toBe(true);
    expect(settings.warning).toBe('');
    await expect(bridge.setJunction(true)).resolves.toMatchObject({ crossVolumeJunction: true, warning: JUNCTION_WARNING });
    expect(core.readCrossVolumeJunction(vault)).toBe(true);
    const data = JSON.parse(fs.readFileSync(path.join(vault, '.obsidian', 'plugins', 'lkw-bridge', 'data.json'), 'utf8')) as { highlight?: boolean; crossVolumeJunction?: boolean };
    expect(data.highlight).toBe(true);
    expect(data.crossVolumeJunction).toBe(true);
    await bridge.initRelay();
    expect(core.readCrossVolumeJunction(vault)).toBe(true);
    await bridge.setJunction(false);
    expect(bridge.getSettings().crossVolumeJunction).toBe(false);

    const source = path.join(notes, '市场范围.md');
    const sourceText = '## 市场范围 ^kb-a1b2c3\n\n见 [[项目/旧名#^kb-c3d4e5|这三家]]。\n';
    fs.writeFileSync(source, sourceText);
    fs.writeFileSync(path.join(notes, '旧名.md'), '原名还在\n');
    const beforeNames = fs.readdirSync(notes).sort();

    const direct = await bridge.openInObsidian({ absPath: path.join(notes, '没有.md'), block: 'kb-a1b2c3' });
    expect(direct.ok).toBe(false);

    const openedNote = await bridge.openInObsidian({ absPath: source, block: 'kb-a1b2c3', heading: '市场范围' });
    expect(openedNote.ok).toBe(true);
    expect(openedNote.via).toBe('relay');
    expect(openedNote.uri).toMatch(/^obsidian:\/\/lkw-open\?/);
    const uri = new URL(openedNote.uri || '');
    expect(uri.searchParams.get('vault')).toBe('LKW-Relay-Vault');
    expect(uri.searchParams.get('block')).toBe('kb-a1b2c3');
    expect(uri.searchParams.get('heading')).toBe('市场范围');
    const relayRel = uri.searchParams.get('path') || '';
    expect(relayRel.startsWith('relay/')).toBe(true);
    expect(opened).toEqual([openedNote.uri]);
    expect(fs.readFileSync(source, 'utf8')).toBe(sourceText);
    expect(fs.readdirSync(notes).sort()).toEqual(beforeNames);

    const stray = path.join(vault, 'relay', '别人的.md');
    fs.writeFileSync(stray, '不要删\n');
    const manifest = JSON.parse(fs.readFileSync(path.join(vault, 'relay', '.manifest.json'), 'utf8')) as { entries: { relayRel: string }[] };
    expect(manifest.entries.map((entry) => entry.relayRel)).toContain(relayRel);

    roots = null;
    const exchange = path.join(vault, 'lkw-exchange');
    fs.mkdirSync(exchange, { recursive: true });
    const renameLog = path.join(exchange, 'rename-log.jsonl');
    fs.appendFileSync(renameLog, `${JSON.stringify({ from: '项目/旧名.md', to: '项目/新名.md', ts: '2026-10-19T00:00:00.000Z' })}\n`);
    await bridge.poll();
    expect(fs.readFileSync(source, 'utf8')).toContain('[[项目/旧名#^kb-c3d4e5|这三家]]');
    expect(fs.existsSync(path.join(userData, 'obsidian-bridge', 'rename-cursor.json'))).toBe(false);

    roots = [{ path: notes, kind: 'folder' }];
    await bridge.poll();
    expect(fs.readFileSync(source, 'utf8')).toContain('[[项目/新名#^kb-c3d4e5|这三家]]');
    expect(fs.readFileSync(path.join(notes, '旧名.md'), 'utf8')).toBe('原名还在\n');
    expect(fs.existsSync(path.join(notes, '新名.md'))).toBe(false);
    expect(fs.readdirSync(notes).sort()).toEqual(beforeNames);
    const cursor = JSON.parse(fs.readFileSync(path.join(userData, 'obsidian-bridge', 'rename-cursor.json'), 'utf8')) as { files: Record<string, number> };
    expect(cursor.files[path.resolve(renameLog)]).toBe(fs.statSync(renameLog).size);

    fs.writeFileSync(source, sourceText);
    await bridge.poll();
    expect(fs.readFileSync(source, 'utf8')).toBe(sourceText);

    fs.appendFileSync(renameLog, '不是 json\n');
    fs.appendFileSync(renameLog, `${JSON.stringify({ from: '项目/旧名.md', to: '归档/最终.md', ts: '2026-10-19T01:00:00.000Z' })}\n`);
    await bridge.poll();
    expect(fs.readFileSync(source, 'utf8')).toContain('[[归档/最终#^kb-c3d4e5|这三家]]');
    expect(fs.readFileSync(path.join(notes, '旧名.md'), 'utf8')).toBe('原名还在\n');

    const appended = core.appendCloseRecord({
      vaultRoot: vault,
      record: { relayRel, reason: 'close', ts: '2026-10-19T02:00:00.000Z' },
    });
    expect(appended.appended).toBe(true);
    bridge.start();
    await bridge.poll();
    bridge.stop();
    expect(fs.existsSync(path.join(vault, relayRel))).toBe(false);
    expect(fs.readFileSync(stray, 'utf8')).toBe('不要删\n');
    expect(fs.readFileSync(source, 'utf8')).toContain('[[归档/最终#^kb-c3d4e5|这三家]]');
    expect(fs.readdirSync(notes).sort()).toEqual(beforeNames);
    expect(filesNamed(vault, 'obsidian.json')).toEqual([]);
    expect(filesNamed(userData, 'obsidian.json')).toEqual([]);
  });

  it('文件已经在库里时直接打开，不进中转清单', async () => {
    const home = tempDir('lkw-home2-');
    const userData = tempDir('lkw-ud2-');
    const vault = path.join(tempDir('lkw-relay2-'), 'Relay');
    const library = tempDir('lkw-lib-');
    fs.mkdirSync(path.join(library, '.obsidian'));
    fs.mkdirSync(path.join(library, '项目'));
    const source = path.join(library, '项目', '市场范围.md');
    fs.writeFileSync(source, '## 市场范围 ^kb-a1b2c3\n');
    const opened: string[] = [];
    const bridge = new ObsidianBridge({
      userDataDir: userData,
      env: { HOME: home, USERPROFILE: home },
      home,
      toolsDir: TOOLS,
      listRoots: async () => [],
      openExternal: async (uri) => {
        opened.push(uri);
      },
    });
    bridge.setVaultDir(vault);
    await bridge.initRelay();
    const result = await bridge.openInObsidian({ absPath: source, block: '不是块', heading: '## 市场范围 ^kb-a1b2c3' });
    expect(result).toMatchObject({ ok: true, via: 'vault' });
    const uri = new URL(result.uri || '');
    expect(uri.protocol).toBe('obsidian:');
    expect(uri.hostname).toBe('lkw-open');
    expect(uri.searchParams.get('vault')).toBe(path.basename(library));
    expect(uri.searchParams.get('path')).toBe('项目/市场范围.md');
    expect(uri.searchParams.get('block')).toBeNull();
    expect(uri.searchParams.get('heading')).toBe('市场范围');
    expect(opened).toEqual([result.uri]);
    const manifest = JSON.parse(fs.readFileSync(path.join(vault, 'relay', '.manifest.json'), 'utf8')) as { entries: unknown[] };
    expect(manifest.entries).toEqual([]);
    expect(fs.readFileSync(source, 'utf8')).toBe('## 市场范围 ^kb-a1b2c3\n');
  });

  it('正式用户库只留着原来的标记，设置写到别处', async () => {
    const local = tempDir('lkw-localapp-');
    const official = path.join(local, 'LocalKnowledgeWorkbench');
    fs.mkdirSync(official);
    fs.writeFileSync(path.join(official, 'keep.txt'), 'keep');
    const home = path.join(local, 'home');
    fs.mkdirSync(home);
    const env = { LOCALAPPDATA: local, USERPROFILE: home, HOME: home };
    const bridge = new ObsidianBridge({
      userDataDir: official,
      env,
      home,
      toolsDir: TOOLS,
      listRoots: async () => [],
      openExternal: async () => undefined,
    });
    const vault = path.join(tempDir('lkw-vault3-'), 'Relay');
    bridge.setVaultDir(vault);
    expect(fs.existsSync(path.join(home, '.lkw-obsidian-bridge', 'settings.json'))).toBe(true);
    expect(fs.readdirSync(official)).toEqual(['keep.txt']);
    const banned = path.join(official, '笔记.md');
    fs.writeFileSync(banned, '# x\n');
    const refused = await bridge.openInObsidian({ absPath: banned });
    expect(refused.ok).toBe(false);
    expect(refused.message).toContain('LocalKnowledgeWorkbench');
    expect(fs.readFileSync(path.join(official, 'keep.txt'), 'utf8')).toBe('keep');
  });
  it('普通库的改名记录只改这个库里的笔记，别的根不动', async () => {
    const home = tempDir('lkw-home4-');
    const userData = tempDir('lkw-ud4-');
    const vaultA = tempDir('lkw-vaultA-');
    fs.mkdirSync(path.join(vaultA, '.obsidian'));
    const inA = path.join(vaultA, '引用.md');
    fs.writeFileSync(inA, '见 [[项目/旧名]]\n');
    const other = tempDir('lkw-other-');
    const inOther = path.join(other, '别处.md');
    fs.writeFileSync(inOther, '见 [[项目/旧名]]\n');
    fs.mkdirSync(path.join(vaultA, 'lkw-exchange'));
    fs.writeFileSync(path.join(vaultA, 'lkw-exchange', 'rename-log.jsonl'), `${JSON.stringify({ from: '项目/旧名.md', to: '项目/新名.md', ts: '2026-10-19T00:00:00.000Z' })}\n`);
    const bridge = new ObsidianBridge({
      userDataDir: userData,
      env: { HOME: home, USERPROFILE: home },
      home,
      toolsDir: TOOLS,
      pollMs: 60_000,
      listRoots: async () => [{ path: vaultA, kind: 'folder' }, { path: other, kind: 'folder' }],
      openExternal: async () => undefined,
    });
    await bridge.poll();
    expect(bridge.getLastError()).toBe('');
    expect(fs.readFileSync(inA, 'utf8')).toBe('见 [[项目/新名]]\n');
    expect(fs.readFileSync(inOther, 'utf8')).toBe('见 [[项目/旧名]]\n');
  });
});
