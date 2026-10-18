export const animationRows = Object.freeze({
  idle: Object.freeze({ row: 0, frames: 6, label: 'Idle' }),
  'running-right': Object.freeze({ row: 1, frames: 8, label: 'Running Right' }),
  'running-left': Object.freeze({ row: 2, frames: 8, label: 'Running Left' }),
  waving: Object.freeze({ row: 3, frames: 4, label: 'Waving' }),
  jumping: Object.freeze({ row: 4, frames: 5, label: 'Jumping' }),
  failed: Object.freeze({ row: 5, frames: 8, label: 'Failed' }),
  waiting: Object.freeze({ row: 6, frames: 6, label: 'Waiting' }),
  running: Object.freeze({ row: 7, frames: 6, label: 'Working' }),
  review: Object.freeze({ row: 8, frames: 6, label: 'Review' }),
});

const CELL_WIDTH = 192;
const CELL_HEIGHT = 208;

export function createAzaleeRenderer(canvas, { imageUrl = './assets/spritesheet.webp', speed = 170 } = {}) {
  const context = canvas.getContext('2d', { alpha: true });
  const image = new Image();
  image.decoding = 'async';
  image.src = imageUrl;
  let animation = 'idle';
  let frame = 0;
  let frameInterval = speed;
  let lastFrameAt = 0;
  let lastDrawSize = '';
  let loadError = false;

  image.addEventListener('error', () => { loadError = true; });
  image.addEventListener('load', () => { loadError = false; });

  function draw() {
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const width = Math.round(rect.width * dpr);
    const height = Math.round(rect.height * dpr);
    const size = `${width}x${height}`;
    if (size !== lastDrawSize) {
      canvas.width = width;
      canvas.height = height;
      context.imageSmoothingEnabled = false;
      lastDrawSize = size;
    }
    context.clearRect(0, 0, width, height);
    if (image.complete && image.naturalWidth) {
      const row = animationRows[animation];
      context.drawImage(image, frame * CELL_WIDTH, row.row * CELL_HEIGHT, CELL_WIDTH, CELL_HEIGHT, 0, 0, width, height);
    }
  }

  function tick(now) {
    const row = animationRows[animation];
    if (!lastFrameAt) lastFrameAt = now;
    const elapsed = now - lastFrameAt;
    if (elapsed >= frameInterval) {
      const steps = Math.floor(elapsed / frameInterval);
      frame = (frame + steps) % row.frames;
      lastFrameAt += steps * frameInterval;
    }
    draw();
    requestAnimationFrame(tick);
  }

  requestAnimationFrame(tick);
  return {
    ready: new Promise((resolve, reject) => {
      if (image.complete && image.naturalWidth) resolve();
      else {
        image.addEventListener('load', () => resolve(), { once: true });
        image.addEventListener('error', () => reject(new Error('Could not load Azalee sprite sheet')), { once: true });
      }
    }),
    setAnimation(name) {
      if (!Object.hasOwn(animationRows, name)) throw new TypeError(`Unknown animation: ${name}`);
      if (name === animation) return false;
      animation = name;
      frame = 0;
      lastFrameAt = 0;
      return true;
    },
    setSpeed(milliseconds) {
      if (!Number.isFinite(milliseconds) || milliseconds < 30 || milliseconds > 2000) throw new RangeError('Animation speed must be between 30 and 2000 ms');
      frameInterval = milliseconds;
    },
    getAnimation: () => animation,
    getFrame: () => frame,
    hasLoadError: () => loadError,
  };
}
