// Builds dist/ForYou.exe: one Windows executable with Node.js and the addon
// inside, using Node's "single executable application" feature.
//
//   npm run build:exe
//
// Run it on Windows with the Node.js version you want to ship (22.9+).
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import postject from 'postject';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = join(root, 'dist');
const bundle = join(dist, 'for-you.cjs');
const blob = join(dist, 'sea-prep.blob');
const seaConfig = join(dist, 'sea-config.json');
const exe = join(dist, 'ForYou.exe');

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist);

// 1. Bundle desktop/main.js and everything it imports into one CommonJS file.
await build({
  entryPoints: [join(root, 'desktop', 'main.js')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  outfile: bundle,
  logLevel: 'warning',
});

// 2. Turn it into a blob Node can embed, with the setup page as an asset.
writeFileSync(seaConfig, JSON.stringify({
  main: bundle,
  output: blob,
  disableExperimentalSEAWarning: true,
  useCodeCache: false,
  assets: { 'configure.html': join(root, 'public', 'configure.html') },
}, null, 2));
execFileSync(process.execPath, ['--experimental-sea-config', seaConfig], { stdio: 'inherit' });

// 3. Copy this Node.js binary, drop its (soon invalid) signature, and inject the blob.
copyFileSync(process.execPath, exe);
removeSignature(exe);
await postject.inject(exe, 'NODE_SEA_BLOB', readFileSync(blob), {
  sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
});

// Removes the Authenticode signature from a PE file, like `signtool remove /s`.
// Editing the exe would leave a broken signature, which looks worse than none.
function removeSignature(file) {
  const data = readFileSync(file);
  const pe = data.readUInt32LE(0x3c);
  const optionalHeader = pe + 24;
  const isPe32Plus = data.readUInt16LE(optionalHeader) === 0x20b;
  const securityEntry = optionalHeader + (isPe32Plus ? 112 : 96) + 4 * 8; // Data directory #4.
  const offset = data.readUInt32LE(securityEntry);
  const size = data.readUInt32LE(securityEntry + 4);
  if (!offset || !size) return;
  data.writeUInt32LE(0, securityEntry);
  data.writeUInt32LE(0, securityEntry + 4);
  // The certificate table sits at the end of the file; cut it off.
  writeFileSync(file, offset + size === data.length ? data.subarray(0, offset) : data);
}

console.log(`Built ${exe} (${Math.round(statSync(exe).size / 1e6)} MB, Node ${process.version})`);
