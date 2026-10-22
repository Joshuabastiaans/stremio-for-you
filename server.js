// Entry point for `npm start` and Docker. Settings come from environment
// variables (.env). The Windows app (ForYou.exe) uses desktop/main.js instead.
import { readFile } from 'node:fs/promises';
import { startServer } from './lib/app.js';

const PORT = Number(process.env.PORT) || 7000;
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
// Local installs only listen on this PC; hosted ones (PUBLIC_URL or HOST set) on all interfaces.
const HOST = process.env.HOST || (PUBLIC_URL ? '0.0.0.0' : '127.0.0.1');

if (!process.env.TMDB_API_KEY) {
  console.error('TMDB API key missing. Set TMDB_API_KEY in .env (see .env.example).');
  process.exit(1);
}

await startServer({
  port: PORT,
  host: HOST,
  publicUrl: PUBLIC_URL,
  configureHtml: await readFile(new URL('./public/configure.html', import.meta.url), 'utf8'),
  getTmdbKey: () => process.env.TMDB_API_KEY,
});
console.log(`For You addon running. Open ${PUBLIC_URL || `http://127.0.0.1:${PORT}`}/configure to connect your Stremio account.`);
