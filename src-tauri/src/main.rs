mod activity_reporter;
mod codex;
mod normalized_event;

use serde_json::{json, Value};
use std::io::Write;
use std::sync::{atomic::AtomicBool, Arc, Mutex};
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

pub struct RunnerState {
    pub running: Arc<AtomicBool>,
    pub event_sequence: Arc<std::sync::atomic::AtomicU64>,
    pub active: Arc<Mutex<Option<codex::ActiveSession>>>,
    pub pending_approvals: Arc<Mutex<std::collections::HashMap<String, serde_json::Value>>>,
}

#[derive(Default)]
pub struct PetRuntimeState(Mutex<Option<Value>>);

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
    let application_version = if application_version.len() <= 80
        && application_version
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "._+-".contains(c))
    {
        application_version
    } else {
        "unknown".to_string()
    };
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
        "pet.visibility.changed",
        "pet.position.changed",
        "manager.visibility.changed",
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

#[tauri::command]
fn set_pet_visibility(app: tauri::AppHandle, visible: bool) -> Result<(), String> {
    let pet = app
        .get_webview_window("pet")
        .ok_or_else(|| "Pet window is unavailable".to_string())?;
    if visible { pet.show() } else { pet.hide() }
        .map_err(|_| "Could not update pet window visibility".to_string())
}

#[tauri::command]
fn report_pet_runtime(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, PetRuntimeState>,
    atlas_loaded: bool,
    canvas_width: u32,
    canvas_height: u32,
) -> Result<(), String> {
    if window.label() != "pet" || canvas_width > 4096 || canvas_height > 4096 {
        return Err("Pet runtime status did not pass validation".to_string());
    }
    let report = json!({
        "atlasLoaded": atlas_loaded,
        "canvasWidth": canvas_width,
        "canvasHeight": canvas_height
    });
    *state.0.lock().unwrap_or_else(|e| e.into_inner()) = Some(report.clone());
    window.app_handle().emit("azalee-pet-runtime", report)
        .map_err(|_| "Could not report pet runtime status".to_string())
}

#[tauri::command]
fn pet_runtime_status(
    app: tauri::AppHandle,
    state: tauri::State<'_, PetRuntimeState>,
) -> Result<Value, String> {
    let pet = app.get_webview_window("pet")
        .ok_or_else(|| "Pet window is unavailable".to_string())?;
    let position = pet.outer_position().map_err(|_| "Could not inspect pet position".to_string())?;
    let size = pet.inner_size().map_err(|_| "Could not inspect pet size".to_string())?;
    let report = state.0.lock().unwrap_or_else(|e| e.into_inner()).clone();
    Ok(json!({
        "renderer": report,
        "visible": pet.is_visible().unwrap_or(false),
        "position": {"x": position.x, "y": position.y},
        "size": {"width": size.width, "height": size.height}
    }))
}

#[tauri::command]
fn hide_manager_window(app: tauri::AppHandle) -> Result<(), String> {
    app.emit("manager.visibility.changed", json!({"visible": false}))
        .ok();
    app.get_webview_window("main")
        .ok_or_else(|| "Manager window is unavailable".to_string())?
        .hide()
        .map_err(|_| "Could not hide the manager window".to_string())
}

#[tauri::command]
fn show_manager_window(app: tauri::AppHandle) -> Result<(), String> {
    let manager = app
        .get_webview_window("main")
        .ok_or_else(|| "Manager window is unavailable".to_string())?;
    manager
        .show()
        .map_err(|_| "Could not show the manager window".to_string())?;
    manager
        .set_focus()
        .map_err(|_| "Could not focus the manager window".to_string())?;
    app.emit("manager.visibility.changed", json!({"visible": true}))
        .ok();
    Ok(())
}

fn pet_position_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|_| "Could not locate Azalee app data".to_string())?;
    std::fs::create_dir_all(&directory)
        .map_err(|_| "Could not prepare Azalee app data".to_string())?;
    Ok(directory.join("pet-position.json"))
}

#[tauri::command]
fn save_pet_position(app: tauri::AppHandle, x: i32, y: i32) -> Result<(), String> {
    let path = pet_position_path(&app)?;
    std::fs::write(
        path,
        serde_json::to_vec(&json!({"x": x, "y": y}))
            .map_err(|_| "Could not encode pet position".to_string())?,
    )
    .map_err(|_| "Could not save pet position".to_string())
}

fn clamp_position(x: i32, y: i32, bounds: (i32, i32, u32, u32), size: (u32, u32)) -> (i32, i32) {
    let (left, top, width, height) = bounds;
    let max_x = left.saturating_add(width.saturating_sub(size.0) as i32);
    let max_y = top.saturating_add(height.saturating_sub(size.1) as i32);
    (x.clamp(left, max_x.max(left)), y.clamp(top, max_y.max(top)))
}

fn position_for_pet(
    app: &tauri::AppHandle,
    pet: &tauri::WebviewWindow,
) -> Result<tauri::PhysicalPosition<i32>, String> {
    let outer_size = pet
        .outer_size()
        .map_err(|_| "Could not inspect Azalee's window size".to_string())?;
    let pet_size = (outer_size.width, outer_size.height);
    let monitors = pet
        .available_monitors()
        .map_err(|_| "Could not inspect displays".to_string())?;
    let primary = pet
        .primary_monitor()
        .map_err(|_| "Could not inspect the primary display".to_string())?;
    let saved = pet_position_path(app)
        .ok()
        .and_then(|path| std::fs::read(path).ok())
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .and_then(|value| {
            Some((
                i32::try_from(value.get("x")?.as_i64()?).ok()?,
                i32::try_from(value.get("y")?.as_i64()?).ok()?,
            ))
        });
    if let Some((x, y)) = saved {
        if let Some(monitor) = monitors.iter().find(|m| {
            let p = m.position();
            let s = m.size();
            x >= p.x
                && y >= p.y
                && (x as i64) < p.x as i64 + s.width as i64
                && (y as i64) < p.y as i64 + s.height as i64
        }) {
            let p = monitor.position();
            let s = monitor.size();
            let (x, y) = clamp_position(x, y, (p.x, p.y, s.width, s.height), pet_size);
            return Ok(tauri::PhysicalPosition::new(x, y));
        }
    }
    let monitor = primary.ok_or_else(|| "Could not determine a display for Azalee".to_string())?;
    let p = monitor.position();
    let s = monitor.size();
    let scale = monitor.scale_factor();
    let logical_w = (pet_size.0 as f64 / scale).round() as i32;
    let logical_h = (pet_size.1 as f64 / scale).round() as i32;
    let right = (s.width as f64 / scale).round() as i32;
    let bottom = (s.height as f64 / scale).round() as i32;
    let x =
        p.x.saturating_add(((right - logical_w - 24) as f64 * scale).round() as i32);
    let y =
        p.y.saturating_add(((bottom - logical_h - 44) as f64 * scale).round() as i32);
    let (x, y) = clamp_position(x, y, (p.x, p.y, s.width, s.height), pet_size);
    Ok(tauri::PhysicalPosition::new(x, y))
}

fn configure_pet_window(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let pet = WebviewWindowBuilder::new(app, "pet", WebviewUrl::App("pet.html".into()))
        .title("Azalee")
        .inner_size(210.0, 228.0)
        .min_inner_size(210.0, 228.0)
        .max_inner_size(210.0, 228.0)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .visible_on_all_workspaces(true)
        .skip_taskbar(true)
        .focusable(false)
        .shadow(false)
        .visible(true)
        .build()?;
    if let Ok(position) = position_for_pet(app, &pet) {
        pet.set_position(position)?;
    }
    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::{NSWindow, NSWindowCollectionBehavior};
        let raw = pet.ns_window()?;
        if !raw.is_null() {
            let window = unsafe { &*(raw as *const NSWindow) };
            window.setCollectionBehavior(
                NSWindowCollectionBehavior::CanJoinAllSpaces
                    | NSWindowCollectionBehavior::FullScreenAuxiliary
                    | NSWindowCollectionBehavior::IgnoresCycle,
            );
        }
    }
    Ok(())
}

fn main() {
    if std::env::args().any(|arg| arg == "--azalee-activity-mcp") {
        std::process::exit(activity_reporter::run());
    }
    tauri::Builder::default()
        .manage(RunnerState::default())
        .manage(PetRuntimeState::default())
        .invoke_handler(tauri::generate_handler![
            default_workspace,
            codex_version,
            start_study_session,
            append_study_record,
            end_study_session,
            start_task,
            interrupt_task,
            respond_to_approval,
            set_pet_visibility,
            hide_manager_window,
            show_manager_window,
            save_pet_position,
            report_pet_runtime,
            pet_runtime_status
        ])
        .setup(|app| {
            configure_pet_window(app.handle())?;
            if let Some(window) = app.get_webview_window("main") {
                #[cfg(target_os = "macos")]
                window.set_shadow(false)?;
            }
            let show = tauri::menu::MenuItem::with_id(
                app,
                "show-controls",
                "Show Azalee Controls",
                true,
                None::<&str>,
            )?;
            let quit =
                tauri::menu::MenuItem::with_id(app, "quit", "Quit Azalee", true, None::<&str>)?;
            let menu = tauri::menu::Menu::with_items(app, &[&show, &quit])?;
            let mut tray = tauri::tray::TrayIconBuilder::new()
                .menu(&menu)
                .show_menu_on_left_click(true);
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.on_menu_event(|app, event| match event.id().as_ref() {
                "show-controls" => {
                    let _ = show_manager_window(app.clone());
                }
                "quit" => app.exit(0),
                _ => {}
            })
            .build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                    window
                        .app_handle()
                        .emit("manager.visibility.changed", json!({"visible": false}))
                        .ok();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("failed to run Azalee desktop application");
}

#[cfg(test)]
mod window_tests {
    use super::clamp_position;

    #[test]
    fn clamps_saved_position_into_display_bounds() {
        assert_eq!(
            clamp_position(-500, 9000, (0, 0, 1200, 900), (210, 228)),
            (0, 672)
        );
        assert_eq!(
            clamp_position(400, 300, (0, 0, 1200, 900), (210, 228)),
            (400, 300)
        );
    }
}
