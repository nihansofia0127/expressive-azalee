import { Behavior, behaviorLabels } from './agent-state.js';
import { animationRows, createAzaleeRenderer } from './azalee-renderer.js';
import { createAnimationController } from './animation-controller.js';
import { createEventCollector } from './event-collector.js';
import { createStateMapper } from './state-mapper.js';
import { createCodexAdapter } from './codex-adapter.js';
import { classifyActivity } from './activity-classifier.js';
import { PresentationMode, presentActivity } from './presentation-mode.js';
import { activityFixtures } from './activity-fixtures.js';

const $ = (selector) => document.querySelector(selector);
const renderer = createAzaleeRenderer($('#azalee-canvas'));
const label = $('#behavior-label');
const adapterStatus = $('#connection-status');
const startButton = $('#start-task');
const stopButton = $('#stop-task');
const taskMessage = $('#task-message');
const connectionIndicator = $('#connection-indicator');
const approvalPanel = $('#approval-panel');
const collector = createEventCollector();
let currentApproval = null;
let currentMode = PresentationMode.BASIC;
let latestClassification = { activity: 'IDLE', explanation: 'Waiting for an event.', evidence: [] };
let latestEvent = null;

const animation = createAnimationController(renderer, (behavior) => {
  label.textContent = behaviorLabels[behavior];
  $('#dev-behavior').textContent = behaviorLabels[behavior];
  $('#azalee-canvas').setAttribute('aria-label', `Azalee ${behaviorLabels[behavior].toLowerCase()}`);
});
const stateMapper = createStateMapper((behavior) => animation.setBehavior(behavior));
const codex = createCodexAdapter({ onEvent: (event) => collector.accept(event) });

collector.subscribe((event) => {
  if (!stateMapper.apply(event)) return;
  latestEvent = event;
  latestClassification = classifyActivity(event);
  renderPresentation();
  $('#last-event').textContent = JSON.stringify({ ...event, timestamp: new Date(Number(event.timestamp)).toISOString() }, null, 2);
  if (event.eventType === 'connection.state') {
    const connected = event.lifecycleStatus === 'connected';
    adapterStatus.textContent = connected ? 'App Server connected' : `App Server ${event.lifecycleStatus ?? 'disconnected'}`;
    connectionIndicator.dataset.connected = String(connected);
    connectionIndicator.setAttribute('aria-label', adapterStatus.textContent);
  }
  if (event.eventType === 'connection.failed' || event.eventType === 'turn.failed') {
    taskMessage.textContent = 'Codex could not complete this task. See the latest event in Developer controls.';
    finishTask();
  }
  if (event.eventType === 'approval.required') {
    currentApproval = event.requestId;
    approvalPanel.hidden = false;
    taskMessage.textContent = 'Waiting for your approval.';
  }
  if (event.eventType === 'user_input.required') {
    taskMessage.textContent = 'Codex requested tool input that this first version cannot collect. Stop the task to continue.';
  }
  if (event.eventType === 'request.resolved') {
    currentApproval = null;
    approvalPanel.hidden = true;
  }
  if (event.eventType === 'turn.completed') {
    taskMessage.textContent = event.lifecycleStatus === 'completed'
      ? 'Codex finished. Azalee is resting.'
      : event.lifecycleStatus === 'interrupted'
        ? 'Task stopped.'
        : 'Codex task failed.';
    finishTask();
  }
});

function renderPresentation() {
  const selected = presentActivity(latestClassification, currentMode);
  animation.setBehavior(selected.behavior);
  animation.playAnimation(selected.animation);
  label.textContent = selected.label;
  $('#dev-behavior').textContent = selected.label;
  $('#debug-mode').textContent = currentMode;
  $('#debug-animation').textContent = animation.getAnimation();
  $('#debug-classification').textContent = latestClassification.activity;
  const confidence = typeof latestClassification.confidence === 'number' ? ` ${(latestClassification.confidence * 100).toFixed(0)}% confidence` : '';
  const prediction = latestClassification.predicted ? ' Predicted only; operation not confirmed.' : '';
  const failureScope = latestClassification.failureScope ? ` Failure scope: ${latestClassification.failureScope}.` : '';
  $('#debug-evidence').textContent = `${latestClassification.explanation} Stage: ${latestClassification.stage}; evidence: ${latestClassification.evidenceSource}${confidence}. Operation: ${latestClassification.operationStatus}.${prediction}${failureScope}`;
  $('#event-provenance').textContent = latestEvent
    ? latestEvent.metadata.synthetic ? 'Synthetic fixture — not verified against real Codex execution.' : `Observed event from ${latestEvent.agentType}.`
    : 'No event received.';
  $('#azalee-canvas').setAttribute('aria-label', `Azalee ${selected.label.toLowerCase()}`);
}

function finishTask() {
  startButton.disabled = false;
  stopButton.disabled = true;
  approvalPanel.hidden = true;
  currentApproval = null;
}

function setManualBehavior(behavior) {
  animation.setBehavior(behavior);
}

for (const [name, row] of Object.entries(animationRows)) {
  const option = document.createElement('option');
  option.value = name;
  option.textContent = `${row.label} · row ${row.row + 1}`;
  $('#animation-select').append(option);
}
$('#animation-select').addEventListener('change', (event) => {
  const name = event.currentTarget.value;
  animation.playAnimation(name);
  $('#debug-animation').textContent = animation.getAnimation();
  $('#azalee-canvas').setAttribute('aria-label', `Azalee ${animationRows[name].label.toLowerCase()} animation`);
});
for (const button of document.querySelectorAll('[data-mode]')) {
  button.addEventListener('click', () => {
    currentMode = button.dataset.mode;
    for (const choice of document.querySelectorAll('[data-mode]')) choice.setAttribute('aria-pressed', String(choice === button));
    renderPresentation();
  });
}
$('#animation-speed').addEventListener('input', (event) => {
  const milliseconds = Number(event.currentTarget.value);
  animation.setSpeed(milliseconds);
  $('#speed-output').textContent = `${milliseconds} ms`;
});

for (const [behavior, text] of Object.entries(behaviorLabels)) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = text;
  button.addEventListener('click', () => setManualBehavior(behavior));
  $('#manual-behaviors').append(button);
}

for (const [key, fixture] of Object.entries(activityFixtures)) {
  const option = document.createElement('option');
  option.value = key;
  option.textContent = fixture.label;
  $('#activity-fixture').append(option);
}
$('#classify-fixture').addEventListener('click', () => {
  const fixture = activityFixtures[$('#activity-fixture').value];
  if (!fixture) return;
  collector.accept({ ...fixture.event, eventId: `${fixture.event.eventId}-${Date.now()}`, timestamp: Date.now(), agentType: 'synthetic', sessionId: null, turnId: null });
});

$('#replay-events').addEventListener('click', async () => {
  const scenario = $('#replay-scenario').value;
  const sequence = scenario === 'failure'
    ? [['turn.started', 'in_progress'], ['tool.started', 'in_progress'], ['turn.completed', 'failed']]
    : scenario === 'interrupted'
      ? [['turn.started', 'in_progress'], ['tool.started', 'in_progress'], ['turn.completed', 'interrupted']]
      : scenario === 'waiting'
        ? [['turn.started', 'in_progress'], ['approval.required', 'waiting'], ['request.resolved', 'resolved'], ['turn.completed', 'completed']]
        : [['turn.started', 'in_progress'], ['tool.started', 'in_progress'], ['tool.completed', 'completed'], ['turn.completed', 'completed']];
  for (let i = 0; i < sequence.length; i += 1) {
    const [eventType, lifecycleStatus] = sequence[i];
    collector.accept({
      eventId: `demo-${Date.now()}-${i}`,
      timestamp: Date.now(),
      agentType: 'demo',
      sessionId: 'demo-session',
      turnId: 'demo-turn',
      eventType,
      lifecycleStatus,
      toolName: eventType.startsWith('tool.') ? 'shell' : null,
      requestId: null,
      metadata: { simulated: true },
    });
    await new Promise((resolve) => setTimeout(resolve, 700));
  }
});

$('#reset-workspace').addEventListener('click', async () => {
  try {
    $('#workspace-path').value = await codex.defaultWorkspace();
    taskMessage.textContent = 'Using the safe temporary workspace.';
  } catch {
    taskMessage.textContent = 'Could not prepare the temporary workspace.';
  }
});

startButton.addEventListener('click', async () => {
  const prompt = $('#task-prompt').value.trim();
  const workspace = $('#workspace-path').value.trim();
  if (!prompt) {
    taskMessage.textContent = 'Enter a task prompt first.';
    return;
  }
  if (!workspace) {
    taskMessage.textContent = 'Choose a workspace folder first.';
    return;
  }
  if (!codex.available) {
    taskMessage.textContent = 'Run Azalee with npm start to launch it as a desktop app and connect Codex.';
    return;
  }
  try {
    startButton.disabled = true;
    stopButton.disabled = false;
    taskMessage.textContent = 'Starting Codex App Server…';
    await codex.startTask(prompt, workspace);
  } catch (error) {
    taskMessage.textContent = error?.message ?? 'Could not start the Codex task.';
    finishTask();
  }
});

stopButton.addEventListener('click', async () => {
  try {
    await codex.interrupt();
    taskMessage.textContent = 'Stopping Codex…';
  } catch (error) {
    taskMessage.textContent = error?.message ?? 'Could not stop the Codex task.';
  }
});

$('#approve-action').addEventListener('click', () => respondToApproval('accept'));
$('#decline-action').addEventListener('click', () => respondToApproval('decline'));
async function respondToApproval(decision) {
  if (!currentApproval) return;
  try {
    await codex.respondToApproval(currentApproval, decision);
    currentApproval = null;
    approvalPanel.hidden = true;
    taskMessage.textContent = decision === 'accept' ? 'Approval sent to Codex.' : 'Action declined.';
  } catch (error) {
    taskMessage.textContent = error?.message ?? 'Could not respond to the approval request.';
  }
}

$('#close-app').addEventListener('click', () => window.__TAURI__?.window?.getCurrentWindow?.().close());
for (const element of [$('#drag-bar'), $('#pet-stage')]) {
  element.addEventListener('mousedown', (event) => {
    if (event.button === 0 && !event.target.closest('button, input, textarea, select, summary')) {
      window.__TAURI__?.window?.getCurrentWindow?.().startDragging();
    }
  });
}

if (codex.available) {
  try {
    await codex.connect();
    adapterStatus.textContent = 'App Server ready';
    $('#task-prompt').placeholder = 'Try: Use the shell tool to run pwd here. Do not edit files.';
  } catch {
    adapterStatus.textContent = 'App Server unavailable';
  }
} else {
  adapterStatus.textContent = 'Desktop build required for Codex';
  startButton.title = 'Run npm start to launch the Tauri desktop app';
}

try {
  const defaultWorkspace = await codex.defaultWorkspace();
  if (defaultWorkspace) $('#workspace-path').value = defaultWorkspace;
} catch {
  // Browser preview remains usable for sprite and simulated event checks.
}

window.addEventListener('beforeunload', () => codex.close());
