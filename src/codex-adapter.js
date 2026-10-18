/** First agent adapter. It transports normalized events emitted by the Rust App Server bridge. */
export function createCodexAdapter({ onEvent }) {
  const tauri = window.__TAURI__;
  let unlisten = null;
  return {
    get available() { return Boolean(tauri?.core?.invoke && tauri?.event?.listen); },
    async connect() {
      if (!this.available) return false;
      if (!unlisten) unlisten = await tauri.event.listen('azalee-normalized-event', event => onEvent(event.payload));
      return true;
    },
    async startTask(prompt, workspace) {
      if (!this.available) throw new Error('Start the desktop app with npm start to connect Codex.');
      return tauri.core.invoke('start_task', { prompt, workspace });
    },
    async interrupt() {
      if (!this.available) throw new Error('Codex task control is only available in the desktop app.');
      return tauri.core.invoke('interrupt_task');
    },
    async respondToApproval(requestId, decision) {
      if (!this.available) throw new Error('Codex task control is only available in the desktop app.');
      return tauri.core.invoke('respond_to_approval', { requestId, decision });
    },
    async defaultWorkspace() {
      if (!this.available) return '';
      return tauri.core.invoke('default_workspace');
    },
    async close() {
      if (unlisten) unlisten();
      unlisten = null;
    },
  };
}
