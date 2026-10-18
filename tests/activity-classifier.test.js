import test from 'node:test';
import assert from 'node:assert/strict';
import { Activity, classifyActivity } from '../src/activity-classifier.js';
import { createEventCollector } from '../src/event-collector.js';
import { PresentationMode, presentActivity } from '../src/presentation-mode.js';
import { activityFixtures } from '../src/activity-fixtures.js';

const expected = {
  codeEditing: Activity.CODING,
  imageGeneration: Activity.PAINTING,
  documentGeneration: Activity.WRITING,
  emailDraft: Activity.EMAILING,
  fileDeletion: Activity.DELETING,
  ambiguousShell: Activity.WORKING,
  approval: Activity.WAITING,
  failed: Activity.FAILED,
};

test('synthetic fixtures classify into conservative semantic categories with evidence', () => {
  for (const [name, fixture] of Object.entries(activityFixtures)) {
    const classification = classifyActivity(fixture.event);
    assert.equal(classification.activity, expected[name], name);
    assert.ok(classification.explanation.length > 0, name);
    assert.ok(classification.evidence.length > 0, name);
  }
});

test('operation stage distinguishes proposed, executing, and completed events', () => {
  const base = activityFixtures.fileDeletion.event;
  assert.equal(classifyActivity({ ...base, eventType: 'approval.required' }).operationStatus, 'proposed');
  assert.equal(classifyActivity({ ...base, eventType: 'tool.started' }).operationStatus, 'executing');
  assert.equal(classifyActivity({ ...base, eventType: 'tool.completed' }).operationStatus, 'completed');
  assert.equal(classifyActivity({ ...base, eventType: 'tool.completed', lifecycleStatus: 'failed' }).operationStatus, 'failed');
});

test('plan activity is marked as a low-confidence intention until an operation event confirms it', () => {
  const predicted = classifyActivity({
    eventId: 'intent-1', eventType: 'activity.intent', lifecycleStatus: 'intended',
    metadata: { activity: { category: Activity.CODING, evidenceSource: 'app_server_plan', confidence: 0.35, stage: 'intended', predicted: true } },
  });
  assert.equal(predicted.activity, Activity.CODING);
  assert.equal(predicted.stage, 'intended');
  assert.equal(predicted.predicted, true);
  assert.equal(predicted.confirmed, false);
  assert.match(predicted.explanation, /not evidence that the operation started/);

  const executing = classifyActivity({ ...activityFixtures.codeEditing.event, eventType: 'item.started', lifecycleStatus: 'in_progress' });
  assert.equal(executing.activity, Activity.CODING);
  assert.equal(executing.stage, 'executing');
  assert.equal(executing.predicted, false);
  assert.equal(executing.confirmed, true);
});

test('waiting and failure lifecycle evidence override semantic file signals', () => {
  const event = { ...activityFixtures.fileDeletion.event, eventType: 'approval.required', lifecycleStatus: 'waiting' };
  assert.equal(classifyActivity(event).activity, Activity.WAITING);
  assert.equal(classifyActivity({ ...event, eventType: 'turn.failed', lifecycleStatus: 'failed' }).activity, Activity.FAILED);
});

test('tool-level errors stay recoverable while turn-level errors classify as FAILED', () => {
  const toolError = classifyActivity({ ...activityFixtures.ambiguousShell.event, eventType: 'tool.completed', lifecycleStatus: 'failed', metadata: { itemType: 'commandExecution', status: 'failed', activity: {} } });
  assert.equal(toolError.activity, Activity.WORKING);
  assert.equal(toolError.failureScope, 'tool');
  assert.equal(toolError.stage, 'failed');
  assert.match(toolError.explanation, /may recover/);
  assert.equal(classifyActivity({ eventType: 'turn.completed', lifecycleStatus: 'failed', metadata: {} }).activity, Activity.FAILED);
});

test('generic shell commands, untrusted extension names, and unknown tool metadata fall back to WORKING', () => {
  for (const event of [
    activityFixtures.ambiguousShell.event,
    { ...activityFixtures.codeEditing.event, metadata: { itemType: 'fileChange', activity: { artifactExtensions: ['sh'], changeKinds: ['update'] } } },
    { ...activityFixtures.emailDraft.event, toolName: 'mailbox', metadata: { itemType: 'mcpToolCall', activity: { operationCategory: null } } },
  ]) assert.equal(classifyActivity(event).activity, Activity.WORKING);
});

test('Basic maps semantic categories to Working; Expressive uses the same classification as a placeholder', () => {
  const classification = classifyActivity(activityFixtures.imageGeneration.event);
  assert.deepEqual(presentActivity(classification, PresentationMode.BASIC), { behavior: 'WORKING', animation: 'running', label: 'Working' });
  assert.deepEqual(presentActivity(classification, PresentationMode.EXPRESSIVE), { behavior: 'WORKING', animation: 'running', label: 'Painting' });
  for (const [activity, animation] of [[Activity.WAITING, 'waiting'], [Activity.REVIEW, 'review'], [Activity.FAILED, 'failed'], [Activity.IDLE, 'idle']]) {
    assert.equal(presentActivity({ activity }, PresentationMode.BASIC).animation, animation);
    assert.equal(presentActivity({ activity }, PresentationMode.EXPRESSIVE).animation, animation);
  }
});

test('Basic and Expressive consume the same intended classification without changing its lifecycle', () => {
  const classification = classifyActivity({ eventType: 'activity.intent', metadata: { activity: { category: Activity.WRITING, predicted: true, stage: 'intended', evidenceSource: 'app_server_plan', confidence: 0.35 } } });
  const basic = presentActivity(classification, PresentationMode.BASIC);
  const expressive = presentActivity(classification, PresentationMode.EXPRESSIVE);
  assert.equal(basic.label, 'Working');
  assert.equal(expressive.label, 'Writing');
  assert.equal(classification.stage, 'intended');
  assert.equal(classification.predicted, true);
});

test('collector preserves session/turn IDs while discarding unapproved or sensitive metadata', () => {
  const collector = createEventCollector();
  collector.accept({ eventId: 'safe-1', timestamp: 1, agentType: 'codex', sessionId: 'thread-safe', turnId: 'turn-safe', eventType: 'tool.started', toolName: 'shell', metadata: { sourceMethod: 'item/started', itemType: 'commandExecution', activity: { commandKinds: ['rm', 'secret-token'], artifactExtensions: ['ts', 'secret'] }, prompt: 'private prompt', command: 'rm /private/path', output: 'secret output', apiKey: 'secret' } });
  const event = collector.getLatest();
  assert.equal(event.sessionId, 'thread-safe');
  assert.equal(event.turnId, 'turn-safe');
  assert.deepEqual(event.metadata.activity, { operationCategory: null, artifactExtensions: ['ts'], changeKinds: [], commandKinds: ['rm'] });
  assert.equal('prompt' in event.metadata, false);
  assert.equal(JSON.stringify(event).includes('/private/path'), false);
  assert.equal(JSON.stringify(event).includes('secret output'), false);
});

test('collector accepts sanitized activity intent and never retains plan text', () => {
  const collector = createEventCollector();
  collector.accept({
    eventId: 'intent-2', timestamp: 1, agentType: 'codex', sessionId: 'thread-2', turnId: 'turn-2',
    eventType: 'activity.intent', lifecycleStatus: 'intended',
    metadata: { activity: { category: 'CODING', evidenceSource: 'app_server_plan', confidence: 0.35, stage: 'intended', predicted: true, step: 'private plan text' }, plan: 'do not retain this' },
  });
  const event = collector.getLatest();
  assert.deepEqual(event.metadata.activity, {
    operationCategory: null, artifactExtensions: [], changeKinds: [], commandKinds: [],
    category: 'CODING', evidenceSource: 'app_server_plan', confidence: 0.35, stage: 'intended', predicted: true,
  });
  assert.equal(event.sessionId, 'thread-2');
  assert.equal(event.turnId, 'turn-2');
  assert.equal(JSON.stringify(event).includes('private plan text'), false);
});
