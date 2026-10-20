/**
 * Obsidian 桥的主进程侧。
 * 打开文件时直接 import relay-core，不另起 node 进程。
 * 清理只调用 cleanupClosed，它只删中转清单里登记过的临时链接。
 * 改名日志的读取偏移写在工作台自己的数据目录，不写 obsidian.json。
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseRenameLines, takeCompleteLines } from '../../shared/obsidianBridge/jsonl';
import { cleanBlockParam, cleanHeadingParam } from '../../shared/obsidianBridge/target';
import type { ObsidianBridgeSettings, ObsidianInitResult, ObsidianOpenRequest, ObsidianOpenResult } from '../../shared/obsidianBridge/types';
import { JUNCTION_WARNING } from '../../shared/obsidianBridge/types';
import { rewriteWikilinks } from '../../shared/obsidianBridge/wikilink';
import {
  assertRelayVaultDir,
  bridgeStateDir,
  classifyMarkdownOpen,
  defaultRelayVaultDir,
  exchangeDirName,
  findVaultForFile,
  isInside,
  isOfficialWorkbenchData,
  officialWorkbenchDataDir,
  readJunctionFlag,
  resolveBridgeToolsDir,
} from '../../shared/obsidianBridge/vault';
import { collectWorkbenchMarkdown, type WorkbenchRoot } from './files';

interface RelayCore {
  defaultVaultDir(env?: NodeJS.ProcessEnv, home?: string): string;
  initRelayVault(opts: { vaultRoot: string; pluginSourceDir?: string }): {
    vaultRoot: string;
    pluginInstalled: boolean;
    instructions: string;
  };
  openRelayFromSettings(opts: { vaultRoot: string; source: string; mode?: string }): { relayRel: string };
  cleanupClosed(opts: { vaultRoot: string; exchangeDir?: string }): {
    removed: string[];
    skipped: string[];
    refused: { relayRel: string; reason: string }[];
    conflictsKept: string[];
  };
  readCrossVolumeJunction(vaultRoot: string): boolean;
}

interface MakeUri {
  buildOpenUri(input: { vault: string; path: string; block?: string; heading?: string }): string;
}

interface Tools {
  toolsDir: string;
  core: RelayCore;
  uri: MakeUri;
}

export interface ObsidianBridgeOptions {
  userDataDir: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
  /** 返回 null 表示工作台的根还没准备好，这次不推进改名偏移。空数组表示确实没有根。 */
  listRoots?: () => Promise<WorkbenchRoot[] | null>;
  openExternal?: (uri: string) => Promise<void>;
  toolsDir?: string;
  pollMs?: number;
}

interface CursorFile {
  files: Record<string, number>;
}

interface SettingsFile {
  relayVaultDir?: string;
}

export class ObsidianBridge {
  private readonly env: NodeJS.ProcessEnv;
  private readonly home: string;
  private readonly stateDir: string;
  private readonly listRoots: () => Promise<WorkbenchRoot[] | null>;
  private readonly openExternal: (uri: string) => Promise<void>;
  private readonly toolsDirOverride: string;
  private readonly pollMs: number;
  private toolsPromise: Promise<Tools> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private tail: Promise<void> = Promise.resolve();
  private pending = false;
  private lastError = '';

  constructor(opts: ObsidianBridgeOptions) {
    this.env = opts.env ?? process.env;
    this.home = opts.home || this.env.USERPROFILE || this.env.HOME || '';
    this.stateDir = bridgeStateDir(opts.userDataDir, this.env);
    this.listRoots = opts.listRoots ?? (async () => []);
    this.openExternal = opts.openExternal ?? (async () => undefined);
    this.toolsDirOverride = opts.toolsDir ?? '';
    this.pollMs = opts.pollMs ?? 1000;
  }

  start(): void {
    void this.poll();
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.poll();
    }, this.pollMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  getLastError(): string {
    return this.lastError;
  }

  /** 串行扫关闭记录和改名日志。启动时也会走这里。 */
  poll(): Promise<void> {
    if (this.pending) return this.tail;
    this.pending = true;
    this.tail = this.tail
      .then(() => this.pollOnce())
      .catch((err: unknown) => {
        this.lastError = err instanceof Error ? err.message : String(err);
      })
      .then(() => {
        this.pending = false;
      });
    return this.tail;
  }

  private async pollOnce(): Promise<void> {
    await this.sweepClosed();
    await this.consumeRenames();
    this.lastError = '';
  }

  getSettings(): ObsidianBridgeSettings {
    const stored = this.readSettings();
    const custom = (stored.relayVaultDir ?? '').trim();
    const fallback = defaultRelayVaultDir(this.env, this.home);
    const relayVaultDir = custom ? path.resolve(custom) : fallback;
    const flag = this.readJunction(relayVaultDir);
    return {
      relayVaultDir,
      defaultRelayVaultDir: fallback,
      usingDefault: !custom,
      crossVolumeJunction: flag,
      vaultReady: this.isDirectory(path.join(relayVaultDir, '.obsidian')),
      warning: flag ? JUNCTION_WARNING : '',
      bundledPlugin: this.readBundledPlugin(),
    };
  }

  setVaultDir(dir: unknown): ObsidianBridgeSettings {
    const text = dir == null ? '' : String(dir).trim();
    if (!text) {
      this.writeSettings({});
      return this.getSettings();
    }
    const resolved = assertRelayVaultDir(text, this.env);
    if (isOfficialWorkbenchData(this.stateDir, this.env)) throw new Error('拒绝写入 LocalKnowledgeWorkbench 正式用户库');
    this.writeSettings({ relayVaultDir: resolved });
    return this.getSettings();
  }

  async initRelay(): Promise<ObsidianInitResult> {
    try {
      const vaultRoot = assertRelayVaultDir(this.getSettings().relayVaultDir, this.env);
      const tools = await this.loadTools();
      const pluginSourceDir = path.resolve(tools.toolsDir, '..');
      const created = tools.core.initRelayVault({ vaultRoot, pluginSourceDir });
      return {
        ok: true,
        vaultRoot: created.vaultRoot,
        pluginInstalled: created.pluginInstalled,
        instructions: created.instructions,
      };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  async setJunction(enabled: boolean): Promise<ObsidianBridgeSettings> {
    const vaultRoot = assertRelayVaultDir(this.getSettings().relayVaultDir, this.env);
    const dataFile = pluginDataFile(vaultRoot);
    if (path.basename(dataFile).toLowerCase() === 'obsidian.json') throw new Error('拒绝写入 obsidian.json');
    if (!this.isDirectory(path.dirname(dataFile))) throw new Error('请先初始化中转库，再设置跨盘联接');
    let current = readJsonObject(dataFile);
    if (fs.existsSync(dataFile) && !current) throw new Error('工作台桥的 data.json 不是合法 JSON，没有改它');
    current = current ?? { exchangeDir: 'lkw-exchange', highlight: true };
    current.crossVolumeJunction = enabled === true;
    fs.mkdirSync(path.dirname(dataFile), { recursive: true });
    fs.writeFileSync(dataFile, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
    return this.getSettings();
  }

  async openInObsidian(req: ObsidianOpenRequest): Promise<ObsidianOpenResult> {
    try {
      const abs = path.resolve(String(req?.absPath ?? ''));
      let stat: fs.Stats;
      try {
        stat = fs.statSync(abs);
      } catch {
        return { ok: false, message: '原文件不存在' };
      }
      if (!stat.isFile()) return { ok: false, message: '原文件不存在或不是文件' };
      const classified = classifyMarkdownOpen(abs, this.env, (dir) => this.isDirectory(dir));
      if (classified.kind === 'refuse') return { ok: false, message: classified.message };
      const block = cleanBlockParam(req?.block);
      const heading = cleanHeadingParam(req?.heading);
      const tools = await this.loadTools();
      const target = {
        ...(block ? { block } : {}),
        ...(heading ? { heading } : {}),
      };
      let uri = '';
      let via: 'vault' | 'relay' = 'vault';
      if (classified.kind === 'vault') {
        uri = tools.uri.buildOpenUri({ vault: classified.hit.vaultName, path: classified.hit.relPath, ...target });
        via = 'vault';
      } else {
        const vaultRoot = assertRelayVaultDir(this.getSettings().relayVaultDir, this.env);
        // 不传 mode：同卷/跨卷怎么处理由中转库 data.json 的 crossVolumeJunction 决定（默认关）。
        const opened = tools.core.openRelayFromSettings({ vaultRoot, source: abs });
        uri = tools.uri.buildOpenUri({ vault: path.basename(vaultRoot), path: opened.relayRel, ...target });
        via = 'relay';
      }
      if (!uri.startsWith('obsidian://lkw-open?')) return { ok: false, message: '生成的链接不是 lkw-open' };
      await this.openExternal(uri);
      return { ok: true, uri, via };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  private async sweepClosed(): Promise<void> {
    const vaultRoot = this.getSettings().relayVaultDir;
    if (!this.isDirectory(path.join(vaultRoot, '.obsidian'))) return;
    const tools = await this.loadTools();
    tools.core.cleanupClosed({ vaultRoot, exchangeDir: this.exchangeName(vaultRoot) });
  }

  private async consumeRenames(): Promise<void> {
    const roots = await this.listRoots();
    if (!roots) return;
    const forbidden = this.forbiddenDirs();
    // 只有日志里真有新记录时才去扫工作台的 md，避免每秒都遍历全部根。
    let cached: string[] | null = null;
    const files = (): string[] => (cached ??= collectWorkbenchMarkdown(roots, forbidden));
    const vaults = new Set<string>();
    const relay = this.getSettings().relayVaultDir;
    if (this.isDirectory(relay)) vaults.add(path.resolve(relay));
    for (const root of roots) {
      if (!root?.path) continue;
      const probe = this.isDirectory(root.path) ? path.join(root.path, 'note.md') : root.path;
      const hit = findVaultForFile(probe, (dir) => this.isDirectory(dir));
      if (hit && !isOfficialWorkbenchData(hit.vaultRoot, this.env)) vaults.add(hit.vaultRoot);
    }
    const relayRoot = path.resolve(relay);
    for (const vault of vaults) {
      const logFile = path.join(vault, this.exchangeName(vault), 'rename-log.jsonl');
      // 普通库的改名记录是相对这个库根的路径，只改这个库里的笔记，不波及别的根或别的库。
      const scoped = vault === relayRoot ? files : () => files().filter((file) => isInside(file, vault));
      this.consumeOneLog(logFile, scoped);
    }
  }

  private consumeOneLog(logFile: string, files: () => readonly string[]): void {
    if (!fs.existsSync(logFile) || !fs.statSync(logFile).isFile()) return;
    if (path.basename(logFile).toLowerCase() === 'obsidian.json') return;
    const buf = fs.readFileSync(logFile);
    const cursor = this.readCursor();
    const key = path.resolve(logFile);
    let offset = cursor.files[key] ?? 0;
    if (!Number.isFinite(offset) || offset < 0 || offset > buf.length) offset = 0;
    const taken = takeCompleteLines(buf, offset);
    const parsed = parseRenameLines(taken.lines);
    if (parsed.records.length) {
      for (const file of files()) {
        if (!fs.existsSync(file)) continue;
        const stat = fs.statSync(file);
        if (!stat.isFile() || stat.size > 8 * 1024 * 1024) continue;
        const before = fs.readFileSync(file, 'utf8');
        const next = rewriteWikilinks(before, parsed.records);
        if (next.text === before) continue;
        fs.writeFileSync(file, next.text, 'utf8');
      }
    }
    if (taken.nextOffset !== offset) {
      cursor.files[key] = taken.nextOffset;
      this.writeCursor(cursor);
    }
  }

  private exchangeName(vaultRoot: string): string {
    return exchangeDirName(readJsonObject(pluginDataFile(vaultRoot)));
  }

  private readJunction(vaultRoot: string): boolean {
    return readJunctionFlag(readJsonObject(pluginDataFile(vaultRoot)));
  }

  private forbiddenDirs(): string[] {
    const out = [this.stateDir];
    const official = officialWorkbenchDataDir(this.env);
    if (official) out.push(official);
    return out;
  }

  /** 安装包附带的 lkw-bridge：toolsDir 的上一级有 manifest.json。只读。 */
  private readBundledPlugin(): { id: string; version: string } | null {
    if (!this.toolsDirOverride) return null;
    const m = readJsonObject(path.join(path.resolve(this.toolsDirOverride), '..', 'manifest.json'));
    if (!m || typeof m.id !== 'string' || typeof m.version !== 'string') return null;
    return { id: m.id, version: m.version };
  }

  private async loadTools(): Promise<Tools> {
    if (!this.toolsPromise) {
      this.toolsPromise = this.importTools().catch((err: unknown) => {
        this.toolsPromise = null;
        throw err;
      });
    }
    return this.toolsPromise;
  }

  private async importTools(): Promise<Tools> {
    const toolsDir = this.toolsDirOverride
      ? path.resolve(this.toolsDirOverride)
      : resolveBridgeToolsDir(this.env, (file) => fs.existsSync(file));
    const core = (await importFile(path.join(toolsDir, 'relay-core.mjs'))) as RelayCore;
    const uri = (await importFile(path.join(toolsDir, 'make-uri.mjs'))) as MakeUri;
    if (typeof core.openRelayFromSettings !== 'function' || typeof core.cleanupClosed !== 'function') {
      throw new Error('relay-core 缺少打开或清理函数');
    }
    if (typeof uri.buildOpenUri !== 'function') throw new Error('make-uri 缺少 buildOpenUri');
    return { toolsDir, core, uri };
  }

  private settingsPath(): string {
    return path.join(this.stateDir, 'settings.json');
  }

  private cursorPath(): string {
    return path.join(this.stateDir, 'rename-cursor.json');
  }

  private readSettings(): SettingsFile {
    return (readJsonObject(this.settingsPath()) as SettingsFile | null) ?? {};
  }

  private writeSettings(body: SettingsFile): void {
    this.writeState(this.settingsPath(), body);
  }

  private readCursor(): CursorFile {
    const parsed = readJsonObject(this.cursorPath());
    const files = parsed && typeof parsed.files === 'object' && parsed.files && !Array.isArray(parsed.files)
      ? (parsed.files as Record<string, number>)
      : {};
    return { files: { ...files } };
  }

  private writeCursor(body: CursorFile): void {
    this.writeState(this.cursorPath(), body);
  }

  private writeState(file: string, body: unknown): void {
    if (path.basename(file).toLowerCase() === 'obsidian.json') throw new Error('拒绝写入 obsidian.json');
    if (isOfficialWorkbenchData(file, this.env)) throw new Error('拒绝写入 LocalKnowledgeWorkbench 正式用户库');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
  }

  private isDirectory(abs: string): boolean {
    try {
      return fs.statSync(abs).isDirectory();
    } catch {
      return false;
    }
  }
}

function pluginDataFile(vaultRoot: string): string {
  return path.join(path.resolve(vaultRoot), '.obsidian', 'plugins', 'lkw-bridge', 'data.json');
}

function readJsonObject(file: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function importFile(file: string): Promise<unknown> {
  // 路径是运行时才知道的。用变量 import()，esbuild 不会把插件 ESM 打进主进程包。
  // new Function 里的 import() 在 vitest 里没有动态导入回调，所以这里直接写。
  const href = pathToFileURL(file).href;
  return import(href);
}
