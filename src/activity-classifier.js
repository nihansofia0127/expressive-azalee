/** Conservative, deterministic interpretation of normalized agent events. */
export const Activity = Object.freeze({
  IDLE: 'IDLE', WORKING: 'WORKING', CODING: 'CODING', PAINTING: 'PAINTING',
  WRITING: 'WRITING', EMAILING: 'EMAILING', DELETING: 'DELETING',
  WAITING: 'WAITING', REVIEW: 'REVIEW', FAILED: 'FAILED',
});

const codeExtensions = new Set(['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'py', 'rs', 'go', 'java', 'kt', 'swift', 'c', 'h', 'cpp', 'hpp', 'cs', 'rb', 'php']);
const proseExtensions = new Set(['md', 'txt', 'rtf', 'doc', 'docx', 'odt']);

function evidence(event, items) {
  const predicted = event.eventType === 'activity.intent' || event.metadata?.activity?.predicted === true;
  const toolFailure = ['tool.completed', 'item.completed'].includes(event.eventType)
    && (event.lifecycleStatus === 'failed' || event.metadata?.status === 'failed');
  const turnFailure = ['turn.failed', 'connection.failed'].includes(event.eventType)
    || event.eventType === 'turn.completed' && (event.lifecycleStatus === 'failed' || event.metadata?.status === 'failed');
  const stage = predicted
    ? 'intended'
    : turnFailure || toolFailure
      ? 'failed'
      : event.eventType === 'approval.required' || event.eventType === 'user_input.required'
        ? 'intended'
        : ['tool.completed', 'item.completed'].includes(event.eventType)
          ? 'completed'
          : ['tool.started', 'item.started'].includes(event.eventType)
            ? 'executing'
        : event.eventType === 'turn.started'
          ? 'executing'
            : event.eventType === 'turn.completed'
              ? 'completed'
              : 'unknown';
  const activity = event.metadata?.activity ?? {};
  return Object.freeze({
    explanation: items.join(' '),
    evidence: Object.freeze(items),
    evidenceSource: activity.evidenceSource ?? (event.metadata?.itemType === 'fileChange' ? 'app_server_file_change' : event.eventType.startsWith('tool.') || event.eventType.startsWith('item.') ? 'app_server_operation' : 'app_server_lifecycle'),
    confidence: typeof activity.confidence === 'number' ? Math.max(0, Math.min(1, activity.confidence)) : predicted ? 0.35 : ['tool.started', 'tool.completed', 'item.started', 'item.completed'].includes(event.eventType) ? 0.9 : 1,
    stage,
    predicted,
    confirmed: !predicted && ['tool.started', 'tool.completed', 'item.started', 'item.completed', 'turn.started', 'turn.completed', 'turn.failed', 'connection.failed', 'approval.required', 'user_input.required'].includes(event.eventType),
    failureScope: turnFailure ? 'turn' : toolFailure ? 'tool' : null,
    operationStatus: event.eventType === 'approval.required' || event.eventType === 'user_input.required'
      ? 'proposed'
      : turnFailure || toolFailure
          ? 'failed'
          : event.eventType === 'tool.completed' || event.eventType === 'item.completed'
            ? 'completed'
          : event.eventType === 'tool.started' || event.eventType === 'item.started'
            ? 'executing'
            : 'not_applicable',
  });
}

function result(activity, event, items) {
  return Object.freeze({ activity, ...evidence(event, items) });
}

export function classifyActivity(event) {
  if (!event || typeof event !== 'object') {
    const empty = { eventType: 'agent.event' };
    return result(Activity.WORKING, empty, ['No normalized event evidence was provided; using the safe WORKING fallback.']);
  }
  const { eventType, lifecycleStatus, metadata = {}, toolName } = event;
  const status = lifecycleStatus ?? metadata.status;
  if (eventType === 'approval.required' || eventType === 'user_input.required' || status === 'waiting') {
    return result(Activity.WAITING, event, ['Codex is waiting for approval or user input.']);
  }
  if (eventType === 'activity.intent') {
    const activity = metadata.activity ?? {};
    const allowed = new Set(Object.values(Activity));
    const category = allowed.has(activity.category) && ![Activity.IDLE, Activity.WAITING, Activity.FAILED, Activity.REVIEW].includes(activity.category)
      ? activity.category
      : Activity.WORKING;
    return result(category, event, [
      category === Activity.WORKING
        ? 'The plan update did not contain a supported semantic activity; using WORKING.'
        : `The App Server plan suggests ${category}; this is an intended-only prediction, not evidence that the operation started.`,
    ]);
  }
  if (eventType === 'turn.failed' || eventType === 'connection.failed' || eventType === 'turn.completed' && status === 'failed') {
    return result(Activity.FAILED, event, ['The Codex turn or connection ended in failure.']);
  }
  if (['tool.completed', 'item.completed'].includes(eventType) && status === 'failed') {
    return result(Activity.WORKING, event, ['A tool or item failed; the turn may recover, so task-level FAILED is not shown.']);
  }
  if (eventType === 'turn.completed') {
    if (status === 'interrupted') return result(Activity.IDLE, event, ['The turn was interrupted and is no longer active.']);
    return result(Activity.IDLE, event, ['The turn completed; Azalee is idle.']);
  }
  if (eventType === 'connection.state' && status === 'disconnected') {
    return result(Activity.IDLE, event, ['The agent connection is disconnected and no task is active.']);
  }
  if (eventType === 'item.started' && metadata.itemType === 'enteredReviewMode') {
    return result(Activity.REVIEW, event, ['The App Server reported entry into review mode.']);
  }
  if (eventType === 'item.completed' && metadata.itemType === 'exitedReviewMode') {
    return result(Activity.REVIEW, event, ['The App Server reported exit from review mode.']);
  }
  if (eventType === 'session.started' || eventType === 'connection.state' && status === 'connected') {
    return result(Activity.IDLE, event, ['The session is ready; no active operation is reported.']);
  }
  if (!['tool.started', 'tool.completed', 'item.started', 'item.completed'].includes(eventType)) {
    return result(Activity.WORKING, event, ['No supported semantic operation is present in this event.']);
  }

  const activity = metadata.activity ?? {};
  const category = activity.operationCategory;
  const sourceMethod = metadata.sourceMethod ?? 'unknown source method';
  if (category === 'image_generation' && metadata.itemType === 'imageGeneration') {
    return result(Activity.PAINTING, event, [`Explicit App Server imageGeneration item from ${sourceMethod}.`]);
  }
  if (category === 'email_draft' || category === 'email_send') {
    return result(Activity.EMAILING, event, [`Explicit email ${category === 'email_send' ? 'send' : 'draft'} operation from ${toolName ?? 'named tool'}.`]);
  }
  if (category === 'document_generation') {
    return result(Activity.WRITING, event, ['Explicit document-generation operation was reported.']);
  }
  if (category === 'file_delete' || activity.changeKinds?.includes('delete') || activity.commandKinds?.some((kind) => ['rm', 'unlink', 'rmdir'].includes(kind))) {
    const signal = category === 'file_delete' ? 'explicit file-delete operation' : activity.changeKinds?.includes('delete') ? 'fileChange delete kind' : 'recognized deletion command token';
    return result(Activity.DELETING, event, [`The event contains a ${signal}.`]);
  }
  const extensions = activity.artifactExtensions ?? [];
  const kinds = activity.changeKinds ?? [];
  if (metadata.itemType === 'fileChange' && kinds.some((kind) => kind === 'add' || kind === 'update') && extensions.some((extension) => codeExtensions.has(extension))) {
    return result(Activity.CODING, event, [`App Server fileChange reported ${kinds.filter((kind) => kind !== 'delete').join('/')} of a source-code file (extension only).`]);
  }
  if ((metadata.itemType === 'fileChange' || category === 'document_generation') && extensions.some((extension) => proseExtensions.has(extension))) {
    return result(Activity.WRITING, event, ['App Server file change targets a recognized prose or document extension.']);
  }
  if (category === 'image_generation') {
    return result(Activity.PAINTING, event, ['Explicit image-generation operation was reported.']);
  }
  return result(Activity.WORKING, event, ['Tool or item activity is present, but it does not identify a supported semantic operation.']);
}
