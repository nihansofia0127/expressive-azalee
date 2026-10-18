import test from 'node:test';
import assert from 'node:assert/strict';
import { Behavior, behaviorLabels, createBehaviorStore } from '../src/agent-state.js';
import { animationRows } from '../src/azalee-renderer.js';
import { createAnimationController } from '../src/animation-controller.js';
import { createEventCollector } from '../src/event-collector.js';
import { createStateMapper } from '../src/state-mapper.js';

test('generic behavior store validates states, suppresses duplicates, and unsubscribes', () => {
  const store = createBehaviorStore();
  const seen = [];
  const unsubscribe = store.subscribe((state) => seen.push(state));
  assert.equal(store.setBehavior(Behavior.WORKING), true);
  assert.equal(store.setBehavior(Behavior.WORKING), false);
  store.setBehavior(Behavior.WAITING);
  unsubscribe();
  store.setBehavior(Behavior.REVIEW);
  assert.deepEqual(seen, [Behavior.IDLE, Behavior.WORKING, Behavior.WAITING]);
  assert.throws(() => store.setBehavior('SEARCHING'), TypeError);
});

test('the atlas player metadata covers the original nine rows and all frame counts', () => {
  assert.deepEqual(Object.values(animationRows).map(({ row }) => row), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(Object.values(animationRows).map(({ frames }) => frames), [6, 8, 8, 4, 5, 8, 6, 6, 6]);
});

test('behavior controller maps generic behavior to animations without source knowledge', () => {
  let animation = 'idle';
  const controller = createAnimationController({
    setAnimation(name) { animation = name; },
    getAnimation() { return animation; },
    setSpeed() {},
  });
  controller.setBehavior(Behavior.WORKING);
  assert.equal(animation, 'running');
  controller.setBehavior(Behavior.FAILED);
  assert.equal(animation, 'failed');
  assert.equal(controller.getBehavior(), Behavior.FAILED);
});

test('event collector drops duplicates and rejects non-normalized events', () => {
  const collector = createEventCollector();
  const accepted = [];
  collector.subscribe((event) => accepted.push(event));
  const event = { eventId: 'azalee-1', timestamp: 123, agentType: 'codex', eventType: 'turn.started', metadata: {} };
  assert.equal(collector.accept(event), true);
  assert.equal(collector.accept(event), false);
  assert.equal(collector.accept({ eventId: 'x', agentType: 'codex', eventType: 'raw-json-rpc' }), false);
  assert.equal(accepted.length, 1);
});

test('state mapper handles lifecycle, approvals, failure, interruptions, duplicates, and stale sessions', () => {
  const states = [];
  const mapper = createStateMapper((state) => states.push(state));
  const makeEvent = (id, type, status, sessionId = 's1') => ({ eventId: `azalee-${id}`, eventType: type, lifecycleStatus: status, sessionId });
  mapper.apply(makeEvent(1, 'session.started', 'active'));
  mapper.apply(makeEvent(2, 'turn.started', 'in_progress'));
  mapper.apply(makeEvent(3, 'tool.started', 'in_progress'));
  mapper.apply(makeEvent(4, 'approval.required', 'waiting'));
  mapper.apply(makeEvent(4, 'approval.required', 'waiting'));
  mapper.apply(makeEvent(5, 'turn.completed', 'completed'));
  mapper.apply(makeEvent(6, 'session.started', 'active', 's2'));
  mapper.apply(makeEvent(7, 'turn.started', 'in_progress', 's2'));
  assert.equal(mapper.apply(makeEvent(2, 'turn.completed', 'failed', 's1')), false);
  mapper.apply(makeEvent(8, 'turn.completed', 'interrupted', 's2'));
  mapper.apply(makeEvent(9, 'turn.started', 'in_progress', 's2'));
  mapper.apply(makeEvent(10, 'turn.completed', 'failed', 's2'));
  assert.deepEqual(states, [
    Behavior.WORKING, Behavior.WAITING, Behavior.IDLE,
    Behavior.WORKING, Behavior.IDLE, Behavior.WORKING, Behavior.FAILED,
  ]);
});

test('a failed tool does not become a failed task before the turn reports its outcome', () => {
  const states = [];
  const mapper = createStateMapper((state) => states.push(state));
  mapper.apply({ eventId: 'azalee-1', sessionId: 's1', eventType: 'turn.started', lifecycleStatus: 'in_progress' });
  mapper.apply({ eventId: 'azalee-2', sessionId: 's1', eventType: 'tool.started', lifecycleStatus: 'in_progress' });
  mapper.apply({ eventId: 'azalee-3', sessionId: 's1', eventType: 'tool.completed', lifecycleStatus: 'failed' });
  assert.deepEqual(states, [Behavior.WORKING]);
  mapper.apply({ eventId: 'azalee-4', sessionId: 's1', eventType: 'turn.completed', lifecycleStatus: 'completed' });
  assert.deepEqual(states, [Behavior.WORKING, Behavior.IDLE]);
});

test('five supported states remain generic and have labels', () => {
  assert.deepEqual(Object.keys(Behavior), ['IDLE', 'WORKING', 'WAITING', 'FAILED', 'REVIEW']);
  assert.deepEqual(Object.keys(behaviorLabels), Object.keys(Behavior));
});
