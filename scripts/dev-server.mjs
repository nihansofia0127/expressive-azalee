import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const build = spawn(process.execPath, [resolve(root, 'scripts/build-frontend.mjs')], { stdio: 'inherit' });
const exitCode = await new Promise((resolveExit) => build.once('exit', resolveExit));
if (exitCode !== 0) process.exit(exitCode ?? 1);
const dist = resolve(root, 'dist');
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.webp': 'image/webp' };

createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    const candidate = resolve(dist, `.${decodeURIComponent(pathname)}`);
    if (candidate !== dist && !candidate.startsWith(`${dist}${sep}`)) throw new Error('invalid path');
    let file = candidate;
    if ((await stat(file)).isDirectory()) file = resolve(file, 'index.html');
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': mime[extname(file)] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404).end('Not found');
  }
}).listen(5173, '127.0.0.1', () => console.log('Azalee dev server at http://127.0.0.1:5173'));
