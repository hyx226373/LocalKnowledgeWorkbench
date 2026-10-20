/**
 * 辅助搜索插件空接口：假 provider 验证分段、超时、abort、无插件不渲染。
 * 不接 Obsidian，不写 obsidian://。
 */
import { readFileSync } from 'node:fs';
import { createElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerDeclaredSearchProvider } from '../src/plugin-runtime/searchProviders';
import { searchProviderDeclErrors, type SearchProviderContext, type SearchProviderHit, type SearchProviderRegistration } from '../src/shared/searchProvider';
import { validateManifest } from '../src/renderer/plugin-host/manifest';
import type { PluginManifest } from '../src/renderer/plugin-host/types';
import {
  AuxiliarySearchRunner,
  SEARCH_PROVIDER_DEBOUNCE_MS,
  SEARCH_PROVIDER_ERROR_TEXT,
  SEARCH_PROVIDER_TIMEOUT_MS,
  SEARCH_PROVIDER_VISIBLE_LIMIT,
  SearchBoxAddon,
  SearchProviderSections,
  applyExpanded,
  dispatchSearchAction,
  filenameSectionLabel,
  isActionTarget,
  isPathTarget,
  isResourceTarget,
  listSearchProviders,
  queryOneProvider,
  registerHostSearchProvider,
  resetSearchProvidersForTests,
  type HostSearchProvider,
  type ProviderSection,
} from '../src/renderer/search/providers';

const ctx: SearchProviderContext = { workspaceId: 'ws-1', rootIds: ['root-a'], limit: 50 };

function hit(title: string, extra: Partial<SearchProviderHit> = {}): SearchProviderHit {
  return { title, target: { resourceId: `res-${title}` }, ...extra };
}

function provider(id: string, label: string, search: HostSearchProvider['search'], icon?: string): HostSearchProvider {
  return { id, label, ...(icon ? { icon } : {}), search };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function settle() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
  resetSearchProvidersForTests();
});

describe('manifest contributes.searchProviders', () => {
  const base = { id: 'x.y', name: 'X', version: '1.0.0', engines: { workbench: '^0.2.0' } };

  it('未声明时通过；声明合法贡献点通过', () => {
    expect(searchProviderDeclErrors(undefined)).toEqual([]);
    expect(validateManifest(base, '0.2.0')).toBeNull();
    expect(
      validateManifest(
        { ...base, contributes: { searchProviders: [{ id: 'x.find', label: '查找', icon: '搜' }] } },
        '0.2.0',
      ),
    ).toBeNull();
  });

  it('非法形状拒绝：不是数组、缺 label、非法 id、重复 id、过长 label、非法 icon', () => {
    expect(searchProviderDeclErrors('nope')).toEqual(['contributes.searchProviders 必须是数组']);
    expect(validateManifest({ ...base, contributes: { searchProviders: [{ id: 'x.find' }] } } as PluginManifest, '0.2.0')).toMatch(/缺少 label/);
    expect(validateManifest({ ...base, contributes: { searchProviders: [{ id: 'Bad', label: '查找' }] } } as PluginManifest, '0.2.0')).toMatch(/非法 id/);
    expect(
      validateManifest(
        {
          ...base,
          contributes: {
            searchProviders: [
              { id: 'x.find', label: '查找' },
              { id: 'x.find', label: '另一' },
            ],
          },
        },
        '0.2.0',
      ),
    ).toMatch(/id 重复/);
    expect(validateManifest({ ...base, contributes: { searchProviders: [{ id: 'x.find', label: '长'.repeat(41) }] } }, '0.2.0')).toMatch(/label 过长/);
    expect(validateManifest({ ...base, contributes: { searchProviders: [{ id: 'x.find', label: '查找', icon: '<b>' }] } }, '0.2.0')).toMatch(/icon 不合法/);
  });
});

describe('runtime api.search.registerProvider', () => {
  it('未在 manifest 声明的 id 拒绝，已声明的可注册并可 dispose', () => {
    const store = new Map<string, SearchProviderRegistration>();
    const declared = [{ id: 'a.b' }];
    const reg = { id: 'a.b', search: async () => [hit('甲')] };
    expect(() => registerDeclaredSearchProvider(declared, { id: 'nope', search: async () => [] }, store)).toThrow(/未在 manifest 中声明/);
    expect(store.size).toBe(0);
    const disp = registerDeclaredSearchProvider(declared, reg, store);
    expect(store.get('a.b')).toBe(reg);
    disp.dispose();
    expect(store.has('a.b')).toBe(false);
  });
});

describe('宿主调度：分段、超时、abort', () => {
  it('两个假 provider 分段；一个出错不影响另一个；片段去掉 HTML', async () => {
    vi.useFakeTimers();
    const seen: SearchProviderContext[] = [];
    const runner = new AuxiliarySearchRunner();
    let got: ProviderSection[] = [];
    runner.schedule(
      '命中',
      ctx,
      [
        provider('ok', '笔记', async (query, next) => {
          seen.push(next);
          expect(query).toBe('命中');
          return [hit('命中甲', { subtitle: '<i>副</i>', snippet: '<b>片段</b><script>alert(1)</script>' })];
        }),
        provider('bad', '坏段', async () => {
          throw new Error('插件内部爆炸');
        }),
      ],
      (sections) => {
        got = sections;
      },
    );
    await vi.advanceTimersByTimeAsync(SEARCH_PROVIDER_DEBOUNCE_MS - 1);
    expect(got).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(seen).toEqual([ctx]);
    expect(got.map((section) => section.id)).toEqual(['ok', 'bad']);
    expect(got[0]).toMatchObject({
      status: 'ok',
      label: '笔记',
      hits: [{ title: '命中甲', subtitle: '副', snippet: '片段alert(1)' }],
    });
    expect(got[1]).toMatchObject({ status: 'error', label: '坏段', hits: [] });
    expect(JSON.stringify(got)).not.toContain('插件内部爆炸');
    expect(JSON.stringify(got)).not.toContain('<b>');
    expect(JSON.stringify(got)).not.toContain('<script');

    const html = renderToStaticMarkup(
      createElement(SearchProviderSections, {
        sections: got,
        query: '命中',
        onOpen: () => {},
        onMore: () => {},
      }),
    );
    expect(html).toContain('笔记');
    expect(html).toContain('坏段');
    expect(html).toContain(SEARCH_PROVIDER_ERROR_TEXT);
    expect(html).toContain('data-testid="search-provider-hit"');
    expect(html).not.toContain('<b>');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('obsidian://');
    runner.dispose();
  });

  it(`每个 provider 单独超时 ${SEARCH_PROVIDER_TIMEOUT_MS}ms，并 abort 该次调用`, async () => {
    expect(SEARCH_PROVIDER_TIMEOUT_MS).toBe(1500);
    let signal: AbortSignal | undefined;
    const pending = queryOneProvider(
      provider('slow', '慢', (_query, _next, nextSignal) => {
        signal = nextSignal;
        return new Promise(() => {});
      }),
      'q',
      ctx,
      new AbortController().signal,
      25,
    );
    const section = await pending;
    expect(section.status).toBe('timeout');
    expect(section.hits).toEqual([]);
    expect(signal?.aborted).toBe(true);
    const html = renderToStaticMarkup(
      createElement(SearchProviderSections, {
        sections: [section],
        query: 'q',
        onOpen: () => {},
        onMore: () => {},
      }),
    );
    expect(html).toContain('慢');
    expect(html).toContain(SEARCH_PROVIDER_ERROR_TEXT);
    expect(html).not.toContain('data-testid="search-provider-hit"');
  });

  it('输入一变就 abort 上一轮，迟到结果不覆盖新一轮', async () => {
    vi.useFakeTimers();
    const gates: Array<{ signal: AbortSignal; resolve: (hits: SearchProviderHit[]) => void }> = [];
    const runner = new AuxiliarySearchRunner();
    const published: ProviderSection[][] = [];
    const list = [
      provider('p', '笔记', (_query, _next, signal) => {
        const gate = deferred<SearchProviderHit[]>();
        gates.push({ signal, resolve: gate.resolve });
        return gate.promise;
      }),
    ];
    runner.schedule('第一', ctx, list, (sections) => published.push(sections));
    await vi.advanceTimersByTimeAsync(SEARCH_PROVIDER_DEBOUNCE_MS);
    expect(gates).toHaveLength(1);
    expect(gates[0]!.signal.aborted).toBe(false);

    runner.schedule('第二', ctx, list, (sections) => published.push(sections));
    expect(gates[0]!.signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(SEARCH_PROVIDER_DEBOUNCE_MS);
    expect(gates).toHaveLength(2);

    gates[0]!.resolve([hit('旧结果')]);
    await settle();
    expect(published).toEqual([]);

    gates[1]!.resolve([hit('新结果')]);
    await settle();
    expect(published).toHaveLength(1);
    expect(published[0]![0]).toMatchObject({ status: 'ok', hits: [{ title: '新结果' }] });
    runner.dispose();
  });

  it('已 abort 的信号不再调用 search', async () => {
    const ac = new AbortController();
    ac.abort();
    let calls = 0;
    const section = await queryOneProvider(
      provider('p', '笔记', async () => {
        calls += 1;
        return [hit('不该出现')];
      }),
      'q',
      ctx,
      ac.signal,
    );
    expect(calls).toBe(0);
    expect(section.status).toBe('aborted');
    expect(
      renderToStaticMarkup(
        createElement(SearchProviderSections, {
          sections: [section],
          query: 'q',
          onOpen: () => {},
          onMore: () => {},
        }),
      ),
    ).toBe('');
  });

  it('超过 5 条只显示 5 条和「更多」，展开后全部可见；点击交给宿主', () => {
    const hits = Array.from({ length: SEARCH_PROVIDER_VISIBLE_LIMIT + 1 }, (_, i) => hit(`条${i}`));
    const folded = applyExpanded(
      [{ id: 'p', label: '笔记', status: 'ok', hits, visible: hits.slice(0, 5), more: 1 }],
      new Set(),
    );
    expect(folded[0]!.visible).toHaveLength(5);
    expect(folded[0]!.more).toBe(1);
    const opened: string[] = [];
    const more: string[] = [];
    const tree = SearchProviderSections({
      sections: folded,
      query: '条',
      onOpen: (id, item) => opened.push(`${id}:${item.title}`),
      onMore: (id) => more.push(id),
    });
    const html = renderToStaticMarkup(tree as ReactElement);
    expect(html.match(/data-testid="search-provider-hit"/g)).toHaveLength(5);
    expect(html).toContain('更多');
    expect(html).not.toContain('<a ');
    expect(html).not.toContain('obsidian://');
    const openHit = findByTestId(tree, 'search-provider-hit')[0]?.props.onMouseDown;
    const openMore = findByTestId(tree, 'search-provider-more')[0]?.props.onMouseDown;
    expect(openHit).toBeTypeOf('function');
    expect(openMore).toBeTypeOf('function');
    openHit!({ preventDefault() {} });
    expect(opened).toEqual(['p:条0']);
    openMore!({ preventDefault() {} });
    expect(more).toEqual(['p']);
    const expanded = applyExpanded(folded, new Set(['p']));
    expect(expanded[0]!.visible).toHaveLength(6);
    expect(expanded[0]!.more).toBe(0);
  });

  it('没有 target 或标题被剥空的命中丢掉', async () => {
    const section = await queryOneProvider(
      provider('p', '笔记', async () => [
        { title: '<b></b>', target: { resourceId: 'r' } },
        { title: '有', target: undefined as unknown as SearchProviderHit['target'] },
        hit('留'),
      ]),
      'q',
      ctx,
      new AbortController().signal,
    );
    expect(section.hits.map((item) => item.title)).toEqual(['留']);
  });
});

describe('无插件不渲染插槽', () => {
  it('没有 provider 时插槽、结果段和「文件名」小标题都不输出', () => {
    expect(listSearchProviders()).toEqual([]);
    expect(filenameSectionLabel([])).toBeNull();
    expect(renderToStaticMarkup(createElement(SearchBoxAddon, { providers: [] }))).toBe('');
    expect(
      renderToStaticMarkup(
        createElement(SearchProviderSections, {
          sections: [],
          query: '笔记',
          onOpen: () => {},
          onMore: () => {},
        }),
      ),
    ).toBe('');
    const runner = new AuxiliarySearchRunner();
    const published: ProviderSection[][] = [];
    runner.schedule('笔记', ctx, [], (sections) => published.push(sections));
    expect(published).toEqual([[]]);
    runner.dispose();
  });

  it('有 provider 才渲染 search-box-addon，dispose 后不再占位', () => {
    const first = registerHostSearchProvider(provider('demo.find', '笔记', async () => [], '笔'));
    const html = renderToStaticMarkup(createElement(SearchBoxAddon, { providers: listSearchProviders() }));
    expect(html).toContain('search-box-addon');
    expect(html).toContain('data-provider="demo.find"');
    expect(html).toContain('笔');
    expect(filenameSectionLabel(listSearchProviders())).toBe('文件名');
    const second = registerHostSearchProvider(provider('demo.find', '替换', async () => []));
    first.dispose();
    expect(listSearchProviders().map((item) => item.label)).toEqual(['替换']);
    second.dispose();
    expect(listSearchProviders()).toEqual([]);
    expect(renderToStaticMarkup(createElement(SearchBoxAddon, { providers: listSearchProviders() }))).toBe('');
  });

  it('action 由宿主转发，插件不自己导航', () => {
    let seen: unknown;
    const disp = registerHostSearchProvider({
      ...provider('demo.act', '动作', async () => []),
      onAction: (action, payload) => {
        seen = [action, payload];
      },
    });
    dispatchSearchAction('demo.act', 'focus', { n: 1 });
    expect(seen).toEqual(['focus', { n: 1 }]);
    expect(isResourceTarget({ resourceId: 'r' })).toBe(true);
    expect(isPathTarget({ rootId: 'root', relPath: 'a/b.md' })).toBe(true);
    expect(isActionTarget({ action: 'focus', payload: 1 })).toBe(true);
    expect(isPathTarget({ resourceId: 'r' })).toBe(false);
    disp.dispose();
  });
});

describe('内置插件注册表', () => {
  it('声明过的 id 才能注册；停用后插槽消失', async () => {
    vi.resetModules();
    vi.doMock('../src/renderer/kb', () => ({
      kb: {
        registerPlugin: async (id: string, version: string, source: 'builtin' | 'user') => ({
          id,
          version,
          source,
          enabled: true,
          granted: [],
          installedAt: 1,
        }),
        setPluginEnabled: async () => {},
      },
    }));
    const hostMod = await import('../src/renderer/plugin-host/host');
    const providersMod = await import('../src/renderer/search/providers');
    providersMod.resetSearchProvidersForTests();
    const manifest = {
      id: 'demo.search',
      name: '搜索',
      version: '1.0.0',
      engines: { workbench: '^0.2.0' },
      contributes: { searchProviders: [{ id: 'demo.search.find', label: '笔记', icon: '笔' }] },
    };
    let api: { search: { registerProvider(reg: { id: string; search: HostSearchProvider['search'] }): { dispose(): void } } } | undefined;
    await hostMod.pluginHost.load([
      {
        source: 'builtin',
        module: {
          manifest,
          activate(next) {
            api = next;
            next.search.registerProvider({
              id: 'demo.search.find',
              search: async () => [hit('来自插件')],
            });
          },
        },
      },
    ]);
    expect(hostMod.pluginHost.get('demo.search')?.status).toBe('active');
    expect(providersMod.listSearchProviders().map((item) => item.label)).toEqual(['笔记']);
    expect(() => api!.search.registerProvider({ id: 'not-declared', search: async () => [] })).toThrow(/未在 manifest 中声明/);
    const addon = renderToStaticMarkup(createElement(providersMod.SearchBoxAddon, { providers: providersMod.listSearchProviders() }));
    expect(addon).toContain('search-box-addon');
    await hostMod.pluginHost.setEnabled('demo.search', false);
    expect(hostMod.pluginHost.get('demo.search')?.status).toBe('disabled');
    expect(providersMod.listSearchProviders()).toEqual([]);
    expect(renderToStaticMarkup(createElement(providersMod.SearchBoxAddon, { providers: providersMod.listSearchProviders() }))).toBe('');
    providersMod.resetSearchProvidersForTests();
  });
});

describe('空接口不接 Obsidian', () => {
  it('搜索插件相关源码没有 obsidian://', () => {
    const files = [
      'src/shared/searchProvider.ts',
      'src/plugin-runtime/searchProviders.ts',
      'src/plugin-runtime/runtime.ts',
      'src/renderer/search/providers.ts',
      'src/renderer/plugin-host/host.ts',
      'src/renderer/plugin-host/manifest.ts',
      'src/renderer/plugin-host/types.ts',
      'src/main/service/pluginHost.ts',
      'src/renderer/MainShell.tsx',
    ];
    for (const file of files) {
      expect(readFileSync(file, 'utf8')).not.toMatch(/obsidian:\/\//);
    }
    const app = readFileSync('src/renderer/MainShell.tsx', 'utf8');
    expect(app).toContain('SearchBoxAddon');
    expect(app).toContain('SearchProviderSections');
    expect(app).toContain('filenameSectionLabel');
    expect(app).toContain('fileShown.length + auxRows.length');
  });
});

function findByTestId(node: ReactNode, testId: string): Array<{ props: { onMouseDown?: (event: { preventDefault(): void }) => void } }> {
  const found: Array<{ props: { onMouseDown?: (event: { preventDefault(): void }) => void } }> = [];
  const walk = (current: ReactNode) => {
    if (!current || typeof current !== 'object') return;
    if (Array.isArray(current)) {
      current.forEach(walk);
      return;
    }
    const el = current as { props?: { 'data-testid'?: string; children?: ReactNode; onMouseDown?: (event: { preventDefault(): void }) => void } };
    if (!el.props) return;
    if (el.props['data-testid'] === testId) found.push(el as { props: { onMouseDown?: (event: { preventDefault(): void }) => void } });
    walk(el.props.children);
  };
  walk(node);
  return found;
}
