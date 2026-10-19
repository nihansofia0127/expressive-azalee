# Phase 7.5 — Runtime Validation Report

## Result

**NO-GO for Phase 8.** The launch, event lifecycle, stop race, and renderer diagnostics received targeted changes, and the automated checks and production build pass. The required success condition—observing a floating Azalee and delivering one real Codex semantic event through the manager into the pet—was not met because the rebuilt macOS app still fails before Tauri setup.

## Confirmed findings and changes

### Manager lifecycle

- `start_task` intentionally returns after spawning the App Server worker; it does not wait for initialization or turn start. The manager set “Starting Codex App Server…” on submit but had no `turn.started` handler to replace it. The message therefore stayed stale throughout a successful task until a terminal event.
- Stop was enabled immediately, before the App Server had supplied a turn ID. A click in that interval returned “The Codex turn is not ready to interrupt.”
- The manager now switches to “Codex is working.” on `turn.started`, enables Stop only once the turn starts, and keeps Stop usable during waiting states. The Rust adapter now records the matching turn ID directly from the `turn/started` notification, closing the notification/RPC-response race. A targeted Rust regression test verifies that the live session becomes interruptible and stale sessions cannot replace its turn ID.
- This explains the stale progress message and early Stop error. It does **not** establish why the earlier run showed no normalized event; the event-to-window path could not be revalidated against a launchable build.

### Pet diagnostics

- The pet is still created from Tauri setup as the existing separate `pet` webview. Its page uses the existing renderer and atlas.
- Added a privacy-safe renderer report containing only atlas-load success and canvas dimensions. Rust stores that status and returns it with native visibility, position, and size. The manager’s developer panel displays that status and acknowledges presentation events received by the pet page.
- These diagnostics distinguish native window state, renderer readiness, and presentation delivery without adding a visual overlay or changing the renderer. They were compiled but could not be observed in a running rebuilt app.
- The prior Phase 7 screenshot reported no pet over another app. This phase did not establish whether that was a separately reproducible window defect or a consequence of the app launch/runtime failure.

### macOS launch

- The rebuilt bundle’s `CFBundleExecutable` is `expressive-azalee`; that file exists, is executable, and is an arm64 Mach-O binary. `codesign --verify --deep --strict` reports the bundle valid. The bundle uses an ad-hoc signature; notarization is skipped because Apple credentials are not configured.
- A fresh `open -a` attempt returned `-10827`, `kLSNoExecutableErr`, despite the executable being present.
- Direct execution exited 134. The newest diagnostic report records `EXC_CRASH`/`SIGABRT`, with the triggered stack entering `_RegisterApplication` and `NSApplication init` from Tauri’s Wry event loop. This occurs before `.setup`, so pet-window construction, tray creation, and the custom NSWindow collection behavior are not on the failing path.
- The evidence localizes the abort to AppKit/LaunchServices application registration, but it does not identify why registration aborts. The existing bundle metadata and signature checks do not show a missing or invalid executable. No security settings were changed.

## Runtime acceptance checklist

| Requirement | Result |
|---|---|
| Manager starts and shows a live task state | Code path corrected; not verified in a rebuilt GUI |
| App Server emits normalized events in manager | Not revalidated |
| Dynamic CODING intent reaches manager | Not verified with real execution |
| Pet page, atlas, and canvas render | Instrumented; not verified at runtime |
| Presentation reaches visible floating pet | Not verified; acceptance blocker |
| Stop targets the active turn | Race corrected and covered by Rust unit test; not live-verified |
| Transparency, always-on-top, dragging, persisted position | Not verified this phase |
| Manager hide/reopen, tray, no focus stealing, Spaces/fullscreen | Not verified this phase |
| NO_AVATAR/BASIC/EXPRESSIVE presentation and study logs | Existing automated coverage passes; not revalidated in the live desktop app |
| Duplicate windows or agent sessions | Not verified this phase |

## Validation

- `npm run check` — passed.
- `npm test` — 35 passed, 0 failed.
- `cargo test --offline --manifest-path src-tauri/Cargo.toml` — 12 passed, 0 failed.
- `git diff --check` — passed.
- `npm run tauri:build` — passed; produced `src-tauri/target/release/bundle/macos/Expressive Azalee.app` (12.56 MiB).
- Normal app opening — failed with `kLSNoExecutableErr`.
- Direct executable launch — aborted with exit code 134 before Tauri setup.
- Real Codex-to-pet task — not attempted in this phase because no rebuilt desktop app could be kept open for observation. No live event or artifact is claimed as validation.

## Files changed

- `src/main.js` — task progress status, pet runtime and presentation acknowledgements, visible native-status errors.
- `src/pet-window.js` — renderer readiness report and presentation acknowledgement.
- `index.html` — developer-panel runtime status field.
- `src-tauri/src/main.rs` — pet renderer status storage/reporting and native window status command.
- `src-tauri/src/codex.rs` — capture turn ID from the start notification and regression test for session matching.

## Remaining limitations and next step

The next step is to resolve the macOS AppKit/LaunchServices abort in an environment where the same bundle can be launched and inspected normally. Once it launches, first verify the pet runtime status and visibility, then run one harmless coding task with activity reporting enabled and confirm this complete chain: `turn.started` → normalized event → `activity.intent` → presentation event → pet acknowledgement and visible animation. Recheck Stop and basic window interactions there. Phase 8 should wait until that end-to-end evidence exists.
