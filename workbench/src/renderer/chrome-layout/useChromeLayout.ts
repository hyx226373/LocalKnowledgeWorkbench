/**
 * React 订阅 ChromeController 快照
 */
import { useCallback, useEffect, useMemo, useSyncExternalStore, type CSSProperties } from 'react';
import type { ChromeComponentId, ChromeStateSnapshot } from '../../shared/chromeLayout';
import type { ChromeController } from './controller';
import { exitContentOnly } from './contentOnlyCommands';

export function useChromeSnapshot(controller: ChromeController): ChromeStateSnapshot {
  const get = useCallback(() => controller.getVisibility(), [controller]);
  const subscribe = useCallback(
    (onStore: () => void) => controller.subscribe(() => onStore()),
    [controller],
  );
  return useSyncExternalStore(subscribe, get, get);
}

export function useChromeVisible(controller: ChromeController, id: ChromeComponentId): boolean {
  const snap = useChromeSnapshot(controller);
  return snap.visibility[id] !== false;
}

/** 真隐藏样式 props：hidden 时 display:none + pointer-events none（无透明遮罩） */
export function chromeSlotProps(
  visible: boolean,
  testId?: string,
): {
  'data-chrome-hidden': 'true' | 'false';
  'data-testid'?: string;
  style: CSSProperties;
  className: string;
} {
  const hidden = !visible;
  return {
    'data-chrome-hidden': hidden ? 'true' : 'false',
    ...(testId ? { 'data-testid': testId } : {}),
    className: 'kb-chrome-slot',
    style: hidden
      ? {
          display: 'none',
          pointerEvents: 'none',
          visibility: 'hidden',
        }
      : {},
  };
}

/** Esc / 同一命令退出只看内容 */
export function useContentOnlyExitKeys(controller: ChromeController): void {
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape' && controller.shouldExitContentOnlyOnEscape()) {
        ev.preventDefault();
        // Esc 仅网页焦点时可达；NPP 持焦时由 main/integ 转发同命令到 exitContentOnly hook
        exitContentOnly(controller);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [controller]);
}

export function usePresentComponents(controller: ChromeController) {
  return useMemo(() => controller.listComponents().filter((m) => m.present), [controller]);
}
