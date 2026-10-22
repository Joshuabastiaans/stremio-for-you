// For running from source on Windows: starts the addon, opens Stremio, and
// shuts the addon down once Stremio is closed. The Stremio shortcuts point here
// (see install-shortcuts.ps1), so the addon only runs while Stremio does.
// ForYou.exe does the same thing with `--with-stremio`.
import { createWriteStream, existsSync, statSync } from 'node:fs';
import { format } from 'node:util';
import { addonRunning, exitWhenStremioCloses, openStremio } from './lib/desktop.js';

const here = new URL('.', import.meta.url);
const envFile = new URL('.env', here);
if (existsSync(envFile)) process.loadEnvFile(envFile);

const PORT = Number(process.env.PORT) || 7000;

if (await addonRunning(PORT)) {
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

exitWhenStremioCloses({
  onExit: (reason) => {
    console.log(`${reason}; stopping addon.`);
    log.end(() => process.exit(0));
  },
});
