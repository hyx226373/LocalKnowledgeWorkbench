/**
 * host-r1 L2: GrabFrame runtime entry points on window.kb, routed through the
 * main `kb` IPC handler exactly like host.* (listed in MAIN_METHODS + preload methods).
 *
 * - grab.pickSource(opts?) -> enumerate capture sources (desktopPanel capturer);
 *   with opts.displayKey returns only the matching source (NOT_FOUND otherwise).
 * - grab.open(opts?)       -> asks the renderer to run the desktopPanel open command
 *   (kb:menu-command) and returns the sources so callers can pick without a 2nd call.
 */
import type { SourceDescriptor } from '../../shared/desktopPanel/types';
import { DESKTOP_PANEL_COMMANDS } from '../../shared/desktopPanel/commands';

export const GRAB_METHODS = ['grab.open', 'grab.pickSource'] as const;

export type RendererCommandResult =
  | { ok: true; commandId: string; value: unknown }
  | { ok: false; code: 'RENDERER_COMMAND_UNREGISTERED' | 'RENDERER_UNAVAILABLE' | 'RENDERER_COMMAND_FAILED'; commandId: string; message: string };

export interface GrabDeps {
  enumerateSources: () => Promise<SourceDescriptor[]> | SourceDescriptor[];
  /**
   * Run a renderer command and return its structured result
   * (window.__kb.runCommandResult). Preferred over sendMenuCommand.
   */
  runRendererCommand?: (commandId: string) => Promise<RendererCommandResult>;
  /** Legacy fire-and-forget dispatch; false when no window is available. */
  sendMenuCommand?: (commandId: string) => boolean;
}

export type GrabResult =
  | { ok: true; sources: SourceDescriptor[]; source?: SourceDescriptor; dispatched?: boolean; commandId?: string; rendererValue?: unknown }
  | {
      ok: false;
      code: 'NOT_FOUND' | 'ENUM_FAILED' | 'NO_WINDOW' | 'RENDERER_COMMAND_UNREGISTERED' | 'RENDERER_UNAVAILABLE' | 'RENDERER_COMMAND_FAILED';
      message: string;
      sources?: SourceDescriptor[];
      commandId?: string;
    };

function pickOpts(raw: unknown): { displayKey?: string } {
  if (!raw || typeof raw !== 'object') return {};
  const o = raw as Record<string, unknown>;
  return typeof o.displayKey === 'string' && o.displayKey ? { displayKey: o.displayKey } : {};
}

async function listSources(deps: GrabDeps): Promise<{ ok: true; sources: SourceDescriptor[] } | { ok: false; message: string }> {
  try {
    const sources = await deps.enumerateSources();
    return { ok: true, sources: Array.isArray(sources) ? sources : [] };
  } catch (e) {
    return { ok: false, message: String((e as Error)?.message ?? e) };
  }
}

export function grabMethodTable(deps: GrabDeps): Record<string, (...args: unknown[]) => Promise<GrabResult>> {
  return {
    'grab.pickSource': async (raw?: unknown) => {
      const r = await listSources(deps);
      if (!r.ok) return { ok: false, code: 'ENUM_FAILED', message: r.message };
      const { displayKey } = pickOpts(raw);
      if (!displayKey) return { ok: true, sources: r.sources };
      const source = r.sources.find((s) => s.displayKey === displayKey);
      if (!source) return { ok: false, code: 'NOT_FOUND', message: `no capture source with displayKey ${displayKey}`, sources: r.sources };
      return { ok: true, sources: r.sources, source };
    },
    'grab.open': async () => {
      const r = await listSources(deps);
      if (!r.ok) return { ok: false, code: 'ENUM_FAILED', message: r.message };
      const commandId = DESKTOP_PANEL_COMMANDS.open;
      if (deps.runRendererCommand) {
        let res: RendererCommandResult;
        try {
          res = await deps.runRendererCommand(commandId);
        } catch (e) {
          res = { ok: false, code: 'RENDERER_UNAVAILABLE', commandId, message: String((e as Error)?.message ?? e) };
        }
        if (!res || typeof res !== 'object') {
          res = { ok: false, code: 'RENDERER_UNAVAILABLE', commandId, message: 'renderer returned no result (window.__kb.runCommandResult missing?)' };
        }
        if (!res.ok) return { ok: false, code: res.code, message: res.message, sources: r.sources, commandId };
        return { ok: true, sources: r.sources, dispatched: true, commandId, rendererValue: res.value ?? null };
      }
      const dispatched = deps.sendMenuCommand ? deps.sendMenuCommand(commandId) : false;
      if (!dispatched) return { ok: false, code: 'NO_WINDOW', message: 'main window not available', sources: r.sources, commandId };
      return { ok: true, sources: r.sources, dispatched, commandId };
    },
  };
}
