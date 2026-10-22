// Stremio addon server: config page, manifest and catalog endpoints.
// No dependencies: Node's built-in http + fetch.
//
// The server never sees a password: the config page signs in to Stremio
// straight from the browser and puts the resulting auth key (plus settings)
// in the install URL. Nothing about users is stored on disk.
//
// Used by server.js (npm start / Docker) and desktop/main.js (ForYou.exe).
import http from 'node:http';
import { createTmdb } from './tmdb.js';
import { moveAddonToTop } from './stremio.js';
import { analyzeLibrary, recentSeeds, catalogPage } from './recommend.js';

const BECAUSE_ROWS_PER_TYPE = 2;
const ADDON_ID = 'community.personal.foryou';
export const VERSION = '1.3.0';

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

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 10_000) throw new Error('Body too large');
  }
  return JSON.parse(raw || '{}');
}

/**
 * Starts the addon server and resolves once it is listening.
 *
 * @param {object} options
 * @param {number} options.port
 * @param {string} options.host
 * @param {string} [options.publicUrl]     Public base URL when behind a proxy.
 * @param {string} options.configureHtml   The setup page.
 * @param {() => string|undefined} options.getTmdbKey
 * @param {object} [options.desktop]       Only for ForYou.exe: { saveTmdbKey(key), shortcuts(mode) }.
 *                                         Enables the local /api endpoints.
 * @param {() => void} [options.onRequest] Called on every request.
 */
export function startServer({ port, host, publicUrl = '', configureHtml, getTmdbKey, desktop, onRequest = () => {} }) {
  // The TMDB key can change at runtime (set on the desktop setup page).
  let tmdb = null;
  let tmdbKeyInUse;
  function currentTmdb() {
    const key = getTmdbKey();
    if (!key) return null;
    if (key !== tmdbKeyInUse) {
      tmdb = createTmdb(key);
      tmdbKeyInUse = key;
    }
    return tmdb;
  }

  function baseUrl(req) {
    if (publicUrl) return publicUrl;
    const proto = req.headers['x-forwarded-proto'] || 'http';
    return `${proto}://${req.headers.host}`;
  }

  // --- manifest --------------------------------------------------------------

  async function genreOptions(kind) {
    const genres = await currentTmdb()?.genres(kind).catch(() => null);
    return [...(genres || new Map()).values()].sort();
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
      version: VERSION,
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

  // --- catalogs --------------------------------------------------------------

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
    const tmdbClient = currentTmdb();
    if (!tmdbClient) return send(res, 503, { metas: [], error: 'No TMDB key set up yet' });
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

    const metas = await catalogPage(tmdbClient, config.authKey, options);
    send(res, 200, { metas, cacheMaxAge: 30 * 60, staleRevalidate: 60 * 60 });
  }

  // --- desktop-only local API --------------------------------------------------
  // Only ForYou.exe enables these. POSTs must come from this server's own setup
  // page, so another website can't change settings through the user's browser.

  const ownOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);

  async function localApi(req, res, pathname) {
    if (pathname === '/api/status') {
      return send(res, 200, { desktop: Boolean(desktop), hasTmdbKey: Boolean(getTmdbKey()), version: VERSION });
    }
    if (!desktop) return send(res, 404, { error: 'Not found' });
    if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });
    if (!ownOrigins.has(req.headers.origin)) return send(res, 403, { error: 'Forbidden' });
    const body = await readJson(req);

    if (pathname === '/api/tmdb-key') {
      const key = String(body.key || '').trim();
      const genres = key && (await createTmdb(key).genres('movie').catch(() => null));
      if (!genres?.size) return send(res, 400, { error: "TMDB didn't accept that key. Check you copied all of it." });
      await desktop.saveTmdbKey(key);
      return send(res, 200, { ok: true });
    }
    if (pathname === '/api/shortcuts') {
      const mode = body.enable ? 'enable' : body.enable === false ? 'disable' : 'status';
      try {
        return send(res, 200, { shortcuts: await desktop.shortcuts(mode) });
      } catch (err) {
        console.error('Shortcut update failed:', err.message);
        return send(res, 500, { error: err.message });
      }
    }
    send(res, 404, { error: 'Not found' });
  }

  // --- router ----------------------------------------------------------------

  const server = http.createServer(async (req, res) => {
    onRequest();
    const started = Date.now();
    const { pathname } = new URL(req.url, 'http://localhost');
    const parts = pathname.split('/').filter(Boolean);

    try {
      if (req.method === 'OPTIONS') return send(res, 204, '');
      if (pathname.startsWith('/api/')) return await localApi(req, res, pathname);
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

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}
