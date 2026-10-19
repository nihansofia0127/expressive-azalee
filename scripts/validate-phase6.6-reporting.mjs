import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { existsSync } from 'node:fs';

const codexPath = process.env.CODEX_BIN || [
  '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
  '/Applications/Codex.app/Contents/Resources/codex', '/opt/homebrew/bin/codex', '/usr/local/bin/codex',
].find(existsSync) || process.env.PATH?.split(path.delimiter).map((d) => path.join(d, 'codex')).find(existsSync);
const reportTool = {
  type: 'function', name: 'azalee_report_activity',
  description: 'Immediately before a matching code, prose/document, or file deletion operation, report its semantic category and stage intended. This is an unverified intention only.',
  inputSchema: {
    type: 'object', properties: {
      activity: { type: 'string', enum: ['CODING', 'WRITING', 'DELETING'] },
      stage: { type: 'string', enum: ['intended'] },
    }, required: ['activity', 'stage'], additionalProperties: false,
  },
};
const activityTasks = [
  { key: 'coding', expected: 'CODING', templateId: 'CODE_CREATE_JS_01', prompt: 'Create a JavaScript file named result.js containing a small exported function that returns the number 7.', artifact: ['result.js', true] },
  { key: 'writing', expected: 'WRITING', templateId: 'WRITE_CREATE_MD_01', prompt: 'Create a Markdown file named result.md containing one short paragraph about a quiet garden.', artifact: ['result.md', true] },
  { key: 'deleting', expected: 'DELETING', templateId: 'DELETE_TEMP_01', prompt: 'Delete the disposable file named disposable.txt from this workspace.', artifact: ['disposable.txt', false] },
];
const controls = [
  { key: 'shell', expected: 'WORKING', templateId: 'CONTROL_PWD_01', prompt: 'Run pwd in this workspace. Do not create, edit, or delete files.' },
  { key: 'recoverable_failure', expected: 'WORKING', templateId: 'CONTROL_RECOVERABLE_FAILURE_01', prompt: 'Run the harmless shell command false as its own operation, then recover by running pwd as a separate operation. Do not create, edit, or delete files.' },
];
const elapsed = (origin) => Math.round((performance.now() - origin) * 10) / 10;

async function runTask(task, reporting, repetition, root) {
  const workspace = path.join(root, `${task.key}-${reporting ? 'on' : 'off'}-${repetition}`);
  await mkdir(workspace, { recursive: true });
  if (task.key === 'deleting') await writeFile(path.join(workspace, 'disposable.txt'), 'temporary validation file');
  const child = spawn(codexPath, ['app-server', '--listen', 'stdio://'], { cwd: workspace, stdio: ['pipe', 'pipe', 'ignore'] });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map();
  let nextId = 1;
  let turnId = null;
  let threadId = null;
  let origin = null;
  let finishTurn;
  const completed = new Promise((resolve) => { finishTurn = resolve; });
  const seenCallIds = new Set();
  const reports = [];
  let firstWorkingMs = null;
  let turnStatus = 'unknown';
  let toolFailures = 0;
  let unresolvedServerRequests = 0;
  let artifactObservedMs = null;
  let artifactTimer = null;
  if (task.artifact) {
    artifactTimer = setInterval(async () => {
      if (artifactObservedMs !== null) return;
      const exists = await access(path.join(workspace, task.artifact[0])).then(() => true, () => false);
      if (exists === task.artifact[1]) artifactObservedMs = elapsed(origin);
    }, 20);
  }
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(String(id), { resolve, reject });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  lines.on('line', (line) => {
    let message; try { message = JSON.parse(line); } catch { return; }
    if (message.id !== undefined && pending.has(String(message.id))) {
      const waiter = pending.get(String(message.id)); pending.delete(String(message.id));
      if (message.error) waiter.reject({ code: message.error.code }); else waiter.resolve(message.result ?? {});
      return;
    }
    if (message.id !== undefined && message.method) {
      const method = message.method;
      if (method === 'item/tool/call') {
        const params = message.params ?? {};
        const args = params.arguments ?? {};
        const keys = Object.keys(args).sort();
        const valid = params.tool === reportTool.name
          && params.threadId === threadId && params.turnId === turnId
          && typeof params.callId === 'string' && params.callId.length > 0 && !seenCallIds.has(params.callId)
          && ['CODING', 'WRITING', 'DELETING'].includes(args.activity) && args.stage === 'intended'
          && keys.length === 2 && keys[0] === 'activity' && keys[1] === 'stage';
        if (valid) seenCallIds.add(params.callId);
        reports.push({ valid, activity: valid ? args.activity : null, stage: valid ? args.stage : null, elapsedMs: elapsed(origin) });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {
          success: valid, contentItems: [{ type: 'inputText', text: valid ? 'Activity intent recorded; operation is not confirmed.' : 'Invalid, stale, or duplicate activity report.' }],
        } })}\n`);
      } else if (method.endsWith('/requestApproval')) {
        unresolvedServerRequests += 1;
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { decision: 'decline' } })}\n`);
      } else {
        unresolvedServerRequests += 1;
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Unsupported validation request' } })}\n`);
      }
      return;
    }
    if (!origin || !message.method) return;
    const params = message.params ?? {};
    if (message.method === 'turn/started') firstWorkingMs ??= elapsed(origin);
    if (message.method === 'item/completed' && params.item?.status === 'failed') toolFailures += 1;
    if (message.method === 'turn/completed') { turnStatus = params.turn?.status ?? 'unknown'; finishTurn(); }
  });
  try {
    const initialized = await send('initialize', { clientInfo: { name: 'azalee-phase66-validation', version: '1.0.0' }, capabilities: reporting ? { experimentalApi: true } : undefined });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} })}\n`);
    const threadParams = { cwd: workspace, approvalPolicy: 'on-request', sandbox: 'workspace-write' };
    if (reporting) threadParams.dynamicTools = [reportTool];
    const thread = await send('thread/start', threadParams);
    threadId = thread.thread?.id;
    if (!threadId) throw { code: 'no_thread' };
    origin = performance.now();
    const taskPrompt = reporting
      ? `Azalee activity reporting is enabled. Immediately before the matching operation, call azalee_report_activity with the expected category (${task.expected}) and stage intended. Do not call it for generic or ambiguous work. This is an unverified intention, not proof. Then perform this task normally:\n${task.prompt}`
      : task.prompt;
    const turn = await send('turn/start', {
      threadId, cwd: workspace, approvalPolicy: 'on-request',
      sandboxPolicy: { type: 'workspaceWrite', writableRoots: [workspace], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true },
      input: [{ type: 'text', text: taskPrompt }],
    });
    turnId = turn.turn?.id ?? null;
    let timeoutId;
    try {
      await Promise.race([completed, new Promise((_, reject) => { timeoutId = setTimeout(() => reject({ code: 'turn_timeout' }), 120_000); })]);
    } finally {
      clearTimeout(timeoutId);
    }
    const artifactVerified = task.artifact ? await access(path.join(workspace, task.artifact[0])).then(() => task.artifact[1], () => !task.artifact[1]) : null;
    return {
      task: task.key, expected: task.expected, reporting, repetition, templateId: task.templateId,
      turnStatus, firstWorkingMs, reportCount: reports.length, validReports: reports.filter((x) => x.valid).length,
      matchingReports: reports.filter((x) => x.valid && x.activity === task.expected).length,
      incorrectReports: reports.filter((x) => x.valid && x.activity !== task.expected).length,
      firstReportMs: reports[0]?.elapsedMs ?? null,
      reportActivities: reports.map((x) => x.activity), reportStages: reports.map((x) => x.stage),
      artifactVerified, artifactObservedMs, toolFailures, unresolvedServerRequests,
      durationMs: elapsed(origin), turnIdPresent: Boolean(turnId),
      serverCallReceived: reports.length > 0,
    };
  } finally {
    clearInterval(artifactTimer);
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 500).unref();
  }
}

function shuffled(values, seed) {
  const out = [...values]; let state = seed || 1;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 0x100000000; };
  for (let i = out.length - 1; i > 0; i -= 1) { const j = Math.floor(random() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
  return out;
}

async function main() {
  if (!codexPath) throw new Error('Codex CLI not found');
  const root = await mkdtemp(path.join(os.tmpdir(), 'azalee-phase66-'));
  const runs = [];
  const seed = 20261018;
  try {
    const plan = [];
    for (const task of activityTasks) for (let i = 1; i <= 3; i += 1) plan.push({ task, reporting: true, repetition: i });
    for (const task of activityTasks) for (let i = 1; i <= 3; i += 1) plan.push({ task, reporting: false, repetition: i });
    for (const task of controls) for (let i = 1; i <= 3; i += 1) plan.push({ task, reporting: true, repetition: i });
    const order = shuffled(plan.map((_, index) => index), seed);
    for (const index of order) runs.push(await runTask(plan[index].task, plan[index].reporting, plan[index].repetition, root));
    const output = {
      phase: '6.6', seed, runCount: runs.length, randomizedOrder: true,
      protocolComparison: {
        directMcpStdio: { initialize: true, toolsList: true, toolCall: true },
        codexCliModelInvocation: { toolAdvertised: true, taskCompleted: true, receiverSawToolCall: false, interpretation: 'inconclusive: the agent completed the task without invoking the tool' },
        appServerExplicitMcpToolCall: { connected: true, toolAdvertised: true, receiverSawToolCall: true, toolResultSuccess: true },
        appServerModelMcpCall: { liveFailedCalls: 33, receiverSawToolCalls: false, source: 'PHASE6.5 seeded matrix' },
        appServerDynamicTool: { liveProbeReportSucceeded: true, artifactCreated: true, turnCompleted: true },
      },
      results: runs,
    };
    await writeFile('PHASE6.6-LIVE-RESULTS.json', `${JSON.stringify(output, null, 2)}\n`);
    const summary = {};
    for (const result of runs) {
      const key = `${result.task}_${result.reporting ? 'on' : 'off'}`;
      (summary[key] ??= { count: 0, completed: 0, artifacts: 0, reportCalls: 0, validReports: 0, falseReports: 0, toolFailures: 0, workingMs: [], reportMs: [] });
      const row = summary[key]; row.count += 1;
      if (result.turnStatus === 'completed') row.completed += 1;
      if (result.artifactVerified === true) row.artifacts += 1;
      row.reportCalls += result.reportCount; row.validReports += result.validReports; row.falseReports += result.incorrectReports; row.toolFailures += result.toolFailures;
      if (Number.isFinite(result.firstWorkingMs)) row.workingMs.push(result.firstWorkingMs);
      if (Number.isFinite(result.firstReportMs)) row.reportMs.push(result.firstReportMs);
    }
    for (const row of Object.values(summary)) for (const field of ['workingMs', 'reportMs']) { row[field].sort((a, b) => a - b); row[field] = row[field].length ? row[field][Math.floor(row[field].length / 2)] : null; }
    console.log(JSON.stringify({ runCount: runs.length, summary }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(JSON.stringify({ errorCode: error?.code ?? 'validation_failed' })); process.exitCode = 1; });
