# Phase 6.5 — MCP Activity Reporter Reliability Report

## Result

**Phase 7 is not ready.** The Tauri app builds and its tests pass, but the primary acceptance criterion is unmet: Codex App Server reports all 33 reporter tool calls as failed. The local MCP process does not receive `tools/call`, although it passes a direct stdio protocol check. No workaround, retry, or error suppression was added.

## Root cause investigation

The reporter is reachable from the App Server's configuration: `mcpServerStatus/list` reported `runtimeStatus: connected`, the tool was advertised, and there was no tools error before or after a task. The App Server emitted matching MCP tool item start/completion events, but each completion was failed. The error carried no useful code or diagnostic detail. There were no approval requests.

A minimal Node MCP server under the same App Server configuration reproduced the behavior. Its sanitized method trace contained `initialize`, `notifications/initialized`, and `tools/list`, but no `tools/call`. This localizes the failure to the App Server dispatch path before the MCP server receives the invocation. Direct stdio `initialize`, `tools/list`, and `tools/call` all succeed against the built Azalee reporter. The exact internal App Server cause remains unknown; the sanitized failure event does not expose enough detail to distinguish a client dispatch defect from another internal rejection.

The reporter advertises `inputSchema` and `outputSchema` as separate MCP tool fields and returns matching text and structured content with `isError: false`. This metadata was checked and the direct protocol test succeeds, but it did not resolve App Server dispatch. Increasing startup/tool timeouts and removing the status preflight also did not change the result. We did not change authentication or retry failed calls.

## Repeated live matrix

The matrix used seed `20261018`, 10 trials per activity arm and 5 per control arm (80 turns total), with temporary workspaces and network access disabled. Run order was randomized. Records contain elapsed times, allowlisted metadata, event shapes/statuses, and artifact booleans; they omit raw prompts, paths, commands, tool arguments, and Codex identifiers.

| Activity / condition | Turns completed | Reports | App Server report failures | Matching observed operation after report | Median Working (ms) | Median report (ms) | Median report-to-operation (ms) | Artifacts |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Coding, reporter on | 10/10 | 13 | 13/13 | 8/10 | 89.5 | 4,082 | 2,289 | 9/10 |
| Coding, reporter off | 10/10 | 0 | — | — | 81.4 | — | — | 10/10 |
| Writing, reporter on | 10/10 | 10 | 10/10 | 4/10 | 84.9 | 2,976 | 3,177 | 7/10 |
| Writing, reporter off | 10/10 | 0 | — | — | 87.4 | — | — | 10/10 |
| Deleting, reporter on | 10/10 | 10 | 10/10 | 8/10 | 84.7 | 4,723 | 2,041 | 8/10 |
| Deleting, reporter off | 10/10 | 0 | — | — | 82.0 | — | — | 10/10 |
| `pwd`, reporter on/off | 10/10 | 0 | — | — | 86.9 / 78.7 | — | — | n/a |
| Recoverable failure, reporter on/off | 10/10 | 0 | — | — | 82.4 / 83.6 | — | — | n/a |

All 30 activity tasks requested the expected semantic label, and all 30 turns completed. However, only 20 had a matching observed operation after the report; the remaining 10 intents were unconfirmed. All 20 controls produced zero reports. The recoverable `false` command generated tool-level failures but all 10 control turns completed. No turn-level task failures or approval requests were observed.

The report-to-operation timing is the interval from the report item to the first matching observed operation event. It is not UI paint latency. Working appeared at roughly 80–90 ms; reports arrived a median 3.0–4.7 seconds into the tasks. Since the App Server never dispatched them to the local MCP process, these are observed failed report attempts, not successful semantic activity signals. Reporting arms also had fewer completed artifacts (24/30) than controls (30/30); the data does not establish causality, but this is a material reliability concern.

Three coding trials emitted duplicate reports (13 calls across 10 trials). The existing lifecycle logic identifies identical unresolved reports as duplicates, and the JavaScript test verifies a duplicate does not replace the current intent. The renderer skips rerendering a duplicate. Thus duplicate reports do not restart the animation or reset its duration in the tested frontend logic. This was unit-tested; it could not be verified as a successful live MCP-to-animation path while App Server dispatch fails.

The complete sanitized matrix is in [PHASE6.5-LIVE-RESULTS.json](/Users/sofiayu/Desktop/honors-research/PHASE6.5-LIVE-RESULTS.json).

## Study UI validation

Three sessions were completed and stopped through the running Tauri UI: No Avatar, Basic, and Expressive. The UI showed the expected condition controls and presentation for each condition, and each session displayed “Recording saved” with JSONL and summary paths. The generated records were inspected: each had four events (`session.started`, `session.ended`, and the corresponding study condition records); summary counts matched, with zero task turns because no agent task was run inside those UI sessions. Records contained no prompt, path, command, argument, or content fields. Expressive showed the existing synthetic Emailing fixture; it was not a live Codex classification. These sessions validate study recording and condition switching, not live reporter behavior.

## Changes and verification

- Kept the agent adapter, renderer, sprites, and study conditions intact.
- Corrected the reporter tool definition to expose `outputSchema` at the MCP tool-definition level alongside `inputSchema`; direct stdio checks pass. This did not fix App Server dispatch.
- Added sanitized reporter diagnostics to the validation harness: allowlisted error categories/signals, approval method names, and before/after MCP connection/tool status. Raw error strings, prompts, paths, commands, and arguments are not persisted.
- `npm run check`: passed.
- `npm test`: 31 passed, 0 failed.
- `cargo test --offline`: 8 passed, 0 failed.
- `git diff --check`: passed.
- `npm run tauri:build`: passed; built the 12.17 MiB macOS app bundle. Notarization was skipped because Apple signing credentials were not configured.
- Built reporter direct stdio smoke check: advertised `report_activity` and returned a successful, matching `CODING/intended` result.

## Remaining limits and next step

The verified failure is in the Codex App Server MCP invocation path, but the emitted error does not identify the deeper internal cause. The harness cannot capture the local server's `tools/call` because none arrives. The failure must be resolved or diagnosed in the bundled App Server/runtime before semantic reporting can be considered reliable. Re-run the same seeded matrix after that dispatch path is shown to deliver a call to the local server, then verify the lifecycle in the UI. Until then, keep generic Working as the safe presentation and defer Phase 7.
