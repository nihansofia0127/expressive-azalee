import { Activity, classifyActivity } from './activity-classifier.js';

const terminalOrBlocking = new Set([Activity.IDLE, Activity.WAITING, Activity.FAILED, Activity.REVIEW]);
const semantic = new Set([Activity.CODING, Activity.PAINTING, Activity.WRITING, Activity.EMAILING, Activity.DELETING]);

/** Keeps reported intentions visibly provisional across generic operations in the same turn. */
export function createActivityLifecycle() {
  let activeTurnId = null;
  let currentIntent = null;
  return {
    apply(event) {
      const classification = classifyActivity(event);
      if (event?.eventType === 'turn.started') {
        activeTurnId = event.turnId ?? null;
        currentIntent = null;
        return classification;
      }
      if (event?.eventType === 'activity.intent') {
        if (!activeTurnId || !event.turnId || event.turnId !== activeTurnId) return null;
        currentIntent = classification;
        return classification;
      }
      if (terminalOrBlocking.has(classification.activity)) {
        currentIntent = null;
        if (classification.activity === Activity.IDLE || classification.activity === Activity.FAILED) activeTurnId = null;
        return classification;
      }
      if (event?.turnId && activeTurnId && event.turnId !== activeTurnId) return null;
      if (classification.confirmed && semantic.has(classification.activity)) {
        currentIntent = null;
        return classification;
      }
      if (currentIntent && (!event?.turnId || event.turnId === activeTurnId)) return currentIntent;
      return classification;
    },
    reset() {
      activeTurnId = null;
      currentIntent = null;
    },
  };
}
