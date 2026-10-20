/**
 * startup-ready-race / imgfix: a kbfile: image requested before the data plane is ready gets 503.
 * If the request started before readiness, wait for kb:plane-ready and reload with a cache-bust query
 * (parseKbfileUrl only reads the path, so ?kbr=N is ignored by the main process).
 */
export function withCacheBust(url: string, n: number): string {
  if (!n) return url;
  const hash = url.indexOf('#');
  const base = hash >= 0 ? url.slice(0, hash) : url;
  const frag = hash >= 0 ? url.slice(hash) : '';
  return `${base}${base.includes('?') ? '&' : '?'}kbr=${n}${frag}`;
}

export interface ReadyApi {
  isDataReady?: () => boolean;
  whenDataReady?: () => Promise<void>;
}

export const MAX_EARLY_RETRIES = 2;

/**
 * Decide what to do on an image error. Returns true when a retry was scheduled (caller must NOT show the error UI).
 * startedBeforeReady: the src was assigned while the plane was not ready yet.
 */
export function scheduleEarlyRetry(api: ReadyApi | undefined, startedBeforeReady: boolean, attempts: number, retry: () => void): boolean {
  if (!startedBeforeReady || attempts >= MAX_EARLY_RETRIES || !api?.whenDataReady) return false;
  void api.whenDataReady().then(retry);
  return true;
}

export function dataReadyNow(api: ReadyApi | undefined): boolean {
  return api?.isDataReady ? api.isDataReady() : true;
}