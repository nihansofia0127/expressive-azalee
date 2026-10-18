# Phase 1.5 — Codex Desktop hooks and Azalee renderer

**Scope:** official documentation review, installed-runtime capability check, a temporary sanitized hook proof of concept, and a search for the original Azalee player. No production renderer or Phase 2 integration was implemented.

## Findings

### Codex Desktop observation

- The official [Codex Hooks documentation](https://developers.openai.com/codex/hooks/) currently defines `SessionStart`, `SessionEnd`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `UserPromptSubmit`, `SubagentStart`, `SubagentStop`, `Stop`, `Interrupt`, `PreCompact`, and `PostCompact`.
- The installed desktop bundle is ChatGPT 26.1007.21159 (build 20052) and includes `codex-cli 0.162.0-alpha.17.2`. The bundled CLI reports `hooks` as `stable true`, so the installed runtime advertises hook support. Official plugin docs also describe lifecycle hooks for manually installed Codex Desktop plugins.
- Project hooks are discovered from `<repo>/.codex/hooks.json`, but the project layer must be trusted and each non-managed hook definition must be reviewed and trusted by its current hash. This checkout has no `.git` metadata, which adds uncertainty about whether it is recognized as a trusted project layer by the current Desktop session.
- The temporary project config was installed at `.codex/hooks.json` for the observation and has now been removed. The isolated POC files remain in `poc/desktop-hook/`. They forward a small allowlist of event metadata to `127.0.0.1:43189`; prompt text, argument values, results, transcript paths, and full working-directory paths are dropped. A synthetic event reached the local listener with those values redacted.
- The user ran a read-only `pwd` task in Codex Desktop while the listener was active, but the listener received no Desktop hook event. This result does not distinguish an unsupported Desktop path from a hook that was not trusted or loaded into that session. Direct Desktop observation therefore remains unverified.

Official hook payloads include `session_id`, `cwd`, `hook_event_name`, `model`, and `permission_mode`; turn-scoped events include `turn_id`. Tool callbacks include `tool_name`, `tool_use_id`, and `tool_input`; post-tool callbacks can include `tool_response`. Lifecycle-specific fields include session start `source`, session end `reason`, and subagent `agent_id` / `agent_type`. Thus they carry useful correlation and coarse tool context. Semantic classification can use event names and tool names, but needs selected tool arguments or outputs to distinguish what the agent is doing. Those values are intentionally redacted in this POC.

Hook coverage has limits: tool hooks cover shell, edits, MCP calls, and most local function tools; hosted tools such as WebSearch do not use the local hook path, and specialized paths can opt out. `SessionEnd` currently reports only reason `other`. Background hooks can finish out of order and unfinished work can be canceled when the session ends. Hooks are callbacks requiring configuration and trust, not a client-owned continuous stream.

**Coverage comparison:** App Server is the primary integration for threads Azalee starts or resumes. The Phase 1 POC already observed correlated thread, turn, item, and tool events live, including completion status. Hooks are a possible passive bridge into Desktop-owned sessions, but this run has not confirmed actual direct-Desktop delivery. Even when working, hooks provide narrower coverage, omit hosted tool events, and have weaker ordering guarantees than App Server. Keep App Server as the verified fallback and reliable source for Azalee-owned sessions.

### Original Azalee renderer and Hatch Pet output

- The current checkout is a static browser prototype with an inline Umbreon SVG. It contains no Azalee renderer. The project is not a Git repository, so there is no local Git history to inspect. Searches of relevant Desktop output and known Codex pet/worktree locations found only `pet-runs/mochi` and the installed pet package at `~/.codex/pets/mochi`; no Azalee player or application checkout was found.
- `pet-runs/mochi/pet_request.json` defines the output contract: `pet_id: mochi`, display name Azalee, an 8-column × 9-row atlas, and nine named rows with frame counts. `final/validation.json` confirms a 1536×1872 RGBA WebP with no errors or warnings. The installed package contains `pet.json` plus `spritesheet.webp`; the descriptor supplies an ID, display name, description, and relative sprite-sheet path. The installed atlas byte-matches the Hatch output. This contract packages pet metadata and art, not a renderer or standalone app.
- Existing art can be consumed independently of Codex Pet. The smallest player is a single atlas loader and animation clock: map each of the nine state names to its row and frame count, crop 192×208 cells, advance frames at a state-specific interval, and draw with transparency. Basic and Expressive modes can select from the same nine rows through one agent-neutral behavior API. No separate pet app or new art is needed for this first player.

### Desktop framework recommendation

**Recommend Tauri 2 for the first standalone macOS app.** The current UI and sprite work are web-based, and Tauri documents transparent and always-on-top window settings plus drag handling. Its shell plugin can spawn and manage child processes, with explicit command/argument scope controls; that is a fit for a local Codex App Server adapter. The expected smaller runtime footprint than Electron is an architectural inference from using the platform webview, not a measurement of this project.

If the web frontend is discarded and minimum native overhead is the leading constraint, SwiftUI with a small AppKit `NSPanel` wrapper is the macOS-native alternative. Apple documents floating panels and floating window levels. That route would require translating the existing web rendering into native UI; it offers less immediate reuse of the current prototype.

## Recommended next step

1. If passive observation must be resolved further, repeat only after confirming in Codex Desktop that the exact hook definition is trusted and loaded for a new or reloaded session. Record which lifecycle, prompt, tool, and stop events arrive.
2. Use Codex App Server as the primary adapter for sessions Azalee starts or resumes. Keep normalized events and the activity interpreter independent of Codex. Treat hooks as an optional passive-observation adapter only if direct Desktop testing confirms adequate coverage.
3. Keep the Hatch atlas and metadata as source assets. If no renderer is found in another intended checkout, implement only the small shared atlas player inside the standalone Tauri app. Keep Codex and future Claude Code integrations behind replaceable adapters.

## Thesis study limitations

Passive Desktop observation is not yet verified. Hooks may miss hosted and opt-out tool paths, and their asynchronous callbacks can arrive out of order or be canceled. The sanitized POC retains IDs and tool names but omits argument/result content, limiting semantic labels. If stronger semantic classification is required, collect only explicitly chosen fields locally with participant consent and document that coverage varies by event source. App Server gives stronger event structure for controlled sessions, but those sessions are initiated or resumed through the companion and therefore do not measure fully passive observation of arbitrary Desktop work.
