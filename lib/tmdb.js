// Minimal TMDB client with caching and a concurrency cap.
import { TTLCache } from './cache.js';

const API = 'https://api.themoviedb.org/3';
const IMG = 'https://image.tmdb.org/t/p';
const DAY = 24 * 60 * 60 * 1000;

const cache = new TTLCache(DAY, 20000);

// Simple semaphore so a cold start doesn't hammer TMDB's rate limit.
const MAX_IN_FLIGHT = 8;
let inFlight = 0;
const queue = [];
async function throttled(fn) {
  if (inFlight >= MAX_IN_FLIGHT) await new Promise((resolve) => queue.push(resolve));
  else inFlight++;
  try {
    return await fn();
  } finally {
    // Hand our slot straight to the next waiter, or free it.
    const next = queue.shift();
    if (next) next();
    else inFlight--;
  }
}

export function createTmdb(apiKey) {
  if (!apiKey) throw new Error('TMDB API key missing. Set TMDB_API_KEY in .env');
  // v4 read access tokens are JWTs; v3 keys are 32 hex chars.
  const isBearer = apiKey.startsWith('eyJ');

  async function get(path, params = {}) {
    const url = new URL(API + path);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    if (!isBearer) url.searchParams.set('api_key', apiKey);

    return cache.wrap(url.pathname + url.search, () =>
      throttled(async () => {
        for (let attempt = 0; ; attempt++) {
          const res = await fetch(url, {
            headers: isBearer ? { Authorization: `Bearer ${apiKey}` } : {},
          });
          if (res.status === 429 && attempt < 3) {
            const wait = Number(res.headers.get('retry-after') || 1) * 1000;
            await new Promise((r) => setTimeout(r, wait));
            continue;
          }
          if (res.status === 404) return null;
          if (!res.ok) throw new Error(`TMDB ${path} failed: HTTP ${res.status}`);
          return res.json();
        }
      }),
    );
  }

  return {
    // IMDb id -> { tmdbId, kind } where kind is 'movie' or 'tv'.
    async findByImdb(imdbId, type) {
      const data = await get(`/find/${imdbId}`, { external_source: 'imdb_id' });
      const hit = type === 'movie' ? data?.movie_results?.[0] : data?.tv_results?.[0];
      return hit ? { tmdbId: hit.id, kind: type === 'movie' ? 'movie' : 'tv' } : null;
    },

    // TMDB's own "people who liked this also liked" list, plus "similar" as a fallback.
    async related(kind, tmdbId) {
      const [recs, similar] = await Promise.all([
        get(`/${kind}/${tmdbId}/recommendations`, { page: 1 }),
        get(`/${kind}/${tmdbId}/similar`, { page: 1 }),
      ]);
      return { recommendations: recs?.results || [], similar: similar?.results || [] };
    },

    // Full details: runtime, collection and IMDb id for movies; seasons, episode
    // counts and status for TV (with external ids appended). `imdbId` is set for both.
    async details(kind, tmdbId) {
      const data = kind === 'movie'
        ? await get(`/movie/${tmdbId}`)
        : await get(`/tv/${tmdbId}`, { append_to_response: 'external_ids' });
      return data && { ...data, imdbId: data.imdb_id || data.external_ids?.imdb_id || null };
    },

    // A film series ("Dune Collection") with all its parts.
    async collection(collectionId) {
      return get(`/collection/${collectionId}`);
    },

    async genres(kind) {
      const data = await get(`/genre/${kind}/list`);
      return new Map((data?.genres || []).map((g) => [g.id, g.name]));
    },
  };
}

export function poster(path) {
  return path ? `${IMG}/w342${path}` : undefined;
}

export function backdrop(path) {
  return path ? `${IMG}/w1280${path}` : undefined;
}
