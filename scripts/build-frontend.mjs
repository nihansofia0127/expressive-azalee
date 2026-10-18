import { cp, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const dist = resolve(root, 'dist');
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await cp(resolve(root, 'index.html'), resolve(dist, 'index.html'));
await cp(resolve(root, 'src'), resolve(dist, 'src'), { recursive: true });
await mkdir(resolve(dist, 'assets'), { recursive: true });
await cp(resolve(root, 'pet-runs/mochi/final/spritesheet.webp'), resolve(dist, 'assets/spritesheet.webp'));
console.log('Built Azalee frontend into dist/');
