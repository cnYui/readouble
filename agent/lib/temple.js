// Temple touchpad input arbitration.
//
// Carried over from cnYui/doubletraining (verified in AIUI Studio 1.1.0's
// glasses simulator): every temple gesture first delivers `GlobalHook`
// (keydown + keyup) and then its gesture key (tap -> Enter, swipe forward ->
// ArrowUp, swipe back -> ArrowDown). Treating GlobalHook as its own action
// would fire twice per tap. Physical-glasses ordering is not verified, so:
//   - a gesture key (keydown or keyup) cancels a pending GlobalHook action;
//   - a GlobalHook arriving right after a gesture key is ignored as an echo;
//   - a lone GlobalHook becomes one tap after a short hold.

export const GLOBAL_HOOK_HOLD_MS = 280;
export const GESTURE_ECHO_MS = 450;

export function createTempleInput(options) {
  const now = options.now;
  const schedule = options.schedule;
  const cancel = options.cancel;
  const onLoneGlobalHook = options.onLoneGlobalHook;
  const holdMs = options.holdMs === undefined ? GLOBAL_HOOK_HOLD_MS : options.holdMs;
  const echoMs = options.echoMs === undefined ? GESTURE_ECHO_MS : options.echoMs;
  let pending = null;
  let lastGestureAt = -Infinity;

  function clearPending() {
    if (pending === null) return;
    cancel(pending);
    pending = null;
  }

  return {
    gestureKeyDown() {
      clearPending();
    },
    gestureKeyUp() {
      clearPending();
      lastGestureAt = now();
    },
    // Returns true when a deferred tap was scheduled.
    globalHookUp() {
      if (now() - lastGestureAt < echoMs) return false;
      clearPending();
      pending = schedule(() => {
        pending = null;
        onLoneGlobalHook();
      }, holdMs);
      return true;
    },
    isPending() {
      return pending !== null;
    },
    dispose() {
      clearPending();
    }
  };
}
