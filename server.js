// Stremio addon server: config page, manifest and catalog endpoints.
// No dependencies: Node's built-in http + fetch.
//
// The server never sees a password: the config page signs in to Stremio
// straight from the browser and puts the resulting auth key (plus settings)
// in the install URL. Nothing about users is stored on disk.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { createTmdb } from './lib/tmdb.js';
import { moveAddonToTop } from './lib/stremio.js';
import { analyzeLibrary, recentSeeds, catalogPage } from './lib/recommend.js';

const PORT = Number(process.env.PORT) || 7000;
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
const BECAUSE_ROWS_PER_TYPE = 2;
const ADDON_ID = 'community.personal.foryou';

const tmdb = createTmdb(process.env.TMDB_API_KEY);
const configureHtml = await readFile(new URL('./public/configure.html', import.meta.url), 'utf8');

// --- config <-> URL segment -------------------------------------------------
// Base64url JSON: { authKey, top?, off?: [row keys] }
// `top` defaults to on for installs made before it was a setting.

function decodeConfig(segment) {
  try {
    const config = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
    if (typeof config?.authKey !== 'string' || !config.authKey) return null;
    config.off = Array.isArray(config.off) ? config.off : [];
    return config;
  } catch {
    return null;
  }
}

const rowOn = (config, row) => !config?.off.includes(row);

// --- manifest ----------------------------------------------------------------

async function genreOptions(kind) {
  const genres = await tmdb.genres(kind).catch(() => new Map());
  return [...genres.values()].sort();
}

// Rows in the order they appear on the Board.
async function buildManifest(config) {
  const [movieGenres, tvGenres] = await Promise.all([genreOptions('movie'), genreOptions('tv')]);
  const skip = [{ name: 'skip' }];
  const catalogs = [
    { type: 'movie', id: 'foryou', name: 'Recommended for You', extra: [{ name: 'genre', options: movieGenres }, ...skip] },
    { type: 'series', id: 'foryou', name: 'Recommended for You', extra: [{ name: 'genre', options: tvGenres }, ...skip] },
  ];
  if (rowOn(config, 'next')) {
    catalogs.push(
      { type: 'movie', id: 'next', name: 'Finish the Story', extra: skip },
      { type: 'series', id: 'next', name: 'New Seasons', extra: skip },
    );
  }
  if (rowOn(config, 'short')) catalogs.push({ type: 'movie', id: 'short', name: 'Under 100 Minutes', extra: skip });
  if (rowOn(config, 'weekend')) catalogs.push({ type: 'series', id: 'weekend', name: 'Finish in a Weekend', extra: skip });

  // "Because you watched X" rows. Their ids carry the seed, so a row's
  // contents always match its title. They rotate when the addon is reinstalled.
  if (config && rowOn(config, 'byw')) {
    try {
      const analysis = await analyzeLibrary(config.authKey);
      for (const type of ['movie', 'series']) {
        for (const seed of recentSeeds(analysis, type, BECAUSE_ROWS_PER_TYPE)) {
          catalogs.push({ type, id: `byw-${seed.imdbId}`, name: `Because you watched ${seed.name}` });
        }
      }
    } catch (err) {
      console.error('Could not read library for manifest:', err.message);
    }
  }

  return {
    id: ADDON_ID,
    version: '1.2.0',
    name: 'For You',
    description:
      'Personal movie and series recommendations based on your Stremio library and watch history. '
      + 'This product uses the TMDB API but is not endorsed or certified by TMDB.',
    resources: ['catalog'],
    types: ['movie', 'series'],
    catalogs,
    behaviorHints: { configurable: true, configurationRequired: !config },
  };
}

// --- helpers -----------------------------------------------------------------

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string';
  res.writeHead(status, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/html; charset=utf-8',
    ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body);
}

function baseUrl(req) {
  if (PUBLIC_URL) return PUBLIC_URL;
  const proto = req.headers['x-forwarded-proto'] || 'http';
  return `${proto}://${req.headers.host}`;
}

// --- routes ------------------------------------------------------------------


// Keep For You first in the account's addon list so its rows sit right under
// Continue Watching (only if the user ticked that on the config page). Stremio
// picks the change up the next time it syncs (on start or when its window
// regains focus). Re-checked while rows are loading, because the app can push
// its own older order back to the account.
const ORDER_CHECK_EVERY_MS = 30_000;
const lastOrderCheck = new Map();
function keepOnTop(authKey) {
  const now = Date.now();
  if (now - (lastOrderCheck.get(authKey) || 0) < ORDER_CHECK_EVERY_MS) return;
  lastOrderCheck.set(authKey, now);
  moveAddonToTop(authKey, ADDON_ID)
    .then(({ found, moved, before }) => {
      if (!found) lastOrderCheck.delete(authKey); // Not installed yet: check again next time.
      const position = found ? `#${before.indexOf(ADDON_ID) + 1} of ${before.length}` : 'not installed';
      console.log(`Addon order: For You is ${position}${moved ? ', moved it to #1' : ''}. First: ${before.slice(0, 3).join(', ')}`);
    })
    .catch((err) => {
      lastOrderCheck.delete(authKey);
      console.error('Could not check addon order:', err.message);
    });
}

async function catalog(res, config, manifestUrl, type, id, extraSegment) {
  if (config.top !== false) keepOnTop(config.authKey);
  if (!['movie', 'series'].includes(type)) return send(res, 404, { metas: [] });
  const extra = new URLSearchParams(extraSegment || '');
  const row = id.startsWith('byw-') ? 'byw' : id;
  const options = {
    row,
    type,
    genre: extra.get('genre') || undefined,
    skip: Math.max(0, Number(extra.get('skip')) || 0),
    manifestUrl,
  };
  const known = ['foryou', 'byw', 'next', 'short', 'weekend'];
  if (!known.includes(row) || !rowOn(config, row)) return send(res, 404, { metas: [] });
  if ((row === 'short' && type !== 'movie') || (row === 'weekend' && type !== 'series')) return send(res, 404, { metas: [] });
  if (row === 'byw') {
    options.seedImdbId = id.slice(4);
    options.pageSize = 30;
  }

  const metas = await catalogPage(tmdb, config.authKey, options);
  send(res, 200, { metas, cacheMaxAge: 30 * 60, staleRevalidate: 60 * 60 });
}

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  const { pathname } = new URL(req.url, 'http://localhost');
  const parts = pathname.split('/').filter(Boolean);

  try {
    if (req.method === 'OPTIONS') return send(res, 204, '');
    if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed' });

    if (parts.length === 0) return send(res, 302, '', { Location: '/configure' });
    if (pathname === '/configure') return send(res, 200, configureHtml);
    if (pathname === '/manifest.json') return send(res, 200, await buildManifest(null));

    // Everything else lives under /<config>/...
    const config = decodeConfig(parts[0]);
    if (!config) return send(res, 404, { error: 'Not found' });
    const rest = parts.slice(1);

    if (rest[0] === 'configure') return send(res, 200, configureHtml);
    if (rest[0] === 'manifest.json') return send(res, 200, await buildManifest(config));
    if (rest[0] === 'catalog' && rest.length >= 3) {
      const [, type, idOrFile, extraFile] = rest;
      const id = extraFile ? idOrFile : idOrFile.replace(/\.json$/, '');
      // Left percent-encoded on purpose: URLSearchParams decodes it, and
      // decoding first would split genres like "Action & Adventure".
      const extra = extraFile ? extraFile.replace(/\.json$/, '') : '';
      return await catalog(res, config, `${baseUrl(req)}/${parts[0]}/manifest.json`, type, id, extra);
    }
    send(res, 404, { error: 'Not found' });
  } catch (err) {
    console.error(`${req.method} ${pathname.replace(/^\/[^/]{20,}/, '/<config>')}:`, err);
    if (!res.headersSent) send(res, 500, { error: 'Internal error', metas: [] });
  } finally {
    // Never log the config segment: it contains the auth key.
    const safePath = pathname.replace(/^\/[^/]{20,}/, '/<config>');
    console.log(`${req.method} ${safePath} ${res.statusCode} ${Date.now() - started}ms`);
  }
});

// Local installs only listen on this PC; hosted ones (PUBLIC_URL or HOST set) on all interfaces.
const HOST = process.env.HOST || (PUBLIC_URL ? '0.0.0.0' : '127.0.0.1');
server.listen(PORT, HOST, () => {
  const url = PUBLIC_URL || `http://127.0.0.1:${PORT}`;
  console.log(`For You addon running. Open ${url}/configure to connect your Stremio account.`);
});
