use crate::normalized_event::{new_event, NormalizedEvent};
use crate::activity_reporter;
use crate::RunnerState;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::Ordering;
use std::sync::{atomic::AtomicU64, Arc, Mutex};
use std::thread;
use tauri::{AppHandle, Emitter};

const EVENT_NAME: &str = "azalee-normalized-event";

pub struct ActiveSession {
    pub thread_id: String,
    pub turn_id: Option<String>,
    writer: Arc<Mutex<ChildStdin>>,
}

struct StreamContext {
    session_id: Option<String>,
    turn_id: Option<String>,
    sequence: Arc<AtomicU64>,
    activity_report_items: HashSet<String>,
}

pub fn default_workspace() -> Result<String, String> {
    let path = std::env::temp_dir().join("expressive-azalee-workspace");
    std::fs::create_dir_all(&path).map_err(|_| "Could not create the temporary workspace".to_string())?;
    path.canonicalize()
        .map(|canonical| canonical.to_string_lossy().into_owned())
        .map_err(|_| "Could not resolve the temporary workspace".to_string())
}

pub fn start_task(
    app: AppHandle,
    state: &RunnerState,
    prompt: String,
    workspace: String,
    activity_reporting: bool,
) -> Result<(), String> {
    if prompt.trim().is_empty() {
        return Err("Enter a task prompt first".to_string());
    }
    if prompt.len() > 20_000 {
        return Err("The task prompt is too long (maximum 20,000 bytes)".to_string());
    }
    let path = PathBuf::from(workspace)
        .canonicalize()
        .map_err(|_| "Choose an existing workspace folder".to_string())?;
    if !path.is_dir() {
        return Err("The selected workspace must be a folder".to_string());
    }
    if state
        .running
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Err("A Codex task is already running".to_string());
    }

    let running = state.running.clone();
    let sequence = state.event_sequence.clone();
    let active = state.active.clone();
    let pending = state.pending_approvals.clone();
    thread::spawn(move || {
        emit_event(
            &app,
            &sequence,
            None,
            None,
            "connection.state",
            Some("connecting"),
            None,
            None,
            json!({"adapter": "codex-app-server"}),
        );
        let result = run_task(&app, &active, &pending, &sequence, prompt, path, activity_reporting);
        *active.lock().unwrap_or_else(|e| e.into_inner()) = None;
        pending.lock().unwrap_or_else(|e| e.into_inner()).clear();
        running.store(false, Ordering::Release);
        match result {
            Ok(()) => {}
            Err(reason) => {
                emit_event(&app, &sequence, None, None, "connection.failed", Some("failed"), None, None, json!({"reason": reason}));
            }
        }
    });
    Ok(())
}

pub fn interrupt_task(state: &RunnerState) -> Result<(), String> {
    let active = state.active.lock().unwrap_or_else(|e| e.into_inner());
    let session = active.as_ref().ok_or_else(|| "The Codex turn is not ready to interrupt".to_string())?;
    let turn_id = session.turn_id.as_ref().ok_or_else(|| "The Codex turn is not ready to interrupt".to_string())?;
    send_json(
        &session.writer,
        &json!({
            "method": "turn/interrupt",
            "id": 90_001,
            "params": {"threadId": session.thread_id, "turnId": turn_id}
        }),
    )
}

pub fn respond_to_approval(state: &RunnerState, request_id: String, decision: String) -> Result<(), String> {
    if decision != "accept" && decision != "decline" {
        return Err("Choose allow or decline".to_string());
    }
    let mut pending = state.pending_approvals.lock().unwrap_or_else(|e| e.into_inner());
    let wire_id = pending.remove(&request_id).ok_or_else(|| "That approval request is no longer active".to_string())?;
    let active = state.active.lock().unwrap_or_else(|e| e.into_inner());
    let session = active.as_ref().ok_or_else(|| "The Codex session has ended".to_string())?;
    send_json(
        &session.writer,
        &json!({"id": wire_id, "result": {"decision": decision}}),
    )
}

fn run_task(
    app: &AppHandle,
    active: &Arc<Mutex<Option<ActiveSession>>>,
    pending: &Arc<Mutex<HashMap<String, Value>>>,
    sequence: &Arc<AtomicU64>,
    prompt: String,
    workspace: PathBuf,
    activity_reporting: bool,
) -> Result<(), String> {
    let codex = resolve_codex_binary()?;
    let mut command = Command::new(codex);
    command.args(["app-server", "--listen", "stdio://"]);
    if activity_reporting {
        let reporter = std::env::current_exe().map_err(|_| "Could not locate the Azalee activity reporter".to_string())?;
        let reporter = reporter.to_string_lossy().to_string();
        let toml_command = serde_json::to_string(&reporter).map_err(|_| "Could not configure the activity reporter".to_string())?;
        command.args([
            "-c".to_string(), format!("mcp_servers.azalee_activity.command={toml_command}"),
            "-c".to_string(), "mcp_servers.azalee_activity.args=[\"--azalee-activity-mcp\"]".to_string(),
            "-c".to_string(), "mcp_servers.azalee_activity.enabled=true".to_string(),
            "-c".to_string(), "mcp_servers.azalee_activity.enabled_tools=[\"report_activity\"]".to_string(),
            "-c".to_string(), "mcp_servers.azalee_activity.default_tools_approval_mode=\"auto\"".to_string(),
            "-c".to_string(), "mcp_servers.azalee_activity.startup_timeout_sec=3".to_string(),
            "-c".to_string(), "mcp_servers.azalee_activity.tool_timeout_sec=2".to_string(),
        ]);
    }
    let mut child = command
        .current_dir(&workspace)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "Could not start Codex App Server".to_string())?;
    let stdin = child.stdin.take().ok_or_else(|| "Codex App Server stdin was unavailable".to_string())?;
    let stdout = child.stdout.take().ok_or_else(|| "Codex App Server stdout was unavailable".to_string())?;
    let writer = Arc::new(Mutex::new(stdin));
    let mut lines = BufReader::new(stdout).lines();
    let mut context = StreamContext { session_id: None, turn_id: None, sequence: sequence.clone(), activity_report_items: HashSet::new() };

    send_request(&writer, 1, "initialize", json!({
        "clientInfo": {"name": "expressive_azalee", "title": "Expressive Azalee", "version": "0.1.0"}
    }))?;
    let _ = wait_for_response(app, &mut child, &mut lines, &writer, &mut context, pending, 1)?;
    send_json(&writer, &json!({"method": "initialized", "params": {}}))?;
    emit_event(app, &context.sequence, None, None, "connection.state", Some("connected"), None, None, json!({"adapter": "codex-app-server"}));

    let workspace_text = workspace.to_string_lossy().to_string();
    send_request(&writer, 2, "thread/start", json!({
        "cwd": workspace_text,
        "approvalPolicy": "on-request",
        "sandbox": "workspace-write"
    }))?;
    let started = wait_for_response(app, &mut child, &mut lines, &writer, &mut context, pending, 2)?;
    let thread_id = started
        .pointer("/thread/id")
        .and_then(Value::as_str)
        .ok_or_else(|| "Codex did not return a thread id".to_string())?
        .to_string();
    context.session_id = Some(thread_id.clone());
    *active.lock().unwrap_or_else(|e| e.into_inner()) = Some(ActiveSession {
        thread_id: thread_id.clone(),
        turn_id: None,
        writer: writer.clone(),
    });

    let sandbox_policy = json!({
        "type": "workspaceWrite",
        "writableRoots": [workspace_text],
        "networkAccess": false,
        "excludeTmpdirEnvVar": true,
        "excludeSlashTmp": true
    });
    let turn_prompt = if activity_reporting {
        format!("Azalee activity reporting is enabled for this task. Immediately before beginning a code-file creation or modification, call the report_activity MCP tool with activity CODING and stage intended. Immediately before beginning prose/document creation or modification, use WRITING. Immediately before beginning a file deletion, use DELETING. Do not report generic or ambiguous work; no report leaves Azalee at Working. Report only an operation you are about to perform; this reports intent and does not confirm that it happened. Then perform the task normally.\n\nTask:\n{prompt}")
    } else { prompt };
    send_request(&writer, 3, "turn/start", json!({
        "threadId": thread_id,
        "input": [{"type": "text", "text": turn_prompt}],
        "cwd": workspace.to_string_lossy(),
        "approvalPolicy": "on-request",
        "sandboxPolicy": sandbox_policy
    }))?;
    let turn_started = wait_for_response(app, &mut child, &mut lines, &writer, &mut context, pending, 3)?;
    context.turn_id = turn_started.pointer("/turn/id").and_then(Value::as_str).map(str::to_string);
    if let Some(session) = active.lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
        session.turn_id = context.turn_id.clone();
    }
    if turn_started.pointer("/turn/status").and_then(Value::as_str) == Some("completed") {
        emit_event(app, &context.sequence, context.session_id.clone(), context.turn_id.clone(), "turn.completed", Some("completed"), None, None, json!({"source": "rpc_response"}));
        return Ok(());
    }

    let mut received_terminal = false;
    loop {
        let line = match lines.next() {
            Some(Ok(line)) => line,
            Some(Err(_)) | None => break,
        };
        let message: Value = match serde_json::from_str(&line) {
            Ok(message) => message,
            Err(_) => continue,
        };
        if handle_server_request(app, &context, pending, &message) {
            continue;
        }
        if message.get("id").is_some() && message.get("method").is_none() {
            continue;
        }
        if process_notification(app, &mut context, &message) {
            received_terminal = true;
            break;
        }
    }
    if received_terminal {
        let _ = child.kill();
        let _ = child.wait();
        emit_event(
            app,
            &context.sequence,
            context.session_id.clone(),
            context.turn_id.clone(),
            "connection.state",
            Some("disconnected"),
            None,
            None,
            json!({"reason": "task_finished"}),
        );
        Ok(())
    } else {
        let _ = child.wait();
        Err("Codex App Server disconnected before the turn completed".to_string())
    }
}

fn wait_for_response(
    app: &AppHandle,
    child: &mut Child,
    lines: &mut impl Iterator<Item = Result<String, std::io::Error>>,
    writer: &Arc<Mutex<ChildStdin>>,
    context: &mut StreamContext,
    pending: &Arc<Mutex<HashMap<String, Value>>>,
    request_id: u64,
) -> Result<Value, String> {
    loop {
        let line = lines.next().ok_or_else(|| {
            let _ = child.kill();
            "Codex App Server disconnected".to_string()
        })?.map_err(|_| "Could not read Codex App Server events".to_string())?;
        let message: Value = serde_json::from_str(&line).map_err(|_| "Codex App Server returned invalid JSON".to_string())?;
        if message.get("id").and_then(Value::as_u64) == Some(request_id) && message.get("method").is_none() {
            if message.get("error").is_some() {
                let code = message.pointer("/error/code").and_then(Value::as_i64);
                return Err(format!("App Server rejected request {request_id} (error code {code:?})"));
            }
            return message.get("result").cloned().ok_or_else(|| "Codex App Server returned no result".to_string());
        }
        if handle_server_request(app, context, pending, &message) {
            continue;
        }
        if message.get("method").and_then(Value::as_str).is_some() {
            let _ = writer;
            process_notification(app, context, &message);
        }
    }
}

fn handle_server_request(
    app: &AppHandle,
    context: &StreamContext,
    pending: &Arc<Mutex<HashMap<String, Value>>>,
    message: &Value,
) -> bool {
    let Some(method) = message.get("method").and_then(Value::as_str) else { return false; };
    let Some(id) = message.get("id").cloned() else { return false; };
    if method.ends_with("/requestApproval") {
        let request_id = id.to_string();
        pending.lock().unwrap_or_else(|e| e.into_inner()).insert(request_id.clone(), id);
        let item_id = message.pointer("/params/itemId").and_then(Value::as_str).map(str::to_string);
        emit_event(
            app,
            &context.sequence,
            context.session_id.clone(),
            context.turn_id.clone(),
            "approval.required",
            Some("waiting"),
            None,
            Some(request_id),
            json!({"requestKind": method, "itemId": item_id}),
        );
        true
    } else if method == "item/tool/requestUserInput" {
        emit_event(
            app,
            &context.sequence,
            context.session_id.clone(),
            context.turn_id.clone(),
            "user_input.required",
            Some("waiting"),
            None,
            Some(id.to_string()),
            json!({"requestKind": "user_input", "supported": false}),
        );
        true
    } else {
        false
    }
}

fn process_notification(app: &AppHandle, context: &mut StreamContext, message: &Value) -> bool {
    let Some(method) = message.get("method").and_then(Value::as_str) else { return false; };
    // These deltas carry unstructured assistant text or patch content. They do
    // not add safe activity evidence, so do not normalize or retain them.
    if matches!(method,
        "item/agentMessage/delta" |
        "item/plan/delta" |
        "command/exec/outputDelta" |
        "item/commandExecution/outputDelta" |
        "item/fileChange/outputDelta" |
        "item/fileChange/patchUpdated" |
        "item/mcpToolCall/progress"
    ) {
        return false;
    }
    let params = message.get("params").cloned().unwrap_or_else(|| json!({}));
    let item = params.get("item").cloned().unwrap_or_else(|| json!({}));
    let item_type = item.get("type").and_then(Value::as_str).unwrap_or("");
    let item_id = item.get("id").and_then(Value::as_str);
    let status = item.get("status").and_then(Value::as_str).or_else(|| params.get("status").and_then(Value::as_str));
    let server_turn = params.pointer("/turn/id").and_then(Value::as_str).or_else(|| params.get("turnId").and_then(Value::as_str));
    if method == "turn/started" {
        context.activity_report_items.clear();
        if let Some(turn_id) = server_turn { context.turn_id = Some(turn_id.to_string()); }
    }
    let is_activity_report = item_type == "mcpToolCall"
        && item.get("server").and_then(Value::as_str) == Some("azalee_activity")
        && item.get("tool").and_then(Value::as_str) == Some("report_activity");
    if is_activity_report && method == "item/completed" {
        return false;
    }
    if is_activity_report && method == "item/started" {
        let Some(current_turn) = context.turn_id.as_deref() else { return false };
        if server_turn.is_some_and(|reported_turn| reported_turn != current_turn) { return false; }
        if !accept_report_item(&mut context.activity_report_items, item_id) { return false; }
        let Some((category, stage)) = activity_reporter::validated_report(item.get("arguments").unwrap_or(&Value::Null)) else {
            return false;
        };
        emit_event(
            app,
            &context.sequence,
            context.session_id.clone(),
            Some(current_turn.to_string()),
            "activity.intent",
            Some(stage),
            Some("report_activity".to_string()),
            item_id.map(str::to_string),
            json!({"sourceMethod": method, "itemType": item_type, "activity": {
                "category": category,
                "evidenceSource": "agent_report",
                "evidenceStrength": "reported",
                "stage": stage,
                "predicted": true
            }}),
        );
        return false;
    }
    if method != "turn/started" {
        if let Some(turn_id) = server_turn { context.turn_id = Some(turn_id.to_string()); }
    }
    let server_session = params.get("threadId").and_then(Value::as_str).or_else(|| params.pointer("/thread/id").and_then(Value::as_str));
    if let Some(session_id) = server_session { context.session_id = Some(session_id.to_string()); }

    let (event_type, lifecycle, tool_name) = match method {
        "thread/started" => ("session.started", Some("active"), None),
        "turn/started" => ("turn.started", Some("in_progress"), None),
        "turn/completed" => {
            let status = params.pointer("/turn/status").and_then(Value::as_str).unwrap_or("unknown");
            let normalized = match status { "completed" => "completed", "interrupted" => "interrupted", "failed" => "failed", _ => "failed" };
            ("turn.completed", Some(normalized), None)
        }
        "item/started" if is_tool_item(item_type) => ("tool.started", Some("in_progress"), normalized_tool_name(item_type, &item)),
        "item/completed" if is_tool_item(item_type) => ("tool.completed", status.or(Some("completed")), normalized_tool_name(item_type, &item)),
        "item/started" => ("item.started", status.or(Some("in_progress")), None),
        "item/completed" => ("item.completed", status.or(Some("completed")), None),
        "serverRequest/resolved" => ("request.resolved", Some("resolved"), None),
        "item/commandExecution/requestApproval" | "item/fileChange/requestApproval" | "item/permissions/requestApproval" => ("approval.required", Some("waiting"), None),
        "item/tool/requestUserInput" => ("user_input.required", Some("waiting"), None),
        "error" => ("turn.failed", Some("failed"), None),
        _ => ("agent.event", status, None),
    };
    let request_id = message.get("id").map(Value::to_string);
    let plan_category = if method == "turn/plan/updated" { predicted_activity_from_plan(&params) } else { None };
    if let Some(category) = plan_category {
        emit_event(
            app,
            &context.sequence,
            context.session_id.clone(),
            context.turn_id.clone(),
            "activity.intent",
            Some("intended"),
            None,
            None,
            json!({"sourceMethod": method, "activity": {
                "category": category,
                "evidenceSource": "app_server_plan",
                "confidence": 0.35,
                "stage": "intended",
                "predicted": true
            }}),
        );
        return method == "turn/completed";
    }
    let metadata = json!({
        "sourceMethod": method,
        "itemType": if item_type.is_empty() { Value::Null } else { Value::String(item_type.to_string()) },
        "status": status,
        "reason": if method == "error" { Value::String("app_server_error".to_string()) } else { Value::Null },
        "activity": safe_activity_metadata(item_type, &item)
    });
    emit_event(app, &context.sequence, context.session_id.clone(), context.turn_id.clone(), event_type, lifecycle, tool_name, request_id, metadata);
    method == "turn/completed"
}

fn accept_report_item(seen: &mut HashSet<String>, item_id: Option<&str>) -> bool {
    let Some(item_id) = item_id else { return false };
    if seen.contains(item_id) || seen.len() >= 256 { return false; }
    seen.insert(item_id.to_string())
}

/// Converts a structured App Server plan into a minimal prediction. Plan text is
/// inspected transiently and is never included in the normalized event.
fn predicted_activity_from_plan(params: &Value) -> Option<&'static str> {
    let plan = params.get("plan")?.as_array()?;
    let ordered = plan.iter().filter(|step| step.get("status").and_then(Value::as_str) == Some("inProgress"))
        .chain(plan.iter().filter(|step| step.get("status").and_then(Value::as_str) == Some("pending")));
    for entry in ordered {
        let step = entry.get("step")?.as_str()?.to_ascii_lowercase();
        let has = |terms: &[&str]| terms.iter().any(|term| step.contains(term));
        if has(&["email"]) && has(&["draft", "send", "write"]) { return Some("EMAILING"); }
        if has(&["delete", "remove"]) && has(&["file", "folder", "directory"]) { return Some("DELETING"); }
        if has(&["image", "illustration", "artwork"]) && has(&["generat", "creat", "draw"]) { return Some("PAINTING"); }
        if has(&["markdown", "document", "prose", "paragraph", "report"]) && has(&["write", "creat", "draft", "generat"]) { return Some("WRITING"); }
        if has(&["code", "source", "javascript", "typescript", "python"])
            && has(&["write", "creat", "edit", "updat", "modif", "implement", "fix"]) { return Some("CODING"); }
    }
    None
}

/// Extracts only allowlisted semantic signals. Never forwards paths, commands, tool arguments, or output.
fn safe_activity_metadata(item_type: &str, item: &Value) -> Value {
    let mut category: Option<&str> = match item_type {
        "imageGeneration" => Some("image_generation"),
        _ => None,
    };
    let mut extensions = Vec::<String>::new();
    let mut change_kinds = Vec::<String>::new();
    let mut command_kinds = Vec::<String>::new();

    if item_type == "fileChange" {
        if let Some(changes) = item.get("changes").and_then(Value::as_array) {
            for change in changes.iter().take(16) {
                let mut has_allowlisted_extension = false;
                if let Some(path) = change.get("path").and_then(Value::as_str) {
                    if let Some(extension) = Path::new(path).extension().and_then(|value| value.to_str()) {
                        let extension = extension.to_ascii_lowercase();
                        if matches!(extension.as_str(), "js" | "jsx" | "ts" | "tsx" | "mjs" | "cjs" | "py" | "rs" | "go" | "java" | "kt" | "swift" | "c" | "h" | "cpp" | "hpp" | "cs" | "rb" | "php" | "html" | "css" | "scss" | "json" | "yaml" | "yml" | "toml" | "md" | "txt" | "rtf" | "doc" | "docx" | "odt") {
                            extensions.push(extension);
                            has_allowlisted_extension = true;
                        }
                    }
                }
                if has_allowlisted_extension {
                    if let Some(kind) = change.pointer("/kind/type").and_then(Value::as_str) {
                        if matches!(kind, "add" | "update" | "delete") {
                            change_kinds.push(kind.to_string());
                        }
                    }
                }
            }
        }
    }

    if item_type == "commandExecution" {
        if let Some(actions) = item.get("commandActions").and_then(Value::as_array) {
            for action in actions.iter().take(16) {
                if let Some(kind) = action.get("type").and_then(Value::as_str) {
                    if matches!(kind, "read" | "listFiles" | "search" | "unknown") { command_kinds.push(kind.to_string()); }
                }
                if let Some(command) = action.get("command").and_then(Value::as_str) {
                    let token = command.trim().split(|character: char| character.is_whitespace() || character == ';' || character == '|').next().unwrap_or("");
                    if matches!(token, "rm" | "unlink" | "rmdir") { command_kinds.push(token.to_string()); }
                }
            }
        }
    }

    if matches!(item_type, "mcpToolCall" | "dynamicToolCall") {
        if let Some(tool) = item.get("tool").and_then(Value::as_str) {
            let normalized = tool.to_ascii_lowercase();
            if normalized.contains("email") && (normalized.contains("draft") || normalized.contains("send")) {
                category = Some(if normalized.contains("send") { "email_send" } else { "email_draft" });
            } else if normalized.contains("image") && (normalized.contains("generat") || normalized.contains("creat")) {
                category = Some("image_generation");
            } else if normalized.contains("document") && (normalized.contains("generat") || normalized.contains("creat") || normalized.contains("write")) {
                category = Some("document_generation");
            }
        }
    }

    json!({
        "operationCategory": category,
        "artifactExtensions": extensions,
        "changeKinds": change_kinds,
        "commandKinds": command_kinds
    })
}

fn is_tool_item(item_type: &str) -> bool {
    matches!(item_type, "commandExecution" | "mcpToolCall" | "dynamicToolCall" | "collabToolCall")
}

fn normalized_tool_name(item_type: &str, item: &Value) -> Option<String> {
    let name = match item_type {
        "commandExecution" => "shell",
        "mcpToolCall" | "dynamicToolCall" | "collabToolCall" => item.get("tool").and_then(Value::as_str).unwrap_or("tool"),
        _ => return None,
    };
    Some(name.chars().take(80).collect())
}

fn emit_event(
    app: &AppHandle,
    sequence: &AtomicU64,
    session_id: Option<String>,
    turn_id: Option<String>,
    event_type: &str,
    status: Option<&str>,
    tool_name: Option<String>,
    request_id: Option<String>,
    metadata: Value,
) {
    let event: NormalizedEvent = new_event(sequence, session_id, turn_id, event_type, status.map(str::to_string), tool_name, request_id, metadata);
    let _ = app.emit(EVENT_NAME, event);
}

fn send_request(writer: &Arc<Mutex<ChildStdin>>, id: u64, method: &str, params: Value) -> Result<(), String> {
    send_json(writer, &json!({"method": method, "id": id, "params": params}))
}

fn send_json(writer: &Arc<Mutex<ChildStdin>>, value: &Value) -> Result<(), String> {
    let mut stdin = writer.lock().unwrap_or_else(|e| e.into_inner());
    serde_json::to_writer(&mut *stdin, value).map_err(|_| "Could not encode App Server request".to_string())?;
    stdin.write_all(b"\n").map_err(|_| "Could not send request to Codex App Server".to_string())?;
    stdin.flush().map_err(|_| "Could not flush request to Codex App Server".to_string())
}

fn resolve_codex_binary() -> Result<PathBuf, String> {
    if let Ok(path) = std::env::var("CODEX_BIN") {
        let path = PathBuf::from(path);
        if path.is_file() { return Ok(path); }
    }
    if let Some(path) = std::env::var_os("PATH") {
        for directory in std::env::split_paths(&path) {
            let candidate = directory.join("codex");
            if candidate.is_file() { return Ok(candidate); }
        }
    }
    if let Some(home) = std::env::var_os("HOME") {
        for candidate in [Path::new(&home).join(".local/bin/codex"), Path::new(&home).join(".cargo/bin/codex")] {
            if candidate.is_file() { return Ok(candidate); }
        }
    }
    for candidate in [
        PathBuf::from("/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex"),
        PathBuf::from("/Applications/Codex.app/Contents/Resources/codex"),
        PathBuf::from("/opt/homebrew/bin/codex"),
        PathBuf::from("/usr/local/bin/codex"),
    ] {
        if candidate.is_file() { return Ok(candidate); }
    }
    Err("Codex CLI was not found. Set CODEX_BIN or add codex to PATH, then restart Azalee.".to_string())
}

#[allow(dead_code)]
fn _workspace_is_absolute(path: &Path) -> bool { path.is_absolute() }

#[cfg(test)]
mod activity_metadata_tests {
    use super::{accept_report_item, predicted_activity_from_plan, safe_activity_metadata};
    use std::collections::HashSet;
    use serde_json::json;

    #[test]
    fn extracts_only_allowlisted_file_signals() {
        let metadata = safe_activity_metadata("fileChange", &json!({
            "changes": [
                { "path": "/private/project/src/main.ts", "kind": { "type": "update" }, "diff": "private source" },
                { "path": "/private/project/notes.md", "kind": { "type": "delete" }, "diff": "private prose" },
                { "path": "/private/project/.env", "kind": { "type": "update" }, "diff": "secret" }
            ]
        }));
        assert_eq!(metadata["artifactExtensions"], json!( ["ts", "md"] ));
        assert_eq!(metadata["changeKinds"], json!( ["update", "delete"] ));
        assert!(metadata.get("path").is_none());
        assert!(metadata.get("diff").is_none());
    }

    #[test]
    fn recognizes_explicit_image_generation_item() {
        let metadata = safe_activity_metadata("imageGeneration", &json!({ "result": "private image data" }));
        assert_eq!(metadata["operationCategory"], "image_generation");
        assert_eq!(metadata["artifactExtensions"], json!([]));
        assert!(metadata.get("result").is_none());
    }

    #[test]
    fn plan_prediction_is_sanitized_and_requires_specific_activity_evidence() {
        assert_eq!(predicted_activity_from_plan(&json!({"plan": [
            {"status": "inProgress", "step": "Create a JavaScript source file"}
        ]})), Some("CODING"));
        assert_eq!(predicted_activity_from_plan(&json!({"plan": [
            {"status": "pending", "step": "Run pwd in the workspace"}
        ]})), None);
    }

    #[test]
    fn activity_report_requires_an_item_id_and_deduplicates_within_the_turn() {
        let mut seen = HashSet::new();
        assert!(!accept_report_item(&mut seen, None));
        assert!(accept_report_item(&mut seen, Some("item-1")));
        assert!(!accept_report_item(&mut seen, Some("item-1")));
        assert!(!accept_report_item(&mut seen, Some("item-1"))); // Completed items remain deduplicated until the next turn.
        seen.clear(); // Turn start resets report identity scope.
        assert!(accept_report_item(&mut seen, Some("item-1")));
    }
}
