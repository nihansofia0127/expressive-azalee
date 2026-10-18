# Phase 2 — Implementation Report

## Delivered

- Packaged a standalone macOS companion in Tauri 2. It is transparent, frameless, always on top, and can be dragged by its header or cat.
- Reused the original nine-row Azalee atlas byte-for-byte. The canvas renderer crops the original 192×208 frames and supports each atlas row, frame speed, and five generic behaviors.
- Kept behavior mapping and animation control agent-neutral. Codex-specific process discovery, JSON-RPC, approval handling, and event conversion live behind a Codex adapter.
- Added a task launcher with a temporary default workspace, workspace selection, stop control, approval prompts, and collapsed developer controls for simulated events and normalized event inspection.
- Restricted each Codex turn to the selected writable workspace, disabled network access, and used the installed Codex CLI’s App Server interface. The app does not read or copy credential files.

## Verification

- Built `src-tauri/target/release/bundle/macos/Expressive Azalee.app` (12.04 MiB).
- Launched the packaged app and verified the Azalee sprite renderer and desktop window through the app accessibility tree.
- Ran a live, read-only Codex task from the app: `pwd` in the temporary workspace. The normalized stream reported a completed turn with session and turn IDs, and the app returned to Idle.
- Ran a second read-only task with a four-second shell delay. The live UI showed Working while Codex executed and Idle after completion.
- Started a 20-second read-only shell task and used Stop. Azalee returned to Idle and remained responsive.
- Confirmed the developer selector lists all nine original atlas rows. The original source atlas was left unchanged.
- `npm run check`, `npm test` (6 passed), frontend build, and `cargo test` (1 passed) succeeded.

## Limits and next step

The app starts its own Codex App Server thread; it does not passively observe tasks started in the regular Codex desktop app. General `tool/requestUserInput` requests can be shown as Waiting but do not yet have a text response flow. Basic/Expressive mode preferences and Claude Code integration remain future work. The next implementation step should add a normalized event adapter interface and an explicit mode setting, then evaluate desktop observation separately against the officially supported integration points found in Phase 1.5.
