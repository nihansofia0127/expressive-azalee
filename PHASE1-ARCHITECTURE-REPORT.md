# Phase 1 — Azalee architecture and Codex integration

**Scope:** inspection and a small, isolated event-capture proof of concept. No production animation code, sprites, or application structure were rewritten.

## A. Existing application

The current repository is not yet the Azalee desktop companion described in the brief. It contains a dependency-free static browser prototype (`index.html`, `src/*.js`, `src/styles.css`) that serves itself with Python's `http.server`. Its character is an inline SVG Umbreon, not Azalee. `src/agent-state.js` holds five coarse states (`IDLE`, `WORKING`, `WAITING`, `DONE`, `ERROR`); `src/main.js` creates manual preview buttons and passes state changes to `mountPet()` in `src/pet.js`. CSS animates the SVG by state. There is no desktop shell, Codex client, external event listener, or agent integration in this prototype.

Azalee's old-name Mochi assets do exist separately at `pet-runs/mochi/final/spritesheet.webp`, with animation previews, QA, and metadata. The atlas is RGBA WebP, 1536 × 1872, laid out as 8 columns × 9 rows of 192 × 208 cells. Its rows are Idle, Running Right, Running Left, Waving, Jumping, Failed, Waiting, Running, and Review. `validation.json` reports no errors or warnings. The repository does not contain code that loads this atlas or plays its rows, so I cannot confirm or reuse the prior Azalee animation renderer from this checkout. The Hatch Pet generation output follows a Codex Pet asset contract, but that does not make the browser prototype itself Codex-dependent.

**Finding:** the checked-in browser prototype is standalone but is not Azalee. Azalee's delivered asset set was generated for a Codex Pet workflow; an independent Azalee desktop app and its sprite player are not present here. This looks like a missing app/code checkout rather than an existing Azalee app that is tightly coupled to Codex.

## B. Codex integration

### Recommended first adapter: Codex app-server

The official app-server protocol is a local JSON-RPC interface over stdio, WebSocket, or Unix socket. It is intended for custom clients that need threads, authentication, approvals, and streamed events. It supports `thread/start`, `thread/list`, `thread/resume`, and streamed `turn/*` and `item/*` notifications. It is the best fit for Azalee when Azalee starts or resumes the Codex thread it will display. See [Codex App Server](https://developers.openai.com/codex/app-server/).

On this machine, `codex` is installed as `codex-cli 0.162.0-alpha.17.2`, and `codex login status` reports “Logged in using ChatGPT.” The app-server proof of concept used that existing local sign-in and completed inference without a separate API key. This confirms the local, signed-in setup. It does not establish how a packaged Azalee install should onboard another user. A distributed app that uses ChatGPT-plan access directly would need to follow the official [Sign in with ChatGPT app-server flow](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server/), including user consent and token refresh; it must not copy Codex's private credential files.

**Existing Codex desktop sessions:** the app-server can list and resume persisted local threads. The protocol documents a live notification stream after this client starts or resumes a thread. It does not document a public attach operation that subscribes to an already-running turn owned by the Codex desktop app. Therefore reliable observation of arbitrary active desktop turns is **not confirmed**. Hooks are an official supplemental route: Codex documents callbacks for `SessionStart`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `Stop`, `Interrupt`, and `SessionEnd`. They require configured and trusted hook definitions and are callbacks rather than one stream connection. Their availability as a bridge from already-running Codex Desktop sessions to a separate app should be tested before relying on it. See [Codex Hooks](https://developers.openai.com/codex/hooks/).

### SDK and other official options

The official TypeScript Codex SDK starts, continues, and resumes local Codex threads. Its documented example returns a final response; OpenAI's SDK documentation points custom clients that need streamed agent events to app-server. The Python SDK also controls local app-server over JSON-RPC. For Azalee's live animation use case, direct app-server use gives the clearest event contract and connection lifecycle. See [Codex SDK](https://developers.openai.com/codex/sdk/).

Codex hooks can supplement app-server for lifecycle and tool callbacks, especially if observation of an existing desktop session matters. They are not a replacement for app-server's full event stream. `codex exec --json` is useful for bounded jobs but does not provide a persistent client for arbitrary existing desktop turns. Screen capture, private log parsing, and undocumented process inspection are unnecessary for the supported path and should not be the baseline.

## C. Event availability

“Verified live” means observed in the isolated app-server proof of concept below. “Documented” means the official protocol describes it, but this proof of concept did not trigger it.

| Desired event | App-server representation and useful fields | Timing / session link | Evidence |
|---|---|---|---|
| Task started | `turn/started`; turn ID and thread context | At turn start; associated with a thread/turn | Verified live |
| Task completed | `turn/completed`; status `completed`, `failed`, or `interrupted`, with error detail on failure | Terminal turn outcome | Verified live for `completed`; other outcomes documented |
| Tool invocation | `item/started` with item type such as `commandExecution`, `mcpToolCall`, or `dynamicToolCall` | At item start; item ID, thread ID, turn ID | Verified live for shell command; other types documented |
| Tool progress | `item/commandExecution/outputDelta`, item status and later `item/completed` | During the tool; streamed output may contain sensitive data | Lifecycle verified; progress deltas documented only |
| Shell execution | `commandExecution`: command, cwd, status, command actions, output, exit code, and duration | Start/progress/completion within a turn | Start and completion verified; command contents were intentionally not logged |
| File creation or modification | `fileChange` item with paths, kinds, and diffs; `turn/diff/updated` has the aggregated diff | Proposed/approved changes during a turn, final item on completion | Documented only; not a general operating-system filesystem audit |
| Image generation | No dedicated image-generation event type was identified in the documented app-server item list. A tool item may identify the invoked tool, depending on how generation was exposed. | Invocation may identify a tool, but semantic intent and produced artifact are not guaranteed by a generic event | Not verified; semantic classification would be an inference |
| Approval requested | `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, and related server requests | Before the gated action continues; includes thread, turn, item IDs and approval context | Documented only |
| Waiting for user input | `item/tool/requestUserInput` / request-response lifecycle; approval requests are a separate signal | When Codex blocks for an answer | Documented only |
| Error or failure | `error`, failed item status, and `turn/completed` with `failed` status and error info | When failure occurs; correlated by thread/turn/item IDs | Documented only |
| Session ended | `thread/status/changed` and `thread/closed` describe runtime state/unloading; the `SessionEnd` hook reports a Codex session end | Thread closure is not the same as a completed task; use turn outcome for task completion | Documented only |

These event payloads can support both Basic and Expressive modes from one integration. Basic mode can reduce the stream to Idle, Working, Waiting, Done, and Error. Expressive mode can consume the same event evidence with an interpreter and fall back to Working when the evidence does not support a specific activity. A tool name or a proposed diff may provide clues, but does not always establish what the agent intends or whether the operation succeeded.

## D. Proof-of-concept results

Added an isolated Node script at [`poc/codex-event-capture.mjs`](poc/codex-event-capture.mjs). It starts the installed app-server, performs the JSON-RPC initialization, creates a new thread in a temporary directory, requests a read-only shell `pwd`, prints timestamped event summaries, and optionally writes the same summaries as JSONL with `--output path.jsonl`. The logger omits prompts, generated text, commands, output, and diffs. It does not touch the Azalee source or assets.

**Observed live:** `thread/started`, `turn/started`, `item/started` / `item/completed` for a `commandExecution`, `item/agentMessage/delta`, and `turn/completed` with `completed` status. The shell command completed in the temporary workspace. App-server also emitted thread status and MCP startup notifications. This proves event capture for an app-server-controlled thread, not attachment to a live Codex desktop turn.

**Run:** `node poc/codex-event-capture.mjs` (optional: `node poc/codex-event-capture.mjs --output events.jsonl`). The proof of concept requires the Codex CLI to be installed and signed in. One initial sandboxed launch was blocked by local process permissions; the authorized rerun succeeded. An initial protocol enum mismatch was corrected before the successful capture. No source-code tests were added or run.

## E. Architecture recommendation and next step

The proposed pipeline is feasible with one change in emphasis: the activity interpreter should take a normalized event stream, while app-server details stay inside a Codex adapter. Keep the desktop companion usable with a manual/demo source even when no agent is connected.

```text
Codex app-server ──> Codex adapter ──┐
Future agent adapter ────────────────┴─> normalized events
                                      ├─> Basic state mapper ─┐
                                      └─> Expressive activity interpreter ─┤
                                                                           v
                                                     shared animation controller / Azalee renderer
```

The smallest changes for Phase 2 are:

1. Preserve the Mochi/Azalee atlas and QA artifacts. Add a sprite-sheet loader/player for its existing nine rows only if the earlier renderer cannot be recovered; first locate the original renderer or confirm it is absent from the intended app checkout.
2. Give the animation layer a small agent-neutral input such as `setBehavior(behavior, mode)`. Keep Codex thread IDs, item types, tool names, JSON-RPC, and authentication in the Codex adapter.
3. Add a normalized event contract with session and turn IDs, timestamp, event kind, lifecycle phase, and optional evidence fields. Retain a generic Working fallback and make source adapters replaceable.
4. Implement Basic and Expressive as two interpretations of the same stream, using one Azalee renderer and one desktop application. Do not create a second pet app or fork the current codebase.
5. Add a thin desktop shell around the shared renderer when always-on-top, transparent-window, drag, and startup behavior are required. The current static page already supplies a starting UI; it does not justify a renderer rewrite by itself.

The nine current sprite states do not include the proposed semantic action poses (typing, painting, writing, envelope, trash bin). Those would require additional assets or a composition approach later. The current atlas is still reusable for Idle, movement, Waiting, Working, Failed, and Review/Done mapping in either mode.

**Main Phase 2 question:** whether Azalee must passively mirror turns initiated in the Codex desktop app, or can ask users to start/resume the selected Codex thread through Azalee. App-server provides a verified, reliable stream for the latter. Official hooks are a promising route for the former, but should be prototyped and tested in Codex Desktop before promising full event coverage. This is a bounded integration question; it does not call for a major rewrite.
