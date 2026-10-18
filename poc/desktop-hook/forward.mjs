#!/usr/bin/env node
// Sanitized Codex hook forwarder. It never forwards prompts, tool arguments,
// tool results, transcript paths, or full working-directory paths.

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);

try {
  const raw = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const event = {
    observed_at: new Date().toISOString(),
    source: "codex-hook",
    event: typeof raw.hook_event_name === "string" ? raw.hook_event_name : "unknown",
    session_id: safeString(raw.session_id),
    turn_id: safeString(raw.turn_id),
    tool_use_id: safeString(raw.tool_use_id),
    tool_name: safeString(raw.tool_name),
    model: safeString(raw.model),
    permission_mode: safeString(raw.permission_mode),
    source_detail: safeString(raw.source),
    reason: safeString(raw.reason),
    agent_type: safeString(raw.agent_type),
    cwd_name: basename(raw.cwd),
    tool_input_keys: raw.tool_input && typeof raw.tool_input === "object"
      ? Object.keys(raw.tool_input).slice(0, 16)
      : [],
  };
  const request = await fetch("http://127.0.0.1:43189/event", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(event),
    signal: AbortSignal.timeout(500),
  });
  if (!request.ok) process.exitCode = 0;
} catch {
  // Observation must not change the Codex task if parsing or delivery fails.
}

function safeString(value) {
  return typeof value === "string" && value.length <= 200 ? value : undefined;
}

function basename(value) {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replaceAll("\\", "/").replace(/\/$/, "");
  return cleaned.slice(cleaned.lastIndexOf("/") + 1).slice(0, 100);
}
