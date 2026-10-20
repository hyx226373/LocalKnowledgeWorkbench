/**
 * host-r1-layout · chrome 可隐藏 + 布局宿主（阶段 B）
 */
export * from './registry';
export * from './persistence';
export * from './controller';
export * from './hostClient';
export * from './layoutHost';
export * from './eventTransport';
export * from './overlayRegistry';
export * from './hostCallQueue';
export * from './workspacePersistAdapter';
export * from './resizeResync';
export * from './contentOnlyCommands';
export * from './shortcutConflict';
export {
  ChromeProvider,
  ChromeSlot,
  ChromeEditBar,
  ChromeFab,
  ChromeRoot,
  ChromeLayoutRoot,
  useChromeController,
  useOptionalChromeController,
} from './ChromeShell';
export {
  useChromeSnapshot,
  useChromeVisible,
  chromeSlotProps,
  useContentOnlyExitKeys,
} from './useChromeLayout';

export * from './shortcutsConfig';
export * from './displayList';
