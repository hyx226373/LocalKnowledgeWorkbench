/**
 * 恶意测试插件：打开 .evil 文件（JSON：{ targets: { otherRoot, wrongExt } }）后逐项尝试越权，
 * 把每项结果渲染成 keyValue（"blocked: …" 或 "LEAKED: …"）。e2e 断言没有任何 LEAKED，且宿主 DOM 中没有注入的元素。
 */
import type { AdapterPluginModule, AdapterPluginManifest, UiNode } from '@kb-workbench/adapter-sdk';
import manifestJson from '../manifest.json' with { type: 'json' };

const manifest = manifestJson as unknown as AdapterPluginManifest;
const short = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 120);

async function probe(name: string, f: () => Promise<string>): Promise<{ key: string; value: string }> {
  try {
    return { key: name, value: `LEAKED: ${(await f()).slice(0, 80)}` };
  } catch (e) {
    return { key: name, value: `blocked: ${short(e)}` };
  }
}
const loadImg = (src: string) =>
  new Promise<string>((res, rej) => {
    const img = new Image();
    img.onload = () => res(`loaded ${img.naturalWidth}x${img.naturalHeight}`);
    img.onerror = () => rej(new Error('image load failed'));
    img.src = src;
    setTimeout(() => rej(new Error('timeout')), 3000);
  });

const plugin: AdapterPluginModule = {
  manifest,
  activate(api) {
    api.adapters.register({
      id: 'test.evil.reader',
      restoreState: (): Record<string, never> | undefined => undefined,
      async open(item, ctx) {
        let target: { render(n: UiNode): void } | null = null;
        const rows: Array<{ key: string; value: string }> = [];
        const show = () =>
          target?.render({
            type: 'stack',
            children: [
              { type: 'heading', text: '<img src=x onerror="parent.__evilInjected=1">' },
              { type: 'text', text: '<b id="evil-b">bold?</b>' },
              { type: 'html', html: '<b id="evil-html">raw html</b>' } as unknown as UiNode,
              { type: 'keyValue', rows },
              { type: 'text', text: rows.some((r) => r.value.startsWith('LEAKED')) ? 'RESULT: LEAKED' : rows.length ? 'RESULT: ALL BLOCKED' : 'RESULT: running' },
            ],
          });
        return {
          async mount(t) {
            if (t.kind !== 'reader') throw new Error('reader only');
            target = t;
            show();
            const files = ctx.files!;
            const own = JSON.parse((await files.readText(item.ref)).text) as { targets: { otherRoot: string; wrongExt: string; otherRootUrl: string } };
            const tok = files.contentUrl(item.ref).split('/')[3];
            rows.push(await probe('读另一个根的文件', async () => (await files.readText(own.targets.otherRoot)).text));
            rows.push(await probe('读同根其他扩展名', async () => (await files.readText(own.targets.wrongExt)).text));
            rows.push(await probe('stat 另一个根', async () => JSON.stringify(await files.stat(own.targets.otherRoot))));
            rows.push(await probe('readBytes 另一个根', async () => String((await files.readBytes(own.targets.otherRoot)).length)));
            rows.push(await probe('fetch kbfile://res', async () => (await (await fetch(own.targets.otherRootUrl)).text())));
            rows.push(await probe('fetch kbfile://plugin 越界', async () => (await (await fetch(`kbfile://plugin/${tok}/${encodeURIComponent(own.targets.otherRoot)}`)).text())));
            rows.push(await probe('img kbfile://plugin 越界', () => loadImg(`kbfile://plugin/${tok}/${encodeURIComponent(own.targets.otherRoot)}`)));
            rows.push(await probe('img kbfile://res', () => loadImg(own.targets.otherRootUrl)));
            rows.push(await probe('伪造令牌', async () => (await (await fetch(`kbfile://plugin/forged/${encodeURIComponent(item.ref)}`)).text())));
            rows.push(await probe('fetch 外网', async () => (await (await fetch('https://example.com/')).text())));
            rows.push(await probe('parent.document', async () => String((parent as Window).document.title)));
            rows.push(await probe('top.location', async () => String((top as Window).location.href)));
            rows.push(await probe('window.kb', async () => (typeof (window as unknown as { kb?: unknown }).kb === 'undefined' ? Promise.reject(new Error('undefined')) : 'present')));
            rows.push(
              await probe('伪造宿主消息', async () => {
                parent.postMessage({ kb: 'kb-frame', type: 'rpc', id: 999, method: 'files.readText', params: { resourceId: own.targets.otherRoot, pluginId: 'example.json-viewer' } }, '*');
                await new Promise((r) => setTimeout(r, 300));
                throw new Error('身份字段被忽略（结果见上面的越界读取）');
              }),
            );
            show();
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
