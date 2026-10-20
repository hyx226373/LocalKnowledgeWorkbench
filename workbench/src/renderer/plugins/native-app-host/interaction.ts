/**
 * Interaction mode state machine for native-app-host.
 * Rules (01 §4): no hover-enter; first-click consume; Escape exits interacting.
 * the user 03: exit content-only → exit hosted interaction (plugin responds, does not emit).
 */

export type InteractionMode = 'idle' | 'attached' | 'interacting';

/** Product activation (03 §3): restore/mount always pending until user activates. */
export type ActivationState = 'pending' | 'active';

export type InteractionEvent =
  | { type: 'attached' }
  | { type: 'detached' }
  | { type: 'first-click' }
  | { type: 'enter' }
  | { type: 'exit' }
  | { type: 'hover' };

export function reduceInteraction(mode: InteractionMode, event: InteractionEvent): InteractionMode {
  switch (event.type) {
    case 'detached':
      return 'idle';
    case 'attached':
      // Never auto-promote to interacting (restore/mount stay non-interacting).
      return mode === 'interacting' ? 'interacting' : 'attached';
    case 'hover':
      // Forbidden: hover must never enter interacting.
      return mode;
    case 'first-click':
    case 'enter':
      if (mode === 'attached' || mode === 'interacting') return 'interacting';
      return mode;
    case 'exit':
      if (mode === 'interacting') return 'attached';
      return mode;
    default:
      return mode;
  }
}

/** True when a content-area click should be consumed (enter interacting, not pierce). */
export function shouldConsumeFirstClick(mode: InteractionMode): boolean {
  return mode === 'attached';
}

/** Hover never changes mode — explicit guard for tests / UI. */
export function applyHover(mode: InteractionMode): InteractionMode {
  return reduceInteraction(mode, { type: 'hover' });
}

/**
 * the user 03 §1: when exiting content-only (true→false), exit hosted interaction.
 * Plugin only responds to layout.chromeVisibilityChanged — does not emit exit events.
 * Entering content-only (false→true) does not force interaction change.
 */
export function interactionAfterLayoutChrome(
  prevInteraction: InteractionMode,
  prevContentOnly: boolean,
  nextContentOnly: boolean,
): InteractionMode {
  if (prevContentOnly === true && nextContentOnly === false) {
    if (prevInteraction === 'interacting') {
      return reduceInteraction(prevInteraction, { type: 'exit' });
    }
  }
  return prevInteraction;
}

/** Alias for docs / call sites. */
export const forceExitInteractionOnContentOnlyEnd = interactionAfterLayoutChrome;
