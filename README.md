# Expressive Azalee

A standalone macOS desktop companion with the existing Azalee sprite atlas and a first Codex App Server adapter. The animation renderer and behavior mapper consume normalized, agent-neutral events.

## Run the desktop app

Requirements: macOS 12 or later, Node.js 22 or later, Rust/Cargo, and the Xcode Command Line Tools. Install JavaScript dependencies once with `npm install`.

```sh
npm start
```

For a distributable `.app`:

```sh
npm run tauri:build
```

The app is a transparent, always-on-top, frameless Tauri 2 window. Drag Azalee by the header or cat. The task launcher starts a new App Server thread in the workspace path shown on screen. The initial workspace is `expressive-azalee-workspace` under macOS's temporary directory; use **Temp** to return to it. Enter another existing folder path to choose a different workspace. Codex writes are confined to that selected folder, network access is disabled, and App Server approval requests require an explicit choice.

The Codex CLI must be installed and signed in through its supported sign-in flow. Azalee launches `codex app-server` and relies on the CLI’s authentication; it does not read or copy credential files. If the CLI is not found on `PATH`, set `CODEX_BIN` to the executable path before launching Azalee. The current installation’s bundled CLI is detected as a fallback.

## Use the companion

Enter a prompt and press **Start Codex task**. Azalee changes to Working on the live `turn/started` / tool events and returns to Idle on completion. Failed turns use Failed; interrupted turns return to Idle. The task output itself is not displayed in this minimal companion.

Expand **Developer controls** to select any of the nine original atlas rows, adjust frame speed, set the five generic behavior states, inspect the latest normalized event, see App Server connection state, or replay simulated success, failure, interruption, and approval-wait sequences.

## Architecture

```text
Codex App Server → Codex adapter → normalized event collector
                 → generic state mapper → animation controller → Azalee renderer
```

- `src-tauri/src/codex.rs` starts the official App Server process, creates a thread and turn in the selected workspace, streams notifications, handles explicit command/file approval decisions, and emits normalized events. It owns Codex JSON-RPC and CLI discovery.
- `src-tauri/src/normalized_event.rs` defines the normalized event contract: event ID and timestamp, agent type, session/thread ID, turn ID, event type, lifecycle status, optional tool name and request ID, and sanitized metadata.
- `src/event-collector.js` validates and distributes normalized events; duplicate IDs are ignored.
- `src/state-mapper.js` maps lifecycle evidence to IDLE, WORKING, WAITING, FAILED, or REVIEW. It suppresses redundant state changes and ignores duplicate, out-of-order, and old-session events.
- `src/animation-controller.js` exposes `setBehavior(behavior)` and maps generic states to the appropriate sprite rows.
- `src/azalee-renderer.js` loads the unchanged atlas, crops 192×208 cells, and loops the selected row at the configured frame interval.
- `src/codex-adapter.js` connects the frontend to normalized Tauri events and task controls. The renderer has no Codex dependency.
- `src-tauri/tauri.conf.json` configures the transparent, frameless, always-on-top macOS window.

The nine art rows remain in their original order: Idle, Running Right, Running Left, Waving, Jumping, Failed, Waiting, Running, Review. The five generic behaviors currently select Idle, Running, Waiting, Failed, and Review. Manual development controls can play each row directly.

## Checks

```sh
npm run check
npm test
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
```

The Node tests cover behavior validation, atlas row metadata, event validation/deduplication, animation mapping, and state handling for success, failure, interruption, approvals, and stale events. Rust includes a normalized-event schema test.

## Current limits

This milestone starts Codex sessions through App Server; it does not observe arbitrary Codex Desktop sessions. It intentionally does not implement Claude integration, semantic activity classification, Basic/Expressive modes, or a full chat transcript view. Codex tool input/output text is not sent to the renderer or shown in development event summaries. Generic App Server user-input requests are surfaced as Waiting but do not yet have a free-text response panel.
