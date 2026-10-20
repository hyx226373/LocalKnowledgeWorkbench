/**
 * Bridge: createHostPanel command ↔ App dockview opener (mirrors desk registration shape, independent code).
 */
type OpenFn = () => string | null | Promise<string | null>;

let openFn: OpenFn | null = null;
let activeItemId: string | null = null;

export function setNativeAppHostOpener(fn: OpenFn): void {
  openFn = fn;
}

export function setActiveNativeAppHostItemId(id: string | null): void {
  activeItemId = id;
}

export function getActiveNativeAppHostItemId(): string | null {
  return activeItemId;
}

export async function createHostPanel(): Promise<string | null> {
  if (!openFn) return null;
  const id = await openFn();
  if (id) setActiveNativeAppHostItemId(id);
  return id;
}
