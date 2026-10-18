import test from 'node:test';
import assert from 'node:assert/strict';
import { createActivityLifecycle } from '../src/activity-lifecycle.js';
import { Activity } from '../src/activity-classifier.js';
import { PresentationMode, presentActivity } from '../src/presentation-mode.js';
import { createStudyRecorder } from '../src/study-recorder.js';

const intent = (activity, turnId = 't1') => ({ eventId: `i-${Math.random()}`, eventType: 'activity.intent', lifecycleStatus: 'intended', turnId, metadata: { activity: { category: activity, stage: 'intended', predicted: true, evidenceSource: 'agent_report', evidenceStrength: 'reported' } } });
const op = (type, id, eventType = 'tool.started', status = 'in_progress', activity = {}) => ({ eventId: `${id}-${eventType}`, requestId: id, turnId: 't1', eventType, lifecycleStatus: status, toolName: 'shell', metadata: { itemType: type, status, activity } });

test('identical unresolved reports are recorded as duplicates and do not replace the current intent', () => {
  const lifecycle = createActivityLifecycle();
  lifecycle.apply({ eventType: 'turn.started', turnId: 't1', metadata: {} });
  lifecycle.apply(intent(Activity.CODING));
  assert.deepEqual(lifecycle.takeTransitions().map((x) => x.type), ['activity.intent.received']);
  assert.equal(lifecycle.apply(intent(Activity.CODING)).duplicateReport, true);
  assert.deepEqual(lifecycle.takeTransitions().map((x) => x.type), ['activity.intent.duplicate']);
});

test('different reports supersede, and repeated activity after confirmation is a new intent', () => {
  const lifecycle = createActivityLifecycle();
  lifecycle.apply({ eventType: 'turn.started', turnId: 't1', metadata: {} });
  lifecycle.apply(intent(Activity.CODING)); lifecycle.takeTransitions();
  lifecycle.apply(intent(Activity.WRITING));
  assert.deepEqual(lifecycle.takeTransitions().map((x) => x.type), ['activity.intent.superseded', 'activity.intent.received']);
  lifecycle.apply({ eventType: 'item.started', turnId: 't1', metadata: { itemType: 'fileChange', activity: { artifactExtensions: ['md'], changeKinds: ['add'] } } });
  assert.deepEqual(lifecycle.takeTransitions().map((x) => x.type), ['activity.confirmed']);
  lifecycle.apply(intent(Activity.WRITING));
  assert.deepEqual(lifecycle.takeTransitions().map((x) => x.type), ['activity.intent.received']);
});

test('unmatched completed operations abandon intent; failure and waiting states take precedence', () => {
  const lifecycle = createActivityLifecycle();
  lifecycle.apply({ eventType: 'turn.started', turnId: 't1', metadata: {} });
  lifecycle.apply(intent(Activity.CODING)); lifecycle.takeTransitions();
  lifecycle.apply(op('commandExecution', 'shell-1'));
  lifecycle.apply(op('commandExecution', 'shell-1', 'tool.completed', 'completed'));
  assert.deepEqual(lifecycle.takeTransitions().map((x) => x.type), ['activity.intent.abandoned']);
  assert.equal(lifecycle.apply({ eventType: 'approval.required', turnId: 't1', lifecycleStatus: 'waiting', metadata: {} }).activity, Activity.WAITING);
  lifecycle.apply(intent(Activity.WRITING)); lifecycle.takeTransitions();
  const failed = lifecycle.apply({ eventType: 'turn.failed', turnId: 't1', lifecycleStatus: 'failed', metadata: {} });
  assert.equal(failed.activity, Activity.FAILED);
  assert.deepEqual(lifecycle.takeTransitions().map((x) => x.type), ['activity.intent.abandoned']);
});

test('turn and session resets abandon pending intent and reject stale reports', () => {
  const lifecycle = createActivityLifecycle();
  lifecycle.apply({ eventType: 'session.started', sessionId: 's1', metadata: {} }); lifecycle.takeTransitions();
  lifecycle.apply({ eventType: 'turn.started', sessionId: 's1', turnId: 't1', metadata: {} });
  lifecycle.apply(intent(Activity.DELETING)); lifecycle.takeTransitions();
  lifecycle.apply({ eventType: 'turn.started', sessionId: 's1', turnId: 't2', metadata: {} });
  assert.deepEqual(lifecycle.takeTransitions().map((x) => x.type), ['activity.intent.abandoned']);
  assert.equal(lifecycle.apply(intent(Activity.CODING, 't1')), null);
  lifecycle.apply(intent(Activity.WRITING, 't2')); lifecycle.takeTransitions();
  lifecycle.apply({ eventType: 'session.started', sessionId: 's2', metadata: {} });
  assert.deepEqual(lifecycle.takeTransitions().map((x) => x.type), ['activity.intent.abandoned']);
});

test('reporter failure remains generic work and is not a turn failure', () => {
  const lifecycle = createActivityLifecycle();
  const event = { eventType: 'activity.reporter.unavailable', lifecycleStatus: 'failed', metadata: { reason: 'reporter_tool_failed' } };
  assert.equal(lifecycle.apply(event).activity, Activity.WORKING);
});

test('conditions share a classification while Basic hides semantics and No Avatar has no visual activity', () => {
  const classification = { activity: Activity.CODING, predicted: true, stage: 'intended' };
  assert.equal(presentActivity(classification, PresentationMode.BASIC).label, 'Working');
  assert.equal(presentActivity(classification, PresentationMode.EXPRESSIVE).label, 'Intends Coding');
  assert.equal(classification.activity, Activity.CODING);
});

test('study logs are opt-in and contain allowlisted, content-free records', async () => {
  const records = [];
  let clock = 0;
  const recorder = createStudyRecorder({ append: async (record) => records.push(record), now: () => 1000 + clock, performanceNow: () => clock });
  recorder.observe({ eventType: 'turn.started', turnId: 'private-turn', agentType: 'codex' });
  assert.equal(records.length, 0);
  recorder.start({ id: '123e4567-e89b-12d3-a456-426614174000', condition: 'EXPRESSIVE', reportingEnabled: true, taskId: 'task-03', agentVersion: 'codex-cli-0.162' });
  clock = 250;
  recorder.observe({ eventType: 'turn.started', turnId: 'private-turn', agentType: 'codex' });
  recorder.observe({ eventType: 'tool.started', toolName: 'shell', agentType: 'codex', metadata: { command: 'secret command' }, prompt: 'private prompt', path: '/Users/private/file' });
  recorder.lifecycleTransitions([{ type: 'activity.intent.received', activity: 'CODING' }], 1);
  recorder.display({ classification: { activity: 'CODING', stage: 'intended', predicted: true, evidenceSource: 'agent_report' }, mode: 'Expressive', label: 'Intends Coding', animation: 'running', displayActivity: 'CODING' });
  await recorder.flush();
  assert.equal(records.length, 4);
  assert.equal(records[0].elapsedMs, 250);
  assert.equal(records[1].elapsedMs, 250);
  assert.equal(records[3].activity, 'CODING');
  assert.equal(records[3].displayLabel, 'Intends Coding');
  assert.equal(records.map(JSON.stringify).join('').includes('secret command'), false);
  assert.equal(records.map(JSON.stringify).join('').includes('private prompt'), false);
  assert.equal(records.map(JSON.stringify).join('').includes('/Users/private/file'), false);
  assert.equal(records[0].activityReportingEnabled, true);
  assert.equal(records[0].condition, 'EXPRESSIVE');
});

test('participant-visible study states record generic Basic and hidden No Avatar presentations', async () => {
  const rows = [];
  const recorder = createStudyRecorder({ append: async (row) => rows.push(row), now: () => 1, performanceNow: () => 1 });
  recorder.start({ id: '123e4567-e89b-12d3-a456-426614174001', condition: 'BASIC', reportingEnabled: false, taskId: 'T1' });
  recorder.display({ classification: { activity: 'CODING', stage: 'executing' }, mode: 'Basic', label: 'Working', animation: 'running', displayActivity: 'WORKING' });
  await recorder.flush();
  assert.equal(rows.at(-1).activity, 'WORKING');
  recorder.end(); await recorder.flush();
  const hidden = createStudyRecorder({ append: async (row) => rows.push(row), now: () => 2, performanceNow: () => 2 });
  hidden.start({ id: '123e4567-e89b-12d3-a456-426614174002', condition: 'NO_AVATAR', reportingEnabled: false, taskId: 'T2' });
  hidden.display({ classification: { activity: 'CODING', stage: 'executing' }, mode: 'Basic', label: 'Working', animation: 'running', displayActivity: 'WORKING', visible: false });
  await hidden.flush();
  assert.equal(rows.at(-1).activity, 'HIDDEN');
  assert.equal(rows.at(-1).animation, 'hidden');
});

test('write failures are exposed to the UI instead of being reported as successful study recording', async () => {
  const recorder = createStudyRecorder({ append: async () => { throw new Error('disk full'); }, now: () => 1, performanceNow: () => 1 });
  recorder.start({ id: '123e4567-e89b-12d3-a456-426614174003', condition: 'BASIC', reportingEnabled: false, taskId: 'T3' });
  recorder.display({ classification: { activity: 'IDLE', stage: 'unknown' }, mode: 'Basic', label: 'Idle', animation: 'idle' });
  await recorder.flush();
  assert.equal(recorder.writeFailed, true);
});
