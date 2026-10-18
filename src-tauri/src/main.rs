mod codex;
mod activity_reporter;
mod normalized_event;

use serde_json::{json, Value};
use std::io::Write;
use std::sync::{atomic::AtomicBool, Arc, Mutex};
use tauri::Manager;

pub struct RunnerState {
    pub running: Arc<AtomicBool>,
    pub event_sequence: Arc<std::sync::atomic::AtomicU64>,
    pub active: Arc<Mutex<Option<codex::ActiveSession>>>,
    pub pending_approvals: Arc<Mutex<std::collections::HashMap<String, serde_json::Value>>>,
}

impl Default for RunnerState {
    fn default() -> Self {
        Self {
            running: Arc::new(AtomicBool::new(false)),
            event_sequence: Arc::new(std::sync::atomic::AtomicU64::new(0)),
            active: Arc::new(Mutex::new(None)),
            pending_approvals: Arc::new(Mutex::new(std::collections::HashMap::new())),
        }
    }
}

#[tauri::command]
fn default_workspace() -> Result<String, String> {
    codex::default_workspace()
}

#[tauri::command]
fn codex_version() -> Option<String> {
    codex::codex_version()
}

fn study_output_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|_| "Could not locate Azalee's study output folder".to_string())?
        .join("study-output");
    std::fs::create_dir_all(&dir)
        .map_err(|_| "Could not create the local study output folder".to_string())?;
    Ok(dir)
}

fn valid_study_id(id: &str) -> bool {
    id.len() == 36 && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

#[tauri::command]
fn start_study_session(
    app: tauri::AppHandle,
    study_session_id: String,
    condition: String,
    activity_reporting_enabled: bool,
    study_task_id: String,
    application_version: String,
    agent_version: Option<String>,
) -> Result<String, String> {
    if !valid_study_id(&study_session_id)
        || !["NO_AVATAR", "BASIC", "EXPRESSIVE"].contains(&condition.as_str())
        || study_task_id.len() > 80
        || !study_task_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "._:-".contains(c))
    {
        return Err("Study session metadata did not pass validation".to_string());
    }
    let path = study_output_dir(&app)?.join(format!("session-{study_session_id}.jsonl"));
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|_| {
            "Could not create a new study log; the session ID may already exist".to_string()
        })?;
    let application_version = if application_version.len() <= 80 && application_version.chars().all(|c| c.is_ascii_alphanumeric() || "._+-".contains(c)) { application_version } else { "unknown".to_string() };
    let line = json!({
        "schemaVersion": 1, "timestamp": std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis(), "elapsedMs": 0,
        "eventType": "session.started", "studySessionId": study_session_id, "condition": condition,
        "activityReportingEnabled": activity_reporting_enabled, "applicationVersion": application_version,
        "agentVersion": agent_version.filter(|v| v.len() <= 80 && v.chars().all(|c| c.is_ascii_alphanumeric() || "._+- ".contains(c))),
        "studyTaskId": study_task_id
    });
    writeln!(file, "{line}").map_err(|_| "Could not write study session metadata".to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
fn append_study_record(
    app: tauri::AppHandle,
    study_session_id: String,
    record: Value,
) -> Result<(), String> {
    if !valid_study_id(&study_session_id) {
        return Err("Invalid study session ID".to_string());
    }
    let allowed = [
        "session.ended",
        "agent.turn.started",
        "agent.turn.completed",
        "agent.turn.failed",
        "agent.tool.started",
        "agent.tool.completed",
        "agent.tool.failed",
        "agent.state.changed",
        "activity.intent.received",
        "activity.intent.duplicate",
        "activity.intent.superseded",
        "activity.intent.abandoned",
        "activity.confirmed",
        "activity.reporter.unavailable",
        "activity.display.started",
        "activity.display.ended",
        "user.mode.changed",
        "user.task.started",
        "user.interruption.initiated",
        "user.approval.responded",
        "study.write.failed",
    ];
    let event_type = record
        .get("eventType")
        .and_then(Value::as_str)
        .filter(|value| allowed.contains(value))
        .ok_or_else(|| "Study event type is not allowed".to_string())?;
    let mut safe = serde_json::Map::new();
    safe.insert("schemaVersion".into(), json!(1));
    safe.insert(
        "timestamp".into(),
        json!(std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()),
    );
    safe.insert("studySessionId".into(), json!(study_session_id));
    safe.insert("eventType".into(), json!(event_type));
    for key in ["elapsedMs", "turnIndex", "duplicateCount", "predicted"] {
        if let Some(value) = record.get(key).filter(|v| v.is_number() || v.is_boolean()) {
            safe.insert(key.into(), value.clone());
        }
    }
    for key in [
        "condition",
        "activityReportingEnabled",
        "studyTaskId",
        "agentType",
        "toolType",
        "lifecycleStatus",
        "activity",
        "stage",
        "evidenceSource",
        "displayMode",
        "displayLabel",
        "animation",
        "reason",
    ] {
        if let Some(value) = record.get(key).and_then(Value::as_str).filter(|v| {
            v.len() <= 80
                && v.chars()
                    .all(|c| c.is_ascii_alphanumeric() || "._:- ".contains(c))
        }) {
            safe.insert(key.into(), json!(value));
        }
    }
    let path = study_output_dir(&app)?.join(format!("session-{study_session_id}.jsonl"));
    let mut file = std::fs::OpenOptions::new()
        .append(true)
        .open(path)
        .map_err(|_| "Study log is not available".to_string())?;
    writeln!(file, "{}", Value::Object(safe))
        .map_err(|_| "Could not append the study event".to_string())
}

#[tauri::command]
fn end_study_session(
    app: tauri::AppHandle,
    study_session_id: String,
    elapsed_ms: u64,
    turn_count: u64,
) -> Result<String, String> {
    if !valid_study_id(&study_session_id) {
        return Err("Invalid study session ID".to_string());
    }
    let dir = study_output_dir(&app)?;
    let log = dir.join(format!("session-{study_session_id}.jsonl"));
    let summary_path = dir.join(format!("session-{study_session_id}-summary.json"));
    let contents = std::fs::read_to_string(log)
        .map_err(|_| "Could not read the local study log for its summary".to_string())?;
    let mut counts = std::collections::BTreeMap::<String, u64>::new();
    for line in contents.lines() {
        if let Ok(value) = serde_json::from_str::<Value>(line) {
            if let Some(kind) = value.get("eventType").and_then(Value::as_str) {
                *counts.entry(kind.to_string()).or_default() += 1;
            }
        }
    }
    let summary = json!({ "schemaVersion": 1, "studySessionId": study_session_id, "endedTimestamp": std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis(), "elapsedMs": elapsed_ms, "turnCount": turn_count, "eventCount": contents.lines().count(), "eventCounts": counts });
    std::fs::write(
        &summary_path,
        serde_json::to_vec_pretty(&summary)
            .map_err(|_| "Could not summarize study log".to_string())?,
    )
    .map_err(|_| "Could not write study summary".to_string())?;
    Ok(summary_path.to_string_lossy().into_owned())
}

#[tauri::command]
fn start_task(
    app: tauri::AppHandle,
    state: tauri::State<'_, RunnerState>,
    prompt: String,
    workspace: String,
    activity_reporting: bool,
) -> Result<(), String> {
    codex::start_task(app, state.inner(), prompt, workspace, activity_reporting)
}

#[tauri::command]
fn interrupt_task(state: tauri::State<'_, RunnerState>) -> Result<(), String> {
    codex::interrupt_task(state.inner())
}

#[tauri::command]
fn respond_to_approval(
    state: tauri::State<'_, RunnerState>,
    request_id: String,
    decision: String,
) -> Result<(), String> {
    codex::respond_to_approval(state.inner(), request_id, decision)
}

fn main() {
    if std::env::args().any(|arg| arg == "--azalee-activity-mcp") {
        std::process::exit(activity_reporter::run());
    }
    tauri::Builder::default()
        .manage(RunnerState::default())
        .invoke_handler(tauri::generate_handler![
            default_workspace,
            codex_version,
            start_study_session,
            append_study_record,
            end_study_session,
            start_task,
            interrupt_task,
            respond_to_approval
        ])
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                #[cfg(target_os = "macos")]
                window.set_shadow(false)?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to run Azalee desktop application");
}
