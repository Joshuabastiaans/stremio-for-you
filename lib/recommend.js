// Turns a Stremio library into ranked recommendation rows.
//
// Main ranking ("Recommended for You"):
// 1. Every library/history item gets an "interest" weight from how much of it
//    you watched, whether you saved it, and how recently you touched it.
// 2. The strongest items become seeds. For each seed we pull TMDB's
//    recommendations (and, at lower weight, "similar" titles).
// 3. Candidates are scored by summing seed weight x list position, so titles
//    suggested by several things you liked rise to the top. A Bayesian rating
//    nudge keeps obscure or badly rated titles down.
// 4. Anything already in your library or history is filtered out.
//
// Other rows reuse that ranking (Under 100 Minutes, Finish in a Weekend) or
// follow what you've finished (Finish the Story: next film in a series, new
// season of a show).
import { TTLCache, mapLimit } from './cache.js';
import { getLibrary } from './stremio.js';
import { poster, backdrop } from './tmdb.js';

const DAY = 24 * 60 * 60 * 1000;
const MAX_SEEDS = 30;
const MIN_VOTES = 15;
const RECENCY_HALF_LIFE_DAYS = 120;
const SHORT_MOVIE_MINUTES = 100;
const WEEKEND_MAX_EPISODES = 12;

const poolCache = new TTLCache(30 * 60 * 1000, 1000);

const tmdbKind = (type) => (type === 'movie' ? 'movie' : 'tv');
const today = () => new Date().toISOString().slice(0, 10);

function interest(item, now) {
  const s = item.state || {};
  const inLibrary = !item.removed && !item.temp;
  const watchedMs = s.overallTimeWatched || 0;
  const finished = s.timesWatched > 0 || s.flaggedWatched > 0;

  let engagement = 0;
  if (item.type === 'movie') {
    if (finished) engagement = 1;
    else if (s.duration > 0) engagement = Math.min(1, watchedMs / s.duration);
  } else {
    // Series: hours watched across all episodes, saturating at ~10h.
    engagement = Math.min(1, watchedMs / (10 * 3600 * 1000));
    if (finished) engagement = Math.max(engagement, 0.5);
  }

  const lastWatched = Date.parse(s.lastWatched) || 0;
  const touched = Math.max(lastWatched, Date.parse(item._mtime) || 0, Date.parse(item._ctime) || 0);
  const ageDays = touched ? (now - touched) / DAY : 365;

  let weight;
  if (engagement > 0) {
    // Started but dropped early and not touched for a week: probably didn't like it.
    const abandoned = engagement < 0.25 && !finished && ageDays > 7;
    weight = abandoned ? 0.05 : 0.4 + 0.6 * engagement;
    if (inLibrary) weight += 0.2;
  } else if (inLibrary) {
    weight = 0.35; // Saved but not watched yet: interested.
  } else {
    weight = 0; // Removed without watching.
  }

  const recency = 0.3 + 0.7 * Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS);
  return { weight: weight * recency, lastWatched, engagement };
}

// Library items Stremio can play from IMDb ids, grouped and scored.
export async function analyzeLibrary(authKey) {
  const items = await getLibrary(authKey);
  const now = Date.now();
  const seen = new Set();
  const byType = { movie: [], series: [] };

  for (const item of items) {
    if (!item?._id) continue;
    const imdbId = item._id.split(':')[0];
    seen.add(imdbId);
    if (!imdbId.startsWith('tt') || !(item.type in byType)) continue;
    byType[item.type].push({
      imdbId,
      name: item.name,
      type: item.type,
      videoId: item.state?.video_id, // Last watched episode, e.g. "tt0903747:2:13".
      ...interest(item, now),
    });
  }

  for (const list of Object.values(byType)) list.sort((a, b) => b.weight - a.weight);
  return { seen, byType };
}

// Most recently watched titles with real engagement, for "Because you watched" rows.
export function recentSeeds(analysis, type, count) {
  return analysis.byType[type]
    .filter((s) => s.lastWatched && s.engagement >= 0.25)
    .sort((a, b) => b.lastWatched - a.lastWatched)
    .slice(0, count);
}

function bayesianRating(c) {
  const v = c.vote_count || 0;
  const m = 200;
  const C = 6.5;
  return (v * (c.vote_average || 0) + m * C) / (v + m);
}

function isUsable(c, date) {
  if (c.adult || (c.vote_count || 0) < MIN_VOTES) return false;
  const released = c.release_date || c.first_air_date;
  return Boolean(released) && released <= date; // Skip unreleased titles: no streams yet.
}

async function scoreCandidates(tmdb, seeds, type) {
  const kind = tmdbKind(type);
  const date = today();
  const candidates = new Map();
  const seedTmdbIds = new Set();

  const resolved = await mapLimit(seeds, 6, async (seed) => {
    const found = await tmdb.findByImdb(seed.imdbId, type).catch(() => null);
    return found && { ...seed, tmdbId: found.tmdbId };
  });
  const usableSeeds = resolved.filter(Boolean);
  for (const seed of usableSeeds) seedTmdbIds.add(seed.tmdbId);

  await mapLimit(usableSeeds, 6, async (seed) => {
    const { recommendations, similar } = await tmdb.related(kind, seed.tmdbId).catch(() => ({ recommendations: [], similar: [] }));
    const lists = [
      [recommendations, 1.0],
      [similar, 0.4],
    ];
    for (const [list, listWeight] of lists) {
      list.forEach((c, rank) => {
        if (!isUsable(c, date)) return;
        const contribution = seed.weight * listWeight * Math.max(0.2, 1 - rank / 25);
        let entry = candidates.get(c.id);
        if (!entry) {
          entry = { tmdb: c, score: 0, because: new Map() };
          candidates.set(c.id, entry);
        }
        entry.score += contribution;
        const prev = entry.because.get(seed.imdbId);
        entry.because.set(seed.imdbId, { seed, weight: (prev?.weight || 0) + contribution });
      });
    }
  });

  return [...candidates.values()]
    .filter((e) => !seedTmdbIds.has(e.tmdb.id))
    .map((e) => ({
      ...e,
      score: e.score * (0.5 + 0.5 * (bayesianRating(e.tmdb) / 10)),
      because: [...e.because.values()].sort((a, b) => b.weight - a.weight).map(({ seed }) => seed),
    }))
    .sort((a, b) => b.score - a.score);
}

// --- pools: ranked candidate lists, one per row --------------------------------
// Each returns { ranked: [entry], seen: Set<imdbId> }. An entry has the TMDB
// list item (`tmdb`), and optionally `imdbId`, `reasons`, `releaseInfo` and
// `allowSeen` (show it even though it's in your library).

// Main ranking. `seedImdbId` narrows it to one title ("Because you watched X").
function rankedPool(tmdb, authKey, type, seedImdbId) {
  return poolCache.wrap(`${authKey}|${type}|${seedImdbId || '*'}`, async () => {
    const analysis = await analyzeLibrary(authKey);
    const all = analysis.byType[type];
    const seeds = seedImdbId
      ? all.filter((s) => s.imdbId === seedImdbId).map((s) => ({ ...s, weight: 1 }))
      : all.filter((s) => s.weight > 0.1).slice(0, MAX_SEEDS);
    return { ranked: await scoreCandidates(tmdb, seeds, type), seen: analysis.seen };
  });
}

const byReleaseDate = (a, b) => (a.release_date || '').localeCompare(b.release_date || '');

// The earliest part you haven't seen of each film series you've finished a
// movie from, most recently watched first.
async function nextMovies(tmdb, finished, seen) {
  const date = today();
  const resolved = await mapLimit(finished, 6, async (seed) => {
    const found = await tmdb.findByImdb(seed.imdbId, 'movie').catch(() => null);
    const details = found && (await tmdb.details('movie', found.tmdbId).catch(() => null));
    return details && { seed, tmdbId: found.tmdbId, collectionId: details.belongs_to_collection?.id };
  });
  const finishedTmdbIds = new Set(resolved.filter(Boolean).map((r) => r.tmdbId));
  const collections = new Map();
  for (const r of resolved) if (r?.collectionId && !collections.has(r.collectionId)) collections.set(r.collectionId, r.seed);

  const entries = await mapLimit([...collections], 6, async ([collectionId, seed]) => {
    const collection = await tmdb.collection(collectionId).catch(() => null);
    const parts = (collection?.parts || []).filter((p) => p.release_date && p.release_date <= date).sort(byReleaseDate);
    for (const part of parts) {
      if (finishedTmdbIds.has(part.id)) continue;
      const details = await tmdb.details('movie', part.id).catch(() => null);
      if (!details?.imdbId || seen.has(details.imdbId)) continue;
      return {
        tmdb: part,
        imdbId: details.imdbId,
        reasons: [{ category: 'Next after', name: seed.name, url: detailLink('movie', seed.imdbId) }],
      };
    }
    return null;
  });
  return entries.filter(Boolean);
}

function parseVideoId(videoId) {
  const m = /^tt\d+:(\d+):(\d+)$/.exec(videoId || '');
  return m && { season: Number(m[1]), episode: Number(m[2]) };
}

// Shows where you watched a season to the end and the next season is out,
// newest season first.
async function newSeasons(tmdb, watched) {
  const date = today();
  const entries = await mapLimit(watched, 6, async (seed) => {
    const progress = parseVideoId(seed.videoId);
    if (!progress) return null;
    const found = await tmdb.findByImdb(seed.imdbId, 'series').catch(() => null);
    const show = found && (await tmdb.details('tv', found.tmdbId).catch(() => null));
    const seasons = (show?.seasons || []).filter((s) => s.season_number > 0);
    const current = seasons.find((s) => s.season_number === progress.season);
    const next = seasons.find((s) => s.season_number === progress.season + 1);
    if (!current || progress.episode < current.episode_count) return null; // Season not finished.
    if (!next?.air_date || next.air_date > date) return null; // No new season out yet.
    return {
      tmdb: { ...show, genre_ids: (show.genres || []).map((g) => g.id) },
      imdbId: seed.imdbId,
      allowSeen: true,
      releaseInfo: `Season ${next.season_number}`,
      airDate: next.air_date,
      reasons: [{ category: 'You finished', name: `Season ${progress.season}`, url: detailLink('series', seed.imdbId) }],
    };
  });
  return entries.filter(Boolean).sort((a, b) => b.airDate.localeCompare(a.airDate));
}

function finishStoryPool(tmdb, authKey, type) {
  return poolCache.wrap(`${authKey}|${type}|next`, async () => {
    const analysis = await analyzeLibrary(authKey);
    const recent = analysis.byType[type]
      .filter((s) => s.lastWatched)
      .sort((a, b) => b.lastWatched - a.lastWatched);
    const ranked = type === 'movie'
      ? await nextMovies(tmdb, recent.filter((s) => s.engagement >= 0.9).slice(0, 60), analysis.seen)
      : await newSeasons(tmdb, recent.slice(0, 40));
    return { ranked, seen: analysis.seen };
  });
}

// --- metas -----------------------------------------------------------------------

// Stremio deep links (formats from stremio-core's deep_links module).
const detailLink = (type, id) => `stremio:///detail/${encodeURIComponent(type)}/${encodeURIComponent(id)}`;
const discoverLink = (manifestUrl, type, catalogId, genre) =>
  `stremio:///discover/${encodeURIComponent(manifestUrl)}/${type}/${catalogId}?genre=${encodeURIComponent(genre)}`;

const becauseReasons = (entry) =>
  (entry.because || []).slice(0, 2).map((seed) => ({
    category: 'Because you watched',
    name: seed.name,
    url: detailLink(seed.type, seed.imdbId),
  }));

function toMeta(entry, type, imdbId, genreNames, manifestUrl, reasons) {
  const c = entry.tmdb;
  const date = c.release_date || c.first_air_date || '';
  const genres = (c.genre_ids || []).map((id) => genreNames.get(id)).filter(Boolean);

  // Reasons and genres show as chip groups under the description. Once an item
  // has `links`, Stremio ignores `genres`, so genres are sent as links too:
  // they open "Recommended for You" filtered to that genre.
  const links = [
    ...reasons,
    ...genres.map((genre) => ({ name: genre, category: 'Genres', url: discoverLink(manifestUrl, type, 'foryou', genre) })),
  ];

  return {
    id: imdbId,
    type,
    name: c.title || c.name,
    poster: poster(c.poster_path),
    background: backdrop(c.backdrop_path),
    description: c.overview || '',
    releaseInfo: entry.releaseInfo || date.slice(0, 4),
    genres,
    links,
  };
}

const keepers = {
  short: (d) => d?.runtime > 0 && d.runtime <= SHORT_MOVIE_MINUTES,
  weekend: (d) => d?.number_of_seasons === 1
    && d.number_of_episodes > 0 && d.number_of_episodes <= WEEKEND_MAX_EPISODES
    && ['Ended', 'Canceled'].includes(d.status),
};

// One page of a row as Stremio metas.
//   row: 'foryou' | 'byw' | 'next' | 'short' | 'weekend'
export async function catalogPage(tmdb, authKey, {
  row, type, seedImdbId, genre, skip = 0, pageSize = 40, manifestUrl,
}) {
  const kind = tmdbKind(type);
  const { ranked, seen } = row === 'next'
    ? await finishStoryPool(tmdb, authKey, type)
    : await rankedPool(tmdb, authKey, type, row === 'byw' ? seedImdbId : undefined);
  const genreNames = await tmdb.genres(kind).catch(() => new Map());
  const keep = keepers[row];
  const reasonsFor = (entry) => (row === 'byw' ? [] : entry.reasons || becauseReasons(entry));

  const pool = genre
    ? ranked.filter((e) => (e.tmdb.genre_ids || []).some((id) => genreNames.get(id) === genre))
    : ranked;

  // Look up details (IMDb id, runtime, seasons) lazily, only as far as this page needs.
  const metas = [];
  const wanted = skip + pageSize;
  let produced = 0;
  for (let i = 0; i < pool.length && produced < wanted; i += 10) {
    const batch = pool.slice(i, i + 10);
    const details = await mapLimit(batch, 10, (e) =>
      (e.imdbId && !keep ? null : tmdb.details(kind, e.tmdb.id).catch(() => null)));
    batch.forEach((entry, j) => {
      const imdbId = entry.imdbId || details[j]?.imdbId;
      if (!imdbId || produced >= wanted) return;
      if (!entry.allowSeen && seen.has(imdbId)) return;
      if (keep && !keep(details[j])) return;
      if (produced++ >= skip) metas.push(toMeta(entry, type, imdbId, genreNames, manifestUrl, reasonsFor(entry)));
    });
  }
  return metas;
}
