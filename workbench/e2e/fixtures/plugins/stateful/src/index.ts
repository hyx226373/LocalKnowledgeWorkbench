/**
 * e2e 夹具：状态迁移。当前状态版本取自 manifest（e2e 构建 v1/v2/v3 三个版本）：
 *   v1 { count }  →  v2 { clicks }（有迁移步骤）  →  v3 { total }（故意没有 v2→v3 的迁移步骤 → 迁移失败）
 * 迁移失败时用 SDK migrateOrPreserve 原样保留旧状态（legacy 字段，随新状态一起保存）并在面板提示。
 */
import type { AdapterPluginModule, AdapterPluginManifest, JsonValue, PreservedLegacyState, UiNode } from '@kb-workbench/adapter-sdk';
import { asRecord, migrateOrPreserve } from '@kb-workbench/adapter-sdk/policy';
import manifestJson from '../manifest.json' with { type: 'json' };

const manifest = manifestJson as unknown as AdapterPluginManifest;
const CUR = manifest.contributes.adapters[0]!.stateSchemaVersion;
const KEY: Record<number, string> = { 1: 'count', 2: 'clicks', 3: 'total' };
type S = { n: number; legacy?: PreservedLegacyState };
const STEPS: Record<number, (d: any) => unknown> = { 1: (d) => (typeof d?.count === 'number' ? { clicks: d.count } : undefined) };

function restore(data: unknown, v: number): S {
  const { state, preserved } = migrateOrPreserve<unknown>(data, v, CUR, STEPS, () => ({ [KEY[CUR]!]: 0 }));
  const r = asRecord(state) ?? {};
  const n = typeof r[KEY[CUR]!] === 'number' ? (r[KEY[CUR]!] as number) : 0;
  const old = asRecord(r.legacy);
  const legacy = preserved ?? (old && typeof old.v === 'number' ? ({ v: old.v, data: old.data as JsonValue, error: String(old.error ?? '') } as PreservedLegacyState) : undefined);
  return { n, ...(legacy ? { legacy } : {}) };
}

const plugin: AdapterPluginModule = {
  manifest,
  activate(api) {
    api.adapters.register<S>({
      id: 'test.stateful.reader',
      restoreState: (data, v) => restore(data, v),
      async open(_item, ctx) {
        let s: S = ctx.restoredState ?? { n: 0 };
        let target: { render(n: UiNode): void } | null = null;
        const show = () => {
          const kids: UiNode[] = [{ type: 'heading', text: `版本 v${CUR} · 计数 ${s.n}`, level: 3 }, { type: 'button', label: '+1', action: 'inc', variant: 'primary' }];
          if (s.legacy) kids.push({ type: 'notice', tone: 'warning', title: '旧版本的视图状态无法迁移，已原样保留（没有丢失）', message: `v${s.legacy.v}：${s.legacy.error}` });
          target?.render({ type: 'stack', children: kids });
        };
        return {
          async mount(t) {
            if (t.kind !== 'reader') throw new Error('reader only');
            target = t;
            t.onAction((a) => {
              if (a !== 'inc') return;
              s = { ...s, n: s.n + 1 };
              ctx.requestSave();
              show();
            });
            show();
          },
          getState: () => ({ [KEY[CUR]!]: s.n, ...(s.legacy ? { legacy: s.legacy } : {}) }) as unknown as S,
          dispose() {
            target = null;
          },
        };
      },
    });
  },
};
export default plugin;
