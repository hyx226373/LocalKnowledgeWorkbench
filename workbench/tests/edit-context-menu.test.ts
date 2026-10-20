import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { previewContextMenu } from '../src/shared/agentMarks';
import {
  CONTEXT_MENU_HANDLED_CHANNEL,
  ContextMenuClaims,
  EDIT_UNDO_ROUTE,
  editContextMenuItems,
  editContextMenuTemplate,
  shouldShowEditContextMenu,
} from '../src/shared/editContextMenu';

const root = path.join(__dirname, '..');

describe('可编辑区右键菜单', () => {
  it('六项都在，enabled 跟 editFlags，剪切前有分隔线', () => {
    expect(shouldShowEditContextMenu({ isEditable: true, rendererHandled: false })).toBe(true);
    const items = editContextMenuItems({
      canUndo: true,
      canRedo: false,
      canCut: false,
      canCopy: true,
      canPaste: false,
      canSelectAll: true,
    });
    expect(items).toEqual([
      { label: '撤销', role: 'undo', enabled: true },
      { label: '重做', role: 'redo', enabled: false },
      { label: '剪切', role: 'cut', enabled: false },
      { label: '复制', role: 'copy', enabled: true },
      { label: '粘贴', role: 'paste', enabled: false },
      { label: '全选', role: 'selectAll', enabled: true },
    ]);
    const template = editContextMenuTemplate({
      canUndo: false,
      canRedo: false,
      canCut: true,
      canCopy: true,
      canPaste: true,
      canSelectAll: true,
    });
    expect(template.map((entry) => entry.type === 'separator' ? 'sep' : entry.role)).toEqual([
      'undo',
      'redo',
      'sep',
      'cut',
      'copy',
      'paste',
      'selectAll',
    ]);
    expect(template.find((entry) => entry.type === 'item' && entry.role === 'cut')).toMatchObject({ enabled: true });
  });

  it('渲染进程已经处理过的右键，即使落在可编辑区也不再弹', () => {
    expect(shouldShowEditContextMenu({ isEditable: true, rendererHandled: true })).toBe(false);
    const claims = new ContextMenuClaims();
    const first = claims.note(7);
    const second = claims.note(7);
    claims.forget(7, first);
    expect(claims.take(7)).toBe(true);
    expect(claims.take(7)).toBe(false);
    claims.note(7);
    claims.forget(7, second);
    expect(claims.take(7)).toBe(true);
    expect(claims.take(3)).toBe(false);
  });

  it('预览区仍是标红菜单，主进程不把它当成编辑菜单', () => {
    const preview = previewContextMenu({ hasSelection: true, fileInRound: true, selectionOrClickOnMark: true });
    expect(preview.map((item) => item.testId)).toEqual(['preview-ctx-copy', 'preview-ctx-mark', 'preview-ctx-unmark']);
    expect(preview.map((item) => item.label)).toEqual(['复制', '标红给 Agent', '取消此处标红']);
    expect(shouldShowEditContextMenu({ isEditable: false, rendererHandled: true })).toBe(false);
    expect(shouldShowEditContextMenu({ isEditable: false, rendererHandled: false })).toBe(false);
    const menu = fs.readFileSync(path.join(root, 'src/renderer/agent-marks/menu.tsx'), 'utf8');
    expect(menu).toContain('event.preventDefault()');
    expect(menu).toContain('if (!args.active) return');
  });

  it('目录树和标签右键仍自己处理，不可编辑区不弹编辑菜单', () => {
    const sidebar = fs.readFileSync(path.join(root, 'src/renderer/dir-view/Sidebar.tsx'), 'utf8');
    const dir = fs.readFileSync(path.join(root, 'src/renderer/dir-view/DirView.tsx'), 'utf8');
    const app = fs.readFileSync(path.join(root, 'src/renderer/MainShell.tsx'), 'utf8');
    expect(sidebar).toContain('data-testid="tree-row"');
    expect(sidebar).toMatch(/onContextMenu=\{\(e\) => \{\s*e\.preventDefault\(\);/);
    expect(dir).toContain('data-testid="vfolder-row"');
    expect(dir).toMatch(/onContextMenu=\{\(e\) => \{\s*e\.preventDefault\(\);/);
    expect(app).toContain("closest?.('.dv-tab')");
    expect(app).toContain('ev.preventDefault()');
    expect(shouldShowEditContextMenu({ isEditable: false, rendererHandled: true })).toBe(false);
  });

  it('编辑器是受控 textarea，撤销走原生 historyUndo，右键不在渲染进程拦截', () => {
    expect(EDIT_UNDO_ROUTE).toBe('textarea-native');
    const src = fs.readFileSync(path.join(root, 'src/renderer/plugins/builtin-readers/editor.tsx'), 'utf8');
    const start = src.indexOf('export function EditorTextarea');
    const end = src.indexOf('export async function showPendingChanges');
    const fn = src.slice(start, end);
    expect(fn).toContain('<textarea');
    expect(fn).toContain('onChange={(e) => doc.setDraft(e.target.value)}');
    expect(fn).not.toContain('onContextMenu');
    expect(src).not.toContain('@codemirror');
    expect(src).not.toContain('EditorView');
    const host = fs.readFileSync(path.join(root, 'src/main/editContextMenu.ts'), 'utf8');
    expect(host).toContain('role: entry.role');
    expect(host).toContain('params.isEditable');
    const preload = fs.readFileSync(path.join(root, 'src/preload/index.ts'), 'utf8');
    expect(preload).toContain('CONTEXT_MENU_HANDLED_CHANNEL');
    expect(preload).toContain('event.defaultPrevented');
    expect(preload).toContain('ipcRenderer.sendSync(CONTEXT_MENU_HANDLED_CHANNEL)');
    expect(CONTEXT_MENU_HANDLED_CHANNEL).toBe('kb:context-menu-handled');
  });
});
