#!/usr/bin/env node
// Minimal local Codex app-server event capture proof of concept.
// Logs event metadata only; it deliberately omits prompts, message text,
// command contents, diffs, and tool output.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createWriteStream } from 'node:fs';

const outputArg = process.argv.indexOf('--output');
if (outputArg >= 0 && !process.argv[outputArg + 1]) {
  throw new Error('Usage: node poc/codex-event-capture.mjs [--output path.jsonl]');
}
const outputPath = outputArg >= 0 ? resolve(process.argv[outputArg + 1]) : null;

const workspace = join(tmpdir(), 'azalee-codex-event-capture');
await mkdir(workspace, { recursive: true });
const log = outputPath ? createWriteStream(outputPath, { flags: 'a' }) : null;
const child = spawn('codex', ['app-server', '--listen', 'stdio://'], {
  cwd: workspace,
  stdio: ['pipe', 'pipe', 'inherit'],
});
const input = createInterface({ input: child.stdout });
const pending = new Map();
let nextId = 1;
let threadId;
let finished = false;
let timedOut = false;
let turnStatus;

function safeSummary(message) {
  const p = message.params ?? {};
  const item = p.item ?? {};
  const summary = { method: message.method };
  if (p.threadId) summary.threadId = p.threadId;
  if (p.turnId) summary.turnId = p.turnId;
  if (p.turn?.id) summary.turnId = p.turn.id;
  if (item.id) summary.itemId = item.id;
  if (item.type) summary.itemType = item.type;
  if (item.status) summary.status = item.status;
  if (p.status) summary.status = p.status;
  if (p.requestId) summary.requestId = p.requestId;
  if (message.method === 'item/commandExecution/requestApproval') summary.kind = 'command approval requested';
  else if (message.method === 'item/fileChange/requestApproval') summary.kind = 'file approval requested';
  else if (message.method === 'item/tool/requestUserInput') summary.kind = 'user input requested';
  else if (item.type === 'commandExecution') summary.kind = 'shell command item';
  else if (item.type === 'fileChange') summary.kind = 'file change item';
  else if (item.type === 'mcpToolCall' || item.type === 'dynamicToolCall') summary.kind = 'tool call item';
  else if (item.type === 'agentMessage') summary.kind = 'agent message item';
  if (message.method === 'turn/completed') summary.status = p.turn?.status ?? p.status ?? 'unknown';
  return summary;
}

function record(summary) {
  const event = { timestamp: new Date().toISOString(), ...summary };
  console.log(JSON.stringify(event));
  if (log) log.write(`${JSON.stringify(event)}\n`);
}

function send(message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function request(method, params = {}) {
  const id = nextId++;
  return new Promise((resolveRequest, rejectRequest) => {
    pending.set(id, { resolve: resolveRequest, reject: rejectRequest, method });
    send({ method, id, params });
  });
}

input.on('line', line => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.id !== undefined && pending.has(message.id)) {
    const req = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) req.reject(new Error(`${req.method}: ${message.error.message}`));
    else req.resolve(message.result);
    return;
  }
  if (message.method) {
    record(safeSummary(message));
    if (message.method === 'turn/completed') {
      finished = true;
      turnStatus = message.params?.turn?.status ?? message.params?.status;
      if (turnStatus !== 'completed') {
        console.error(`Codex turn ended with status: ${turnStatus ?? 'unknown'}`);
        process.exitCode = 1;
      }
      child.stdin.end();
    }
  }
});

child.on('error', error => { console.error(`Could not start app-server: ${error.message}`); process.exitCode = 1; });
child.on('close', code => {
  clearTimeout(timer);
  if (log) log.end();
  if (!finished) {
    console.error(`App-server disconnected before turn/completed (exit ${code ?? 'unknown'}${timedOut ? ', timeout' : ''}).`);
    process.exitCode = 1;
  }
});
const timer = setTimeout(() => {
  timedOut = true;
  child.kill('SIGTERM');
}, 180_000);

try {
  const initialized = await request('initialize', {
    clientInfo: { name: 'expressive_azalee_poc', title: 'Expressive Azalee event capture POC', version: '0.1.0' },
  });
  if (!initialized) throw new Error('App-server initialization returned no result');
  send({ method: 'initialized', params: {} });

  const started = await request('thread/start', {
    cwd: workspace,
    approvalPolicy: 'never',
    sandbox: 'read-only',
  });
  threadId = started.thread?.id;
  if (!threadId) throw new Error('App-server did not return a thread id');
  record({ method: 'poc/thread-created', threadId, workspace });

  await request('turn/start', {
    threadId,
    input: [{ type: 'text', text: 'Use the shell tool to run `pwd` in this directory and then report only the result. Do not write or modify any files.' }],
    cwd: workspace,
    approvalPolicy: 'never',
    sandboxPolicy: { type: 'readOnly', access: { type: 'fullAccess' } },
  });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
  child.kill('SIGTERM');
}
