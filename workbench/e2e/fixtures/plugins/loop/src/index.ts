// 卡死测试插件：按文件内容表现异常，用来验证宿主的看门狗与逐次调用超时。
//   busy-open   打开时同步死循环（iframe 的事件循环被占满）
//   busy-action 正常显示；点按钮后同步死循环
//   hang-open   open() 返回永不完成的 Promise（异步挂起，不占 CPU）
//   flood       不停地发 render 消息
//   ok          正常显示一行文字（用于性能测量）
import type { AdapterPluginModule, AdapterPluginManifest } from '@kb-workbench/adapter-sdk';
import manifestJson from '../manifest.json' with { type: 'json' };

const manifest = manifestJson as unknown as AdapterPluginManifest;
const spin = () => {
  // eslint-disable-next-line no-constant-condition
  for (;;) Math.sqrt(Math.random());
};

const plugin: AdapterPluginModule = {
  manifest,
  activate(api) {
    api.adapters.register({
      id: 'test.loop.reader',
      async open(item, ctx) {
        const mode = (await ctx.files!.readText(item.ref)).text.trim();
        if (mode === 'busy-open') spin();
        if (mode === 'hang-open') await new Promise(() => {});
        return {
          mount(t) {
            if (t.kind !== 'reader') throw new Error('reader only');
            t.render({ type: 'stack', children: [{ type: 'text', text: `模式：${mode}` }, { type: 'button', label: '开始死循环', action: 'spin', variant: 'secondary' }] });
            t.onAction((a) => {
              if (a === 'spin') spin();
            });
            if (mode === 'flood') {
              let i = 0;
              const tick = () => {
                for (let k = 0; k < 50; k++) t.render({ type: 'text', text: `第 ${++i} 次` });
                setTimeout(tick, 0);
              };
              tick();
            }
          },
          getState: () => ({}),
          dispose() {},
        };
      },
    });
  },
};
export default plugin;
