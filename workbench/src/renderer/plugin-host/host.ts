/**
 * 插件宿主（渲染进程内）。
 *  - 内置插件（工作台、内置阅读器、内置示例、主题包）在渲染进程中激活，拿到 PluginApi；权限视为已授予。
 *  - 第三方插件只有沙箱适配器插件（SDK AdapterPluginManifest，开发者模式安装，D7）：
 *    这里只登记它们的声明式适配器（用于“打开方式”/优先级/占位原因）、缓存授权并弹出授权对话框；
 *    代码运行在每个面板自己的 <iframe sandbox="allow-scripts">（SandboxFrame），所有文件访问在主进程按授权再查一次。
 * 主题包只含数据（令牌 + 受限 CSS + 布局预设 JSON），没有可执行代码。
 */
import type { ComponentType } from 'react';
import { checkDisplayMode } from './layoutModel';
import { kb } from '../kb';
import { kbfileResUrl, kbfileRootUrl, type Root } from '../../shared/types';
import { adapters, chromeThemes, commands, layoutPresets, panels, readingThemes } from './registry';
import { registerConsoleBlock } from '../console/blockContext';
import { validateManifest } from './manifest';
export { validateManifest };
import { HOST_API_VERSION, type AdapterProps, type Disposable, type PluginApi, type PluginManifest, type PluginModule } from './types';
import type { AdapterPluginDto } from '../../shared/pluginIpc';
import type { AdapterContribution, PermissionDecl, PermissionGrant, PermissionPromptAnswer, PermissionPromptRequest } from '../../shared/adapter-sdk/types';
import { describePermission, isAskPerSite, matchUrlPattern, siteHostOf } from '../../shared/adapter-sdk/policy';
import { netDecl } from '../../shared/webPanel';
import { findGrant, grantDecision, upsertGrant, type GrantDecision } from '../../shared/grants';

export type PluginStatus = 'active' | 'disabled' | 'incompatible' | 'error' | 'denied';

export interface PluginRecord {
  manifest: PluginManifest;
  source: 'builtin' | 'user';
  kind: 'code' | 'theme' | 'sandbox';
  status: PluginStatus;
  message?: string;
  /** 内置示例插件与第三方插件可禁用；工作台核心与内置阅读器不可禁用 */
  canDisable: boolean;
}

export interface PluginEntry {
  module: PluginModule;
  source: 'builtin' | 'user';
  kind?: 'code' | 'theme';
  canDisable?: boolean;
  /** 预检失败（例如主题包校验错误）：登记为不兼容，不激活 */
  preflightError?: string;
}

export interface AdapterPermissionPrompt extends PermissionPromptRequest {
  roots: Root[];
  /** 触发询问的文件所在根（标注“当前文件所在”） */
  suggestRootId?: string;
  /** 默认勾选的根（已授权的根，或当前文件所在的根） */
  preselectRootIds?: string[];
}

class PluginHost {
  private records = new Map<string, PluginRecord>();
  private modules = new Map<string, PluginModule>();
  private disposables = new Map<string, Disposable[]>();
  private listeners = new Set<() => void>();
  private apis = new Map<string, PluginApi>();
  /** 适配器 id → 声明它的插件（来自 manifest，插件禁用后依然可查，用于占位原因） */
  private adapterOwners = new Map<string, string>();
  /** 第三方沙箱插件（主进程列表的快照，含授权） */
  private sandboxed = new Map<string, AdapterPluginDto>();
  private inflightPrompts = new Map<string, Promise<GrantDecision>>();
  /** 沙箱适配器面板组件（由 App 注入，避免循环依赖） */
  sandboxComponent: ComponentType<AdapterProps<unknown>> = () => null;
  /** 授权对话框（App 注入应用内对话框；测试中可替换）。默认拒绝。 */
  askAdapterPermission: (req: AdapterPermissionPrompt) => Promise<PermissionPromptAnswer> = async () => 'deny';

  private snapshot: PluginRecord[] = [];
  private version = 0;
  /** 返回稳定快照（供 useSyncExternalStore 使用） */
  list(): PluginRecord[] {
    return this.snapshot;
  }
  getVersion() {
    return this.version;
  }
  get(id: string) {
    return this.records.get(id);
  }
  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private changed() {
    this.version++;
    this.snapshot = [...this.records.values()].map((r) => ({ ...r }));
    for (const l of this.listeners) l();
  }

  /** 某适配器的提供者插件状态（未声明 → undefined） */
  adapterOwnerStatus(adapterId: string): PluginStatus | undefined {
    const owner = this.adapterOwners.get(adapterId);
    return owner ? this.records.get(owner)?.status : undefined;
  }
  adapterOwner(adapterId: string) {
    const owner = this.adapterOwners.get(adapterId);
    return owner ? this.records.get(owner) : undefined;
  }

  async load(mods: PluginEntry[]) {
    for (const { module, source, kind = 'code', preflightError, canDisable } of mods) {
      const m = module.manifest;
      for (const a of m?.contributes?.adapters ?? []) this.adapterOwners.set(a.id, m.id);
      for (const v of m?.contributes?.views ?? []) this.adapterOwners.set(v.id, m.id);
      if (kind === 'theme' && m?.id && (this.modules.has(m.id) || this.records.has(m.id))) await this.dropLoaded(m.id);
      const err = preflightError ?? validateManifest(m, HOST_API_VERSION, source, kind === 'theme' ? 'theme' : 'code');
      const can = canDisable ?? (kind === 'code' && !['builtin.workbench', 'builtin.readers'].includes(m?.id));
      if (err) {
        this.records.set(m?.id ?? `invalid-${this.records.size}`, { manifest: m, source, kind, status: 'incompatible', message: err, canDisable: false });
        continue;
      }
      if (this.modules.has(m.id) || this.sandboxed.has(m.id)) {
        this.records.set(`${m.id}#dup`, { manifest: m, source, kind, status: 'incompatible', message: `插件 id 重复：${m.id}`, canDisable: false });
        continue;
      }
      this.modules.set(m.id, module);
      const st = await kb.registerPlugin(m.id, m.version, source);
      const rec: PluginRecord = { manifest: m, source, kind, status: 'disabled', canDisable: can };
      this.records.set(m.id, rec);
      if (st.enabled || !can) await this.activate(m.id);
    }
    this.changed();
  }

  async activate(id: string) {
    const rec = this.records.get(id);
    const mod = this.modules.get(id);
    if (!rec || !mod) return;
    const api = this.createApi(rec);
    this.apis.set(id, api);
    try {
      await mod.activate(api);
      rec.status = 'active';
      rec.message = undefined;
    } catch (e) {
      // 崩溃隔离：激活失败只影响该插件，撤销它已注册的贡献
      this.cleanup(id);
      rec.status = 'error';
      rec.message = String((e as Error)?.message ?? e);
    }
    this.changed();
  }

  /** 重复安装主题包时卸掉旧模块、注册项和记录，再装新的。 */
  private async dropLoaded(id: string): Promise<void> {
    try {
      await this.modules.get(id)?.deactivate?.();
    } catch {
      /* 卸掉失败也要清注册 */
    }
    this.cleanup(id);
    this.modules.delete(id);
    this.apis.delete(id);
    this.records.delete(id);
    for (const [adapterId, owner] of [...this.adapterOwners]) if (owner === id) this.adapterOwners.delete(adapterId);
  }

  private cleanup(id: string) {
    for (const d of this.disposables.get(id) ?? []) {
      try {
        d.dispose();
      } catch {
        /* ignore */
      }
    }
    this.disposables.delete(id);
    for (const r of [adapters, panels, commands, chromeThemes, readingThemes, layoutPresets]) r.unregisterOwner(id);
  }

  /** 视图组件拿到的 api 来自注册它的插件 */
  apiFor(id: string): PluginApi {
    const a = this.apis.get(id);
    if (!a) throw new Error(`插件未激活: ${id}`);
    return a;
  }

  async setEnabled(id: string, enabled: boolean) {
    const rec = this.records.get(id);
    if (!rec) return;
    if (rec.kind === 'sandbox') {
      await kb.setAdapterPluginEnabled(id, enabled);
      return this.reloadSandboxed();
    }
    if (!rec.canDisable && !enabled) return;
    await kb.setPluginEnabled(id, enabled);
    if (enabled) return this.activate(id);
    try {
      await this.modules.get(id)?.deactivate?.();
    } catch {
      /* 停用失败也要清理 */
    }
    this.cleanup(id);
    rec.status = 'disabled';
    this.changed();
  }

  // ---------------------------------------------------------------- 第三方沙箱适配器插件

  sandboxPlugin(id: string): AdapterPluginDto | undefined {
    return this.sandboxed.get(id);
  }
  sandboxPlugins(): AdapterPluginDto[] {
    return [...this.sandboxed.values()];
  }

  async reloadSandboxed() {
    this.loadSandboxed(await kb.listAdapterPlugins());
  }

  /** 用主进程的插件列表（重新）登记沙箱插件：只登记声明式适配器，不执行插件代码 */
  loadSandboxed(dtos: AdapterPluginDto[]) {
    const ids = new Set(dtos.map((d) => d.id));
    for (const old of [...this.sandboxed.keys()]) {
      if (ids.has(old)) continue;
      this.cleanup(old);
      this.records.delete(old);
      this.sandboxed.delete(old);
      for (const [a, o] of [...this.adapterOwners]) if (o === old) this.adapterOwners.delete(a);
    }
    for (const d of dtos) {
      this.cleanup(d.id);
      this.sandboxed.set(d.id, d);
      const m = d.manifest;
      const manifest: PluginManifest = { id: d.id, name: d.name, version: d.version, engines: { workbench: m?.engines?.workbench ?? '' }, description: m?.description };
      for (const a of m?.contributes?.adapters ?? []) this.adapterOwners.set(a.id, d.id);
      const status: PluginStatus = d.errors.length ? 'incompatible' : d.enabled ? 'active' : 'disabled';
      // r11-A：随应用内置的适配器（web.generic）记为 builtin（不可卸载、可禁用）
      this.records.set(d.id, { manifest, source: d.source === 'builtin' ? 'builtin' : 'user', kind: 'sandbox', status, message: d.errors.join('；') || undefined, canDisable: !d.errors.length });
      if (status !== 'active' || !m) continue;
      for (const a of m.contributes.adapters) {
        const honest = checkDisplayMode(a.id, a.sourceKinds, a.displayMode);
        if (honest) continue;
        const f = a.match.file;
        const w = a.match.web;
        const prio = Math.min(200, a.match.priority ?? 50);
        const contrib = {
          id: a.id,
          title: a.title,
          sourceKinds: a.sourceKinds,
          displayMode: a.displayMode,
          stateSchemaVersion: a.stateSchemaVersion,
          match: (t: Parameters<NonNullable<typeof adapters.best>>[0]) => {
            // 网页：URL 模式（主机必须在 net 域名内，安装校验已保证）
            if (t.sourceKind === 'web') {
              if (w?.urlPatterns?.some((p) => matchUrlPattern(t.url, p))) return prio;
              // r11-A：内置逐站授权网页适配器（web.generic）是任意 http(s) 网址的回退（优先级 1）
              return d.source === 'builtin' && isAskPerSite(netDecl(a)) && siteHostOf(t.url) ? Math.min(prio, 1) || 1 : 0;
            }
            if (t.sourceKind !== 'file' || !f || t.resource.kind !== 'file') return 0;
            if (f.extensions?.length && !f.extensions.includes(t.resource.ext.toLowerCase())) return 0;
            if (f.maxSizeBytes && t.resource.size > f.maxSizeBytes) return 0;
            return prio;
          },
          component: this.sandboxComponent,
          sandbox: { pluginId: d.id, pluginName: d.name, decl: a },
        };
        try {
          const disp = adapters.register(d.id, contrib);
          this.disposables.set(d.id, [...(this.disposables.get(d.id) ?? []), disp]);
        } catch (e) {
          const rec = this.records.get(d.id)!;
          rec.status = 'incompatible';
          rec.message = String((e as Error).message);
        }
      }
    }
    this.changed();
  }

  grantsOf(pluginId: string): PermissionGrant[] {
    return this.sandboxed.get(pluginId)?.grants ?? [];
  }
  decision(pluginId: string, adapterId: string, perm: PermissionDecl): GrantDecision {
    return grantDecision(this.grantsOf(pluginId), pluginId, adapterId, perm).decision;
  }
  /** r11-A：主进程返回的授权记录（逐站批准 / 撤销）写回缓存 */
  applyGrant(g: PermissionGrant | null | undefined) {
    if (g) this.storeGrant(g);
  }
  private storeGrant(g: PermissionGrant) {
    const d = this.sandboxed.get(g.pluginId);
    if (!d) return;
    this.sandboxed.set(g.pluginId, { ...d, grants: upsertGrant(d.grants, g) });
    this.changed();
  }

  /**
   * 首次打开使用该适配器的条目时询问（同一权限同时只弹一次）；已有记录则直接返回。
   * force：插件管理页“改为允许/更改文件夹”时重新询问。
   */
  async ensurePermission(pluginId: string, adapter: AdapterContribution, perm: PermissionDecl, force = false, suggestRootId?: string): Promise<GrantDecision> {
    if (!force) {
      const cur = this.decision(pluginId, adapter.id, perm);
      if (cur !== 'prompt') return cur;
    }
    const key = `${pluginId}|${adapter.id}|${perm.id}`;
    const inflight = this.inflightPrompts.get(key);
    if (inflight) return inflight;
    const p = (async (): Promise<GrantDecision> => {
      const dto = this.sandboxed.get(pluginId);
      const roots = await kb.listRoots();
      const prev = findGrant(this.grantsOf(pluginId), pluginId, adapter.id, perm.id);
      const preselect = prev?.decision === 'granted' && Array.isArray(prev.rootIds) ? prev.rootIds : suggestRootId ? [suggestRootId] : [];
      const answer = await this.askAdapterPermission({
        pluginId,
        pluginName: dto?.name ?? pluginId,
        adapterId: adapter.id,
        adapterTitle: adapter.title,
        displayMode: adapter.displayMode,
        permission: perm,
        scopeLines: describePermission(perm),
        roots,
        suggestRootId,
        preselectRootIds: preselect,
      });
      const granted = answer !== 'deny';
      const g = await kb.setPermissionGrant({
        pluginId,
        adapterId: adapter.id,
        permissionId: perm.id,
        decision: granted ? 'granted' : 'denied',
        ...(typeof answer === 'object' ? { rootIds: answer.rootIds } : granted && perm.kind === 'fs.read' && perm.scope === 'ask-per-root' ? { rootIds: roots.map((r) => r.id) } : {}),
      });
      this.storeGrant(g);
      return g.decision;
    })().finally(() => this.inflightPrompts.delete(key));
    this.inflightPrompts.set(key, p);
    return p;
  }

  async revoke(pluginId: string, adapterId: string, permissionId: string) {
    const g = await kb.revokePermission(pluginId, adapterId, permissionId);
    this.storeGrant(g);
  }

  private createApi(rec: PluginRecord): PluginApi {
    const id = rec.manifest.id;
    const track = (d: Disposable) => {
      const list = this.disposables.get(id) ?? [];
      list.push(d);
      this.disposables.set(id, list);
      return d;
    };
    return {
      pluginId: id,
      hostVersion: HOST_API_VERSION,
      adapters: {
        register: (a) => {
          const honest = checkDisplayMode(a.id, a.sourceKinds, a.displayMode);
          if (honest) throw new Error(honest);
          this.adapterOwners.set(a.id, id);
          return track(adapters.register(id, a));
        },
      },
      views: {
        // 0.1 写法的兼容层：只处理文件
        register: (v) => {
          this.adapterOwners.set(v.id, id);
          return track(
            adapters.register(id, {
              id: v.id,
              title: v.title,
              sourceKinds: ['file'],
              displayMode: 'in-app-reader',
              match: (t) => (t.sourceKind === 'file' ? v.match(t.resource) : 0),
              component: v.component,
              serializeState: v.serializeState,
              restoreState: v.restoreState,
            }),
          );
        },
      },
      panels: { register: (p) => track(panels.register(id, p)) },
      commands: {
        register: (c) => track(commands.register(id, c)),
        execute: async (cid, ...args) => {
          const c = commands.get(cid);
          if (!c) throw new Error(`命令不存在: ${cid}`);
          return c.run(...args);
        },
      },
      consoleBlocks: {
        register: (c) => track(registerConsoleBlock(id, c)),
      },
      themes: {
        registerChrome: (t) => track(chromeThemes.register(id, t)),
        registerReading: (t) => track(readingThemes.register(id, t)),
        registerLayoutPreset: (p) => track(layoutPresets.register(id, p)),
      },
      workspace: {
        readText: async (rid) => kb.readText(rid),
        fileUrl: (r) => kbfileResUrl(r.resourceId, r.name),
        rootFileUrl: (rootId, rel) => kbfileRootUrl(rootId, rel),
        showInFolder: async (rid) => kb.showInFolder(rid),
        onDidChangeFile: (rid, cb) => track(fileChanges.subscribe(rid, cb)),
        ...(rec.source === 'builtin'
          ? {
              textEdit: {
                open: (rid) => kb.textOpen(rid),
                stat: (rid) => kb.textStat(rid),
                previewSave: (rid, text, base) => kb.textPreviewSave(rid, text, base),
                save: (rid, text, base) => kb.textSave(rid, text, base),
                history: (rid) => kb.textHistory(rid),
                undoLastSave: (rid, force) => kb.textUndoLastSave(rid, force),
              },
            }
          : {}),
      },
      storage: {
        get: async <T,>(key: string) => (await kb.pluginStorageGet(id, key)) as T | null,
        set: (key, value) => kb.pluginStorageSet(id, key, value),
      },
    };
  }
}

/**
 * 文件内容变化的订阅：主进程 fs-change 只带根 + 相对路径（文件可能已被改名），
 * 所以收到变化后按资源 ID 查一次内容哈希，只有哈希变了才通知订阅者。
 */
class FileChangeHub {
  private subs = new Map<string, Set<() => void>>();
  private hashes = new Map<string, string>();
  private off: (() => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  subscribe(rid: string, cb: () => void): Disposable {
    let set = this.subs.get(rid);
    if (!set) {
      set = new Set();
      this.subs.set(rid, set);
      void kb.textStat(rid).then((s) => this.hashes.set(rid, s.hash), () => {});
    }
    set.add(cb);
    if (!this.off) this.off = kb.onFsChange(() => this.kick());
    return {
      dispose: () => {
        set!.delete(cb);
        if (!set!.size) {
          this.subs.delete(rid);
          this.hashes.delete(rid);
        }
      },
    };
  }
  /** 本进程刚写完（保存/撤销）后立即通知其他订阅者，不等文件监听 */
  kick() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.check(), 120);
  }
  private async check() {
    for (const [rid, set] of this.subs) {
      let h: string;
      try {
        h = (await kb.textStat(rid)).hash;
      } catch {
        continue;
      }
      if (this.hashes.get(rid) === h) continue;
      this.hashes.set(rid, h);
      for (const cb of [...set]) cb();
    }
  }
}
export const fileChanges = new FileChangeHub();

export const pluginHost = new PluginHost();
