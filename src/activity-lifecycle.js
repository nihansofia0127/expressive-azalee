import { Activity, classifyActivity } from './activity-classifier.js';

const blocking = new Set([Activity.IDLE, Activity.WAITING, Activity.FAILED, Activity.REVIEW]);
const semantic = new Set([Activity.CODING, Activity.PAINTING, Activity.WRITING, Activity.EMAILING, Activity.DELETING]);

/** Keeps reports provisional and emits auditable transitions for the study recorder. */
export function createActivityLifecycle() {
  let activeSessionId = null;
  let activeTurnId = null;
  let currentIntent = null;
  let transitions = [];
  const transition = (type, activity, reason = undefined, evidenceSource = undefined, stage = undefined) => transitions.push({ type, activity, ...(reason ? { reason } : {}), ...(evidenceSource ? { evidenceSource } : {}), ...(stage ? { stage } : {}) });
  return {
    apply(event) {
      transitions = [];
      const classification = classifyActivity(event);
      if (event?.eventType === 'session.started') {
        this.reset();
        activeSessionId = event.sessionId ?? null;
        return classification;
      }
      if (event?.sessionId && activeSessionId && event.sessionId !== activeSessionId) {
        this.reset();
        activeSessionId = event.sessionId;
      }
      if (event?.eventType === 'turn.started') {
        if (activeTurnId && activeTurnId !== event.turnId && currentIntent) transition('activity.intent.abandoned', currentIntent.activity, 'new_turn');
        activeTurnId = event.turnId ?? null;
        currentIntent = null;
        return classification;
      }
      if (event?.eventType === 'activity.intent') {
        if (!activeTurnId || !event.turnId || event.turnId !== activeTurnId) return null;
        const activity = classification.activity;
        if (!semantic.has(activity) || !classification.predicted) return classification;
        if (currentIntent?.activity === activity) {
          transition('activity.intent.duplicate', activity, 'same_unresolved_report', classification.evidenceSource, 'intended');
          return Object.freeze({ ...classification, duplicateReport: true });
        }
        if (currentIntent) transition('activity.intent.superseded', currentIntent.activity, 'different_report', 'agent_report', 'intended');
        currentIntent = { activity };
        transition('activity.intent.received', activity, undefined, classification.evidenceSource, 'intended');
        return classification;
      }
      if (event?.turnId && activeTurnId && event.turnId !== activeTurnId) return null;
      if (blocking.has(classification.activity)) {
        if (currentIntent) transition('activity.intent.abandoned', currentIntent.activity, classification.activity.toLowerCase());
        currentIntent = null;
        if ([Activity.IDLE, Activity.FAILED].includes(classification.activity)) activeTurnId = null;
        return classification;
      }
      if (semantic.has(classification.activity) && classification.confirmed) {
        if (currentIntent) {
          if (currentIntent.activity === classification.activity) transition('activity.confirmed', classification.activity, undefined, classification.evidenceSource, classification.stage);
          else transition('activity.intent.abandoned', currentIntent.activity, 'different_activity_observed');
        } else transition('activity.confirmed', classification.activity, 'operation_observed', classification.evidenceSource, classification.stage);
        currentIntent = null;
        return classification;
      }
      if (currentIntent && ['tool.started', 'item.started'].includes(event?.eventType)) {
        return currentIntent && Object.freeze({ ...classification, activity: currentIntent.activity, stage: 'intended', predicted: true, confirmed: false, explanation: `Codex reported ${currentIntent.activity} as its immediate intention; the current operation does not independently confirm it.`, evidenceSource: 'agent_report', evidenceStrength: 'reported' });
      }
      // Generic operation completion is not evidence that a reported
      // intention was false. Keep it provisional through ambiguous work until
      // semantic evidence, a blocking state, or the turn boundary resolves it.
      if (currentIntent) return Object.freeze({ ...classification, activity: currentIntent.activity, stage: 'intended', predicted: true, confirmed: false, explanation: `Codex reported ${currentIntent.activity} as its immediate intention; operation evidence has not confirmed it.`, evidenceSource: 'agent_report', evidenceStrength: 'reported' });
      return classification;
    },
    takeTransitions() { const result = transitions; transitions = []; return result; },
    reset() {
      if (currentIntent) transition('activity.intent.abandoned', currentIntent.activity, 'session_reset');
      activeSessionId = null;
      activeTurnId = null;
      currentIntent = null;
    },
  };
}
