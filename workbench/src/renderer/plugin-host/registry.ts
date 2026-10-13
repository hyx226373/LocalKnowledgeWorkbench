import { clearActionPackage, registerActions } from '../../shared/actions/registry';
import { installActionPackages } from '../../shared/actions/install';
import type {
  AdapterContribution,
  AdapterTarget,
  ChromeThemeContribution,
  CommandContribution,
  ConsoleBlockContribution,
  Disposable,
  LayoutPresetContribution,
  PanelContribution,
  ReadingThemeContribution,
} from './types';

installActionPackages();

export type Owned<T> = T & { owner: string };

/** 通用注册表：按 id 唯一，记录归属插件，变化时通知订阅者 */
export class Registry<T extends { id: string }> {
  private items = new Map<string, Owned<T>>();
  private listeners = new Set<() => void>();
  private version = 0;

  register(owner: string, item: T): Disposable {
    if (this.items.has(item.id)) throw new Error(`重复注册: ${item.id}（已由 ${this.items.get(item.id)!.owner} 注册）`);
    this.items.set(item.id, { ...item, owner });
    this.changed();
    return { dispose: () => this.unregister(item.id) };
  }
  unregister(id: string) {
    if (this.items.delete(id)) this.changed();
  }
  unregisterOwner(owner: string) {
    let n = 0;
    for (const [id, it] of this.items) if (it.owner === owner) (this.items.delete(id), n++);
    if (n) this.changed();
  }
  get(id: string): Owned<T> | undefined {
    return this.items.get(id);
  }
  all(): Owned<T>[] {
    return [...this.items.values()];
  }
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  getVersion() {
    return this.version;
  }
  private changed() {
    this.version++;
    for (const l of this.listeners) l();
  }
}

export class AdapterRegistry extends Registry<AdapterContribution<any>> {
  /** 按优先级排序返回能显示该目标的适配器（异常的 match 视为 0，避免一个插件拖垮全部） */
  resolve(target: AdapterTarget): Owned<AdapterContribution<any>>[] {
    const scored: { v: Owned<AdapterContribution<any>>; p: number }[] = [];
    for (const v of this.all()) {
      if (!v.sourceKinds.includes(target.sourceKind)) continue;
      let p = 0;
      try {
        p = Number(v.match(target)) || 0;
      } catch {
        p = 0;
      }
      if (p > 0) scored.push({ v, p });
    }
    return scored.sort((a, b) => b.p - a.p || a.v.id.localeCompare(b.v.id)).map((x) => x.v);
  }
  best(target: AdapterTarget) {
    return this.resolve(target)[0];
  }
}

export const adapters = new AdapterRegistry();
/** @deprecated 旧名 */
export const views = adapters;
export const panels = new Registry<PanelContribution>();

/** 命令登记同时写入共享操作表。trigger:'wheel' 原样收下，不改成键盘加速键。 */
class CommandRegistry extends Registry<CommandContribution> {
  override register(owner: string, item: CommandContribution): Disposable {
    const inner = super.register(owner, item);
    const undoCatalog = registerActions(owner, [item]);
    return {
      dispose: () => {
        undoCatalog();
        inner.dispose();
      },
    };
  }
  override unregisterOwner(owner: string) {
    super.unregisterOwner(owner);
    clearActionPackage(owner);
  }
}

export const commands = new CommandRegistry();
/** id = kind */
export const consoleBlockRegistry = new Registry<ConsoleBlockContribution & { id: string }>();
export const chromeThemes = new Registry<ChromeThemeContribution>();
export const readingThemes = new Registry<ReadingThemeContribution>();
export const layoutPresets = new Registry<LayoutPresetContribution>();
