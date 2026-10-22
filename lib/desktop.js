// Windows helpers shared by launcher.js and ForYou.exe: finding and opening
// Stremio, exiting once it closes, and pointing Stremio's shortcuts at us.
import { spawn, execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const CHECK_EVERY_MS = 10_000;
const STARTUP_GRACE_MS = 90_000; // How long Stremio may take to appear.
const MISSES_BEFORE_EXIT = 2; // Tolerates a quick Stremio restart.

export function stremioExe() {
  if (process.env.STREMIO_EXE) return process.env.STREMIO_EXE;
  const programs = join(process.env.LOCALAPPDATA || '', 'Programs');
  const candidates = [
    join(programs, 'Stremio', 'stremio-shell-ng.exe'), // Stremio 5
    join(programs, 'LNV', 'Stremio-4', 'stremio.exe'), // Stremio 4
  ];
  return candidates.find((path) => existsSync(path)) || candidates[0];
}

export function openStremio() {
  const args = (process.env.STREMIO_ARGS || '').split(' ').filter(Boolean);
  spawn(stremioExe(), args, { detached: true, stdio: 'ignore' })
    .on('error', (err) => console.error('Could not open Stremio:', err.message))
    .unref();
}

export function openInBrowser(url) {
  spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

export function stremioIsRunning() {
  const image = basename(stremioExe());
  return new Promise((resolve) => {
    execFile('tasklist', ['/FI', `IMAGENAME eq ${image}`, '/NH', '/FO', 'CSV'], { windowsHide: true }, (err, stdout) => {
      resolve(!err && stdout.toLowerCase().includes(`"${image.toLowerCase()}"`));
    });
  });
}

export async function addonRunning(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/manifest.json`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

// Calls onExit once Stremio has been seen and then closed. If Stremio never
// shows up, exits after the startup grace period, unless stayAlive() says not to.
export function exitWhenStremioCloses({ onExit, stayAlive = () => false }) {
  const startedAt = Date.now();
  let seen = false;
  let misses = 0;
  setInterval(async () => {
    if (await stremioIsRunning()) {
      seen = true;
      misses = 0;
      return;
    }
    if (!seen && (stayAlive() || Date.now() - startedAt < STARTUP_GRACE_MS)) return;
    if (++misses >= MISSES_BEFORE_EXIT) onExit(seen ? 'Stremio closed' : 'Stremio was not opened');
  }, CHECK_EVERY_MS);
}

// --- Stremio shortcuts -----------------------------------------------------------

// Reads or rewrites the Stremio shortcuts (Start Menu, taskbar pin, desktop).
// Only touches shortcuts that open Stremio itself or already open For You.
const SHORTCUT_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$shell = New-Object -ComObject WScript.Shell
$stremio = $env:FY_STREMIO
$paths = @(
  (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Stremio.lnk'),
  (Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar\Stremio.lnk'),
  (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Stremio.lnk')
)
if ($env:FY_PATHS) { $paths = $env:FY_PATHS -split '\|' }
$results = @()
foreach ($path in $paths) {
  if (-not (Test-Path -LiteralPath $path)) { continue }
  $link = $shell.CreateShortcut($path)
  $ours = $link.Arguments -like '*--with-stremio*'
  if (-not $ours -and $link.TargetPath -ne $stremio) { continue }
  if ($env:FY_MODE -eq 'enable') {
    $link.TargetPath = $env:FY_TARGET
    $link.Arguments = $env:FY_ARGS
    $link.WorkingDirectory = $env:FY_WORKDIR
    $link.IconLocation = "$stremio,0"
    $link.Description = 'Stremio (with the For You addon)'
    $link.Save()
    $ours = $true
  } elseif ($env:FY_MODE -eq 'disable' -and $ours) {
    $link.TargetPath = $stremio
    $link.Arguments = ''
    $link.WorkingDirectory = Split-Path $stremio
    $link.IconLocation = "$stremio,0"
    $link.Description = 'Stremio'
    $link.Save()
    $ours = $false
  }
  $results += [pscustomobject]@{ path = $path; forYou = [bool]$ours }
}
ConvertTo-Json -InputObject @($results) -Compress
`;

function runPowerShell(script, env) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { windowsHide: true, env: { ...process.env, ...env } },
      (err, stdout, stderr) => (err ? reject(new Error(stderr.trim() || err.message)) : resolve(stdout)),
    );
  });
}

/**
 * Points Stremio's shortcuts at `exePath --with-stremio` (run hidden through
 * conhost), points them back at Stremio, or just reports their state.
 *
 * @param {'enable' | 'disable' | 'status'} mode
 * @param {object} [options]
 * @param {string} [options.exePath]  What the shortcuts should start (for 'enable').
 * @param {string[]} [options.paths]  Shortcut files to use instead of the defaults (tests).
 * @returns {Promise<{ path: string, forYou: boolean }[]>}
 */
export async function stremioShortcuts(mode, { exePath, paths } = {}) {
  const output = await runPowerShell(SHORTCUT_SCRIPT, {
    FY_MODE: mode,
    FY_STREMIO: stremioExe(),
    FY_TARGET: join(process.env.WINDIR || 'C:\\Windows', 'System32', 'conhost.exe'),
    FY_ARGS: exePath ? `--headless "${exePath}" --with-stremio` : '',
    FY_WORKDIR: exePath ? dirname(exePath) : '',
    FY_PATHS: paths ? paths.join('|') : '',
  });
  const parsed = JSON.parse(output.trim() || '[]');
  return Array.isArray(parsed) ? parsed : [parsed];
}
