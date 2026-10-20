/**
 * Production source for layout LayoutHost.getPanels → window.__kbNativePanels.
 * Layout alone calls host.setVisible; plugin only publishes attached/shouldShow.
 * Closes INTEG-L1 gap that left resting native visibility false after attach.
 */
export const NATIVE_PANELS_HOOK = '__kbNativePanels' as const;

export interface NativePanelRef {
  id: string;
  layout: { x: number; y: number; w: number; h: number };
  attached: boolean;
  /** After attach: true so layout host setVisible(true); modal hide is separate. */
  shouldShow: boolean;
}

function getGlobal(): Record<string, unknown> | null {
  try {
    return (typeof window !== 'undefined' ? window : globalThis) as unknown as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function listNativePanels(): NativePanelRef[] {
  const g = getGlobal();
  const cur = g?.[NATIVE_PANELS_HOOK];
  if (!Array.isArray(cur)) return [];
  return cur.map((p) => {
    const o = p as NativePanelRef;
    return {
      id: String(o.id),
      layout: {
        x: Number(o.layout?.x) || 0,
        y: Number(o.layout?.y) || 0,
        w: Number(o.layout?.w) || 0,
        h: Number(o.layout?.h) || 0,
      },
      attached: !!o.attached,
      shouldShow: o.shouldShow !== false,
    };
  });
}

/** Upsert one panel; layout reads this on sync. */
export function upsertNativePanel(ref: NativePanelRef): NativePanelRef[] {
  const g = getGlobal();
  if (!g) return [ref];
  const prev = listNativePanels().filter((p) => p.id !== ref.id);
  const next = [...prev, { ...ref, layout: { ...ref.layout } }];
  g[NATIVE_PANELS_HOOK] = next;
  return next;
}

export function removeNativePanel(panelId: string): NativePanelRef[] {
  const g = getGlobal();
  const next = listNativePanels().filter((p) => p.id !== panelId);
  if (g) g[NATIVE_PANELS_HOOK] = next;
  return next;
}

/** Test helper. */
export function resetNativePanelsForTests(): void {
  const g = getGlobal();
  if (g) g[NATIVE_PANELS_HOOK] = [];
}

/**
 * Resting visibility for layout: attached + shouldShow.
 * Modal/occlusion hide is layout's job (setVisible false when occluded).
 */
export function restingShouldShow(opts: { bound: boolean; occluded: boolean }): boolean {
  return opts.bound && !opts.occluded;
}
