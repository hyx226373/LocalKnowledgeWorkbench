/**
 * proposeAttach / proposeDetach — never silent; user confirm required and cancellable (VC-L1-09).
 */
import type {
  HostAttachResponse,
  HostOkResponse,
  NativeHostCandidate,
} from '../../../shared/nativeAppHost';
import type { NativeHostClient } from './hostClient';

export type ConfirmFn = (input: {
  title: string;
  body: string;
  candidate?: NativeHostCandidate;
}) => Promise<boolean>;

export type ProposeAttachResult =
  | { ok: true; response: Extract<HostAttachResponse, { ok: true }> }
  | { ok: false; cancelled: true }
  | { ok: false; cancelled?: false; error: Extract<HostAttachResponse, { ok: false }> };

export type ProposeDetachResult =
  | { ok: true; response: HostOkResponse }
  | { ok: false; cancelled: true }
  | { ok: false; cancelled?: false; error: Extract<HostOkResponse, { ok: false }> };

/**
 * User must confirm before host.attach. Cancel → no attach call.
 */
export async function proposeAttach(opts: {
  client: NativeHostClient;
  panelId: string;
  candidate: NativeHostCandidate;
  confirm: ConfirmFn;
  bounds?: { x: number; y: number; width: number; height: number };
}): Promise<ProposeAttachResult> {
  const { client, panelId, candidate, confirm, bounds } = opts;
  const accepted = await confirm({
    title: '确认接入外部窗口',
    body: `将托管「${candidate.title}」\n${candidate.path}\n(pid ${candidate.pid})。可取消。`,
    candidate,
  });
  if (!accepted) {
    return { ok: false, cancelled: true };
  }
  const response = await client.attach({
    identity: {
      hwnd: candidate.hwnd,
      pid: candidate.pid,
      createTime: candidate.createTime,
      path: candidate.path,
    },
    panelId,
    bounds,
  });
  if (!response.ok) {
    return { ok: false, error: response };
  }
  return { ok: true, response };
}

export async function proposeDetach(opts: {
  client: NativeHostClient;
  bindingId: string;
  titleHint?: string;
  confirm: ConfirmFn;
}): Promise<ProposeDetachResult> {
  const accepted = await opts.confirm({
    title: '确认释放托管',
    body: `释放「${opts.titleHint ?? opts.bindingId}」？可取消。`,
  });
  if (!accepted) return { ok: false, cancelled: true };
  const response = await opts.client.detach({ bindingId: opts.bindingId });
  if (!response.ok) return { ok: false, error: response };
  return { ok: true, response };
}

/** Default confirm for UI — uses dialogs when available; injectable in tests. */
export async function defaultConfirm(input: {
  title: string;
  body: string;
}): Promise<boolean> {
  try {
    // Lazy import to keep unit tests free of React dialogs module side effects when injected.
    const { dialogs } = await import('../../ui/dialogs');
    return dialogs.confirm({ title: input.title, body: input.body, ok: '确认接入', cancel: '取消' });
  } catch {
    return false;
  }
}
