// Entry point of ForYou.exe, the Windows app (built by scripts/build-exe.mjs).
//
//   ForYou.exe                 Starts the addon and opens the setup page. Keeps
//                              running while Stremio is open, or for 10 minutes
//                              of setup if it isn't.
//   ForYou.exe --with-stremio  What the Stremio shortcuts run after "Start with
//                              Stremio": starts the addon hidden, opens
//                              Stremio, and stops when Stremio closes.
//
// The TMDB key is saved in %APPDATA%\For You\settings.json. Nothing about the
// user's Stremio account is stored.
import { copyFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { format } from 'node:util';
import * as sea from 'node:sea';
import { startServer, VERSION } from '../lib/app.js';
import { addonRunning, exitWhenStremioCloses, openInBrowser, openStremio, stremioShortcuts } from '../lib/desktop.js';

const PORT = Number(process.env.PORT) || 7000;
const SETUP_IDLE_MS = 10 * 60 * 1000;
const withStremio = process.argv.includes('--with-stremio');
const setupUrl = `http://127.0.0.1:${PORT}/configure`;

const dataDir = process.env.FORYOU_DATA_DIR || join(process.env.APPDATA || '.', 'For You');
const settingsFile = join(dataDir, 'settings.json');
// "Start with Stremio" runs this copy, so deleting the download doesn't break the shortcuts.
const installedExe = join(process.env.LOCALAPPDATA || '.', 'Programs', 'For You', 'ForYou.exe');

function loadSettings() {
  try {
    return JSON.parse(readFileSync(settingsFile, 'utf8'));
  } catch {
    return {};
  }
}

function configureHtml() {
  if (sea.isSea()) return sea.getAsset('configure.html', 'utf8');
  return readFileSync(join(__dirname, '..', 'public', 'configure.html'), 'utf8');
}

// Copies the running exe to its fixed install location and points Stremio's
// shortcuts there (or back at Stremio).
async function shortcuts(mode) {
  if (mode !== 'enable') return stremioShortcuts(mode);
  if (!sea.isSea()) throw new Error('"Start with Stremio" only works in ForYou.exe.');
  if (process.execPath.toLowerCase() !== installedExe.toLowerCase()) {
    mkdirSync(join(installedExe, '..'), { recursive: true });
    try {
      copyFileSync(process.execPath, installedExe);
    } catch (err) {
      // An older copy may be running right now; keep using it.
      if (!existsSync(installedExe)) throw err;
    }
  }
  const result = await stremioShortcuts('enable', { exePath: installedExe });
  if (!result.length) throw new Error("Couldn't find Stremio's shortcuts. Is Stremio installed?");
  return result;
}

async function main() {
  mkdirSync(dataDir, { recursive: true });

  if (await addonRunning(PORT)) {
    // Another copy is already running: just open what was asked for.
    if (withStremio) openStremio();
    else openInBrowser(setupUrl);
    return;
  }

  // Request logs go to a file. When double-clicked, the console window only
  // shows a short explanation.
  const logFile = join(dataDir, 'addon.log');
  const tooBig = existsSync(logFile) && statSync(logFile).size > 1_000_000;
  const log = createWriteStream(logFile, { flags: tooBig ? 'w' : 'a' });
  log.write(`\n--- For You ${VERSION} launched ${new Date().toISOString()} ${withStremio ? '(with Stremio)' : ''} ---\n`);
  const say = (text) => process.stdout.write(`${text}\n`);
  console.log = console.error = (...args) => log.write(`${new Date().toISOString()} ${format(...args)}\n`);
  const stop = (reason) => {
    console.log(`${reason}; stopping.`);
    log.end(() => process.exit(0));
  };
  process.on('uncaughtException', (err) => {
    console.error('Crashed:', err);
    say(`Something went wrong: ${err.message}\nDetails are in ${logFile}`);
    log.end(() => process.exit(1));
  });

  let settings = loadSettings();
  let lastRequest = Date.now();
  await startServer({
    port: PORT,
    host: '127.0.0.1',
    configureHtml: configureHtml(),
    getTmdbKey: () => settings.tmdbKey,
    onRequest: () => { lastRequest = Date.now(); },
    desktop: {
      async saveTmdbKey(key) {
        settings = { ...settings, tmdbKey: key };
        writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
      },
      shortcuts,
    },
  });

  if (withStremio) {
    openStremio();
  } else {
    say(`For You ${VERSION} is running.\n`);
    say(`Setup page: ${setupUrl} (opening in your browser)\n`);
    say('Keep this window open while you use Stremio. It closes by itself when');
    say('Stremio closes. To have For You start with Stremio automatically, use');
    say('"Start with Stremio" on the setup page.');
    openInBrowser(setupUrl);
  }

  exitWhenStremioCloses({
    onExit: stop,
    // Double-clicked for setup: give the user time to get a TMDB key, sign in, etc.
    stayAlive: () => !withStremio && Date.now() - lastRequest < SETUP_IDLE_MS,
  });
}

main();
