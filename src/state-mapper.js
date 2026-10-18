import { Behavior } from './agent-state.js';

/** Maps normalized lifecycle evidence to generic animation behavior. */
export function createStateMapper(setBehavior) {
  let currentSession = null;
  let latestSequence = 0;
  let taskActive = false;
  let currentBehavior = Behavior.IDLE;
  const processed = new Set();
  const transition = (next) => {
    if (next === currentBehavior) return;
    currentBehavior = next;
    setBehavior(next);
  };

  return {
    apply(event) {
      if (!event || processed.has(event.eventId)) return false;
      processed.add(event.eventId);
      if (processed.size > 512) processed.delete(processed.values().next().value);
      const sequence = Number(String(event.eventId).match(/-(\d+)$/)?.[1] ?? 0);
      if (sequence && sequence < latestSequence) return false;
      if (sequence) latestSequence = sequence;
      if (event.eventType === 'session.started' && event.sessionId) currentSession = event.sessionId;
      if (event.sessionId && currentSession && event.sessionId !== currentSession) return false;

      switch (event.eventType) {
        case 'turn.started':
        case 'tool.started':
          taskActive = true;
          transition(Behavior.WORKING);
          break;
        case 'approval.required':
        case 'user_input.required':
          taskActive = true;
          transition(Behavior.WAITING);
          break;
        case 'request.resolved':
        case 'tool.completed':
          if (taskActive) transition(Behavior.WORKING);
          break;
        case 'turn.completed':
          taskActive = false;
          if (event.lifecycleStatus === 'failed') transition(Behavior.FAILED);
          else transition(Behavior.IDLE);
          break;
        case 'turn.failed':
        case 'connection.failed':
          taskActive = false;
          transition(Behavior.FAILED);
          break;
        case 'connection.state':
          if (event.lifecycleStatus === 'disconnected' && taskActive) {
            taskActive = false;
            transition(Behavior.FAILED);
          }
          break;
        default:
          break;
      }
      return true;
    },
    reset() {
      currentSession = null;
      latestSequence = 0;
      taskActive = false;
      processed.clear();
      transition(Behavior.IDLE);
    },
  };
}
