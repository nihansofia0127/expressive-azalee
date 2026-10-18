mod codex;
mod normalized_event;

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
fn start_task(
    app: tauri::AppHandle,
    state: tauri::State<'_, RunnerState>,
    prompt: String,
    workspace: String,
) -> Result<(), String> {
    codex::start_task(app, state.inner(), prompt, workspace)
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
    tauri::Builder::default()
        .manage(RunnerState::default())
        .invoke_handler(tauri::generate_handler![
            default_workspace,
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
