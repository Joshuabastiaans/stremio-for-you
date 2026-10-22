// End-to-end smoke test: fake Stremio + TMDB APIs, the real server, real HTTP requests.
// Run with: npm test
import http from 'node:http';
import { readFile } from 'node:fs/promises';

process.env.TMDB_API_KEY = 'fakekey123';
process.env.PORT = '7391';
delete process.env.PUBLIC_URL;

const now = Date.now();
const daysAgo = (d) => new Date(now - d * 86400000).toISOString();
const library = [
  { _id: 'tt1', name: 'Seed Movie A', type: 'movie', removed: false, temp: false, _mtime: daysAgo(3),
    state: { timesWatched: 1, overallTimeWatched: 7.2e6, duration: 7.2e6, lastWatched: daysAgo(3) } },
  { _id: 'tt2', name: 'Seed Movie B', type: 'movie', removed: false, temp: false, _mtime: daysAgo(10), state: {} },
  { _id: 'tt3', name: 'Seed Show', type: 'series', removed: false, temp: false, _mtime: daysAgo(1),
    state: { overallTimeWatched: 20 * 3.6e6, lastWatched: daysAgo(1), video_id: 'tt3:1:8' } }, // Finished season 1.
  { _id: 'tt5', name: 'Midway Show', type: 'series', removed: false, temp: false, _mtime: daysAgo(2),
    state: { overallTimeWatched: 3e6, lastWatched: daysAgo(2), video_id: 'tt5:1:3' } }, // Mid-season.
  { _id: 'tt4', name: 'Abandoned Movie', type: 'movie', removed: true, temp: true, _mtime: daysAgo(30),
    state: { overallTimeWatched: 3e5, duration: 6e6, lastWatched: daysAgo(30) } },
  { _id: 'tt9', name: 'Already Seen', type: 'movie', removed: true, temp: true, _mtime: daysAgo(60),
    state: { timesWatched: 1, overallTimeWatched: 6e6, duration: 6e6, lastWatched: daysAgo(60) } },
];

const c = (id, extra = {}) => ({ id, title: `Movie ${id}`, release_date: '2020-01-01', vote_count: 500, vote_average: 7.5, genre_ids: [28], overview: 'x', poster_path: '/p.jpg', ...extra });
const t = (id, extra = {}) => ({ id, name: `Show ${id}`, first_air_date: '2019-01-01', vote_count: 300, vote_average: 8, genre_ids: [10759], ...extra });
const tmdb = {
  '/find/tt1': { movie_results: [{ id: 101 }] },
  '/find/tt2': { movie_results: [{ id: 102 }] },
  '/find/tt3': { tv_results: [{ id: 301 }] },
  '/find/tt4': { movie_results: [{ id: 104 }] },
  '/movie/101/recommendations': { results: [c(201), c(202), c(109), c(102), c(206, { release_date: '2099-01-01' })] },
  '/movie/101/similar': { results: [c(203, { genre_ids: [35] })] },
  '/movie/102/recommendations': { results: [c(202), c(204)] },
  '/movie/102/similar': { results: [] },
  '/movie/104/recommendations': { results: [c(205)] },
  '/movie/104/similar': { results: [] },
  '/tv/301/recommendations': { results: [t(401), t(402, { vote_count: 3 })] },
  '/tv/301/similar': { results: [] },
  '/genre/movie/list': { genres: [{ id: 28, name: 'Action' }, { id: 35, name: 'Comedy' }] },
  '/genre/tv/list': { genres: [{ id: 10759, name: 'Action & Adventure' }] },
};

Object.assign(tmdb, {
  '/find/tt5': { tv_results: [{ id: 305 }] },
  // Seed Movie A (101) is part 1 of a film series; part 2 (150) is out, part 3 (151) isn't.
  '/collection/900': { id: 900, parts: [c(101, { release_date: '2015-01-01' }), c(150, { release_date: '2018-01-01' }), c(151, { release_date: '2099-01-01' })] },
});

// TMDB ids map to IMDb ids as tt<id>, except the library titles.
const imdbFor = (id) => ({ 101: 'tt1', 102: 'tt2', 104: 'tt4', 109: 'tt9' })[id] || `tt${id}`;
const runtimes = { 201: 95, 202: 130, 203: 88, 204: 110 };
const movieDetails = (id) => ({
  id: Number(id), imdb_id: imdbFor(id), runtime: runtimes[id] || 120,
  belongs_to_collection: id === '101' ? { id: 900 } : null,
});
const season = (n, episodes, air) => ({ season_number: n, episode_count: episodes, air_date: air });
const tvDetails = {
  301: { name: 'Seed Show', status: 'Returning Series', number_of_seasons: 2, number_of_episodes: 18,
    seasons: [season(0, 2, '2019-01-01'), season(1, 8, '2019-01-01'), season(2, 10, '2021-01-01')], genres: [{ id: 10759 }] },
  305: { name: 'Midway Show', status: 'Returning Series', number_of_seasons: 2, number_of_episodes: 16,
    seasons: [season(1, 8, '2019-01-01'), season(2, 8, '2021-01-01')] },
  401: { name: 'Show 401', status: 'Ended', number_of_seasons: 1, number_of_episodes: 8, seasons: [season(1, 8, '2019-01-01')] },
};
const tvImdb = { 301: 'tt3', 305: 'tt5' };

const calls = [];
const setCalls = [];
const ADDON_ID = 'community.personal.foryou';
const addon = (id, extra = {}) => ({ transportUrl: `https://${id}/manifest.json`, manifest: { id }, flags: {}, ...extra });
let addonCollection = [
  addon('com.linvo.cinemeta', { flags: { official: true, protected: true } }),
  addon('org.stremio.local', { flags: { official: true, protected: true } }),
  addon('com.stremio.torrentio.addon'),
];

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  if (!url.pathname.includes('addonCollection')) calls.push(url.pathname);
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  if (url.host === 'api.strem.io') {
    const body = JSON.parse(init.body);
    if (url.pathname === '/api/addonCollectionGet') {
      return json({ result: { addons: structuredClone(addonCollection), lastModified: daysAgo(1) } });
    }
    if (url.pathname === '/api/addonCollectionSet') {
      setCalls.push(body);
      addonCollection = body.addons;
      return json({ result: { success: true } });
    }
    if (url.pathname === '/api/datastoreGet') {
      return body.authKey.startsWith('AUTHKEY') ? json({ result: library }) : json({ error: { message: 'Session not found' } });
    }
  }
  if (url.host === 'api.themoviedb.org') {
    if (url.searchParams.get('api_key') !== 'fakekey123') return json({}, 401);
    const path = url.pathname.replace('/3', '');
    const movie = path.match(/^\/movie\/(\d+)$/);
    if (movie) return json(movieDetails(movie[1]));
    const tv = path.match(/^\/tv\/(\d+)$/);
    if (tv) {
      const d = tvDetails[tv[1]] || { name: `Show ${tv[1]}`, number_of_seasons: 3, number_of_episodes: 30, status: 'Ended', seasons: [] };
      return json({ id: Number(tv[1]), ...d, external_ids: { imdb_id: tvImdb[tv[1]] || `tt${tv[1]}` } });
    }
    if (path.startsWith('/find/')) return json(tmdb[path] || { movie_results: [], tv_results: [] });
    return tmdb[path] ? json(tmdb[path]) : json({}, 404);
  }
  throw new Error('Unexpected fetch ' + url);
};

console.log = ((log) => (...args) => {
  // Keep test output readable: hide the server's per-request log lines.
  if (!/^(GET|POST|OPTIONS|PUT) \//.test(String(args[0]))) log(...args);
})(console.log);

await import('../server.js');

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: 7391, method, path, headers: { 'content-type': 'application/json' } }, (res) => {
      let data = '';
      res.on('data', (d) => (data += d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}
const getJson = async (path) => JSON.parse((await request('GET', path)).body);
const settle = () => new Promise((r) => setTimeout(r, 200));

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ->  ' + detail : ''}`);
  if (!ok) failures++;
};

// --- config page --------------------------------------------------------------

const page = await request('GET', '/configure');
check('config page served', page.status === 200 && page.body.includes('<h1>For You</h1>'));
check('config page credits TMDB', page.body.includes('not endorsed or certified by TMDB'));
check('config page signs in with Stremio directly, not via this server',
  page.body.includes('https://api.strem.io/api') && !page.body.includes("'/connect'"));

const passwordPost = await request('POST', '/connect', { email: 'a@b.c', password: 'secret' });
check('server has no endpoint that accepts passwords', passwordPost.status === 405);

// Run the page's own encodeConfig() so browser and server encodings can't drift apart.
const html = await readFile(new URL('../public/configure.html', import.meta.url), 'utf8');
const encodeConfig = new Function(`${html.match(/function encodeConfig[\s\S]*?\n {2}}/)[0]}; return encodeConfig;`)();
const base = (config) => `/${encodeConfig(config)}`;
const main = base({ authKey: 'AUTHKEY_MAIN', top: true });

// --- manifest -----------------------------------------------------------------

const bare = await getJson('/manifest.json');
check('unconfigured manifest requires configuration', bare.behaviorHints.configurationRequired === true);
check('manifest credits TMDB', bare.description.includes('not endorsed or certified by TMDB'));

const manifestRes = await request('GET', `${main}/manifest.json`);
const manifest = JSON.parse(manifestRes.body);
check('browser-encoded config (incl. non-ASCII) decodes on the server',
  (await request('GET', `${base({ authKey: 'AUTHKEY_ünïcode', top: true })}/manifest.json`)).status === 200);
check('CORS header', manifestRes.headers['access-control-allow-origin'] === '*');
check('configured manifest', manifest.behaviorHints.configurationRequired === false);
const names = manifest.catalogs.map((cat) => `${cat.type}/${cat.id}: ${cat.name}`);
check('"Because you watched" rows for recent titles',
  names.includes('movie/byw-tt1: Because you watched Seed Movie A') && names.includes('series/byw-tt3: Because you watched Seed Show'));
check('abandoned movie not used for a "Because" row', !names.some((n) => n.includes('Abandoned')));
check('genre options from TMDB', manifest.catalogs[0].extra[0].options.includes('Action'));

// --- recommendations ------------------------------------------------------------

const movies = (await getJson(`${main}/catalog/movie/foryou.json`)).metas;
const movieIds = movies.map((m) => m.id);
check('movie recs returned', movies.length > 0, movieIds.join(', '));
check('title recommended by two seeds ranks first', movieIds[0] === 'tt202');
check('already-watched title excluded', !movieIds.includes('tt9'));
check('library title excluded', !movieIds.includes('tt2'));
check('unreleased title excluded', !movieIds.includes('tt206'));
check('meta has poster', movies[0].poster?.includes('image.tmdb.org'));
check('description is only the plot', movies[0].description === 'x', JSON.stringify(movies[0].description));
const because = movies[0].links.filter((l) => l.category === 'Because you watched');
check('"Because you watched" chips, strongest first, linking to the seed',
  because.map((l) => l.name).join() === 'Seed Movie A,Seed Movie B' && because[0].url === 'stremio:///detail/movie/tt1',
  JSON.stringify(because));
const genreLink = movies[0].links.find((l) => l.category === 'Genres');
const expectedGenreUrl = `stremio:///discover/${encodeURIComponent(`http://127.0.0.1:7391${main}/manifest.json`)}/movie/foryou?genre=Action`;
check('genre chips link to this catalog filtered by genre', genreLink?.name === 'Action' && genreLink.url === expectedGenreUrl, genreLink?.url);

const byw = (await getJson(`${main}/catalog/movie/byw-tt1.json`)).metas;
check('"Because you watched X" row only uses that seed', byw.length > 0 && !byw.some((m) => m.id === 'tt204'), byw.map((m) => m.id).join(', '));
check('"Because you watched X" rows have no redundant reason chip',
  !byw[0].links.some((l) => l.category === 'Because you watched') && byw[0].links.some((l) => l.category === 'Genres'));

const comedy = (await getJson(`${main}/catalog/movie/foryou/genre=Comedy.json`)).metas;
check('genre filter', comedy.length === 1 && comedy[0].id === 'tt203', comedy.map((m) => m.id).join(', '));
const tvGenre = (await getJson(`${main}/catalog/series/foryou/genre=Action%20%26%20Adventure.json`)).metas;
check('genre containing "&" works', tvGenre.length === 1 && tvGenre[0].id === 'tt401');
const skipped = (await getJson(`${main}/catalog/movie/foryou/skip=2.json`)).metas;
check('skip pagination', skipped.length === movies.length - 2 && skipped[0].id === movieIds[2]);
const series = (await getJson(`${main}/catalog/series/foryou.json`)).metas;
check('series recs, low-vote title filtered', series.length === 1 && series[0].id === 'tt401', series.map((m) => m.id).join(', '));

const before = calls.length;
await request('GET', `${main}/catalog/movie/foryou.json`);
check('second request served from cache', calls.length === before, `${calls.length - before} upstream calls`);

// --- new rows -------------------------------------------------------------------

check('manifest has the new rows, in Board order',
  names.slice(0, 6).join(' | ') === 'movie/foryou: Recommended for You | series/foryou: Recommended for You | movie/next: Finish the Story | series/next: New Seasons | movie/short: Under 100 Minutes | series/weekend: Finish in a Weekend',
  names.join(' | '));

const nextMovies = (await getJson(`${main}/catalog/movie/next.json`)).metas;
check('Finish the Story: next released part of a film series you finished',
  nextMovies.length === 1 && nextMovies[0].id === 'tt150', nextMovies.map((m) => m.id).join(', '));
check('Finish the Story: chip says what it follows',
  nextMovies[0]?.links[0]?.category === 'Next after' && nextMovies[0].links[0].name === 'Seed Movie A');

const newSeasons = (await getJson(`${main}/catalog/series/next.json`)).metas;
check('New Seasons: show whose next season is out after you finished one',
  newSeasons.length === 1 && newSeasons[0].id === 'tt3', newSeasons.map((m) => m.id).join(', '));
check('New Seasons: says which season and what you finished',
  newSeasons[0]?.releaseInfo === 'Season 2' && newSeasons[0].links[0].category === 'You finished' && newSeasons[0].links[0].name === 'Season 1');

const short = (await getJson(`${main}/catalog/movie/short.json`)).metas;
check('Under 100 Minutes: only short picks, in ranking order', short.map((m) => m.id).join() === 'tt201,tt203', short.map((m) => m.id).join(', '));
check('Under 100 Minutes: keeps the "Because you watched" chips', short[0]?.links[0]?.category === 'Because you watched');

const weekend = (await getJson(`${main}/catalog/series/weekend.json`)).metas;
check('Finish in a Weekend: one finished short season', weekend.map((m) => m.id).join() === 'tt401', weekend.map((m) => m.id).join(', '));
check('row types are enforced', (await request('GET', `${main}/catalog/series/short.json`)).status === 404);

const minimal = base({ authKey: 'AUTHKEY_MAIN', top: true, off: ['next', 'short', 'weekend', 'byw'] });
const minimalNames = (await getJson(`${minimal}/manifest.json`)).catalogs.map((cat) => cat.id);
check('rows can be switched off', minimalNames.join() === 'foryou,foryou', minimalNames.join(', '));
check('switched-off rows return nothing', (await request('GET', `${minimal}/catalog/movie/short.json`)).status === 404);

check('unknown rows return nothing', (await request('GET', `${main}/catalog/movie/together.json`)).status === 404);

// --- "rows at the top" setting ----------------------------------------------------

check('nothing reordered while the addon is not installed', setCalls.length === 0);
addonCollection.push(addon(ADDON_ID));
const sendToBottom = () => addonCollection.push(...addonCollection.splice(addonCollection.findIndex((a) => a.manifest.id === ADDON_ID), 1));
const isFirst = () => addonCollection[0].manifest.id === ADDON_ID;

await request('GET', `${base({ authKey: 'AUTHKEY_OFF', top: false })}/catalog/movie/foryou.json`);
await settle();
check('top: false leaves the addon order alone', setCalls.length === 0 && !isFirst());

await request('GET', `${base({ authKey: 'AUTHKEY_LEGACY' })}/catalog/movie/foryou.json`);
await settle();
check('installs from before the setting keep moving to the top', setCalls.length === 1 && isFirst());

sendToBottom();
await request('GET', `${main}/catalog/movie/foryou.json`);
await settle();
const order = addonCollection.map((a) => a.manifest.id);
check('top: true moves For You to the front', setCalls.length === 2 && isFirst(), order.join(', '));
check('every other addon keeps its order', order.slice(1).join() === 'com.linvo.cinemeta,org.stremio.local,com.stremio.torrentio.addon');
check('addon flags kept intact', addonCollection[1].flags.protected === true);
check('reorder uses the auth key from the install URL', setCalls[1]?.authKey === 'AUTHKEY_MAIN' && setCalls[1]?.type === 'AddonCollectionSet');

sendToBottom();
await request('GET', `${main}/catalog/series/foryou.json`);
await settle();
check('order re-check is rate-limited to every 30s', setCalls.length === 2);

// --- misc ---------------------------------------------------------------------

const configuredPage = await request('GET', `${main}/configure`);
check('configure page served under config path', configuredPage.status === 200);
check('invalid config segment 404s', (await request('GET', '/not-a-config/manifest.json')).status === 404);

console.log(failures ? `\n${failures} FAILED` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
