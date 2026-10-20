/**
 * M-3 policy helpers (no electron import — unit-testable).
 * excludeSelfOk is true ONLY when C helper verified exclusion.
 * setContentProtection success alone must never flip this to true.
 */

export function computeExcludeSelfOk(helperVerified: boolean | null | undefined): boolean {
  return helperVerified === true;
}

/** Message when excludeSelf was not verified by C helper. */
export const EXCLUDE_SELF_BEST_EFFORT_MSG =
  'live (excludeSelf best-effort via setContentProtection; not verified; helper absent)';
