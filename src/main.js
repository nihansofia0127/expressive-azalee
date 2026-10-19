import { Behavior, behaviorLabels } from './agent-state.js';
import { animationRows } from './azalee-renderer.js';
import { createAnimationController } from './animation-controller.js';
import { createEventCollector } from './event-collector.js';
import { createStateMapper } from './state-mapper.js';
import { createCodexAdapter } from './codex-adapter.js';
import { createActivityLifecycle } from './activity-lifecycle.js';
import { PresentationMode, presentActivity } from './presentation-mode.js';
import { activityFixtures } from './activity-fixtures.js';
import { createStudyRecorder } from './study-recorder.js';

const $ = (selector) => document.querySelector(selector);
const adapterStatus = $('#connection-status');
const startButton = $('#start-task');
const stopButton = $('#stop-task');
const taskMessage = $('#task-message');
const connectionIndicator = $('#connection-indicator');
const approvalPanel = $('#approval-panel');
const collector = createEventCollector();
const activityLifecycle = createActivityLifecycle();
const studyRecorder = createStudyRecorder({ append: (record) => codex.appendStudyRecord(record.studySessionId, record) });
let currentApproval = null;
let currentMode = PresentationMode.BASIC;
let studyOutputPath = null;
let latestClassification = { activity: 'IDLE', explanation: 'Waiting for an event.', evidence: [] };
let latestEvent = null;

let selectedAnimation = 'idle';
const animation = createAnimationController({
  setAnimation(name) { selectedAnimation = name; },
  getAnimation() { return selectedAnimation; },
  setSpeed() {},
}, (behavior) => {
  $('#dev-behavior').textContent = behaviorLabels[behavior];
});
const stateMapper = createStateMapper((behavior) => animation.setBehavior(behavior));
const codex = createCodexAdapter({ onEvent: (event) => collector.accept(event) });

collector.subscribe((event) => {
  studyRecorder.observe(event);
  if (!stateMapper.apply(event)) return;
  latestEvent = event;
  latestClassification = activityLifecycle.apply(event);
  studyRecorder.lifecycleTransitions(activityLifecycle.takeTransitions());
  if (!latestClassification) return;
  if (!latestClassification.duplicateReport) renderPresentation();
  $('#last-event').textContent = JSON.stringify({ ...event, timestamp: new Date(Number(event.timestamp)).toISOString() }, null, 2);
  if (event.eventType === 'connection.state') {
    const connected = event.lifecycleStatus === 'connected';
    adapterStatus.textContent = connected ? 'App Server connected' : `App Server ${event.lifecycleStatus ?? 'disconnected'}`;
    connectionIndicator.dataset.connected = String(connected);
    connectionIndicator.setAttribute('aria-label', adapterStatus.textContent);
  }
  if (event.eventType === 'turn.started') {
    taskMessage.textContent = 'Codex is working.';
    stopButton.disabled = false;
  }
  if (event.eventType === 'tool.started') {
    taskMessage.textContent = 'Codex is working.';
  }
  if (event.eventType === 'approval.required' || event.eventType === 'user_input.required') {
    stopButton.disabled = false;
  }
  if (event.eventType === 'connection.failed' || event.eventType === 'turn.failed') {
    taskMessage.textContent = studyRecorder.active ? 'Codex could not complete this task.' : 'Codex could not complete this task. See the latest event in Developer controls.';
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
      ? (activeStudy?.condition === 'NO_AVATAR' ? 'Codex finished.' : 'Codex finished. Azalee is resting.')
      : event.lifecycleStatus === 'interrupted'
        ? 'Task stopped.'
        : 'Codex task failed.';
    finishTask();
  }
});

if (window.__TAURI__?.event?.listen) {
  window.__TAURI__.event.listen('azalee-pet-runtime', ({ payload }) => {
    showPetRuntimeStatus({ renderer: payload });
  });
  window.__TAURI__.event.listen('azalee-presentation-ack', ({ payload }) => {
    if (!payload || typeof payload.animation !== 'string') return;
    $('#pet-runtime-status').textContent = `Pet received ${payload.mode} presentation · ${payload.animation}`;
  });
}

function showPetRuntimeStatus(status) {
  if (!status || typeof status !== 'object') return;
  const renderer = status.renderer;
  if (!renderer) {
    $('#pet-runtime-status').textContent = 'Pet window exists; renderer status is pending.';
    return;
  }
  const ready = renderer.atlasLoaded
    ? `Sprite atlas loaded · canvas ${renderer.canvasWidth}×${renderer.canvasHeight}`
    : 'Sprite atlas failed to load.';
  const native = status.visible === undefined ? '' : ` · window ${status.visible ? 'visible' : 'hidden'} at (${status.position?.x ?? '?'}, ${status.position?.y ?? '?'}) · ${status.size?.width ?? '?'}×${status.size?.height ?? '?'}`;
  $('#pet-runtime-status').textContent = `Pet runtime: ${ready}${native}`;
}

function renderPresentation() {
  const mode = activeStudy?.condition === 'EXPRESSIVE' ? PresentationMode.EXPRESSIVE : activeStudy ? PresentationMode.BASIC : currentMode;
  const selected = presentActivity(latestClassification, mode);
  const visible = !(activeStudy?.condition === 'NO_AVATAR');
  animation.setBehavior(selected.behavior);
  animation.playAnimation(selected.animation);
  label.textContent = selected.label;
  $('#dev-behavior').textContent = selected.label;
  $('#debug-mode').textContent = mode;
  $('#debug-animation').textContent = animation.getAnimation();
  $('#debug-classification').textContent = latestClassification.activity;
  const confidence = typeof latestClassification.confidence === 'number' ? ` ${(latestClassification.confidence * 100).toFixed(0)}% confidence` : '';
  const prediction = latestClassification.predicted ? ' Predicted only; operation not confirmed.' : '';
  const failureScope = latestClassification.failureScope ? ` Failure scope: ${latestClassification.failureScope}.` : '';
  $('#debug-evidence').textContent = `${latestClassification.explanation} Stage: ${latestClassification.stage}; evidence: ${latestClassification.evidenceSource}${confidence}. Operation: ${latestClassification.operationStatus}.${prediction}${failureScope}`;
  $('#event-provenance').textContent = latestEvent
    ? latestEvent.metadata.synthetic ? 'Synthetic fixture — not verified against real Codex execution.' : `Observed event from ${latestEvent.agentType}.`
    : 'No event received.';
  const semantic = ['CODING', 'PAINTING', 'WRITING', 'EMAILING', 'DELETING'].includes(latestClassification.activity);
  const displayActivity = mode === PresentationMode.EXPRESSIVE && semantic ? latestClassification.activity : selected.behavior;
  studyRecorder.display({ classification: latestClassification, mode, label: selected.label, animation: selected.animation, visible, displayActivity });
  window.__TAURI__?.event?.emit('azalee-presentation', {
    visible,
    mode,
    activity: visible ? displayActivity : 'HIDDEN',
    label: selected.label,
    animation: selected.animation,
  })?.catch?.((error) => {
    $('#pet-runtime-status').textContent = `Pet update event failed: ${error?.message ?? 'unknown error'}`;
  });
  if (window.__TAURI__?.core?.invoke) {
    window.__TAURI__.core.invoke('set_pet_visibility', { visible })
      .then(() => window.__TAURI__.core.invoke('pet_runtime_status'))
      .then(showPetRuntimeStatus)
      .catch((error) => {
        $('#pet-runtime-status').textContent = `Pet visibility update failed: ${error?.message ?? 'unknown error'}`;
      });
  }
  if (lastPetVisibility !== visible) {
    studyRecorder.petVisibilityChanged(visible);
    lastPetVisibility = visible;
  }
}
let lastPetVisibility = null;

function finishTask() {
  startButton.disabled = false;
  stopButton.disabled = true;
  approvalPanel.hidden = true;
  currentApproval = null;
  $('#activity-reporting').disabled = studyRecorder.active;
  $('#study-end-header').disabled = false;
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
  window.__TAURI__?.event?.emit('azalee-presentation', { visible: true, mode: currentMode, activity: 'WORKING', label: animationRows[name].label, animation: name })?.catch?.(() => {});
});
for (const button of document.querySelectorAll('[data-mode]')) {
  button.addEventListener('click', () => {
    if (studyRecorder.active) return;
    currentMode = button.dataset.mode;
    studyRecorder.modeChanged(currentMode);
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
    $('#activity-reporting').disabled = true;
    $('#study-end-header').disabled = studyRecorder.active;
    studyRecorder.userAction('user.task.started', 'WORKING', 'task_submit');
    taskMessage.textContent = 'Starting Codex App Server…';
    stopButton.disabled = true;
    await codex.startTask(prompt, workspace, $('#activity-reporting').checked);
  } catch (error) {
    taskMessage.textContent = error?.message ?? 'Could not start the Codex task.';
    finishTask();
  }
});

stopButton.addEventListener('click', async () => {
  try {
    studyRecorder.userAction('user.interruption.initiated', 'WORKING', 'stop_button');
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
    studyRecorder.userAction('user.approval.responded', 'WAITING', decision);
    await codex.respondToApproval(currentApproval, decision);
    currentApproval = null;
    approvalPanel.hidden = true;
    taskMessage.textContent = decision === 'accept' ? 'Approval sent to Codex.' : 'Action declined.';
  } catch (error) {
    taskMessage.textContent = error?.message ?? 'Could not respond to the approval request.';
  }
}

let activeStudy = null;
$('#study-start').addEventListener('click', async () => {
  if (startButton.disabled) {
    $('#study-message').textContent = 'Finish or stop the current Codex task before starting a study session.';
    return;
  }
  const taskId = $('#study-task-id').value.trim();
  if (!taskId || !/^[A-Za-z0-9._:-]{1,80}$/.test(taskId)) {
    $('#study-message').textContent = 'Enter a study task ID using letters, numbers, dot, underscore, colon, or hyphen.';
    return;
  }
  try {
    const id = crypto.randomUUID();
    const condition = $('#study-condition').value;
    const reportingEnabled = $('#activity-reporting').checked;
    const agentVersion = await codex.codexVersion();
    const outputPath = await codex.startStudySession({ studySessionId: id, condition, activityReportingEnabled: reportingEnabled, studyTaskId: taskId, applicationVersion: '0.1.0', agentVersion });
    activeStudy = studyRecorder.start({ id, condition, reportingEnabled, taskId, agentVersion });
    studyOutputPath = outputPath;
    currentMode = condition === 'EXPRESSIVE' ? PresentationMode.EXPRESSIVE : PresentationMode.BASIC;
    for (const button of document.querySelectorAll('[data-mode]')) button.setAttribute('aria-pressed', String(button.dataset.mode === currentMode));
    document.body.classList.add('study-session');
    document.body.classList.toggle('study-no-avatar', condition === 'NO_AVATAR');
    $('#study-condition').disabled = true;
    $('#study-task-id').disabled = true;
    $('#activity-reporting').disabled = true;
    $('#study-start').disabled = true;
    $('#study-end-header').hidden = false;
    $('#study-message').textContent = 'Recording active. End the session to flush logs and write its summary.';
    $('#study-end-header').title = `Local study log: ${outputPath}`;
    renderPresentation();
  } catch (error) {
    $('#study-message').textContent = error?.message ?? 'Could not start study recording.';
  }
});

async function endStudySession() {
  if (!activeStudy) return;
  const ended = studyRecorder.end();
  await studyRecorder.flush();
  const writeWarning = studyRecorder.writeFailed;
  try {
    const summaryPath = await codex.endStudySession(ended.id, Math.round(ended.elapsedMs), studyRecorder.turnCount);
    $('#study-message').textContent = `${writeWarning ? 'Partial recording: one or more event writes failed. ' : 'Recording saved. '}JSONL: ${studyOutputPath}; summary: ${summaryPath}`;
  } catch (error) {
    $('#study-message').textContent = `Recording ended, but summary creation failed: ${error?.message ?? 'unknown error'}`;
  }
  document.body.classList.remove('study-session', 'study-no-avatar');
  $('#study-condition').disabled = false;
  $('#study-task-id').disabled = false;
  $('#activity-reporting').disabled = false;
  $('#study-start').disabled = false;
  $('#study-end-header').hidden = true;
  $('#study-end-header').disabled = false;
  activeStudy = null;
  studyOutputPath = null;
  currentMode = PresentationMode.BASIC;
  for (const button of document.querySelectorAll('[data-mode]')) button.setAttribute('aria-pressed', String(button.dataset.mode === currentMode));
  renderPresentation();
}
$('#study-end-header').addEventListener('click', endStudySession);

$('#close-app').addEventListener('click', () => window.__TAURI__?.core?.invoke('hide_manager_window').catch(() => {}));
for (const element of [$('#drag-bar')]) {
  element.addEventListener('mousedown', (event) => {
    if (event.button === 0 && !event.target.closest('button, input, textarea, select, summary')) {
      window.__TAURI__?.window?.getCurrentWindow?.().startDragging();
    }
  });
}

if (window.__TAURI__?.event?.listen) {
  window.__TAURI__.event.listen('azalee-pet-position-changed', () => studyRecorder.petPositionChanged());
  window.__TAURI__.event.listen('manager.visibility.changed', ({ payload }) => {
    if (typeof payload?.visible === 'boolean') studyRecorder.managerVisibilityChanged(payload.visible);
  });
}

if (codex.available) {
  try {
    await codex.connect();
    try {
      showPetRuntimeStatus(await window.__TAURI__.core.invoke('pet_runtime_status'));
    } catch {
      $('#pet-runtime-status').textContent = 'Pet window status unavailable.';
    }
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
