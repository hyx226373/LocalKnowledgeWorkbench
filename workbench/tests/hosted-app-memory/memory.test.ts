import { describe, expect, it } from 'vitest';
import {
  NATIVE_APP_HOST_VIEW_TYPE,
  FORBIDDEN_PERSIST_KEYS,
  emptyHostedAppMemoryState,
  saveHostedAppMemory,
  loadHostedAppMemory,
  rememberHostedApp,
  markHostedAppActive,
  isHostedAppPendingActivation,
  serializeHostedAppItemState,
  restoreHostedAppItemState,
  sanitizePersist,
} from '../../src/shared/nativeAppHost';

describe('hosted app memory (req #8)', () => {
  it('saves only persistable fields (no hwnd/pid/activation)', () => {
    let state = emptyHostedAppMemoryState();
    state = rememberHostedApp(state, {
      hostPath: 'C:/Apps/Notepad++/notepad++.exe',
      titleHint: 'NPP',
      layout: { x: 10, y: 20, w: 800, h: 600 },
    });
    state = markHostedAppActive(state, 'bind-1');
    const saved = saveHostedAppMemory(state);
    expect(saved).toMatchObject({
      viewType: NATIVE_APP_HOST_VIEW_TYPE,
      hostPath: 'c:\\apps\\notepad++\\notepad++.exe',
      titleHint: 'NPP',
      layout: { x: 10, y: 20, w: 800, h: 600 },
      attachPolicy: 'reselect-on-restore',
    });
    expect(saved).not.toHaveProperty('hwnd');
    expect(saved).not.toHaveProperty('pid');
    expect(saved).not.toHaveProperty('bindingId');
    expect(saved).not.toHaveProperty('activation');
    expect(saved).not.toHaveProperty('interaction');
  });

  it('restores pending + needsReselect and never auto-activates', () => {
    const restored = loadHostedAppMemory({
      viewType: NATIVE_APP_HOST_VIEW_TYPE,
      hostPath: 'D:\\Tools\\npp.exe',
      titleHint: 'npp',
      layout: { x: 1, y: 2, w: 3, h: 4 },
      attachPolicy: 'reselect-on-restore',
      hwnd: 'should-be-ignored-by-sanitize-path',
    });
    // hwnd in raw should fail sanitize → empty pending shell
    expect(restored.activation).toBe('pending');
    expect(restored.bindingId).toBeNull();
    expect(isHostedAppPendingActivation(restored)).toBe(true);
  });

  it('restores clean payload to pending reselect', () => {
    const restored = loadHostedAppMemory({
      viewType: NATIVE_APP_HOST_VIEW_TYPE,
      hostPath: 'D:\\Tools\\npp.exe',
      titleHint: 'npp',
      layout: { x: 1, y: 2, w: 3, h: 4 },
      attachPolicy: 'reselect-on-restore',
    });
    expect(restored.needsReselect).toBe(true);
    expect(restored.activation).toBe('pending');
    expect(restored.interaction).toBe('idle');
    expect(restored.hostPath).toBe('d:\\tools\\npp.exe');
    expect(restored.persist?.layout).toEqual({ x: 1, y: 2, w: 3, h: 4 });
  });

  it('rejects forbidden persist keys', () => {
    for (const k of FORBIDDEN_PERSIST_KEYS) {
      expect(() =>
        sanitizePersist({
          viewType: NATIVE_APP_HOST_VIEW_TYPE,
          hostPath: 'c:\\a.exe',
          titleHint: '',
          layout: { x: 0, y: 0, w: 0, h: 0 },
          attachPolicy: 'reselect-on-restore',
          [k]: 'x',
        }),
      ).toThrow(/forbidden/);
    }
    expect(() =>
      sanitizePersist({
        viewType: NATIVE_APP_HOST_VIEW_TYPE,
        hostPath: 'c:\\a.exe',
        titleHint: '',
        layout: { x: 0, y: 0, w: 0, h: 0 },
        attachPolicy: 'reselect-on-restore',
        pid: 123,
      }),
    ).toThrow(/pid/);
  });

  it('workspace adapter round-trips via state.data wrapper', () => {
    let state = rememberHostedApp(emptyHostedAppMemoryState(), {
      hostPath: 'C:\\Windows\\System32\\notepad.exe',
      titleHint: 'Notepad',
      layout: { x: 0, y: 0, w: 400, h: 300 },
    });
    state = markHostedAppActive(state, 'runtime-only');
    const itemState = serializeHostedAppItemState(state);
    expect(itemState.schemaVersion).toBe(1);
    expect(itemState.data).not.toHaveProperty('bindingId');
    const again = restoreHostedAppItemState(itemState);
    expect(again.activation).toBe('pending');
    expect(again.needsReselect).toBe(true);
    expect(again.bindingId).toBeNull();
    expect(again.hostPath).toBe('c:\\windows\\system32\\notepad.exe');
  });
});