# Phase 5 — Early Structured Activity Reporting

## Summary

Azalee now has an opt-in, local MCP activity reporter for Codex App Server tasks. Codex can emit an `activity.intent` event immediately before a planned operation, with the event tied to the current session and turn. The event is labelled as reported intent and remains unconfirmed until App Server later supplies matching operation evidence.

The live test emitted the expected report in all 9 opted-in Coding, Writing, and Deleting runs. Compared with matched runs without reporting, this moved semantic feedback earlier in most Coding and Writing runs, but not in most Deleting runs. Total task duration also increased in these small samples. The reporter is useful as an experimental signal, but should remain optional.

## Supported integration

The installed Codex CLI is `codex-cli 0.162.0-alpha.17.2`. Its App Server command accepts documented `-c key=value` configuration overrides. Codex's MCP documentation supports local stdio MCP servers, including configuration scoped to the Codex App Server process. App Server item lifecycle notifications include the full `mcpToolCall` item, including `server`, `tool`, `arguments`, and status. These supported interfaces provide the mechanism needed here; this does not rely on App Server dynamic tools or Codex internals.

References: [Codex MCP configuration](https://developers.openai.com/codex/mcp) · [Codex App Server item and event schema](https://developers.openai.com/codex/app-server).

When the user enables the visible **Ask Codex to report activity intent** option, Azalee passes MCP configuration overrides only to the App Server child it starts. The app does not write global or project Codex configuration. The same toggle is independent of Basic/Expressive mode. With the option off, the original task prompt and App Server setup are retained.

The opt-in task receives a short, visible-behavior prompt prefix telling Codex to call `report_activity` immediately before a matching operation. This is necessary because tool availability alone does not make an agent call the tool. It adds an agent step, so duration comparisons include both the extra tool step and the added instruction.

## Event contract and lifecycle

The MCP tool accepts only these values:

```json
{
  "activity": "CODING",
  "stage": "intended"
}
```

The tool accepts `CODING`, `WRITING`, and `DELETING`. Generic `WORKING` is the implicit no-report fallback, so the tool rejects it along with unknown categories, non-`intended` stages, malformed arguments, and additional fields. The App Server adapter accepts the report only from the configured `azalee_activity` server's `report_activity` tool, only for the active turn, and only once per App Server item ID in a turn.

Azalee emits a normalized event with the following safe metadata:

```json
{
  "eventType": "activity.intent",
  "sessionId": "<active session>",
  "turnId": "<active turn>",
  "lifecycleStatus": "intended",
  "toolName": "report_activity",
  "metadata": {
    "sourceMethod": "item/started",
    "itemType": "mcpToolCall",
    "activity": {
      "category": "CODING",
      "evidenceSource": "agent_report",
      "evidenceStrength": "reported",
      "stage": "intended",
      "predicted": true
    }
  }
}
```

The MCP arguments are reduced to an allowlisted category and stage. Prompts, command strings, file paths, file contents, tool output, and numeric confidence claims are not retained in the normalized activity report. The existing session and turn IDs remain available for correct association.

The activity lifecycle retains an intention across generic shell events in the same turn without promoting it to confirmed execution. Matching `fileChange` or explicit deletion evidence can replace it with observed activity. Waiting, review, turn failure, and turn completion take precedence. A missing, malformed, or stale report falls back to existing classification or generic Working. A reporter tool error is returned as an MCP tool error; it does not terminate the MCP server or mark the whole turn failed.

Basic and Expressive use the same event and classification. Basic renders reported semantic categories as Working; Expressive labels a report `Intends Coding`, `Intends Writing`, or `Intends Deleting` until operation evidence confirms it. The activity option is not coupled to the presentation toggle.

## Implementation

- `src-tauri/src/activity_reporter.rs` implements the small stdio MCP server and strict tool-input validation. The existing Azalee binary starts this server only when invoked with its private reporter argument.
- `src-tauri/src/codex.rs` configures the optional local MCP server with process-local CLI overrides and normalizes its `item/started` report into a turn-scoped `activity.intent` event.
- `src-tauri/src/main.rs` adds the reporter launch path and forwards the visible opt-in setting to the Codex adapter.
- `src/codex-adapter.js`, `src/main.js`, `index.html`, and `src/styles.css` add the independent activity-reporting option and connect the new lifecycle manager to the shared presentation logic.
- `src/event-collector.js`, `src/activity-classifier.js`, and `src/activity-lifecycle.js` validate, classify, and preserve the reported intention while keeping it provisional.
- `tests/activity-classifier.test.js` and Rust unit tests cover valid/invalid reports, privacy filtering, stale/missing reports, duplicate item IDs, mode presentation, and failure/waiting priority.
- `scripts/validate-phase5-activity-reporting.mjs` runs the repeatable live test suite in disposable workspaces and writes only sanitized event and timing results to `PHASE5-LIVE-RESULTS.json`.

No new runtime dependencies, sprites, external services, or Codex configuration files were added.

## Live validation

The validation harness launched the installed official Codex App Server with the same MCP configuration overrides and task instruction used by the desktop app. It ran 24 turns: three reported and three baseline trials each for Coding, Writing, and Deleting; two baseline and two reporter-enabled generic `pwd` tasks; and baseline and reporter-enabled recoverable-failure tasks. Each task used a separate disposable directory under the system temporary directory. The harness measured elapsed time with `performance.now()` and deleted its temporary workspace after the runs.

All 24 turns completed. All nine reported Coding/Writing/Deleting trials produced at least one valid report matching the requested activity. One single-file Coding trial invoked the reporting tool twice. The two generic shell tasks with the reporter configured emitted no report. The artifact checks passed for all nine create/delete trials.

Times below are milliseconds from the harness sending `turn/start`, except paired duration deltas, which are reported minus baseline. First Working was observed 66–216 ms after `turn/start` across the live trials.

| Activity | Correct reports | Median first report | Confirmed semantic item after report | Report-to-item lead | Baseline confirmed semantic items | Median task duration, reported vs baseline | Median paired duration delta |
|---|---:|---:|---:|---:|---:|---:|---:|
| Coding | 3/3 | 4,385 ms (3,185–5,803) | 2/3 | 2,758 ms (2,693–2,824) when observed | 3/3, median 5,602 ms | 8,221 vs 6,623 ms | +1,711 ms |
| Writing | 3/3 | 2,844 ms (2,771–3,150) | 3/3 | 2,711 ms (1,321–2,777) | 2/3, median 4,905 ms among detections | 6,797 vs 5,639 ms | +472 ms |
| Deleting | 3/3 | 4,272 ms (3,204–6,466) | 3/3 | 1,688 ms (1,521–2,509) | 3/3, median 3,367 ms | 6,424 vs 4,100 ms | +2,440 ms |

“Confirmed semantic item” is the first matching App Server item start the existing deterministic classifier could recognize: `fileChange` for source/document changes, or a `commandExecution` item with explicit deletion evidence. These are App Server operation boundaries, not operating-system file-write timestamps. In the deletion case, the App Server item is a generic shell operation and does not reveal the exact instant the file was removed. One Coding report trial had no confirmed semantic item even though its file artifact existed; its report therefore remained intent evidence only.

The matched duration deltas are noisy and based on three paired runs per category. The median increase was positive for all three categories. This is total turn-duration overhead for the opted-in treatment, including the extra MCP call and task instruction; it is not an estimate of MCP transport cost alone. Failed App Server items were seen in reported and baseline tasks. The harness recorded aggregate failed-item counts, not their contents or per-tool identities, so those failures cannot be attributed to the reporter. No turn failed.

The four generic shell tasks (two baseline and two with the reporter configured) produced no semantic classification or report. The baseline and reporter-enabled recoverable-failure tasks each had one failed item and then completed their turn; the failure remained tool-level rather than becoming task-level FAILED. During an earlier reporter-enabled control run, Codex redundantly reported `WORKING` for the recoverable-failure task. The tool and prompt were tightened so generic work uses the no-report fallback; the final reporter-enabled control then emitted no report and completed. This is a useful example of why the semantic reporter accepts only the three specific categories.

## Validation and limits

- `npm run check`: passed, including the live validation harness syntax check.
- `npm test`: 22/22 passed.
- `cargo test --offline`: 7/7 passed.
- `npm run tauri:build`: passed and produced a release `.app` bundle.
- The packaged app was opened through LaunchServices. Its accessibility tree showed the new opt-in checkbox alongside the existing Basic/Expressive controls. The live suite exercised the same App Server configuration and release Azalee executable as the MCP server; the UI checkbox itself was verified visually/accessibly but was not used to submit each validation task.
- No global Codex configuration or credentials were accessed or modified.

The classifier's fallback behavior is conservative, but reported labels depend on the agent following the optional instruction. A report is a statement of immediate intent, not independent verification. Three repetitions per activity are feasibility evidence, not a reliable estimate of classification accuracy or participant task-time effects. Baseline ordering was alternated within each matched pair, but this small run does not control model variability or learning effects. Report use changes the task prompt and adds a model-selected tool step, both of which must be included in any HCI study protocol and disclosed consistently in Basic and Expressive conditions.

## Recommendation for Phase 6

Keep structured reporting optional and prioritize reliability and study instrumentation before adding activity-specific sprites or an LLM classifier. The reporter emitted the requested category in all nine opt-in trials and often preceded semantic App Server evidence by roughly 1.3–2.8 seconds, but Coding missed confirmed semantic evidence once, Deleting was often already recognized just as early without the report, and task duration increased in these small matched samples. Phase 6 should capture tool-level failure identity and event ordering without content, evaluate more randomized paired runs, and determine whether the prompt/tool step is acceptable for the study. New sprites can follow once the study has chosen the semantic categories and its intended-versus-confirmed display policy.
