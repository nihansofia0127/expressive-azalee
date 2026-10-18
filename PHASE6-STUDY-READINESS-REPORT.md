# Phase 6 — Study Instrumentation and Activity Reporting Reliability

## Readiness

**Phase 7 is not ready to begin.** The study UI and opt-in recorder are implemented, and all requested automated checks pass. In the real 80-turn App Server matrix, every activity-report MCP call ended with a failed tool status (32/32). The reporter's response was then corrected to follow the MCP tool-result shape, but a focused post-change live coding check still produced two failed calls. The underlying App Server error is not retained in sanitized logs, so its cause remains unknown. Fix and validate that integration before using activity reporting in a study.

## Changes made

- Added an agent-neutral activity lifecycle for intended, confirmed, superseded, duplicate, abandoned, completed, and failed activity evidence. Duplicate unresolved reports are recorded without restarting the displayed animation. A matching semantic operation confirms intent; unrelated completion abandons it. Turn/session boundaries clear pending intent. Tool-level errors remain recoverable; only turn-level failure drives the persistent failed state.
- Added an opt-in local study recorder. It records condition, safe task ID, application/agent versions, monotonic elapsed time, generic lifecycle transitions, activity evidence, display transitions, and safe tool types. It does not record prompts, file contents, paths, commands, tool arguments, session/turn IDs, or secrets. Logs are JSONL in Tauri app data under `study-output`; ending a session produces an aggregate JSON summary. Recording is off by default.
- Added randomized/counterbalanced study condition controls for `NO_AVATAR`, `BASIC`, and `EXPRESSIVE`. Conditions share the same agent settings and underlying classification stream. `NO_AVATAR` hides pet feedback while leaving task controls available; `BASIC` displays generic Working; `EXPRESSIVE` labels provisional intent and confirmed semantic activity. Participant sessions hide developer controls.
- Made reporter availability optional. The adapter checks that the local MCP reporter is listed before adding reporting instructions; if unavailable, the task continues without them. The reporter now returns an explicit `isError: false`, structured content, and matching serialized text content per the [MCP Tools specification](https://modelcontextprotocol.io/specification/2025-06-18/server/tools).

## Validation

- `npm run check`: passed.
- `npm test`: passed, 31 tests.
- `cargo test --offline` in `src-tauri`: passed, 8 tests.
- `npm run tauri:build`: succeeded. The existing Tauri app and original assets were preserved.
- `git diff --check`: passed.
- The rebuilt app's accessibility tree showed the Research session controls, Basic/Expressive controls, and task controls. The app UI was not used to start a persisted study session, so JSONL creation through a participant session was not manually exercised end to end. Renderer request transitions are logged; physical frame-paint latency was not measured.
- A direct stdio protocol check returned a successful reporter tool result. App Server reports still failed, indicating that the reporter implementation's direct protocol response alone does not resolve the runtime failure.

## Live Codex experiment

The harness ran in temporary workspaces with networking disabled, using seed `20261018`: 10 trials each for Coding, Writing, and Deleting with reporting enabled and disabled (60 activity trials), plus 5 each of `pwd` and recoverable-failure controls with reporting enabled and disabled (20 controls). `PHASE6-LIVE-RESULTS.json` contains the sanitized per-trial results; `PHASE6-REPORTER-DIAGNOSTIC.json` contains a focused post-response-change check. All 80 turns completed. All 20 generic controls emitted zero activity reports; recoverable failures remained tool-level and did not fail their turns.

| Activity / condition | Verified artifacts/actions | Correct intent reports | Matching confirmations | Unconfirmed intents | Median first Working | Median first report | Median report-to-confirmation | Median turn duration |
|---|---:|---:|---:|---:|---:|---:|---:|
| Coding, reporting on | 9/10 | 12/12 (10 tasks) | 3/10 | 7/10 | 79.9 ms | 4,486.8 ms | 1,723.7 ms* | 6,841.8 ms |
| Coding, reporting off | 10/10 | — | — | — | 84.4 ms | — | — | 6,184.5 ms |
| Writing, reporting on | 9/10 | 10/10 | 7/10 | 3/10 | 81.8 ms | 3,264.6 ms | 3,278.8 ms | 8,132.5 ms |
| Writing, reporting off | 10/10 | — | — | — | 89.6 ms | — | — | 5,156.2 ms |
| Deleting, reporting on | 8/10 | 10/10 | 8/10 | 2/10 | 83.3 ms | 4,749.5 ms | 1,585.3 ms | 7,493.5 ms |
| Deleting, reporting off | 10/10 | — | — | — | 81.8 ms | — | — | 4,327.2 ms |
| `pwd` / recoverable-failure controls, either condition | 20/20 turns completed | 0 reports | — | — | 76–84 ms by arm | — | — | 3,364–4,546 ms by arm |

*Coding confirmation latency is the median among the three trials that produced a matching semantic event. “First Working” is the App Server turn-start/working observation, not a measured UI paint. “First report” is when the reporter operation appeared in the event stream. Confirmed semantic events were matching observed operations, not the agent's statement of intent. The JSONL recorder's `activity.display.started` means a renderer state request; it does not claim a frame was physically painted.

The reported-minus-baseline median turn-duration differences were +1.07 s for Coding, +2.72 s for Writing, and +2.95 s for Deleting. With only 10 trials per arm and model/runtime variability, these are descriptive, not causal estimates. Still, reporting added substantial observed delay in this run. Median first reports arrived 3.3–4.7 seconds after turn start, and the Writing/Deleting report often preceded the matching semantic item by seconds. Thus intent can be useful before confirmation, but it is not early in absolute task time and did not reliably confirm the eventual action.

The Coding duplicate reports were separate MCP item starts, not collector replay. Two of ten reporting-enabled Coding tasks produced duplicate reports (12 calls for 10 tasks). All 32 reporter calls in the matrix ended as failed MCP items despite valid two-field arguments. A post-change focused coding check also had two separate failed calls. The sanitized data indicates an MCP tool error but omits its message and code by design; the exact cause cannot be stated. Retries are consistent with the observed duplicate calls, but the agent's reason for retrying is not verified.

## Limitations and next step

- The experiment validates the App Server path and classifier lifecycle, but the failing report tool means report-on behavior is not reliable enough for participant use.
- Reporting-on tasks verified 26/30 filesystem outcomes; reporting-off tasks verified 30/30. These small randomized arms do not establish that reporting caused the difference, but the result reinforces the need to fix the reporter and repeat the randomized matrix before study deployment.
- Generic controls produced no semantic false positives. Intent correctness alone is not evidence that work occurred: 12/30 reported activity trials did not receive a matching confirmed semantic event, and 4/30 had no verified artifact/action.
- The experiment did not measure physical animation frame latency or run all conditions through the study UI. Manual UI presence was verified, while recorder persistence through an actual UI study session remains to be exercised.

**Recommended next step:** make the local MCP tool call succeed in the actual Codex App Server path, expose only a sanitized failure category for diagnosis, and repeat the seeded activity/control matrix. Then verify one complete study session through the UI, including JSONL and summary creation, condition display, and stop behavior. Defer an LLM classifier and new animation assets until reporting reliability and participant-session logging pass these checks.
