import { Behavior } from './agent-state.js';
import { Activity } from './activity-classifier.js';

export const PresentationMode = Object.freeze({ BASIC: 'Basic', EXPRESSIVE: 'Expressive' });

const semanticPlaceholder = Object.freeze({
  [Activity.CODING]: 'running',
  [Activity.PAINTING]: 'running',
  [Activity.WRITING]: 'running',
  [Activity.EMAILING]: 'running',
  [Activity.DELETING]: 'running',
});

/** Selects a presentation from a classification without touching the agent adapter. */
export function presentActivity(classification, mode = PresentationMode.BASIC) {
  const activity = classification?.activity ?? Activity.WORKING;
  if (activity === Activity.IDLE) return Object.freeze({ behavior: Behavior.IDLE, animation: 'idle', label: 'Idle' });
  if (activity === Activity.WAITING) return Object.freeze({ behavior: Behavior.WAITING, animation: 'waiting', label: 'Waiting for you' });
  if (activity === Activity.FAILED) return Object.freeze({ behavior: Behavior.FAILED, animation: 'failed', label: 'Failed' });
  if (activity === Activity.REVIEW) return Object.freeze({ behavior: Behavior.REVIEW, animation: 'review', label: 'Review' });
  if (mode === PresentationMode.EXPRESSIVE && semanticPlaceholder[activity]) {
    const label = activity[0] + activity.slice(1).toLowerCase();
    return Object.freeze({ behavior: Behavior.WORKING, animation: semanticPlaceholder[activity], label: classification?.predicted ? `Intends ${label}` : label });
  }
  return Object.freeze({ behavior: Behavior.WORKING, animation: 'running', label: 'Working' });
}
