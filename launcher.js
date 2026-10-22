// Starts the addon, opens Stremio, and shuts the addon down once Stremio is closed.
// The Stremio shortcuts point here (see install-shortcuts.ps1), so the addon only
// runs while Stremio does.
import { spawn, execFile } from 'node:child_process';
import { createWriteStream, existsSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { format } from 'node:util';

const here = new URL('.', import.meta.url);
const envFile = new URL('.env', here);
if (existsSync(envFile)) process.loadEnvFile(envFile);

const PORT = Number(process.env.PORT) || 7000;
const STREMIO_EXE = process.env.STREMIO_EXE
  || `${process.env.LOCALAPPDATA}\\Programs\\Stremio\\stremio-shell-ng.exe`;
const STREMIO_ARGS = (process.env.STREMIO_ARGS || '').split(' ').filter(Boolean);
const CHECK_EVERY_MS = 10_000;
const STARTUP_GRACE_MS = 90_000; // How long Stremio may take to appear.
const MISSES_BEFORE_EXIT = 2; // Tolerates a quick Stremio restart.

async function addonAlreadyRunning() {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/manifest.json`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

function stremioIsRunning() {
  const image = basename(STREMIO_EXE);
  return new Promise((resolve) => {
    execFile('tasklist', ['/FI', `IMAGENAME eq ${image}`, '/NH', '/FO', 'CSV'], { windowsHide: true }, (err, stdout) => {
      resolve(!err && stdout.toLowerCase().includes(`"${image.toLowerCase()}"`));
    });
  });
}

function openStremio() {
  spawn(STREMIO_EXE, STREMIO_ARGS, { detached: true, stdio: 'ignore' }).unref();
}

if (await addonAlreadyRunning()) {
  // Another launcher already runs the addon and is watching Stremio.
  openStremio();
  process.exit(0);
}

// There's no console window, so log to a file. Appends across launches and
// starts fresh once it passes 1 MB.
const logFile = new URL('addon.log', here);
const tooBig = existsSync(logFile) && statSync(logFile).size > 1_000_000;
const log = createWriteStream(logFile, { flags: tooBig ? 'w' : 'a' });
log.write(`\n--- launched ${new Date().toISOString()} ---\n`);
console.log = console.error = (...args) => log.write(`${new Date().toISOString()} ${format(...args)}\n`);
process.on('uncaughtException', (err) => {
  console.error('Crashed:', err);
  log.end(() => process.exit(1));
});

await import('./server.js');
// --no-open: just run the addon alongside an already-open Stremio (e.g. after an update).
if (!process.argv.includes('--no-open')) openStremio();

const startedAt = Date.now();
let seen = false;
let misses = 0;
setInterval(async () => {
  if (await stremioIsRunning()) {
    seen = true;
    misses = 0;
    return;
  }
  if (!seen && Date.now() - startedAt < STARTUP_GRACE_MS) return;
  if (++misses >= MISSES_BEFORE_EXIT) {
    console.log('Stremio closed; stopping addon.');
    log.end(() => process.exit(0));
  }
}, CHECK_EVERY_MS);
