import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, mkdir, rm, writeFile, access, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { existsSync } from 'node:fs';
import { classifyActivity, Activity } from '../src/activity-classifier.js';

const codexPath = process.env.CODEX_BIN || [
  '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
  '/Applications/Codex.app/Contents/Resources/codex',
  '/opt/homebrew/bin/codex',
  '/usr/local/bin/codex',
].find(existsSync) || (process.env.PATH?.split(path.delimiter).map((directory) => path.join(directory, 'codex')).find(existsSync));
const reporterPath = path.resolve('src-tauri/target/release/expressive-azalee');
const smokeOnly = process.argv.includes('--smoke');
const supplementalOnly = process.argv.includes('--supplemental');
const reportInstruction = 'Azalee activity reporting is enabled for this task. Immediately before beginning a code-file creation or modification, call the report_activity MCP tool with activity CODING and stage intended. Immediately before beginning prose/document creation or modification, use WRITING. Immediately before beginning a file deletion, use DELETING. Do not report generic or ambiguous work; no report leaves Azalee at Working. Report only an operation you are about to perform; this reports intent and does not confirm that it happened. Then perform the task normally.\n\nTask:\n';
const tasks = [
  { key: 'coding', expected: Activity.CODING, prompt: 'Create a JavaScript file named result.js containing a small exported function that returns the number 7.' },
  { key: 'writing', expected: Activity.WRITING, prompt: 'Create a Markdown file named result.md containing one short paragraph about a quiet garden.' },
  { key: 'deleting', expected: Activity.DELETING, prompt: 'Delete the disposable file named disposable.txt from this workspace.' },
  { key: 'shell', expected: Activity.WORKING, prompt: 'Run pwd in this workspace. Do not create, edit, or delete any files.' },
  { key: 'recoverable_failure', expected: Activity.WORKING, prompt: 'Run a harmless shell command that returns a nonzero exit code, then recover by running pwd. Do not create, edit, or delete files.' },
];

function elapsed(origin) { return Math.round((performance.now() - origin) * 10) / 10; }

function sanitizedActivity(item) {
  const activity = { operationCategory: null, artifactExtensions: [], changeKinds: [], commandKinds: [] };
  if (item.type === 'mcpToolCall' && item.server === 'azalee_activity' && item.tool === 'report_activity') return activity;
  if (item.type === 'fileChange' && Array.isArray(item.changes)) {
    const safeExt = new Set(['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'py', 'rs', 'go', 'java', 'kt', 'swift', 'c', 'h', 'cpp', 'hpp', 'cs', 'rb', 'php', 'html', 'css', 'scss', 'json', 'yaml', 'yml', 'toml', 'md', 'txt', 'rtf', 'doc', 'docx', 'odt']);
    for (const change of item.changes.slice(0, 16)) {
      const ext = path.extname(typeof change.path === 'string' ? change.path : '').slice(1).toLowerCase();
      const kind = change.kind?.type;
      if (safeExt.has(ext)) activity.artifactExtensions.push(ext);
      if (safeExt.has(ext) && ['add', 'update', 'delete'].includes(kind)) activity.changeKinds.push(kind);
    }
  }
  if (item.type === 'commandExecution' && Array.isArray(item.commandActions)) {
    for (const action of item.commandActions.slice(0, 16)) {
      const type = action.type;
      if (['read', 'listFiles', 'search', 'unknown'].includes(type)) activity.commandKinds.push(type);
      const command = typeof action.command === 'string' ? action.command : '';
      const token = command.trim().split(/[\s;|]/, 1)[0];
      if (['rm', 'unlink', 'rmdir'].includes(token)) activity.commandKinds.push(token);
    }
  }
  return activity;
}

function classifyItem(item, method) {
  if (item.type === 'mcpToolCall' && item.server === 'azalee_activity' && item.tool === 'report_activity') {
    const args = item.arguments ?? {};
    if (!['CODING', 'WRITING', 'DELETING'].includes(args.activity) || args.stage !== 'intended') return null;
    return classifyActivity({ eventType: 'activity.intent', lifecycleStatus: 'intended', metadata: { activity: { category: args.activity, evidenceSource: 'agent_report', evidenceStrength: 'reported', stage: 'intended', predicted: true } } });
  }
  const tool = ['commandExecution', 'mcpToolCall', 'dynamicToolCall', 'collabToolCall'].includes(item.type);
  return classifyActivity({
    eventType: tool ? (method === 'item/started' ? 'tool.started' : 'tool.completed') : (method === 'item/started' ? 'item.started' : 'item.completed'),
    lifecycleStatus: item.status ?? (method === 'item/started' ? 'in_progress' : 'completed'),
    toolName: item.type === 'commandExecution' ? 'shell' : item.tool ?? null,
    metadata: { sourceMethod: method, itemType: item.type, status: item.status, activity: sanitizedActivity(item) },
  });
}

async function runTask(task, reporting, repetition, root) {
  const workspace = path.join(root, `${task.key}-${reporting ? 'reported' : 'baseline'}-${repetition}`);
  await mkdir(workspace, { recursive: true });
  if (task.key === 'deleting') await writeFile(path.join(workspace, 'disposable.txt'), 'temporary validation file');

  const args = ['app-server', '--listen', 'stdio://'];
  if (reporting) {
    args.push(
      '-c', `mcp_servers.azalee_activity.command=${JSON.stringify(reporterPath)}`,
      '-c', 'mcp_servers.azalee_activity.args=["--azalee-activity-mcp"]',
      '-c', 'mcp_servers.azalee_activity.enabled=true',
      '-c', 'mcp_servers.azalee_activity.enabled_tools=["report_activity"]',
      '-c', 'mcp_servers.azalee_activity.default_tools_approval_mode="auto"',
      '-c', 'mcp_servers.azalee_activity.startup_timeout_sec=3',
      '-c', 'mcp_servers.azalee_activity.tool_timeout_sec=2',
    );
  }
  const child = spawn(codexPath, args, { cwd: workspace, stdio: ['pipe', 'pipe', 'ignore'] });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map();
  let nextRequest = 1;
  let origin = null;
  let turnIdSeen = false;
  let turnStatus = 'unknown';
  let endTurn;
  const completed = new Promise((resolve) => { endTurn = resolve; });
  const records = { firstWorkingMs: null, reportMs: null, reportActivity: null, reportClassification: null, reportCount: 0, firstOperation: null, firstOperationAfterReport: null, firstSemantic: null, toolFailures: 0, malformedReportCalls: 0 };
  let reporterConfigured = false;
  let reporterObserved = false;

  lines.on('line', (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.id !== undefined && pending.has(String(message.id))) {
      const waiter = pending.get(String(message.id));
      pending.delete(String(message.id));
      if (message.error) waiter.reject(new Error(`App Server request failed: ${waiter.method}`));
      else waiter.resolve(message.result ?? {});
      return;
    }
    if (message.id !== undefined && message.method) {
      const result = message.method.endsWith('/requestApproval') ? { decision: 'decline' } : null;
      const response = result
        ? { jsonrpc: '2.0', id: message.id, result }
        : { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Unsupported test request' } };
      child.stdin.write(`${JSON.stringify(response)}\n`);
      return;
    }
    if (!message.method || !origin) return;
    const params = message.params ?? {};
    if (message.method === 'turn/started') {
      records.firstWorkingMs ??= elapsed(origin);
      if (typeof params.turnId === 'string') turnIdSeen = true;
      if (typeof params.turn?.id === 'string') turnIdSeen = true;
    }
    if (message.method === 'turn/completed') {
      turnStatus = params.turn?.status ?? params.status ?? 'unknown';
      endTurn();
    }
    if (message.method === 'item/completed' && params.item?.status === 'failed') records.toolFailures += 1;
    if (message.method !== 'item/started' && message.method !== 'item/completed') return;
    const item = params.item ?? {};
    if (item.type === 'mcpToolCall' && item.server === 'azalee_activity' && item.tool === 'report_activity' && message.method === 'item/started') {
      const classification = classifyItem(item, message.method);
      if (!classification) { records.malformedReportCalls += 1; return; }
      reporterObserved = true;
      records.reportMs ??= elapsed(origin);
      records.reportActivity ??= item.arguments.activity;
      records.reportClassification ??= classification.activity;
      records.reportCount += 1;
      return;
    }
    if (message.method !== 'item/started') return;
    if (!records.firstOperation && ['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall'].includes(item.type)) {
      records.firstOperation = { type: item.type, startMs: elapsed(origin) };
    }
    if (records.reportMs !== null && !records.firstOperationAfterReport && ['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall'].includes(item.type)) {
      records.firstOperationAfterReport = { type: item.type, startMs: elapsed(origin) };
    }
    const classification = classifyItem(item, message.method);
    if (!records.firstSemantic && classification.confirmed && ![Activity.WORKING, Activity.IDLE].includes(classification.activity)) {
      records.firstSemantic = { activity: classification.activity, startMs: elapsed(origin), itemType: item.type };
    }
  });

  const send = (method, params) => {
    const id = nextRequest++;
    const promise = new Promise((resolve, reject) => pending.set(String(id), { resolve, reject, method }));
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return promise;
  };
  const notify = (method, params = {}) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);

  try {
    await send('initialize', { clientInfo: { name: 'azalee-phase5-validation', version: '1.0.0' } });
    notify('notifications/initialized');
    const thread = await send('thread/start', { cwd: workspace, approvalPolicy: 'on-request', sandbox: 'workspace-write' });
    const threadId = thread.thread?.id;
    if (!threadId) throw new Error('App Server did not return a thread ID');
    if (reporting) {
      const mcp = await send('mcpServerStatus/list', { threadId, detail: 'toolsAndAuthOnly', serverName: 'azalee_activity' });
      const content = JSON.stringify(mcp);
      if (!content.includes('report_activity')) throw new Error('Configured Azalee MCP tool was not listed for the App Server thread');
      reporterConfigured = true;
    }
    origin = performance.now();
    const taskText = reporting ? `${reportInstruction}${task.prompt}` : task.prompt;
    const sandboxPolicy = { type: 'workspaceWrite', writableRoots: [workspace], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true };
    const turn = await send('turn/start', { threadId, input: [{ type: 'text', text: taskText }], cwd: workspace, approvalPolicy: 'on-request', sandboxPolicy });
    const turnId = turn.turn?.id;
    if (turnId) turnIdSeen = true;
    if (turn.turn?.status === 'completed') endTurn();
    let timeoutId;
    try {
      await Promise.race([completed, new Promise((_, reject) => { timeoutId = setTimeout(() => reject(new Error('Timed out waiting for task completion')), 120_000); })]);
    } finally {
      clearTimeout(timeoutId);
    }
    const durationMs = elapsed(origin);
    let artifactVerified = null;
    if (task.key === 'coding') artifactVerified = await access(path.join(workspace, 'result.js')).then(() => true, () => false);
    if (task.key === 'writing') artifactVerified = await access(path.join(workspace, 'result.md')).then(() => true, () => false);
    if (task.key === 'deleting') artifactVerified = await access(path.join(workspace, 'disposable.txt')).then(() => false, () => true);
    return {
      activity: task.key, expected: task.expected, reporting, repetition, turnStatus, durationMs,
      turnIdObserved: turnIdSeen, firstWorkingMs: records.firstWorkingMs,
      reportMs: records.reportMs, reportActivity: records.reportActivity,
      reportMatchedExpected: records.reportActivity === null ? null : records.reportActivity === task.expected,
      reportCount: records.reportCount,
      duplicateReports: records.reportCount > 1,
      reportedClassification: records.reportClassification,
      firstOperationType: records.firstOperation?.type ?? null,
      firstOperationStartMs: records.firstOperation?.startMs ?? null,
      operationAfterReportType: records.firstOperationAfterReport?.type ?? null,
      reportToFirstOperationMs: records.reportMs !== null && records.firstOperationAfterReport ? Math.round((records.firstOperationAfterReport.startMs - records.reportMs) * 10) / 10 : null,
      reportToTurnCompletionMs: records.reportMs !== null ? Math.round((durationMs - records.reportMs) * 10) / 10 : null,
      firstConfirmedSemantic: records.firstSemantic,
      reportToConfirmedSemanticStartMs: records.reportMs !== null && records.firstSemantic ? Math.round((records.firstSemantic.startMs - records.reportMs) * 10) / 10 : null,
      toolFailures: records.toolFailures, malformedReportCalls: records.malformedReportCalls,
      reporterAvailable: reporting ? reporterConfigured : null,
      reportEmitted: reporting ? reporterObserved : null,
      artifactVerified,
    };
  } finally {
    lines.close();
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
  }
}

async function main() {
  if (!codexPath) throw new Error('Codex CLI was not found; set CODEX_BIN to its executable path.');
  const root = await mkdtemp(path.join(os.tmpdir(), 'azalee-phase5-'));
  const results = [];
  try {
    if (smokeOnly) {
      results.push(await runTask(tasks[0], true, 1, root));
    } else if (supplementalOnly) {
      for (let repetition = 1; repetition <= 2; repetition += 1) results.push(await runTask(tasks[3], true, repetition, root));
      results.push(await runTask(tasks[4], true, 2, root));
    } else {
      for (const task of tasks.slice(0, 3)) {
        for (let repetition = 1; repetition <= 3; repetition += 1) {
          const reportingFirst = repetition % 2 === 1;
          for (const reporting of reportingFirst ? [true, false] : [false, true]) {
            results.push(await runTask(task, reporting, repetition, root));
          }
        }
      }
      for (let repetition = 1; repetition <= 2; repetition += 1) results.push(await runTask(tasks[3], false, repetition, root));
      results.push(await runTask(tasks[4], false, 1, root));
    }
    let allResults = results;
    if (supplementalOnly) {
      try {
        const previous = JSON.parse(await readFile('PHASE5-LIVE-RESULTS.json', 'utf8'));
        const priorResults = Array.isArray(previous.results) ? previous.results.filter((entry) => !(entry.reporting && ['shell', 'recoverable_failure'].includes(entry.activity) && [1, 2].includes(entry.repetition))) : [];
        allResults = [...priorResults, ...results];
      } catch { /* A supplemental run can also be used on its own. */ }
    }
    await writeFile('PHASE5-LIVE-RESULTS.json', `${JSON.stringify({ monotonicElapsedMs: true, results: allResults }, null, 2)}\n`);
    for (const result of results) {
      console.log(JSON.stringify({ activity: result.activity, reporting: result.reporting, repetition: result.repetition, turnStatus: result.turnStatus, durationMs: result.durationMs, firstWorkingMs: result.firstWorkingMs, reportMs: result.reportMs, reportActivity: result.reportActivity, reportMatchedExpected: result.reportMatchedExpected, reportCount: result.reportCount, reportToConfirmedSemanticStartMs: result.reportToConfirmedSemanticStartMs, firstConfirmedSemantic: result.firstConfirmedSemantic, toolFailures: result.toolFailures, reporterAvailable: result.reporterAvailable, artifactVerified: result.artifactVerified }));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
