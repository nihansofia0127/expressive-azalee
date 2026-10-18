/** Agent-neutral states exposed to the animation layer. */
export const Behavior = Object.freeze({
  IDLE: 'IDLE', WORKING: 'WORKING', WAITING: 'WAITING', FAILED: 'FAILED', REVIEW: 'REVIEW',
});

export const behaviorLabels = Object.freeze({
  [Behavior.IDLE]: 'Idle',
  [Behavior.WORKING]: 'Working',
  [Behavior.WAITING]: 'Waiting for you',
  [Behavior.FAILED]: 'Failed',
  [Behavior.REVIEW]: 'Review',
});

export function createBehaviorStore(initial = Behavior.IDLE) {
  const listeners = new Set();
  let current = initial;
  const setBehavior = (next) => {
    if (!Object.hasOwn(behaviorLabels, next)) throw new TypeError(`Unknown behavior: ${next}`);
    if (next === current) return false;
    current = next;
    for (const listener of listeners) listener(current);
    return true;
  };
  return {
    getBehavior: () => current,
    setBehavior,
    subscribe(listener) {
      listeners.add(listener);
      listener(current);
      return () => listeners.delete(listener);
    },
  };
}
