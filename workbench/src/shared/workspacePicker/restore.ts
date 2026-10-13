/**
 * 把已有来源折成 RestoreEvent。
 * 无来源是 unknown。挂载帧（readyOnMount）和未声明 reportsReady 的定位都不算 restored。
 */
import type { RestoreEvent, RestorePhase, RestoreSource, WebPhaseEvent } from './types';

function make(
  workspaceId: string,
  panelId: string,
  phase: RestorePhase,
  retryable: boolean,
  reason?: string,
  host?: RestoreEvent['host'],
): RestoreEvent {
  const out: RestoreEvent = { workspaceId, panelId, phase, retryable };
  if (reason !== undefined) out.reason = reason;
  if (host) out.host = host;
  return out;
}

function navId(ev: WebPhaseEvent): string {
  return typeof ev.navigationId === 'string' && ev.navigationId ? ev.navigationId : 'same';
}

function filePhase(workspaceId: string, panelId: string, source: Extract<RestoreSource, { kind: 'file' }>): RestoreEvent {
  if (source.armed === false) return make(workspaceId, panelId, 'preparing', false);
  const resource = source.resource;
  if (source.armed && resource == null) return make(workspaceId, panelId, 'loading', false);
  if (resource && resource.missing === true) return make(workspaceId, panelId, 'failed', true, 'resource-missing');
  // 只有适配器声明了 reportsReady 且内容回调已到，才是 restored。readyOnMount 不能顶上。
  if (source.reportsReady === true && source.contentReady === true) return make(workspaceId, panelId, 'restored', false);
  const located = resource != null && resource.missing !== true;
  if (located) return make(workspaceId, panelId, 'unknown', false, 'no-content-event');
  return make(workspaceId, panelId, 'unknown', false);
}

function webPhase(workspaceId: string, panelId: string, source: Extract<RestoreSource, { kind: 'web' }>): RestoreEvent {
  if (source.hasView === false) return make(workspaceId, panelId, 'unknown', false);
  const events = Array.isArray(source.events) ? source.events : [];
  let phase: RestorePhase = 'unknown';
  let reason: string | undefined;
  let retryable = false;
  let failedNav: string | null = null;
  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue;
    const nav = navId(ev);
    if (failedNav && nav !== failedNav) failedNav = null;
    if (ev.type === 'site-prompt' || ev.state === 'site-prompt') {
      phase = 'unavailable';
      reason = 'site-prompt';
      retryable = false;
      failedNav = null;
      continue;
    }
    if (ev.type === 'blocked' && ev.reason === 'domain-blocked') {
      phase = 'unavailable';
      reason = 'domain-blocked';
      retryable = false;
      failedNav = null;
      continue;
    }
    if (ev.type === 'gone' || ev.state === 'failed') {
      phase = 'failed';
      retryable = true;
      reason = ev.type === 'gone' ? (ev.reason ?? 'gone') : (ev.error ?? ev.reason ?? 'failed');
      failedNav = nav;
      continue;
    }
    if (ev.type === 'ready' || ev.state === 'ready') {
      // 同一次导航在 failed/gone 之后，随后的 ready 保持 failed。
      if (failedNav === nav) continue;
      phase = 'restored';
      reason = undefined;
      retryable = false;
      continue;
    }
    if (ev.state === 'loading') {
      if (failedNav === nav) continue;
      phase = 'loading';
      reason = undefined;
      retryable = false;
    }
  }
  return make(workspaceId, panelId, phase, retryable, reason);
}

function failureText(launch: { failure?: string; reason?: string }): string {
  const v = launch.failure ?? launch.reason;
  return typeof v === 'string' ? v : 'failed';
}

function appPhase(workspaceId: string, panelId: string, source: Extract<RestoreSource, { kind: 'app' }>): RestoreEvent {
  if (source.opened === false) return make(workspaceId, panelId, 'unavailable', false, 'manual-open');
  if (source.opened === true && source.crashed === true) return make(workspaceId, panelId, 'failed', true, 'crashed');
  if (source.opened === true && source.exited === true && source.crashed !== true) return make(workspaceId, panelId, 'unknown', false);
  if (source.opened === true && source.launch && source.launch.ok === false) {
    return make(workspaceId, panelId, 'failed', true, failureText(source.launch));
  }
  if (source.launch && source.launch.ok === true) return make(workspaceId, panelId, 'restored', false);
  return make(workspaceId, panelId, 'unknown', false);
}

function nativePhase(workspaceId: string, panelId: string, source: Extract<RestoreSource, { kind: 'native-host' }>): RestoreEvent {
  const layout: RestorePhase = source.layoutApplied ? 'restored' : 'unknown';
  if (source.integLinked === false) {
    return make(workspaceId, panelId, 'unavailable', false, 'not-in-integ', {
      layout,
      attach: 'unavailable',
      document: 'unavailable',
    });
  }
  if (source.hostGate === true) {
    return make(workspaceId, panelId, 'unavailable', false, 'host-gate', {
      layout,
      attach: 'unavailable',
      document: 'unavailable',
    });
  }
  if (source.hostGate === false && source.userOpened !== true) {
    return make(workspaceId, panelId, 'unavailable', false, 'manual-open', {
      layout,
      attach: 'unavailable',
      document: 'unknown',
    });
  }
  return make(workspaceId, panelId, 'unknown', false, undefined, {
    layout,
    attach: 'unknown',
    document: 'unknown',
  });
}

export function restorePhase(input: { workspaceId: string; panelId: string; source?: RestoreSource | null }): RestoreEvent {
  const { workspaceId, panelId } = input;
  const source = input.source;
  if (!source || source.kind === 'none') return make(workspaceId, panelId, 'unknown', false);
  switch (source.kind) {
    case 'file':
      return filePhase(workspaceId, panelId, source);
    case 'web':
      return webPhase(workspaceId, panelId, source);
    case 'app':
      return appPhase(workspaceId, panelId, source);
    case 'native-host':
      return nativePhase(workspaceId, panelId, source);
    default:
      return make(workspaceId, panelId, 'unknown', false);
  }
}
