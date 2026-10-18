# Codex Desktop hook proof of concept

This temporary proof of concept forwards selected Codex lifecycle and local tool hook events to `127.0.0.1:43189`. It forwards only event names, opaque session/turn/tool IDs, tool names, model and permission metadata, a working-directory basename, and tool-input key names. It never forwards prompt text, tool argument values, tool results, transcript paths, or full paths.

Run the listener with `node poc/desktop-hook/listener.mjs`. To enable this for one trusted project session, temporarily copy this file to `.codex/hooks.json`, open/reload the project in Codex Desktop, review and trust the displayed hook definitions, and run one harmless task. The hook does not modify agent decisions. Stop the listener and remove `.codex/hooks.json` after the observation.

This project-local configuration is deliberately not enabled by default. The installed project has no Git metadata; verify that the desktop host recognizes the project hook layer before treating a missing event as evidence that hooks are unsupported.
