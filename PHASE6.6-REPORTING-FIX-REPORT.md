# Phase 6.6 — Reporting Reliability Report

**Result: reporting works through Codex App Server for explicit semantic tasks, but the acceptance gate is not fully met.** The live fallback is App Server dynamic tools. The root cause of the model-triggered MCP failure remains unknown; no retry or error suppression was added.

## Findings and changes

- Direct MCP stdio protocol checks succeeded. A `codex exec` task with the MCP tool advertised completed without calling it, so that comparison is inconclusive.
- Through App Server, explicit `mcpServer/tool/call` reached the local MCP server and returned success. However, the prior Phase 6.5 matrix saw **0 reporter calls across 33 model-triggered MCP attempts**. The transport-level root cause is not established.
- App Server `dynamicTools` was used as the isolated fallback. One local task proved the full callback/acknowledgment path. Current Codex documentation describes the dynamic tool callback flow, but labels it experimental and requires `capabilities.experimentalApi = true` ([App Server dynamic tools](https://developers.openai.com/codex/app-server/#dynamic-tool-calls-experimental)).
- The Rust adapter now registers the allowlisted `azalee_report_activity` dynamic tool for the task thread, validates its category/stage and session/turn/call IDs, and returns success only after the normalized intent event is emitted. The existing MCP reporter implementation remains available but is no longer the active task-report path.
- Fixed the agent-neutral activity lifecycle: duplicate same-category reports are recorded as duplicates, generic tool completions keep an intent provisional, and turn completion, blocking states, or contradictory semantic evidence resolve it. Tests cover duplicate handling and ambiguous operations.

The dynamic tool API is experimental, which is a compatibility risk for a research instrument. Codex supports local stdio MCP configuration generally ([MCP configuration](https://developers.openai.com/codex/mcp/)); this installation’s model-triggered MCP path nevertheless remains unverified/reliably unavailable.

## Live App Server matrix

Seed **20261018**; 24 sequential runs, three repetitions per task/condition; temporary workspaces; network disabled. The result file contains sanitized counts, categories, and timings only.

| Task | Runs completed | Artifacts verified | Accepted matching reports | Invalid report attempts | Median first Working | Median first report |
|---|---:|---:|---:|---:|---:|---:|
| Coding, reporting on | 3/3 | 3/3 | 6 | 0 | 153 ms | 3,350 ms |
| Writing, reporting on | 3/3 | 3/3 | 6 | 0 | 167 ms | 3,342 ms |
| Deleting, reporting on | 3/3 | 3/3 | 3 | 0 | 182 ms | 7,003 ms |
| Coding, reporting off | 3/3 | 3/3 | 0 | 0 | 107 ms | — |
| Writing, reporting off | 3/3 | 3/3 | 0 | 0 | 174 ms | — |
| Deleting, reporting off | 3/3 | 3/3 | 0 | 0 | 163 ms | — |
| `pwd` control | 3/3 | n/a | 0 | 2 rejected | 113 ms | 3,406 ms* |
| Recoverable failure control | 3/3 | n/a | 0 | 2 rejected | 175 ms | 2,461 ms* |

All 24 turns completed. All nine reporting-on semantic tasks received at least one valid matching report; the extra Coding/Writing calls were duplicate reports, not new activity starts. No invalid control call became a normalized semantic activity event. However, the agent attempted the reporter in two `pwd` runs and one recoverable-failure run; those calls were rejected and contributed tool-level failures. The turns recovered and completed, but the control acceptance criterion is therefore **not cleanly passed**. `*` is the median attempted invalid call time, not a valid semantic detection.

For Coding and Writing, the median report arrived about 3.2 seconds after the first generic Working signal. Deleting arrived later (about 6.8 seconds after Working). Callback receipt itself was immediate in the adapter; these measurements include the model’s time to decide and invoke the tool. They are not user-visible animation latency measurements.

## Tauri UI / study recorder

Actual Tauri sessions were run and explicitly stopped in Basic, Expressive, and No Avatar conditions. Each produced a JSONL file and a validated summary with one completed turn. Basic displayed generic Working; Expressive displayed the confirmed Coding label with the existing Working animation; No Avatar logged hidden presentation. The final No Avatar lifecycle check recorded one received Coding intent followed by one duplicate, with no duplicate animation restart. The task used a generic shell operation, so that intent remained unconfirmed and ended at the turn boundary; it was not logged as confirmed Coding.

The first Basic and Expressive sessions predate the final duplicate-lifecycle correction and are marked as such in the machine-readable results. The final duplicate verification used the corrected build. Study condition affects presentation only; all modes consume the same normalized activity stream.

## Validation and readiness

- `npm test`: **34 passed**.
- `npm run check`: passed.
- `cargo test --offline`: **10 passed**.
- `npm run tauri:build`: passed; macOS bundle produced (12.19 MiB). Ad-hoc signing skipped notarization because signing credentials were not configured.
- UI session logs and summaries were checked for matching record counts, completed turns, and `session.ended`.
- Privacy check: persisted live results contain no prompts, paths, commands, file contents, or raw tool arguments.

**Phase 7 readiness: NO-GO for the full acceptance gate.** The semantic-task reporting path is demonstrated, the fallback is functional, duplicate reports no longer restart intent, and task-level turns completed. But rejected reporter attempts on controls still create tool-level failures, and the active mechanism depends on an experimental App Server API. Before Phase 7, either gate tool availability so controls cannot call the reporter, or explicitly revise the control criterion and accept the experimental API risk. Do not treat this matrix as broad accuracy evidence beyond these safe fixtures and tasks.

## Files

- `src-tauri/src/codex.rs`, `src-tauri/src/activity_reporter.rs`: App Server dynamic-tool transport and validation.
- `src/activity-lifecycle.js`, `tests/phase6-study.test.js`: provisional intent/duplicate lifecycle correction and tests.
- `scripts/validate-phase6.6-reporting.mjs`: seeded sanitized live validation matrix.
- `PHASE6.6-LIVE-RESULTS.json`: sanitized matrix results and Tauri study summaries.
