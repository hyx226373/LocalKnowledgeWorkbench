/**
 * Electron native-app-host service — product capabilities only.
 * Enumerate / attach / setBounds / show-hide / activate / detach / getState /
 * screen↔panel coords / identity hwnd+pid+createTime+path.
 */
import { randomUUID } from 'node:crypto';
import {
  identitiesMatch,
  assertIdentityShape,
  normalizeAttachIdentity,
  toPersistPayload,
  screenToPanel,
  panelToScreen,
  panelBoundsForNative,
  pickDisplayForRect,
} from '../../shared/nativeAppHost';
import type {
  DisplayMetrics,
  HostActivateRequest,
  HostAttachRequest,
  HostAttachResponse,
  HostCoordRequest,
  HostCoordResponse,
  HostDetachRequest,
  HostGetStateRequest,
  HostListDiagnostics,
  HostListResponse,
  HostOkResponse,
  HostSetBoundsRequest,
  HostSetVisibleRequest,
  HostStateResponse,
  NativeAppHostPersist,
  NativeHostCandidate,
  NativeHostIdentity,
  NativeHostStateSnapshot,
  PanelScreenRect,
} from '../../shared/nativeAppHost/types';
import {
  canOperate,
  canReattach,
  isZombieRisk,
  reduceBinding,
  type BindingRecord,
} from './bindingState';
import {
  createWin32Helper,
  NativeHelperError,
  type Win32NativeHelper,
} from './win32Helper';

export type ParentHwndResolver = (panelId: string) => string | null;

export interface NativeHostServiceOptions {
  helper?: Win32NativeHelper;
  /** Resolve Electron content HWND for a panel (win32). */
  resolveParentHwnd?: ParentHwndResolver;
  /** Supply display list for DPI-aware bounds (from Electron screen). */
  listDisplays?: () => DisplayMetrics[];
  now?: () => number;
}

export class NativeHostService {
  private readonly helper: Win32NativeHelper;
  private readonly resolveParentHwnd: ParentHwndResolver;
  private readonly listDisplays: () => DisplayMetrics[];
  private readonly now: () => number;
  /** bindingId → record */
  private readonly bindings = new Map<string, BindingRecord>();
  /** panelId → bindingId */
  private readonly byPanel = new Map<string, string>();

  constructor(opts: NativeHostServiceOptions = {}) {
    this.helper = opts.helper ?? createWin32Helper();
    this.resolveParentHwnd = opts.resolveParentHwnd ?? (() => null);
    this.listDisplays = opts.listDisplays ?? (() => [{ bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 }]);
    this.now = opts.now ?? Date.now;
  }

  getHelper(): Win32NativeHelper {
    return this.helper;
  }

  async list(): Promise<HostListResponse> {
    const platform = this.helper.platform;
    if (!this.helper.isSupported()) {
      return {
        ok: false,
        code: 'PLATFORM_UNSUPPORTED',
        message: `host.list requires win32 (current: ${platform})`,
        platform,
      };
    }
    try {
      const raw = await this.helper.listTopLevelWindows();
      // host-r1 L2: list must carry full identity (attach rejects createTime<=0).
      const candidates = raw.filter((c) => !!c && typeof c.hwnd === 'string' && c.pid > 0 && c.createTime > 0 && !!c.path);
      const diag = (this.helper as { lastListDiagnostics?: HostListDiagnostics }).lastListDiagnostics;
      const diagnostics: HostListDiagnostics = diag
        ? { ...diag, skippedNoIdentity: diag.skippedNoIdentity + (raw.length - candidates.length) }
        : { enumerated: raw.length, candidates: candidates.length, errors: 0, skippedNoIdentity: raw.length - candidates.length, firstError: null };
      diagnostics.candidates = candidates.length;
      return { ok: true, candidates, platform, diagnostics };
    } catch (e) {
      const err = asHelperError(e);
      return {
        ok: false,
        code: err.code === 'PLATFORM_UNSUPPORTED' ? 'PLATFORM_UNSUPPORTED' : err.code === 'HELPER_UNAVAILABLE' ? 'HELPER_UNAVAILABLE' : 'ENUM_FAILED',
        message: err.message,
        platform,
      };
    }
  }

  /**
   * Attach only after explicit list selection — caller must pass the full identity
   * from a prior host.list candidate. No silent attach of unauthorized windows.
   */
  async attach(req: HostAttachRequest): Promise<HostAttachResponse> {
    // host-r1 L2: never throw / crash on a malformed request; answer explicitly.
    try {
      return await this.attachInner(req);
    } catch (e) {
      return mapOpError(e);
    }
  }

  private async attachInner(rawReq: HostAttachRequest): Promise<HostAttachResponse> {
    if (!rawReq || typeof rawReq !== 'object') {
      return { ok: false, code: 'UNAUTHORIZED', message: 'attach request required' };
    }
    const norm = normalizeAttachIdentity(rawReq.identity);
    if (!norm.ok) {
      return {
        ok: false,
        code: 'IDENTITY_INCOMPLETE',
        missing: norm.missing,
        message: `identity incomplete: missing/invalid ${norm.missing.join(', ')}; pass the full candidate from host.list (hwnd,pid,createTime,path)`,
      };
    }
    const req: HostAttachRequest = { ...rawReq, identity: norm.identity };
    assertIdentityShape(req.identity as NativeHostIdentity);
    if (!req.panelId) {
      return { ok: false, code: 'UNAUTHORIZED', message: 'panelId required' };
    }
    if (!this.helper.isSupported()) {
      return {
        ok: false,
        code: 'PLATFORM_UNSUPPORTED',
        message: `host.attach requires win32 (current: ${this.helper.platform})`,
      };
    }

    const existingId = this.byPanel.get(req.panelId);
    if (existingId) {
      const existing = this.bindings.get(existingId);
      if (existing && existing.state !== 'invalid') {
        return { ok: false, code: 'ALREADY_ATTACHED', message: `panel ${req.panelId} already has binding ${existingId}` };
      }
      // Clear invalid binding to allow re-attach
      if (existing) this.clearBinding(existingId);
    }

    try {
      const live = await this.helper.readIdentity(req.identity.hwnd);
      if (!identitiesMatch(live, req.identity)) {
        const diff: string[] = [];
        if (live.pid !== req.identity.pid) diff.push(`pid live=${live.pid} req=${req.identity.pid}`);
        if (live.createTime !== req.identity.createTime) diff.push(`createTime live=${live.createTime} req=${req.identity.createTime}`);
        if (live.path.toLowerCase() !== req.identity.path.toLowerCase()) diff.push('path differs');
        return {
          ok: false,
          code: 'IDENTITY_MISMATCH',
          message: `candidate identity no longer matches live window (pid reuse or hwnd recycle): ${diff.join('; ') || 'hwnd'}`,
        };
      }

      const parentHwnd = this.resolveParentHwnd(req.panelId);
      let originalParentHwnd: string | null = null;
      if (parentHwnd) {
        const r = await this.helper.attach(live.hwnd, { hwnd: parentHwnd });
        originalParentHwnd = r.originalParentHwnd;
      } else {
        // Still record binding; bounds/visibility can apply. Parent may be set later on win32.
        await this.helper.attach(live.hwnd, { hwnd: '0' });
      }

      if (req.bounds) {
        const displays = this.listDisplays();
        const d = pickDisplayForRect(req.bounds, displays);
        const physical = panelBoundsForNative(
          { ...req.bounds, scaleFactor: d.scaleFactor },
          { usePhysical: false },
        );
        await this.helper.setBounds(live.hwnd, physical);
        await this.helper.setVisible(live.hwnd, true);
      }

      const bindingId = randomUUID();
      let rec = reduceBinding(null, {
        type: 'attach',
        bindingId,
        panelId: req.panelId,
        identity: live,
        bounds: req.bounds,
      })!;
      rec = { ...rec, hostParentHwnd: parentHwnd, originalParentHwnd };
      this.bindings.set(bindingId, rec);
      this.byPanel.set(req.panelId, bindingId);

      return { ok: true, bindingId, identity: live, state: rec.state };
    } catch (e) {
      return mapOpError(e);
    }
  }

  /**
   * host-r1 L2: resolve a binding by bindingId, falling back to panelId.
   * Live failure: detach({panelId}) looked up bindings.get(undefined) -> NOT_ATTACHED.
   */
  resolveBindingId(req: { bindingId?: unknown; panelId?: unknown } | null | undefined): string | null {
    if (!req || typeof req !== 'object') return null;
    if (typeof req.bindingId === 'string' && this.bindings.has(req.bindingId)) return req.bindingId;
    if (typeof req.panelId === 'string') {
      const id = this.byPanel.get(req.panelId);
      if (id && this.bindings.has(id)) return id;
    }
    return null;
  }

  async detach(req: HostDetachRequest): Promise<HostOkResponse> {
    const r = (req ?? {}) as HostDetachRequest;
    if (typeof r.bindingId !== 'string' && typeof r.panelId !== 'string') {
      return { ok: false, code: 'NOT_ATTACHED', message: 'detach requires bindingId or panelId' };
    }
    const bindingId = this.resolveBindingId(r);
    const rec = bindingId ? this.bindings.get(bindingId) : undefined;
    if (!rec || !bindingId) {
      return {
        ok: false,
        code: 'NOT_ATTACHED',
        message: `binding not found (bindingId=${r.bindingId ?? '-'} panelId=${r.panelId ?? '-'}; live bindings=${this.bindings.size})`,
      };
    }
    try {
      const alive = await this.helper.isAlive(rec.identity.hwnd);
      if (alive) {
        await this.helper.detach(rec.identity.hwnd, rec.originalParentHwnd);
      }
      this.clearBinding(bindingId);
      return { ok: true };
    } catch (e) {
      // Still clear local binding to avoid zombie bind
      this.clearBinding(bindingId);
      return mapOpError(e);
    }
  }

  async setBounds(req: HostSetBoundsRequest): Promise<HostOkResponse> {
    const rec = await this.refreshAlive(req.bindingId);
    if (!rec) return { ok: false, code: 'NOT_ATTACHED', message: 'binding not found' };
    if (rec.state === 'invalid') return { ok: false, code: 'INVALID_BINDING', message: rec.reason ?? 'invalid' };
    if (!canOperate(rec)) return { ok: false, code: 'INVALID_BINDING', message: 'cannot setBounds' };
    try {
      const displays = this.listDisplays();
      const d = pickDisplayForRect(req.bounds, displays);
      const bounds = panelBoundsForNative({ ...req.bounds, scaleFactor: d.scaleFactor }, { usePhysical: false });
      await this.helper.setBounds(rec.identity.hwnd, bounds);
      this.bindings.set(rec.bindingId, reduceBinding(rec, { type: 'setBounds', bounds: req.bounds })!);
      return { ok: true };
    } catch (e) {
      await this.maybeInvalidate(rec, e);
      return mapOpError(e);
    }
  }

  async setVisible(req: HostSetVisibleRequest): Promise<HostOkResponse> {
    const rec = await this.refreshAlive(req.bindingId);
    if (!rec) return { ok: false, code: 'NOT_ATTACHED', message: 'binding not found' };
    if (rec.state === 'invalid') return { ok: false, code: 'INVALID_BINDING', message: rec.reason ?? 'invalid' };
    try {
      if (req.forModal && !req.visible) {
        await this.helper.setVisible(rec.identity.hwnd, false);
        this.bindings.set(rec.bindingId, reduceBinding(rec, { type: 'hideForModal' })!);
        return { ok: true };
      }
      if (req.forModal && req.visible) {
        const next = reduceBinding(rec, { type: 'restoreAfterModal' })!;
        await this.helper.setVisible(rec.identity.hwnd, next.desiredVisible);
        this.bindings.set(rec.bindingId, next);
        return { ok: true };
      }
      await this.helper.setVisible(rec.identity.hwnd, req.visible);
      this.bindings.set(rec.bindingId, reduceBinding(rec, { type: 'setVisible', visible: req.visible })!);
      return { ok: true };
    } catch (e) {
      await this.maybeInvalidate(rec, e);
      return mapOpError(e);
    }
  }

  async activate(req: HostActivateRequest): Promise<HostOkResponse> {
    const rec = await this.refreshAlive(req.bindingId);
    if (!rec) return { ok: false, code: 'NOT_ATTACHED', message: 'binding not found' };
    if (rec.state === 'invalid') return { ok: false, code: 'INVALID_BINDING', message: rec.reason ?? 'invalid' };
    if (!req.focusHost) return { ok: true };
    try {
      await this.helper.activate(rec.identity.hwnd);
      return { ok: true };
    } catch (e) {
      await this.maybeInvalidate(rec, e);
      return mapOpError(e);
    }
  }

  async getState(req: HostGetStateRequest = {}): Promise<HostStateResponse> {
    let bindingId = req.bindingId;
    if (!bindingId && req.panelId) bindingId = this.byPanel.get(req.panelId);
    if (!bindingId) {
      return {
        ok: true,
        snapshot: {
          bindingId: null,
          state: 'idle',
          identity: null,
          bounds: null,
          visible: false,
          alive: false,
          panelId: req.panelId,
        },
      };
    }
    const rec = await this.refreshAlive(bindingId);
    if (!rec) {
      return {
        ok: true,
        snapshot: {
          bindingId: null,
          state: 'idle',
          identity: null,
          bounds: null,
          visible: false,
          alive: false,
        },
      };
    }
    const alive = rec.state !== 'invalid' && (await this.helper.isAlive(rec.identity.hwnd));
    const snapshot: NativeHostStateSnapshot = {
      bindingId: rec.bindingId,
      state: rec.state,
      identity: rec.identity,
      bounds: rec.bounds,
      visible: rec.state === 'hidden-for-modal' ? false : rec.desiredVisible,
      alive,
      panelId: rec.panelId,
      reason: rec.reason,
    };
    return { ok: true, snapshot };
  }

  screenToPanel(req: HostCoordRequest): HostCoordResponse {
    try {
      return { ok: true, point: screenToPanel(req.point, req.panel) };
    } catch (e) {
      return { ok: false, code: 'OS_ERROR', message: String((e as Error).message) };
    }
  }

  panelToScreen(req: HostCoordRequest): HostCoordResponse {
    try {
      return { ok: true, point: panelToScreen(req.point, req.panel) };
    } catch (e) {
      return { ok: false, code: 'OS_ERROR', message: String((e as Error).message) };
    }
  }

  /** Build persistable fields for a binding (never includes hwnd). */
  toPersist(bindingId: string, titleHint?: string): NativeAppHostPersist | null {
    const rec = this.bindings.get(bindingId);
    if (!rec) return null;
    const b = rec.bounds;
    return toPersistPayload({
      hostPath: rec.identity.path,
      titleHint: titleHint ?? '',
      layout: b ? { x: b.x, y: b.y, w: b.width, h: b.height } : undefined,
      attachPolicy: 'reselect-on-restore',
    });
  }

  /** Whether a panel can propose attach again after force-kill. */
  canProposeAttach(panelId: string): boolean {
    const id = this.byPanel.get(panelId);
    if (!id) return true;
    return canReattach(this.bindings.get(id) ?? null);
  }

  /** Test/helper: expose binding count. */
  bindingCount(): number {
    return this.bindings.size;
  }

  private clearBinding(bindingId: string): void {
    const rec = this.bindings.get(bindingId);
    if (rec) this.byPanel.delete(rec.panelId);
    this.bindings.delete(bindingId);
  }

  private async refreshAlive(bindingId: string): Promise<BindingRecord | null> {
    const rec = this.bindings.get(bindingId);
    if (!rec) return null;
    if (rec.state === 'invalid') return rec;
    const alive = await this.helper.isAlive(rec.identity.hwnd);
    if (isZombieRisk(rec, alive)) {
      const next = reduceBinding(rec, { type: 'markInvalid', reason: 'target-process-gone' })!;
      this.bindings.set(bindingId, next);
      return next;
    }
    return rec;
  }

  private async maybeInvalidate(rec: BindingRecord, e: unknown): Promise<void> {
    const err = asHelperError(e);
    if (err.code === 'NOT_FOUND') {
      const next = reduceBinding(rec, { type: 'markInvalid', reason: 'target-process-gone' })!;
      this.bindings.set(rec.bindingId, next);
    }
  }
}

const HELPER_CODES = new Set(['PLATFORM_UNSUPPORTED', 'HELPER_UNAVAILABLE', 'ENUM_FAILED', 'NOT_FOUND', 'OS_ERROR', 'IDENTITY_MISMATCH', 'UNAUTHORIZED']);

function asHelperError(e: unknown): NativeHelperError {
  if (e instanceof NativeHelperError) return e;
  // host-r1 L2: native-app-helper (JS) throws plain Error with .code; keep it.
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && HELPER_CODES.has(code)) {
    return new NativeHelperError(code as NativeHelperError['code'], String((e as Error).message ?? e));
  }
  return new NativeHelperError('OS_ERROR', String((e as Error)?.message ?? e));
}

function mapOpError(e: unknown): HostOkResponse & { ok: false } {
  const err = asHelperError(e);
  const code =
    err.code === 'PLATFORM_UNSUPPORTED'
      ? 'PLATFORM_UNSUPPORTED'
      : err.code === 'HELPER_UNAVAILABLE'
        ? 'HELPER_UNAVAILABLE'
        : err.code === 'NOT_FOUND'
          ? 'INVALID_BINDING'
          : err.code === 'IDENTITY_MISMATCH'
            ? 'IDENTITY_MISMATCH'
            : 'OS_ERROR';
  return { ok: false, code, message: err.message };
}

/** Filter candidates for gate app Notepad++ (display hint; attach still needs explicit select). */
export function filterNotepadPpCandidates(candidates: NativeHostCandidate[]): NativeHostCandidate[] {
  return candidates.filter((c) => {
    const p = c.path.replace(/\//g, '\\').toLowerCase();
    const t = c.title.toLowerCase();
    return p.endsWith('\\notepad++.exe') || p.endsWith('notepad++.exe') || t.includes('notepad++');
  });
}

export type { PanelScreenRect, NativeHostIdentity };
