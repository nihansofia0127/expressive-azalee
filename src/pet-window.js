import { createAzaleeRenderer } from './azalee-renderer.js';

const renderer = createAzaleeRenderer(document.querySelector('#azalee-canvas'));
const label = document.querySelector('#behavior-label');
const tauri = window.__TAURI__;
const currentWindow = tauri?.window?.getCurrentWindow?.();

if (tauri?.event?.listen) {
  await tauri.event.listen('azalee-presentation', ({ payload }) => {
    if (!payload || typeof payload !== 'object') return;
    if (typeof payload.animation === 'string') {
      try { renderer.setAnimation(payload.animation); } catch { /* Ignore invalid display state. */ }
    }
    if (typeof payload.label === 'string') label.textContent = payload.label;
  });
  await tauri.event.listen('azalee-manager-visibility', ({ payload }) => {
    if (payload?.visible) tauri.core.invoke('show_manager_window').catch(() => {});
  });
}

document.querySelector('#pet-hit-area').addEventListener('mousedown', (event) => {
  if (event.button === 0) currentWindow?.startDragging().catch(() => {});
});

if (currentWindow?.onMoved) {
  let saveTimer;
  await currentWindow.onMoved(({ payload }) => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try {
        await tauri.core.invoke('save_pet_position', { x: payload.x, y: payload.y });
        await tauri.event.emit('azalee-pet-position-changed', { moved: true });
      } catch { /* Position persistence is best effort if the app-data folder is unavailable. */ }
    }, 350);
  });
}
