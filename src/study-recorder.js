const conditions = new Set(['NO_AVATAR', 'BASIC', 'EXPRESSIVE']);
const studyEventTypes = new Set([
  'session.ended', 'agent.turn.started', 'agent.turn.completed', 'agent.turn.failed',
  'agent.tool.started', 'agent.tool.completed', 'agent.tool.failed', 'agent.state.changed',
  'activity.intent.received', 'activity.intent.duplicate', 'activity.intent.superseded',
  'activity.intent.abandoned', 'activity.confirmed', 'activity.reporter.unavailable',
  'activity.display.started', 'activity.display.ended', 'user.mode.changed',
  'user.task.started', 'user.interruption.initiated', 'user.approval.responded', 'study.write.failed',
  'pet.visibility.changed', 'pet.position.changed', 'manager.visibility.changed',
]);
const toolTypeMap = Object.freeze({ commandExecution: 'shell', fileChange: 'file_change', mcpToolCall: 'mcp', dynamicToolCall: 'dynamic_tool', collabToolCall: 'collab_tool' });

/** Creates privacy-filtered study records; persistence is supplied by the desktop adapter. */
export function createStudyRecorder({ append, now = () => Date.now(), performanceNow = () => globalThis.performance.now() }) {
  let study = null;
  let turnIndex = 0;
  let displayedKey = null;
  let writeQueue = Promise.resolve();
  let writeFailed = false;
  const safe = (event) => {
    if (!study || !study.enabled || !studyEventTypes.has(event.eventType)) return false;
    const record = {
      timestamp: now(), elapsedMs: study.origin === null ? 0 : Math.max(0, Math.round((performanceNow() - study.origin) * 10) / 10),
      studySessionId: study.id, condition: study.condition, activityReportingEnabled: study.reportingEnabled,
      studyTaskId: study.taskId, eventType: event.eventType,
    };
    Object.assign(record, { condition: study.condition, activityReportingEnabled: study.reportingEnabled, studyTaskId: study.taskId });
    for (const field of ['turnIndex', 'agentType', 'toolType', 'lifecycleStatus', 'activity', 'stage', 'evidenceSource', 'predicted', 'displayMode', 'displayLabel', 'animation', 'duplicateCount', 'reason', 'agentVersion']) {
      const value = event[field];
      if (typeof value === 'string' && /^[a-zA-Z0-9_.: -]{1,80}$/.test(value)) record[field] = value;
      else if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) record[field] = value;
    }
    // Deliberately excludes prompts, paths, command text, tool arguments and event payloads.
    writeQueue = writeQueue.then(() => append(record)).catch(() => { writeFailed = true; });
    return true;
  };
  return {
    start({ id = globalThis.crypto.randomUUID(), condition, reportingEnabled, taskId, applicationVersion = '0.1.0', agentVersion = null }) {
      if (!conditions.has(condition)) throw new TypeError('Choose a valid study condition.');
      if (study) throw new Error('A study session is already active.');
      study = { id, condition, reportingEnabled: Boolean(reportingEnabled), taskId: taskId.trim().slice(0, 80), enabled: true, origin: performanceNow(), applicationVersion, agentVersion };
      turnIndex = 0; displayedKey = null; writeFailed = false;
      return Object.freeze({ id: study.id, condition, reportingEnabled: study.reportingEnabled, taskId: study.taskId, applicationVersion, agentVersion });
    },
    observe(event) {
      if (!study) return;
      const type = event.eventType;
      const base = { turnIndex, agentType: event.agentType === 'codex' ? 'codex' : 'agent', toolType: toolTypeMap[event.metadata?.itemType] ?? 'other', lifecycleStatus: event.lifecycleStatus };
      if (type === 'turn.started') { turnIndex += 1; base.turnIndex = turnIndex; }
      else base.turnIndex = turnIndex;
      if (type === 'turn.completed') safe({ ...base, eventType: event.lifecycleStatus === 'failed' ? 'agent.turn.failed' : 'agent.turn.completed' });
      else if (type === 'turn.failed') safe({ ...base, eventType: 'agent.turn.failed' });
      else if (type === 'turn.started') safe({ ...base, eventType: 'agent.turn.started' });
      else if (type === 'tool.started') safe({ ...base, eventType: 'agent.tool.started' });
      else if (type === 'tool.completed') safe({ ...base, eventType: event.lifecycleStatus === 'failed' ? 'agent.tool.failed' : 'agent.tool.completed' });
      else if (event.eventType === 'approval.required') safe({ ...base, eventType: 'agent.state.changed', activity: 'WAITING' });
      else if (event.eventType === 'connection.failed') safe({ ...base, eventType: 'agent.state.changed', activity: 'FAILED' });
      else if (event.eventType === 'connection.state') safe({ ...base, eventType: 'agent.state.changed', activity: event.lifecycleStatus === 'connected' ? 'IDLE' : 'WORKING' });
      else if (event.eventType === 'request.resolved') safe({ ...base, eventType: 'agent.state.changed', activity: 'WORKING' });
      else if (event.eventType === 'activity.reporter.unavailable') safe({ ...base, eventType: 'activity.reporter.unavailable', reason: 'reporter_tool_failed' });
    },
    display({ classification, mode, label, animation, visible = true, displayActivity = null }) {
      if (!study) return;
      const activity = visible ? (displayActivity ?? classification.activity) : 'HIDDEN';
      const key = `${mode}:${activity}:${classification.stage}:${visible}`;
      if (key === displayedKey) return;
      if (displayedKey !== null) safe({ eventType: 'activity.display.ended', turnIndex, activity: displayedKey.split(':')[1] });
      displayedKey = key;
      safe({ eventType: 'activity.display.started', turnIndex, activity, stage: classification.stage, evidenceSource: classification.evidenceSource, predicted: classification.predicted, displayMode: mode, displayLabel: label, animation: visible ? animation : 'hidden' });
    },
    modeChanged(mode) { if (study) safe({ eventType: 'user.mode.changed', turnIndex, displayMode: mode }); },
    petVisibilityChanged(visible) { if (study) safe({ eventType: 'pet.visibility.changed', turnIndex, activity: visible ? 'VISIBLE' : 'HIDDEN' }); },
    petPositionChanged() { if (study) safe({ eventType: 'pet.position.changed', turnIndex, reason: 'dragged' }); },
    managerVisibilityChanged(visible) { if (study) safe({ eventType: 'manager.visibility.changed', turnIndex, activity: visible ? 'VISIBLE' : 'HIDDEN' }); },
    lifecycleTransitions(items, index = turnIndex) {
      if (!study) return;
      for (const item of items ?? []) safe({ eventType: item.type, turnIndex: index, activity: item.activity, reason: item.reason, evidenceSource: item.evidenceSource, stage: item.stage, duplicateCount: item.type === 'activity.intent.duplicate' ? 1 : undefined });
    },
    userAction(eventType, activity, reason) { safe({ eventType, turnIndex, activity, reason }); },
    reporterUnavailable() { if (study) safe({ eventType: 'activity.reporter.unavailable', turnIndex, reason: 'not_available' }); },
    end() {
      if (!study) return null;
      const ended = { ...study, elapsedMs: Math.max(0, Math.round((performanceNow() - study.origin) * 10) / 10) };
      safe({ eventType: 'activity.display.ended', turnIndex, activity: displayedKey?.split(':')[1] ?? 'IDLE' });
      safe({ eventType: 'session.ended', turnIndex });
      study = null; displayedKey = null;
      return ended;
    },
    get active() { return Boolean(study); },
    get turnCount() { return turnIndex; },
    get writeFailed() { return writeFailed; },
    flush() { return writeQueue; },
  };
}
