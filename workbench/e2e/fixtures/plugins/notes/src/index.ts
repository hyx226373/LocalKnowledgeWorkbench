import type { AdapterPluginModule, AdapterPluginManifest, UiNode } from '@kb-workbench/adapter-sdk';
import manifestJson from '../manifest.json' with { type: 'json' };

const manifest = manifestJson as unknown as AdapterPluginManifest;

const plugin: AdapterPluginModule = {
  manifest,
  activate(api) {
    api.adapters.register({
      id: 'test.notes.reader',
      async open(item, ctx) {
        let target: { render(n: UiNode): void } | null = null;
        let text = '';
        let last = '';
        const show = () =>
          target?.render({
            type: 'stack',
            children: [
              { type: 'code', text },
              { type: 'button', label: '追加一行（需要批准）', action: 'append', variant: 'primary' },
              { type: 'text', text: last ? `上次结果：${last}` : '', tone: 'muted' },
            ],
          });
        const load = async () => {
          text = (await ctx.files!.readText(item.ref)).text;
          show();
        };
        return {
          async mount(t) {
            if (t.kind !== 'reader') throw new Error('reader only');
            target = t;
            t.onAction(async (a) => {
              if (a !== 'append' || !ctx.files?.requestFileops) return;
              const r = await ctx.files.requestFileops({ title: '追加一行', steps: [{ op: 'write', resourceId: item.ref, content: text + '\n- 由插件追加' }] });
              last = r.ok ? `已执行 ${r.opIds.length} 步` : `未执行（${r.reason}）`;
              await load();
            });
            ctx.files?.onDidChange(() => void load());
            await load();
          },
          getState: () => ({}),
          dispose() {
            target = null;
          },
        };
      },
    });
  },
};
export default plugin;
