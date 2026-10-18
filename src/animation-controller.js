import { Behavior } from './agent-state.js';

const behaviorAnimations = Object.freeze({
  [Behavior.IDLE]: 'idle',
  [Behavior.WORKING]: 'running',
  [Behavior.WAITING]: 'waiting',
  [Behavior.FAILED]: 'failed',
  [Behavior.REVIEW]: 'review',
});

/** Agent-neutral facade between coarse behaviors and the Azalee sprite player. */
export function createAnimationController(renderer, onBehavior = () => {}) {
  let currentBehavior = Behavior.IDLE;
  const setBehavior = (behavior) => {
    const animation = behaviorAnimations[behavior];
    if (!animation) throw new TypeError(`Unknown behavior: ${behavior}`);
    if (currentBehavior === behavior) return false;
    currentBehavior = behavior;
    renderer.setAnimation(animation);
    onBehavior(behavior);
    return true;
  };
  return {
    setBehavior,
    getBehavior: () => currentBehavior,
    playAnimation: (name) => renderer.setAnimation(name),
    setSpeed: (milliseconds) => renderer.setSpeed(milliseconds),
    getAnimation: () => renderer.getAnimation(),
  };
}
