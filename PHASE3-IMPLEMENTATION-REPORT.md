# Phase 3 — Semantic Classification and Presentation Modes

## Delivered

- Added a deterministic, agent-neutral classifier in `src/activity-classifier.js`. Every result includes an explanation, evidence list, and operation stage (`proposed`, `executing`, `completed`, `failed`, or `not_applicable`). Approval and input requests take precedence as Waiting; failure takes precedence as Failed; unsupported or ambiguous tool events fall back to Working.
- Added Basic and Expressive presentation selection in `src/presentation-mode.js`. Both modes receive the same normalized event and classification. Basic shows only generic states. Expressive labels semantic activity and currently uses the existing `running` row for semantic work; Idle, Waiting, Review, and Failed retain their existing rows.
- Added a mode toggle and a classification debug panel with the latest normalized event, rule result, evidence, provenance, mode, and selected animation. Synthetic fixtures are marked as synthetic in the UI.
- Added fixtures for source editing, image generation, document writing, email drafting, deletion, ambiguous shell work, approval, and failure.
- Extended the Rust App Server adapter to emit allowlisted operation categories, file extensions, file change kinds, and sanitized command action kinds. It does not forward command strings, file paths, diffs, prompts, tool arguments, outputs, or image data. The event collector independently filters metadata and preserves session and turn identifiers.
- Reused the existing renderer and nine-row atlas. No new sprite or second application was created.

## Validation

- `npm run check` — passed.
- `npm test` — 12 passed, including the original 6 tests and new classifier, mode, evidence, lifecycle-priority, ambiguity, and metadata-sanitization tests.
- `npm run build` — passed; the manual fixture module is included in the frontend output.
- The existing Phase 2 report records live Codex App Server verification for task start, shell tool execution, completion, interruption, and responsiveness during long-running tasks. This phase did not rebuild or package the desktop app.
- Rust tests were added for allowlisted metadata extraction, but could not run because `cargo` and `rustc` are not installed in this environment. A local preview server was also blocked by the environment (`listen EPERM` on `127.0.0.1:5173`), so this phase has no new visual desktop run.
- The existing atlas metadata test still verifies all nine rows and frame counts. The renderer code and atlas were not changed.

## What real Codex events support

The Phase 2 live run verified real thread/turn lifecycle and generic shell tool start/completion events. Those events support Working and Idle. They do not contain enough evidence to call a generic shell task Coding.

The installed App Server schema also defines structured `fileChange` items with change kinds and paths, an `imageGeneration` item, and parsed command actions. The adapter now reduces these to safe metadata. The classifier can therefore recognize source edits as Coding, explicit image generation as Painting, prose/document file changes as Writing, explicit deletion signals as Deleting, and clearly named email or document tools as Emailing/Writing. These semantic paths are supported by the schema and implementation but were **not exercised by a live Codex task in this phase**. Email and document tool naming also depends on an integration exposing an explicit, recognizable operation name.

The synthetic fixtures only verify rule behavior. They are not evidence of how frequently Codex emits each event or how accurately activity can be inferred in ordinary work. Approval, failure, and review presentation rules are covered by tests; new live event capture for those states was not performed here.

## Remaining limitations

- The packaged `.app` was not rebuilt, as requested. The source frontend and `dist/` contain Phase 3 changes; the existing packaged app remains the Phase 2 build until a later authorized app run/build.
- The Rust event metadata change needs `cargo test` on a machine with the Rust toolchain before packaging.
- Codex event coverage varies by operation. If an event has no explicit semantic marker, Azalee intentionally shows Working.
- Email classification is only available when a tool name explicitly identifies an email draft/send action. Message contents are neither collected nor inspected.
- Expressive activity animations are placeholders using the current Working row. Activity-specific sprites remain future work.
