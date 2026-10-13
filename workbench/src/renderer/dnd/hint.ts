const listeners = new Set<() => void>();
let hint = '';

export function setLiveHint(text: string) {
  if (hint === text) return;
  hint = text;
  listeners.forEach((l) => l());
}

export function liveHint() {
  return hint;
}

export function subscribeHint(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
