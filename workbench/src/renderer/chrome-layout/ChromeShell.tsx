/**
 * Chrome UI 接线：真隐藏（卸载或 display:none + pointer-events:none）、
 * 只看内容开关、编辑模式面板。最小侵入挂到 App。
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ChromeComponentId, ChromeStateSnapshot } from '../../shared/chromeLayout';
import type { ChromeController } from './controller';
import { chromeSlotProps, useChromeSnapshot, useContentOnlyExitKeys } from './useChromeLayout';
import './chrome-layout.css';

const ChromeCtx = createContext<ChromeController | null>(null);

export function useChromeController(): ChromeController {
  const c = useContext(ChromeCtx);
  if (!c) throw new Error('useChromeController: 缺少 ChromeProvider');
  return c;
}

export function useOptionalChromeController(): ChromeController | null {
  return useContext(ChromeCtx);
}

export function ChromeProvider({
  controller,
  children,
}: {
  controller: ChromeController;
  children: React.ReactNode;
}) {
  useContentOnlyExitKeys(controller);
  return <ChromeCtx.Provider value={controller}>{children}</ChromeCtx.Provider>;
}

/** 按 id 包裹 chrome 槽位；隐藏时真隐藏（无 hit-test） */
export function ChromeSlot({
  id,
  testId,
  children,
  /** true=隐藏时卸载（更彻底）；false=display:none */
  unmountWhenHidden = false,
}: {
  id: ChromeComponentId;
  testId?: string;
  children: React.ReactNode;
  unmountWhenHidden?: boolean;
}) {
  const controller = useOptionalChromeController();
  if (!controller) return <>{children}</>;
  return (
    <ChromeSlotInner
      controller={controller}
      id={id}
      testId={testId}
      unmountWhenHidden={unmountWhenHidden}
    >
      {children}
    </ChromeSlotInner>
  );
}

function ChromeSlotInner({
  controller,
  id,
  testId,
  unmountWhenHidden,
  children,
}: {
  controller: ChromeController;
  id: ChromeComponentId;
  testId?: string;
  unmountWhenHidden: boolean;
  children: React.ReactNode;
}) {
  const snap = useChromeSnapshot(controller);
  const visible = snap.visibility[id] !== false;
  if (unmountWhenHidden && !visible) return null;
  const props = chromeSlotProps(visible, testId);
  return (
    <div {...props} data-chrome-id={id}>
      {children}
    </div>
  );
}

/** 编辑模式工具条：逐项开关 + 保存/取消 */
export function ChromeEditBar() {
  const controller = useOptionalChromeController();
  if (!controller) return null;
  return <ChromeEditBarInner controller={controller} />;
}

function ChromeEditBarInner({ controller }: { controller: ChromeController }) {
  const snap = useChromeSnapshot(controller);
  if (!snap.editMode) return null;
  const present = controller.listComponents().filter((m) => m.present);

  return (
    <div className="kb-chrome-edit-bar" data-testid="chrome-edit-bar">
      <strong>布局编辑</strong>
      {present.map((m) => (
        <label key={m.id}>
          <input
            type="checkbox"
            data-testid={`chrome-edit-toggle-${m.id}`}
            checked={snap.visibility[m.id] !== false}
            disabled={snap.contentOnly}
            onChange={(e) => controller.setVisible(m.id, e.target.checked)}
          />
          {m.id.replace(/^chrome\./, '')}
        </label>
      ))}
      <span className="spacer" style={{ flex: 1 }} />
      {snap.dirty && <span data-testid="chrome-edit-dirty">未保存</span>}
      <button
        type="button"
        className="kb-button kb-button--secondary kb-button--small"
        data-testid="chrome-commit-edit"
        onClick={() => controller.commitEdit()}
      >
        保存
      </button>
      <button
        type="button"
        className="kb-button kb-button--ghost kb-button--small"
        data-testid="chrome-cancel-edit"
        onClick={() => controller.cancelEdit()}
      >
        取消
      </button>
    </div>
  );
}

/** 浮动：只看内容 / 编辑布局 / 恢复 */
export function ChromeFab() {
  const controller = useOptionalChromeController();
  if (!controller) return null;
  return <ChromeFabInner controller={controller} />;
}

function ChromeFabInner({ controller }: { controller: ChromeController }) {
  const snap = useChromeSnapshot(controller);

  const toggleContentOnly = useCallback(() => {
    if (snap.contentOnly && controller.shouldExitContentOnlyOnSameCommand()) {
      controller.setContentOnly(false);
    } else if (!snap.contentOnly) {
      controller.setContentOnly(true);
    } else {
      controller.setContentOnly(false);
    }
  }, [controller, snap.contentOnly]);

  return (
    <div className="kb-chrome-fab" data-testid="chrome-fab">
      <button
        type="button"
        className="kb-button kb-button--secondary kb-button--small"
        data-testid="chrome-content-only-toggle"
        title="只看内容（再按或 Esc 退出）"
        onClick={toggleContentOnly}
      >
        {snap.contentOnly ? '退出只看内容' : '只看内容'}
      </button>
      <button
        type="button"
        className="kb-button kb-button--ghost kb-button--small"
        data-testid="chrome-edit-mode-toggle"
        onClick={() => controller.setEditMode(!snap.editMode)}
      >
        {snap.editMode ? '结束编辑' : '编辑布局'}
      </button>
      <button
        type="button"
        className="kb-button kb-button--ghost kb-button--small"
        data-testid="chrome-restore"
        onClick={() => controller.restore()}
      >
        恢复布局
      </button>
    </div>
  );
}

/** 根包装：标记 contentOnly，供样式与测试 */
export function ChromeRoot({
  controller,
  children,
}: {
  controller: ChromeController;
  children: React.ReactNode;
}) {
  const snap = useChromeSnapshot(controller);
  return (
    <div
      className="kb-chrome-root"
      data-content-only={snap.contentOnly ? 'true' : 'false'}
      data-edit-mode={snap.editMode ? 'true' : 'false'}
      data-testid="chrome-root"
    >
      {children}
    </div>
  );
}

/** 便捷：一次挂好 Provider + EditBar + Fab */
export function ChromeLayoutRoot({
  controller,
  children,
  showFab = true,
}: {
  controller: ChromeController;
  children: React.ReactNode;
  showFab?: boolean;
}) {
  return (
    <ChromeProvider controller={controller}>
      <ChromeRoot controller={controller}>
        <ChromeEditBar />
        {children}
        {showFab && <ChromeFab />}
      </ChromeRoot>
    </ChromeProvider>
  );
}

export type { ChromeStateSnapshot };
