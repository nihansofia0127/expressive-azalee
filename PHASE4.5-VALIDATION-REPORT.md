# Phase 4.5 — Runtime Reliability and Live Early-Detection Validation

## Summary

The release app now has a reproducible ad-hoc bundle signature and launches through macOS LaunchServices when run in the permitted desktop environment. The earlier launch and App Server errors came from the restricted execution environment: LaunchServices and Codex's state runtime could not complete their normal startup work inside that sandbox. The official Codex CLI initialized successfully once the requested execution permission was granted.

Nine real App Server tasks completed in disposable workspaces: three Coding, three Writing, Deleting, `pwd`, and a recoverable shell failure. App Server emitted **zero `turn/plan/updated` notifications**, even though each Coding and Writing prompt explicitly requested a short plan. Coding and Writing used generic shell `commandExecution` items rather than semantic `fileChange` events, so the conservative classifier had no confirmed semantic evidence. Deleting was recognized from an explicit `rm` command token, but only about 1 ms before that shell item completed.

## 1. macOS application launch

### Findings

- `Contents/Info.plist` names `expressive-azalee` as `CFBundleExecutable`; that file exists, is executable, and is an arm64 Mach-O, matching the arm64 Mac. The bundle identifier and minimum macOS version are also present.
- No explicit entitlements were embedded. The bundle has an ad-hoc signature and no Developer ID team. There is no notarization configuration or Apple signing identity in this environment.
- Before the correction, `codesign --verify --deep --strict` rejected the bundle: the executable carried a linker ad-hoc signature, but the assembled app resources were not sealed in a valid bundle signature.
- Tauri configuration now sets `bundle.macOS.signingIdentity` to `"-"`. The Tauri release build signs the executable and the whole bundle ad hoc. `codesign --verify --deep --strict` now reports that the bundle is valid. The build reports that notarization was skipped because Apple signing credentials are not configured.
- The direct executable's SIGABRT crash report points to `_RegisterApplication` during `NSApplication` initialization. It does not point to Azalee renderer or application code. Launching the Mach-O directly from this sandbox did not provide a usable LaunchServices application context.
- Calling `open -na` from the restricted shell continued to return `kLSNoExecutableErr`, including after bundle signing was repaired. The same command, run in the approved desktop execution environment, returned successfully. The opened window displayed Azalee, Basic/Expressive controls, developer controls, and “App Server ready.” This identifies the remaining launch error as an execution-environment restriction rather than a missing `CFBundleExecutable` or wrong architecture.
- `log show` and `spctl --assess` could not provide useful diagnostics inside the sandbox (`log: Cannot run while sandboxed`; `spctl` reported an internal Code Signing subsystem error there). The crash reports were inspected for process, exception, termination, and stack frames only.

The smallest persistent packaging correction is the Tauri `signingIdentity: "-"` setting in [tauri.conf.json](src-tauri/tauri.conf.json). The app was built and opened through macOS LaunchServices after this change. Local launch is verified; Developer ID signing and notarized distribution are not.

## 2. Codex App Server initialization

The earlier error was `failed to initialize sqlite state runtime under ~/.codex`. Non-sensitive metadata showed the directory is owned by the current user and has mode `755`; `config.toml` has mode `600`. No Codex file contents, credentials, or database contents were read or modified.

The same installed CLI initialized App Server and completed all nine tasks when run with the approved execution permission. That confirms the prior failure was the restricted shell's inability to access the normal Codex state runtime, rather than a damaged database or failed authentication. No permission bits were changed and no state or credential files were reset.

## 3. Live App Server timing

All values below are milliseconds from sending `turn/start`. The first generic Working time is the arrival of `turn/started`, which the Azalee state mapper maps to Working. “First command item” is an observed `commandExecution`; it does not prove that the command was the target file operation. Plan event coverage was zero across all nine tasks, so there is no prediction lead or prediction match to report.

### Coding and Writing repeats

| Run | First generic Working | Plan prediction | First command item start → completion | Confirmed semantic activity | Turn completed | Artifact check |
|---|---:|---|---|---|---:|---|
| Coding 1 | 363.9 | None | 5,194.2 → 5,196.5 completed; another at 6,830.8 → 6,833.1 completed | None | 7,834.4 | JavaScript file exists |
| Coding 2 | 19.6 | None | 2,691.3 → 2,691.9 failed; recovery at 3,807.2 → 3,808.5 completed | None | 4,778.4 | JavaScript file exists |
| Coding 3 | 14.4 | None | 2,665.3 → 2,666.6 failed; recovery at 3,868.8 → 3,873.1 completed | None | 4,896.4 | JavaScript file exists |
| Writing 1 | 35.2 | None | 2,885.2 → 2,891.1 failed; recovery at 5,049.5 → 5,051.1 completed | None | 5,942.2 | Markdown file exists |
| Writing 2 | 16.9 | None | 3,465.8 → 3,467.9 completed | None | 5,455.5 | Markdown file exists |
| Writing 3 | 18.9 | None | 3,280.7 → 3,282.0 completed | None | 4,240.7 | Markdown file exists |

The app's plan predictor had no opportunity to emit an `activity.intent` in these six turns. App Server did not report a file-change item for the files; the observed work was represented by shell command items. The target file write's exact start and completion cannot be separated from those generic shell events without interpreting command contents, which Azalee intentionally does not do.

### Other tasks

| Task | First generic Working | Relevant events | First confirmed semantic | Turn completed | Result |
|---|---:|---|---|---:|---|
| Delete disposable file | 13.8 | Shell item failed at 2,736.5–2,737.5; an explicit `rm` command item started at 3,880.9 and completed at 3,881.9 | DELETING at 3,880.9 (`item/started`, explicit deletion token) | 4,590.8 | Completed; disposable file absent. No plan prediction. Semantic event preceded item completion by 1.0 ms. |
| Generic `pwd` | 14.8 | `commandExecution` started at 2,197.0 and completed at 2,198.0 | None; remained WORKING | 3,092.2 | Completed. No false Coding classification. |
| Recoverable failure | 14.8 | Failing shell item at 3,273.4–3,274.4; recovery command at 4,337.6–4,338.8 | None | 5,469.6 | Turn completed successfully; recovery file exists. The tool error did not imply turn failure. |

All nine turns completed successfully. Two Coding runs, one Writing run, the Deleting run, and the recoverable-failure run included a failed shell item before the successful turn completion. These results support the Phase 4 rule that a tool-level error should not show task-level FAILED.

The Coding/Writing start notification latency ranged from 14.4 to 363.9 ms (median 19.25 ms). This measures App Server event arrival, not frame paint or animation latency. No animation latency was measured. Phase 3.6 previously observed file-change metadata only about 42 ms before operation completion; this run instead found no file-change event for any of the six Coding/Writing tasks.

## Limitations and recommendation

The plan-based prediction did not improve feedback in these repeated tests: the supported plan notification was not emitted, and the actual file edits arrived as opaque shell operations. A deterministic plan parser cannot help when the signal is absent. The current classifier correctly avoids calling generic shell use Coding or Writing, but that leaves these six real tasks at Working.

Prioritize a supported, structured activity signal that is emitted before the operation—such as an optional, isolated activity-reporting tool or adapter contract—then repeat the same trials and measure prediction lead and accuracy. Keep the plan predictor as a low-confidence fallback. Do not add Claude or new sprites yet: an LLM would not recover activity metadata that the event stream never supplies, and the present evidence points to event coverage and timing as the constraint.

The Tauri app was rebuilt after the signing configuration change. `npm run check`, all 17 JavaScript tests, and all 4 Rust tests passed.
