/**
 * startup-ready-race / imgfix: kbfile:/kbplugin: are registered before the window opens (fd6724a opens it before
 * plane.ready; a scheme registered after the frame navigated stays ERR_UNKNOWN_URL_SCHEME for that page).
 * Until the data plane is ready the handlers answer 503 so the renderer can retry after kb:plane-ready.
 */
export const PROTOCOL_NOT_READY_STATUS = 503;

export function protocolNotReady(ready: boolean, headers?: Record<string, string>): Response | null {
  if (ready) return null;
  return new Response('data plane not ready', { status: PROTOCOL_NOT_READY_STATUS, headers: { 'Retry-After': '1', 'Cache-Control': 'no-store', ...(headers ?? {}) } });
}

/** Idempotent registration guard (early call before createWindow; the old post-ready call becomes a no-op). */
export function once(fn: () => void): () => boolean {
  let done = false;
  return () => {
    if (done) return false;
    done = true;
    fn();
    return true;
  };
}