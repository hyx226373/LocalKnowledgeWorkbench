import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RestoreBar } from '../../src/renderer/workspace-picker/RestoreBar';
import { RESTORE_BAR_COMMAND } from '../../src/renderer/settings/restoreBarVisible';
import {
  classifyFileResource,
  dismissRestore,
  dismissRestoreAll,
  hiddenByDismiss,
  readRestoreDismissed,
  restoreBarFacts,
  restoreRetryTarget,
  withRestoreDismissed,
} from '../../src/renderer/workspace-picker/restoreBarModel';
import type { RestoreFeedPorts } from '../../src/renderer/workspace-picker/restoreFeed';

const base = {
  idFound: true,
  exists: true,
  outOfScope: false,
  rootStatus: 'ok' as const,
  rootName: '甲根',
  inCurrentWorkspace: true,
  switchTo: null,
  pathFound: false,
  moved: false,
};

describe('底部文件条', () => {
  it('没有事件源时不占底部', () => {
    const html = renderToStaticMarkup(createElement(RestoreBar, {
      workspaceId: 'w',
      panels: [{ panelId: 'quiet', kind: 'file', title: '笔记.md' }],
    }));
    expect(html).not.toContain('data-testid="ws-restore"');
    expect(restoreBarFacts({ kind: 'file', phase: 'unknown', retryable: false }).show).toBe(false);
  });

  it('文件在时重试会打开', () => {
    const facts = restoreBarFacts({
      kind: 'file',
      phase: 'unknown',
      retryable: false,
      file: { missing: false, openFailed: true },
    });
    expect(facts.show).toBe(true);
    expect(restoreRetryTarget(facts)).toBe('open');
    const ports: RestoreFeedPorts = {
      onArmed: (_id, cb) => {
        cb(true);
        return () => {};
      },
      getResource: () => ({ missing: false, openFailed: true }),
    };
    const html = renderToStaticMarkup(createElement(RestoreBar, {
      workspaceId: 'w',
      panels: [{ panelId: 'note', kind: 'file', title: '笔记.md' }],
      ports,
    }));
    expect(html).toContain('data-panel-id="note"');
    expect(html).toContain('data-retryable="true"');
    expect(html).not.toContain('disabled');
  });

  it('文件不在时显示原因，重试不可点，悬停有原因', () => {
    expect(classifyFileResource({ ...base, exists: false }).missingReason).toBe('已删除');
    expect(classifyFileResource({ ...base, exists: false, moved: true }).missingReason).toBe('改名或搬走');
    expect(classifyFileResource({ ...base, outOfScope: true }).missingReason).toBe('被格式筛选排除');
    expect(classifyFileResource({ ...base, exists: false, rootStatus: 'missing' }).missingReason).toBe('所在的根没挂上');
    const facts = restoreBarFacts({
      kind: 'file',
      phase: 'failed',
      reason: 'resource-missing',
      retryable: true,
      file: classifyFileResource({ ...base, exists: false }),
    });
    expect(facts.reasonText).toBe('找不到：已删除');
    expect(facts.retryable).toBe(false);
    expect(facts.retryTitle).toBe('找不到：已删除');
    expect(restoreRetryTarget(facts)).toBe('none');
    expect(facts.locate).toBe(true);
    expect(facts.remap).toBe(true);
  });

  it('根不在当前工作区时不可重试，并写明根名', () => {
    const file = classifyFileResource({ ...base, inCurrentWorkspace: false, switchTo: 'ws-b' });
    const facts = restoreBarFacts({ kind: 'file', phase: 'unknown', retryable: false, file });
    expect(facts.reasonText).toBe('所在的根不在当前工作区：甲根');
    expect(facts.retryable).toBe(false);
    expect(facts.switchWorkspaceId).toBe('ws-b');
    expect(restoreRetryTarget(facts)).toBe('none');
  });

  it('关闭和全部清除记在布局里，同一问题重新载入不再出现', () => {
    const once = dismissRestore({}, 'note', 'missing:已删除');
    expect(hiddenByDismiss(once, 'note', 'missing:已删除')).toBe(true);
    expect(hiddenByDismiss(once, 'note', 'missing:改名或搬走')).toBe(false);
    const all = dismissRestoreAll({}, [
      { panelId: 'note', problemKey: 'missing:已删除' },
      { panelId: 'pic', problemKey: 'missing:已删除' },
    ]);
    const stored = withRestoreDismissed({ layout: { schema: 4 } }, all);
    expect(readRestoreDismissed(stored.layout)).toEqual(all);
    const html = renderToStaticMarkup(createElement(RestoreBar, {
      workspaceId: 'w',
      panels: [{ panelId: 'note', kind: 'file', title: '笔记.md', reportsReady: true }],
      ports: {
        onArmed: (_id, cb) => {
          cb(true);
          return () => {};
        },
        getResource: () => ({ missing: true, missingReason: '已删除' }),
      },
      dismissed: readRestoreDismissed(stored.layout),
    }));
    expect(html).not.toContain('data-testid="ws-restore"');
    const again = renderToStaticMarkup(createElement(RestoreBar, {
      workspaceId: 'w',
      panels: [{ panelId: 'note', kind: 'file', title: '笔记.md', reportsReady: true }],
      ports: {
        onArmed: (_id, cb) => {
          cb(true);
          return () => {};
        },
        getResource: () => ({ missing: true, missingReason: '改名或搬走' }),
      },
      dismissed: readRestoreDismissed(stored.layout),
    }));
    expect(again).toContain('找不到：改名或搬走');
  });

  it('一条都没有时不渲染容器，命令不绑快捷键', () => {
    const html = renderToStaticMarkup(createElement(RestoreBar, {
      workspaceId: 'w',
      panels: [{ panelId: 'note', kind: 'file', reportsReady: true }],
      ports: {
        onArmed: (_id, cb) => {
          cb(true);
          return () => {};
        },
        getResource: () => ({ missing: false }),
        onContentReady: (_id, cb) => {
          cb();
          return () => {};
        },
      },
    }));
    expect(html).not.toContain('data-testid="ws-restore"');
    expect(RESTORE_BAR_COMMAND.id).toBe('workspace.restoreBar.toggle');
    expect(RESTORE_BAR_COMMAND).not.toHaveProperty('keybinding');
  });

  it('布局里的绝对路径不会被当成已关闭的提示', () => {
    expect(readRestoreDismissed({ restoreDismissed: { 'C:\\secret': 'missing:已删除', note: 'D:\\gone' } })).toEqual({});
  });
});
