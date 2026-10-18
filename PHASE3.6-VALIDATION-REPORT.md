# Phase 3.6 — Local Environment and Real Codex Validation

## Summary

The missing Rust environment was resolved with the official rustup installer. Stable Rust 1.99.1 and Cargo are installed under `/Users/sofiayu/.cargo` and `/Users/sofiayu/.rustup`. The installer could not edit the shell's `.tcshrc`; I used the toolchain by adding `~/.cargo/bin` to the command PATH, without changing startup files.

The Phase 3 Tauri release app rebuilt successfully and was launched from its bundle in the desktop session. The Basic/Expressive controls and classification debug panel appeared. I changed modes in the running app, exercised a synthetic code fixture, and selected all nine atlas rows. The renderer showed the existing sprites, including distinct right/left running poses and the other existing poses. No sprite or renderer rewrite was made.

One small UI defect was fixed during validation: selecting an atlas preview row changed the canvas but left “Selected animation” in the debug panel stale. The debug value and canvas accessible label now follow the selected row. A Rust metadata test also exposed that an ignored `.env` file could still contribute its change kind; change kinds now follow only allowlisted extensions.

## Environment and checks

| Check | Result |
|---|---|
| Official stable Rust install | Passed: rustc 1.99.1, stable-aarch64-apple-darwin. |
| `npm run check` | Passed. |
| `npm test` | Passed: 12 tests. |
| `npm run build` | Passed. |
| `cargo test --offline` | Passed: 3 Rust tests. Cargo needed network access once to download crates because the initial local cache was empty; afterward the tests ran offline. |
| `npm run tauri -- build` | Passed: 12.07 MiB macOS app bundle at `src-tauri/target/release/bundle/macos/Expressive Azalee.app`. |
| Running app UI | Launched from the rebuilt bundle in the desktop session. Basic and Expressive toggles and the debug panel were visible and responsive. |
| All nine atlas rows | Selected in the running app; the debug animation name followed the chosen row after the fix, and the sprite canvas rendered the existing atlas poses. |

The first Rust test run found a real issue in safe metadata extraction: `.env` was excluded from extension metadata but its `update` kind still appeared. The extractor now records a change kind only when that file has an allowlisted extension. The final Rust suite passes all 3 tests.

The system `open -a` command returned macOS Launch Services error `kLSNoExecutableErr` for the generated bundle even though its `Contents/MacOS/expressive-azalee` arm64 executable exists. I launched and inspected that same rebuilt app through the desktop app interface, which succeeded. This appears to be a Launch Services registration issue in this environment; ordinary Finder launching was not independently confirmed.

## Live Codex event results

The following results come from the earlier Phase 3.5/3.6 real App Server validation in a temporary workspace. They are live protocol events, not synthetic fixtures. Event offsets are measured from the local `turn/start` request. Rule latency is local classifier evaluation time after an event arrived; it does not include network or paint latency.

| Activity | Result and first semantic evidence | Arrival offset | Rule latency | Timing and limitation |
|---|---|---:|---:|---|
| Coding | CODING on `item.started` / `fileChange`, extension `js`, kind `add`. | 3,623.7 ms | 0.526 ms | During execution; corresponding `item.completed` arrived 43.6 ms later. Turn completed at 5,631.8 ms. |
| Writing | WRITING on `item.started` / `fileChange`, extension `md`, kind `add`. | 1,691.3 ms | 0.180 ms | During execution; corresponding `item.completed` arrived 42.0 ms later. Turn completed at 2,737.5 ms. |
| Deleting | DELETING on `tool.started` / `commandExecution`, sanitized command kind `rm`. | 2,927.9 ms | 0.174 ms | During execution; the disposable file was verified absent. A combined command with unknown structure correctly remained WORKING. |
| Ambiguous shell (`pwd`) | WORKING on `tool.started`; no semantic operation metadata. | 1,876.7 ms | 0.027 ms | No false Coding result. Turn completed at 2,672.0 ms. |
| Failure (`false`) | FAILED on `tool.completed` with failed lifecycle. | 1,688.9 ms | 0.028 ms | Detected when the command failed; the overall turn later succeeded at 3,049.4 ms, so a failed tool can briefly appear as task failure. |
| Painting | Untested. | N/A | N/A | No supported image-generation tool was exercised. |

Coding and Writing evidence arrives only tens of milliseconds before the matching file-change completion event. That is technically before completion but gives little lead time for expressive feedback. The failure rule describes a failed operation, not necessarily a failed turn. These are the main classification timing/meaning limits for the next phase.

## Mode and animation UI validation

The running app started in Basic mode, then switched to Expressive and back. A code-editing fixture was explicitly marked “Synthetic fixture — not verified against real Codex execution.” Its rule result stayed CODING across the mode switch; Expressive showed the Coding label and the existing running placeholder. The toggle only re-renders the latest result and does not call the agent adapter.

The developer atlas control was used to select Idle, Running Right, Running Left, Waving, Jumping, Failed, Waiting, Working, and Review. Those names correspond to the nine rows in the original atlas. The asset and shared canvas renderer remain in place.

## Recommendation

Prioritize event timing and activity-state semantics before Claude integration or new animation assets. The existing event bridge provides sufficient evidence for some coding, writing, and explicit deletion actions, but those signals arrive late; tool failure and turn failure also need clearer separation. Painting remains unverified.
