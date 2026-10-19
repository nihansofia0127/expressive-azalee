# Phase 7 — Floating Pet Implementation Report

## Result

The Phase 7 window architecture and UI split are implemented, and the macOS Tauri bundle builds. Phase 7 is **not yet accepted**: during desktop validation, the pet was not visible over another application and the real Codex task produced no normalized event in the Azalee debug panel. Phase 8 should wait until these runtime issues are resolved.

## Architecture and files

- The existing `main` webview remains the manager. It owns the Codex App Server connection, task controls, presentation mode, study controls, lifecycle, and privacy-filtered study logging.
- A single `pet` webview is created once during Tauri setup. It loads `pet.html`, uses the existing `createAzaleeRenderer` and the existing sprite atlas, and receives display updates over the Tauri event bus. Reopening the manager reuses the existing window; it does not create a second agent session or pet.
- The manager hides on close and can be reopened from the menu-bar tray item. Quit remains an explicit tray menu action.
- Changed files: `index.html`, `pet.html`, `src/main.js`, `src/pet-window.js`, `src/pet.css`, `src/study-recorder.js`, `tests/phase6-study.test.js`, `scripts/build-frontend.mjs`, `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/capabilities/default.json`, `src-tauri/gen/schemas/capabilities.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, and `src-tauri/src/main.rs`.

## Window behavior

- The pet is frameless, transparent, fixed at a compact 210×228 logical size, non-resizable, always-on-top, excluded from the Dock/taskbar, and configured non-focusable. The sprite canvas is 192×208 logical pixels and keeps the renderer’s Retina-aware drawing and nine existing atlas rows.
- Dragging uses Tauri’s native window drag. The last physical screen position is saved in Azalee app data. On startup, saved coordinates are clamped to a connected monitor; first launch places the pet near the primary monitor’s lower-right corner.
- macOS uses Tauri’s all-workspaces behavior plus `NSWindowCollectionBehaviorCanJoinAllSpaces`, `FullScreenAuxiliary`, and `IgnoresCycle`, behind a non-null native-window check. Fullscreen behavior is best-effort.
- Clicks outside the compact window bounds can reach other apps. macOS/Tauri do not provide per-pixel click-through while preserving drag with this implementation, so transparent portions inside the small rectangular window may still intercept clicks. No blanket mouse-event ignoring is enabled.

## Experimental conditions and logging

- NO_AVATAR sets the pet window hidden while the manager continues to own the same agent/session and recorder. BASIC presents generic states; EXPRESSIVE presents semantic labels using the existing placeholder animations. Both receive the same normalized activity state and the selected mode affects only presentation.
- A study condition stays fixed for the duration of a recorded session, preserving the experiment. Outside a study session, mode changes update presentation without restarting the agent.
- Study logs now accept privacy-safe pet visibility, pet move, and manager visibility transitions. Position records store only a drag reason, never screen coordinates. Existing display transition records remain in place.
- The control-task reporter issue and experimental dynamic-tool API remain Phase 6.6 study-readiness limitations.

## Validation evidence

- `npm run check`: passed.
- `npm test`: 35 passed, 0 failed.
- `cargo test --offline`: 11 passed, 0 failed, including a new monitor-bound clamping test.
- `git diff --check`: passed.
- `npm run tauri:build`: passed; produced the macOS `.app` bundle (12.50 MiB). `codesign --verify --deep --strict` passed. Notarization was skipped because Apple notarization credentials were unavailable.
- The Tauri development launcher started the manager window and reported App Server ready. The release bundle’s `open` attempt returned `kLSNoExecutableErr` despite a present executable matching `CFBundleExecutable`; direct executable launch aborted in macOS `_RegisterApplication`. The diagnostic stack identifies LaunchServices/AppKit registration but does not establish the underlying cause.
- One real task was submitted from the manager in the safe temporary workspace. Its requested artifact appeared, but the manager remained at “Starting Codex App Server…”, the debug panel showed no normalized event, Stop returned an error, and the pet was not visible in the cross-application screenshot. This is **not** a successful live semantic-reporting validation.
- The manager was visually inspected. Drag persistence, tray reopening, pet transparency, focus behavior, Mission Control, multiple Spaces, fullscreen, external displays, and relaunch-position behavior were not verified end to end. The missing pet in the cross-application view is a blocker, not an assumed pass.

## Readiness

**NO-GO for Phase 8.** First diagnose why the pet window does not appear and why the attempted real task does not update the normalized-event UI. Then verify show/hide across all three conditions, dragging and saved position, manager hide/reopen, and one real semantic event reaching the pet. The implementation preserves the existing renderer and study architecture, but runtime acceptance is still outstanding.
