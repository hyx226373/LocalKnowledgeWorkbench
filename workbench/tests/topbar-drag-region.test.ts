import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..');
const appSrc = readFileSync(join(root, 'src/renderer/MainShell.tsx'), 'utf8');
const styles = readFileSync(join(root, 'src/renderer/styles.css'), 'utf8');
const previewSrc = readFileSync(join(root, 'src/renderer/agent-live/preview.tsx'), 'utf8');
const previewCss = readFileSync(join(root, 'src/renderer/agent-live/agent-live.css'), 'utf8');
const connectSrc = readFileSync(join(root, 'src/renderer/agent-live/connectButton.tsx'), 'utf8');
const panelCss = readFileSync(join(root, 'src/renderer/panel-manager/panel-manager.css'), 'utf8');
const chromeSrc = readFileSync(join(root, 'src/main/windowChrome.ts'), 'utf8');

function extractHeader(src: string): string {
  const start = src.search(/<header\b[^>]*className="[^"]*kb-topbar/);
  expect(start).toBeGreaterThanOrEqual(0);
  const close = src.indexOf('</header>', start);
  expect(close).toBeGreaterThan(start);
  return src.slice(start, close + '</header>'.length);
}

/** 取包含 data-testid 的最近开标签（支持多行 className）。 */
function openingTagAroundTestId(src: string, testId: string): string {
  const marker = `data-testid="${testId}"`;
  const idx = src.indexOf(marker);
  expect(idx, `missing data-testid="${testId}"`).toBeGreaterThanOrEqual(0);
  let start = src.lastIndexOf('<', idx);
  expect(start).toBeGreaterThanOrEqual(0);
  let i = start + 1;
  let depth = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    else if (ch === '>' && depth === 0) return src.slice(start, i + 1);
    i++;
  }
  throw new Error(`unclosed tag for ${testId}`);
}

function hasNoDrag(tag: string): boolean {
  return /\bkb-no-drag\b/.test(tag);
}

function ruleHasNoDrag(css: string, selectorNeedle: string): boolean {
  const idx = css.indexOf(selectorNeedle);
  if (idx < 0) return false;
  const open = css.indexOf('{', idx);
  const close = css.indexOf('}', open);
  if (open < 0 || close < 0) return false;
  const body = css.slice(open, close + 1);
  return /-webkit-app-region:\s*no-drag/.test(body) && !/!important/.test(body);
}

describe('顶栏 app-region：空白可拖、控件可点', () => {
  it('顶栏不再在按钮之后放全宽 drag 层', () => {
    const header = extractHeader(appSrc);
    expect(header).not.toContain('kb-topbar-drag-space');
    expect(appSrc).not.toContain('kb-topbar-drag-space');
    expect(styles).not.toMatch(/\.kb-topbar-drag-space\s*\{/);

    const firstButton = header.search(/<button\b/);
    expect(firstButton).toBeGreaterThan(0);
    const laterDragLayer = header.slice(firstButton).search(
      /className="[^"]*kb-topbar-drag-space[^"]*"|grid-column:\s*1\s*\/\s*-1/,
    );
    expect(laterDragLayer).toBe(-1);
  });

  it('侧栏开关、工作区切换、工作区总览所在元素链都有 kb-no-drag', () => {
    const header = extractHeader(appSrc);
    expect(hasNoDrag(openingTagAroundTestId(header, 'drawer-toggle'))).toBe(true);
    expect(hasNoDrag(openingTagAroundTestId(appSrc, 'ws-switcher'))).toBe(true);
    expect(hasNoDrag(openingTagAroundTestId(header, 'ws-overview-toggle'))).toBe(true);

    expect(header).toMatch(/className="kb-ghost-wrap kb-no-drag"/);
    expect(header).toMatch(/kb-ov-entry[^\n]*kb-no-drag|kb-no-drag[^\n]*kb-ov-entry/);
    expect(header).toMatch(/kb-topbar-search[^\n]*kb-no-drag/);

    const left = header.match(/kb-topbar-cluster--left[\s\S]*?kb-topbar-search/);
    expect(left?.[0]).toBeTruthy();
    const leftButtons = left![0].match(/<button\b[\s\S]*?>/g) ?? [];
    expect(leftButtons.length).toBeGreaterThan(0);
    for (const tag of leftButtons) expect(hasNoDrag(tag)).toBe(true);

    const right = header.match(/kb-topbar-cluster--right[\s\S]*<\/header>/);
    expect(right?.[0]).toBeTruthy();
    const rightButtons = right![0].match(/<button\b[\s\S]*?>/g) ?? [];
    expect(rightButtons.length).toBeGreaterThan(0);
    for (const tag of rightButtons) expect(hasNoDrag(tag)).toBe(true);
  });

  it('顶栏 button/input/[role=button]/.kb-ghost-wrap 走 no-drag，且不用 !important', () => {
    expect(styles).toMatch(/\.kb-topbar\s*\{[\s\S]*?-webkit-app-region:\s*drag/);
    expect(ruleHasNoDrag(styles, '.kb-topbar button')).toBe(true);
    expect(ruleHasNoDrag(styles, '.kb-topbar input')).toBe(true);
    expect(ruleHasNoDrag(styles, '.kb-topbar [role=button]')).toBe(true);
    expect(ruleHasNoDrag(styles, '.kb-topbar .kb-ghost-wrap')).toBe(true);

    const blockStart = styles.indexOf('.kb-topbar button');
    const blockEnd = styles.indexOf('}', styles.indexOf('{', blockStart));
    const block = styles.slice(blockStart, blockEnd + 1);
    expect(block).toContain('.kb-topbar input');
    expect(block).toContain('.kb-topbar [role=button]');
    expect(block).toContain('.kb-topbar .kb-ghost-wrap');
    expect(block).toMatch(/-webkit-app-region:\s*no-drag/);
    expect(block).not.toContain('!important');
  });

  it('agent-live 预览顶栏没有后置全宽 drag 层，控件 no-drag', () => {
    const header = extractHeader(previewSrc);
    expect(header).not.toContain('kb-topbar-drag-space');
    expect(previewSrc).not.toContain('kb-topbar-drag-space');
    expect(previewCss).not.toMatch(/\.kb-topbar-drag-space\s*\{/);

    const firstControl = header.search(/<ConnectAgentButton\b|<button\b|<input\b|<div className=\{?'search/);
    expect(firstControl).toBeGreaterThan(0);
    expect(header.slice(firstControl)).not.toMatch(/kb-topbar-drag-space|grid-column:\s*1\s*\/\s*-1/);

    expect(hasNoDrag(openingTagAroundTestId(connectSrc, 'connect-agent'))).toBe(true);
    expect(hasNoDrag(openingTagAroundTestId(connectSrc, 'connect-agent-menu'))).toBe(true);
    expect(previewCss).toMatch(/\.al-preview-search\s*\{[^}]*-webkit-app-region:\s*no-drag/);
    expect(ruleHasNoDrag(previewCss, '.al-preview-frame > .kb-topbar button')).toBe(true);
    expect(previewCss).toMatch(/\.al-connect\s*\{[^}]*-webkit-app-region:\s*no-drag/);
    expect(ruleHasNoDrag(previewCss, '.al-preview-tab')).toBe(true);
    expect(ruleHasNoDrag(previewCss, '.al-preview-tab button')).toBe(true);
  });

  it('标签栏可点元素 no-drag，空白和窗口按钮占位不铺全宽 drag 遮罩', () => {
    const docked = '.kb-dock.center .dv-groupview:not(.dv-groupview-floating) > .dv-tabs-and-actions-container';
    for (const part of [
      `${docked} .dv-scrollable`,
      `${docked} .dv-tabs-container`,
      `${docked} .dv-tab`,
      `${docked} .dv-pre-actions-container`,
      `${docked} .dv-left-actions-container`,
      `${docked} .dv-right-actions-container`,
      `${docked} button`,
      `${docked} [role=button]`,
      `${docked} [role=tab]`,
      '.kb-dock.center .pm-restore-tabs',
    ]) {
      expect(ruleHasNoDrag(panelCss, part)).toBe(true);
    }

    const blockStart = panelCss.indexOf(`${docked} .dv-scrollable`);
    expect(blockStart).toBeGreaterThanOrEqual(0);
    const blockEnd = panelCss.indexOf('}', panelCss.indexOf('{', blockStart));
    const block = panelCss.slice(blockStart, blockEnd + 1);
    expect(block).toMatch(/-webkit-app-region:\s*no-drag/);
    expect(block).not.toContain('!important');
    expect(block).not.toMatch(/-webkit-app-region:\s*drag\b/);

    expect(panelCss).not.toMatch(/\.dv-void-container[^{]*\{[^}]*-webkit-app-region:\s*drag/);
    expect(panelCss).not.toMatch(/\.kb-topbar-drag-space\s*\{/);
    expect(panelCss).toMatch(/\.dv-groupview-floating \.dv-tabs-and-actions-container\s*\{[^}]*-webkit-app-region:\s*no-drag/);

    const gap = styles.match(/\.kb-window-controls-gap\s*\{[^}]*\}/);
    expect(gap?.[0]).toBeTruthy();
    expect(gap![0]).toMatch(/-webkit-app-region:\s*no-drag/);
    expect(gap![0]).toMatch(/width:\s*140px/);
    expect(gap![0]).not.toMatch(/position:\s*(fixed|absolute)/);
    expect(gap![0]).not.toMatch(/grid-column:\s*1\s*\/\s*-1/);
    expect(gap![0]).not.toContain('!important');

    const dragRules = [...styles.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) => (
      /-webkit-app-region:\s*drag\b/.test(m[2]) && !/-webkit-app-region:\s*no-drag/.test(m[2])
    ));
    expect(dragRules.length).toBeGreaterThan(0);
    for (const rule of dragRules) {
      const body = rule[2];
      expect(body).not.toMatch(/position:\s*(fixed|absolute)/);
      expect(body).not.toMatch(/grid-column:\s*1\s*\/\s*-1/);
      expect(body).not.toMatch(/inset:\s*0/);
      expect(body).not.toContain('!important');
    }

    expect(chromeSrc).toMatch(/WINDOW_CHROME_OVERLAY_HEIGHT\s*=\s*48/);
    expect(chromeSrc).not.toMatch(/createElement|innerHTML|document\.body/);
  });
});
