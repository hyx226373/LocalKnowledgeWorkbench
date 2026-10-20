/**
 * Rediscovery matching for SourceDescriptor ↔ live sources.
 * Used by capture service restore path; unit-tested in desktop-capture.test.ts.
 */
import type { SourceDescriptor } from './types';

export interface SourceMatchCandidate {
  descriptor: SourceDescriptor;
  /** Optional live capturer id for ranking only — never persisted. */
  captureId?: string;
}

/**
 * Score how well `candidate` matches `wanted`.
 * Higher is better; < 0 means hard reject.
 */
export function scoreSourceMatch(
  wanted: SourceDescriptor,
  candidate: SourceDescriptor
): number {
  if (wanted.v !== 1 || candidate.v !== 1) return -1;

  let score = 0;

  if (wanted.displayKey && candidate.displayKey) {
    if (wanted.displayKey === candidate.displayKey) score += 100;
    else {
      // Soft: compare numeric Electron display.id if both look numeric
      const a = Number(wanted.displayKey);
      const b = Number(candidate.displayKey);
      if (Number.isFinite(a) && Number.isFinite(b) && a === b) score += 100;
      else score -= 50;
    }
  }

  const wh = wanted.mediaSourceHint?.display_id;
  const ch = candidate.mediaSourceHint?.display_id;
  if (wh && ch) {
    if (wh === ch) score += 40;
    else score -= 10;
  }

  const wn = wanted.mediaSourceHint?.name;
  const cn = candidate.mediaSourceHint?.name;
  if (wn && cn) {
    if (wn === cn) score += 20;
    else if (wn.toLowerCase() === cn.toLowerCase()) score += 10;
  }

  // Bounds: same origin + size within tolerance after resolution change
  const wb = wanted.bounds;
  const cb = candidate.bounds;
  if (wb && cb) {
    if (wb.x === cb.x && wb.y === cb.y) score += 15;
    if (wb.width === cb.width && wb.height === cb.height) score += 15;
    else {
      // Resolution changed but same displayKey already scored — mild penalty only
      score -= 5;
    }
  }

  if (wanted.scaleFactor && candidate.scaleFactor) {
    if (wanted.scaleFactor === candidate.scaleFactor) score += 5;
  }

  return score;
}

/**
 * Pick best live source for a persisted descriptor.
 * Returns null when no candidate scores above threshold (explicit failure).
 */
export function rediscoverSource(
  wanted: SourceDescriptor,
  live: SourceDescriptor[],
  minScore = 50
): SourceDescriptor | null {
  let best: SourceDescriptor | null = null;
  let bestScore = -Infinity;
  for (const c of live) {
    const s = scoreSourceMatch(wanted, c);
    if (s > bestScore) {
      bestScore = s;
      best = c;
    }
  }
  if (!best || bestScore < minScore) return null;
  return best;
}

/** Serialize for workspace JSON — strips any accidental captureId. */
export function serializeSourceForPersist(source: SourceDescriptor): SourceDescriptor {
  const out: SourceDescriptor = {
    v: 1,
    displayKey: source.displayKey,
    label: source.label,
    bounds: { ...source.bounds },
    scaleFactor: source.scaleFactor,
  };
  if (source.mediaSourceHint) {
    out.mediaSourceHint = { ...source.mediaSourceHint };
  }
  return out;
}

/** Guard: reject persist blobs that illegally carry captureId/sessionId. */
export function assertNoEphemeralIds(persistJson: unknown): void {
  const raw = JSON.stringify(persistJson);
  if (/"captureId"\s*:/.test(raw)) {
    throw new Error('DesktopPanelLayoutPersist must not contain captureId');
  }
  if (/"sessionId"\s*:/.test(raw)) {
    throw new Error('DesktopPanelLayoutPersist must not contain sessionId');
  }
}
