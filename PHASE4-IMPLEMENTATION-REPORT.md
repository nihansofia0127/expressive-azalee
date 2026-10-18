# Phase 4 — Early Activity Detection and Activity Lifecycle

> **Phase 4.5 update:** The launch and App Server environment blockers were later resolved for validation, and nine live task runs were captured. See [PHASE4.5-VALIDATION-REPORT.md](PHASE4.5-VALIDATION-REPORT.md) for the updated runtime findings and timing results. The findings below describe the state at the end of Phase 4.

## Summary

Phase 4 adds a low-confidence prediction from Codex's structured plan event, carries prediction and execution stages through the agent-neutral activity classifier, and separates a failed tool from a failed turn. Basic and Expressive still consume the same normalized events. The task prompt sent to Codex is unchanged.

The implementation and release build pass. A fresh live timing run could not start: the installed App Server exited before authentication or thread creation because this execution environment cannot initialize its state database under `~/.codex`. No credential files were accessed, no sandbox restriction was bypassed, and no Phase 4 live event timings are claimed.

## App Server signals inspected

I generated the JSON Schema bundle from the installed `codex-cli 0.162.0-alpha.17.2` with its supported `app-server generate-json-schema` command. The generated notification schema verifies these signals:

| Signal | Fields or meaning | Classification use |
|---|---|---|
| `turn/started` | Thread and turn lifecycle | First generic Working state; no semantic category. |
| `turn/plan/updated` | `plan[]` entries with freeform `step` and `pending`, `inProgress`, or `completed` status; thread and turn IDs | Can suggest an activity before a tool starts. A plan step is an announced intention, not proof of execution. |
| `item/started` | Thread/turn IDs, item ID, item type, and start timestamp; item union includes `fileChange`, `commandExecution`, and tools | Confirms an observed operation has begun. Existing safe metadata extracts allowlisted file extensions/change kinds and deletion command tokens. |
| `item/completed` and `turn/completed` | Item or turn outcome/status | Confirms operation completion or the overall turn outcome. |
| `item/agentMessage/delta` | Arbitrary text delta with item/thread/turn IDs | Ignored. It is unstructured assistant text and may contain private content. |

The schema has no dedicated semantic activity field or `activity.report` notification. The supported plan event is the earliest structured signal found that can carry task meaning. Its step text is freeform, so the Codex adapter checks a small set of explicit keywords transiently and emits only a category, source, confidence, and lifecycle stage. The step text is never put in the normalized event. Unmatched or ambiguous steps produce no semantic prediction.

The public App Server overview describes the supported thread, turn, event-stream, and approval protocol: [Codex App Server documentation](https://developers.openai.com/codex/app-server), [Codex as a platform](https://developers.openai.com/blog/codex-as-a-platform). The protocol details above were verified against the schema emitted by the locally installed CLI.

## Implementation

- `turn/plan/updated` may produce `activity.intent` for CODING, PAINTING, WRITING, EMAILING, or DELETING when a plan step contains specific matching terms.
- Intent events contain `stage: intended`, `predicted: true`, `evidenceSource: app_server_plan`, and confidence `0.35`. They never claim the operation started.
- A subsequent supported `item/started` or `tool.started` event can classify an observed operation as executing. Completion and failure stages follow later lifecycle events. Session and turn IDs on App Server events remain intact.
- Assistant-message and patch-content deltas are ignored. No raw prompt, plan text, command, path, file content, or tool output is added to normalized metadata.
- Failed tool/item events now remain WORKING and report `failureScope: tool` in the debug evidence. A failed turn (`turn.failed` or failed `turn.completed`) maps to FAILED. A completed turn clears a recovered tool error to IDLE.
- Basic continues to show generic Working for semantic predictions; Expressive shows the semantic label while using the existing running animation. Both receive the same collector event and classifier result. The mode handler only re-renders presentation.

The plan event serves as the optional, controlled early report mechanism using an existing supported App Server event. It does not add instructions to the user's prompt, an MCP tool, or another service. It adds no model round trip; only local event processing occurs after the plan event arrives.

## Validation

| Check | Result |
|---|---|
| `npm run check` | Passed. |
| `npm test` | Passed: 17 tests. Includes prediction lifecycle, safe plan-event sanitization, both presentation modes, tool failure recovery, and turn-level failure. |
| `cargo test --offline` | Passed: 4 Rust tests. Includes plan keyword conservatism and sanitized metadata. |
| Tauri release build | Passed. Bundle: `src-tauri/target/release/bundle/macos/Expressive Azalee.app` (12.05 MiB). |
| Launch rebuilt app | Not verified. Direct executable launch exited with code 134; macOS `open -na` returned `kLSNoExecutableErr` for the generated bundle. The already-running older app window showed the existing Basic/Expressive controls and sprite, but it is not evidence that the rebuilt binary was launched. |
| Fresh real App Server tasks | Blocked before a task began. The official CLI reported: `failed to initialize sqlite state runtime under /Users/sofiayu/.codex: failed to initialize state runtime at /Users/sofiayu/.codex`. This is a state-database/filesystem initialization failure, not a confirmed authentication failure. The environment restriction prevents testing the live tasks here. |

The live-run attempt used a disposable temporary directory and prepared safe coding, writing, deletion, `pwd`, and recoverable-failure tasks. The process failed during App Server initialization, before `thread/start`, so none ran and no files were changed. Painting remains untested. The warning was not treated as an authentication failure, and I did not read or modify Codex state or credential files.

### Real timing comparison

Phase 4 timings below are unavailable because the new live runner could not initialize App Server. The comparison column gives the verified real-event baseline from [Phase 3.6 validation](PHASE3.6-VALIDATION-REPORT.md); it is not new Phase 4 evidence.

| Activity | Phase 4 first generic Working | Phase 4 first predicted semantic | Phase 4 first confirmed semantic | Phase 3.6 live baseline |
|---|---:|---:|---:|---|
| Coding | Not measured | Not measured | Not measured | CODING on file-change start at 3,623.7 ms after `turn/start`, 43.6 ms before item completion. |
| Writing | Not measured | Not measured | Not measured | WRITING on file-change start at 1,691.3 ms, 42.0 ms before item completion. |
| Deleting | Not measured | Not measured | Not measured | DELETING on `tool.started` at 2,927.9 ms. |
| Generic shell (`pwd`) | Not measured | None observed in Phase 3.6 | None; stayed WORKING | WORKING at 1,876.7 ms. |
| Recoverable tool failure | Not measured | Not measured | Not measured | A failed `false` tool event arrived at 1,688.9 ms; the turn later completed successfully at 3,049.4 ms. This motivated the failure-scope fix. |

The new event path adds no extra request, but the real arrival time of a plan event relative to tool start is not established in this run. The plan predictor's 35% confidence is a conservative product rule, not a measured accuracy rate. Synthetic tests verify routing and sanitization only; they do not establish live classification accuracy.

## Limitations and next step

Plan predictions depend on Codex emitting `turn/plan/updated` and on explicit activity words appearing in a plan step. A plan can be absent, delayed, broad, or wrong. In those cases Azalee remains at generic Working until observed operation metadata is available. The current conservative keyword rules cover only explicit, textual plan signals; Painting, Emailing, and Writing predictions have not been verified on live Codex tasks.

Phase 3.6 showed that Coding and Writing file-change events arrived only about 42 ms before completion. This phase provides a possible earlier intention signal, but its lead time and false-positive rate need live measurement before claiming an improvement.

Phase 4 should next be validated in an environment where the official Codex CLI can initialize its normal state database without relaxing filesystem restrictions. Compare plan intent against actual operation starts and turn outcomes. An optional LLM classifier is not warranted yet: the new supported plan signal is deterministic and makes no extra model call, while the main unknown is live signal coverage and timing. Reconsider only if real plan events remain too sparse or too ambiguous for the study.
