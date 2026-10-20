/**
 * 去掉「收起标题」。localStorage 键 kb.sidebarTitleVisible 不删，只是不再读。
 * 分区收起（kb.sidebarBlocksCollapsed）仍可用。标题没有隐藏规则，一律显示。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { SingleDrawer as Drawer } from '../src/renderer/drawer/Drawer';

/** 非字面量动态导入，避免 react 没有声明文件时多出 TS7016。 */
function loadModule(spec: string): Promise<Record<string, any>> {
  return import(spec);
}

const ROOT = process.cwd();
const SELF = path.join(ROOT, 'tests/sidebar-title-removed.test.ts');
const TITLE_KEY = 'kb.sidebarTitleVisible';
const BLOCK_KEY = 'kb.sidebarBlocksCollapsed';

const NEEDLES = [
  'sidebar-title-toggle',
  'toggleSidebarTitle',
  'kb-sbt-toggle',
  'workbench.toggleSidebarTitle',
  'initSidebarTitle',
  '__kbSbt',
  'kb.sidebarTitleVisible',
  'data-sbt',
];

function collect(dir: string, out: string[] = []): string[] {
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { return out; }
  for (const name of names) {
    const full = path.join(dir, name);
    let st: ReturnType<typeof statSync>;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) collect(full, out);
    else if (full !== SELF && /\.(ts|tsx|css|js|mjs|cjs|html)$/.test(name)) out.push(full);
  }
  return out;
}

it('源码和测试里不再有收起标题开关，分区收起还在', () => {
  const hits: string[] = [];
  for (const file of [...collect(path.join(ROOT, 'src')), ...collect(path.join(ROOT, 'tests')), ...collect(path.join(ROOT, 'e2e'))]) {
    const text = readFileSync(file, 'utf8');
    for (const needle of NEEDLES) {
      if (text.includes(needle)) hits.push(`${path.relative(ROOT, file)}: ${needle}`);
    }
  }
  expect(hits).toEqual([]);

  const title = readFileSync(path.join(ROOT, 'src/renderer/drawer/sidebarTitle.ts'), 'utf8');
  expect(title).toContain('kb.sidebarBlocksCollapsed');
  expect(title).toContain('export function toggleSidebarBlock');
  expect(title).toContain('export function showAllSidebarBlocks');
  expect(title).toContain('initSidebarBlocks()');

  const app = readFileSync(path.join(ROOT, 'src/renderer/MainShell.tsx'), 'utf8');
  expect(app).toContain('toggleSidebarBlock');
  expect(app).toContain('sidebar.block.showAll');

  const css = readFileSync(path.join(ROOT, 'src/renderer/drawer/drawer.css'), 'utf8');
  expect(css).toContain('.kb-sbb-bar');
  expect(css).not.toMatch(/\.kb-module-title\s*\{[^}]*display\s*:\s*none/);
});

it('抽屉不再渲染收起标题按钮，分区收起条还在', async () => {
  const react = await loadModule('react');
  const server = await loadModule('react-dom/server');
  const html = server.renderToStaticMarkup(react.createElement(Drawer, {
    open: true,
    onWidth: () => undefined,
    selection: ['root', 'fav'],
    onSelectionChange: () => undefined,
    slots: { root: '根目录内容', fav: '收藏内容' },
  })) as string;
  expect(html).not.toContain('sidebar-title-toggle');
  expect(html).not.toContain('收起标题');
  expect(html).not.toContain('显示标题');
  expect(html).toContain('data-testid="sidebar-block-bar-root"');
  expect(html).toContain('根目录内容');
});

it('存过隐藏标题时也不再套用，分区收起照常读', async () => {
  const store = new Map<string, string>([
    [TITLE_KEY, '0'],
    [BLOCK_KEY, '["web"]'],
  ]);
  const classes: string[] = [];
  const dataset: Record<string, string> = {};
  const g = globalThis as Record<string, unknown>;
  const prevDocument = Object.getOwnPropertyDescriptor(g, 'document') ?? null;
  const prevStorage = Object.getOwnPropertyDescriptor(g, 'localStorage') ?? null;
  Object.defineProperty(g, 'document', {
    configurable: true,
    writable: true,
    value: {
      documentElement: {
        dataset,
        classList: {
          toggle(name: string, on?: boolean) {
            const at = classes.indexOf(name);
            const enable = on ?? at < 0;
            if (enable && at < 0) classes.push(name);
            if (!enable && at >= 0) classes.splice(at, 1);
            return enable;
          },
        },
      },
    },
  });
  Object.defineProperty(g, 'localStorage', {
    configurable: true,
    writable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
      removeItem: (key: string) => { store.delete(key); },
    },
  });
  try {
    vi.resetModules();
    const mod = await import('../src/renderer/drawer/sidebarTitle');
    expect(dataset.sbt).toBeUndefined();
    expect(store.get(TITLE_KEY)).toBe('0');
    expect(mod.isSidebarBlockCollapsed('web')).toBe(true);
    expect(classes).toContain('sbc-web');
    expect(mod.isSidebarBlockCollapsed('root')).toBe(false);

    mod.toggleSidebarBlock('root');
    expect(mod.isSidebarBlockCollapsed('root')).toBe(true);
    expect(classes).toContain('sbc-root');
    expect(store.get(TITLE_KEY)).toBe('0');
    expect(store.get(BLOCK_KEY)).toContain('root');

    mod.showAllSidebarBlocks();
    expect(mod.isSidebarBlockCollapsed('web')).toBe(false);
    expect(mod.isSidebarBlockCollapsed('root')).toBe(false);
    expect(classes).not.toContain('sbc-web');
    expect(store.get(TITLE_KEY)).toBe('0');
    expect('toggleSidebarTitle' in mod).toBe(false);
  } finally {
    const restore = (key: string, desc: PropertyDescriptor | null) => {
      if (!desc) {
        delete g[key];
        return;
      }
      Object.defineProperty(g, key, desc);
    };
    restore('document', prevDocument);
    restore('localStorage', prevStorage);
  }
});

afterEach(() => {
  vi.resetModules();
});
