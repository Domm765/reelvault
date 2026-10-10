'use strict';
// ReelVault - single-file build (all modules inlined so it can be uploaded from a phone).
const __defs = {}; const __cache = {};
function __req(n){ if(!__cache[n]){ const m={exports:{}}; __cache[n]=m; __defs[n](m,m.exports);} return __cache[n].exports; }
__defs['tmdb'] = function(module, exports) {
'use strict';
// Minimal TMDB client: v3 key or v4 bearer token, in-memory cache, concurrency-limited IMDb id resolution.
const BASE = 'https://api.themoviedb.org/3';
const KEY = process.env.TMDB_API_KEY || '';
const cache = new Map(); // key -> {exp, val}

function cget(k) { const e = cache.get(k); if (e && e.exp > Date.now()) return e.val; cache.delete(k); }
function cset(k, val, ttl) {
  cache.set(k, { exp: Date.now() + ttl, val });
  if (cache.size > 5000) cache.delete(cache.keys().next().value);
  return val;
}

async function api(path, params = {}, ttl = 6 * 3600e3) {
  const url = new URL(BASE + path);
  const headers = { accept: 'application/json' };
  if (KEY.startsWith('eyJ')) headers.Authorization = `Bearer ${KEY}`; else url.searchParams.set('api_key', KEY);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  const ck = url.pathname + url.search.replace(/api_key=[^&]*&?/, '');
  const hit = cget(ck); if (hit) return hit;
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(url, { headers });
    if (r.status === 429) { await new Promise(s => setTimeout(s, 1000 * (attempt + 1))); continue; }
    if (!r.ok) throw new Error(`TMDB ${r.status} ${path}`);
    return cset(ck, await r.json(), ttl);
  }
  throw new Error('TMDB rate limited');
}

async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const idx = i++; try { out[idx] = await fn(items[idx]); } catch { out[idx] = null; } }
  }));
  return out;
}

// keyword name -> id (exact match preferred)
async function keywordId(name) {
  const r = await api('/search/keyword', { query: name }, 7 * 86400e3);
  const hit = (r.results || []).find(k => k.name.toLowerCase() === name.toLowerCase()) || (r.results || [])[0];
  return hit ? hit.id : null;
}

async function searchTitle(type, title, year) {
  const r = await api(`/search/${type === 'movie' ? 'movie' : 'tv'}`, { query: title, ...(year ? (type === 'movie' ? { year } : { first_air_date_year: year }) : {}) }, 7 * 86400e3);
  return (r.results || [])[0] || null;
}

// Convert TMDB result rows into Stremio metas (needs IMDb id so other addons can supply streams).
async function toMetas(type, rows) {
  const metas = await pool(rows, 8, async row => {
    const ext = await api(`/${type === 'movie' ? 'movie' : 'tv'}/${row.id}/external_ids`, {}, 30 * 86400e3);
    if (!ext.imdb_id) return null;
    const date = row.release_date || row.first_air_date || '';
    return {
      id: ext.imdb_id, type,
      name: row.title || row.name,
      poster: row.poster_path ? `https://image.tmdb.org/t/p/w342${row.poster_path}` : undefined,
      background: row.backdrop_path ? `https://image.tmdb.org/t/p/w780${row.backdrop_path}` : undefined,
      description: row.overview || undefined,
      releaseInfo: date.slice(0, 4) || undefined,
      imdbRating: row.vote_average ? row.vote_average.toFixed(1) : undefined
    };
  });
  return metas.filter(Boolean);
}

module.exports = { api, pool, keywordId, searchTitle, toMetas };

};
__defs['tvmaze'] = function(module, exports) {
'use strict';
// TVmaze public API (no key). Used for streaming (web channel) premieres, which TMDB tracks poorly.
const BASE = 'https://api.tvmaze.com';
const cache = new Map();
const DAY = 86400e3;

async function get(path, ttl = 6 * 3600e3) {
  const h = cache.get(path); if (h && h.exp > Date.now()) return h.val;
  for (let i = 0; i < 3; i++) {
    const r = await fetch(BASE + path, { headers: { accept: 'application/json' } });
    if (r.status === 429) { await new Promise(s => setTimeout(s, 1500 * (i + 1))); continue; }
    if (r.status === 404) return [];
    if (!r.ok) throw new Error(`TVmaze ${r.status} ${path}`);
    const val = await r.json();
    cache.set(path, { exp: Date.now() + ttl, val });
    return val;
  }
  throw new Error('TVmaze rate limited');
}

const strip = h => (h || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() || undefined;
const iso = n => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);

function toMeta(show) {
  const imdb = show.externals && show.externals.imdb;
  if (!imdb) return null;
  return {
    id: imdb, type: 'series', name: show.name,
    poster: show.image && (show.image.medium || show.image.original),
    background: show.image && show.image.original,
    description: strip(show.summary),
    releaseInfo: (show.premiered || '').slice(0, 4) || undefined,
    imdbRating: show.rating && show.rating.average ? String(show.rating.average.toFixed ? show.rating.average.toFixed(1) : show.rating.average) : undefined,
    genres: show.genres && show.genres.length ? show.genres : undefined
  };
}

// opts: days (lookback), kind: 'new-series' (S1E1 of a new show) | 'new-shows' (non-scripted premieres) | 'any-premiere' (S1E1 or new season)
async function webPremieres({ days = 30, kind = 'new-series' } = {}) {
  const dates = Array.from({ length: days }, (_, i) => iso(i));
  const out = []; let idx = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (idx < dates.length) {
      const d = dates[idx++];
      try { out.push(...(await get(`/schedule/web?date=${d}`)).map(e => ({ ...e, _date: d }))); } catch { /* skip day */ }
    }
  }));
  const NON_SCRIPTED = /reality|talk|documentary|game show|variety|panel|award/i;
  const seen = new Set(); const metas = [];
  out.sort((a, b) => (b.airdate || b._date).localeCompare(a.airdate || a._date));
  for (const ep of out) {
    const show = ep._embedded && ep._embedded.show; if (!show || seen.has(show.id)) continue;
    const nonScripted = NON_SCRIPTED.test(show.type || '');
    const premiere = ep.number === 1;
    if (kind === 'new-series' && !(premiere && ep.season === 1 && !nonScripted)) continue;
    if (kind === 'new-shows' && !(nonScripted && premiere)) continue;
    if (kind === 'any-premiere' && !premiere) continue;
    const m = toMeta(show); if (!m) continue;
    seen.add(show.id); metas.push(m);
  }
  return metas;
}
// Title lookup used as a fallback when TMDB search finds nothing (or the hit has no IMDb id).
async function findShow(title) {
  const r = await get(`/singlesearch/shows?q=${encodeURIComponent(title)}`, 7 * DAY);
  return r && r.id ? toMeta(r) : null;
}
module.exports = { webPremieres, findShow, toMeta };

};
__defs['catalogues'] = function(module, exports) {
'use strict';
// Every row of the addon. type: 'movie' | 'series'. Row numbers match the wish list (there is no #4).
const REGION = process.env.WATCH_REGION || 'US';
const day = n => new Date(Date.now() - n * 86400e3).toISOString().slice(0, 10);
const today = () => day(0);

const NETWORK = { HBO: 49, SHOWTIME: 67, MTV: 33, COMEDY_CENTRAL: 47 };
const GENRE = { comedy: 35, animation: 16, horror: 27, docu: 99, reality: 10764, talk: 10767 };

const decade = (from, to) => () => ({
  sort_by: 'vote_average.desc', 'vote_count.gte': 4000,
  'primary_release_date.gte': from, 'primary_release_date.lte': to
});

const C = [];
const add = (n, id, name, type, source, extra = {}) => C.push({ n, id: `rv-${id}`, name, type, source, ...extra });

// 1 / 2 : weekly-fresh rows (rolling window, cached max 6h)
add(1, 'new-series', 'Recently Added Series', 'series', { kind: 'discover', path: '/discover/tv', params: () => ({
  sort_by: 'popularity.desc', 'first_air_date.gte': day(45), 'first_air_date.lte': today(),
  with_watch_monetization_types: 'flatrate', watch_region: REGION, without_genres: '10764,10767,99,10763,10766', 'vote_count.gte': 0 }), also: { days: 45, kind: 'new-series' } });
add(2, 'new-shows', 'Recently Added Shows', 'series', { kind: 'discover', path: '/discover/tv', params: () => ({
  sort_by: 'popularity.desc', 'first_air_date.gte': day(60), 'first_air_date.lte': today(),
  with_genres: `${GENRE.reality}|${GENRE.talk}|${GENRE.docu}`, watch_region: REGION, with_watch_monetization_types: 'flatrate' }), also: { days: 45, kind: 'new-shows' } });
add(3, 'rent-buy', 'Rent, Buy & Digital Releases', 'movie', { kind: 'discover', path: '/discover/movie', params: () => ({
  sort_by: 'popularity.desc', region: REGION, with_release_type: '4|5', 'release_date.gte': day(75), 'release_date.lte': today() }) });
add(5, 'new-standup', 'Recently Added Stand-Up Comedy', 'movie', { kind: 'discover', path: '/discover/movie', keywords: ['stand-up comedy', 'stand up'], params: () => ({
  sort_by: 'primary_release_date.desc', with_genres: GENRE.comedy, 'primary_release_date.lte': today(), 'vote_count.gte': 5 }) });

// 31 : TVmaze-only row, every streaming premiere or new season of the last 7 days
add(31, 'tvmaze-week', 'Streaming Premieres This Week', 'series', { kind: 'tvmaze', days: 7, mode: 'any-premiere' });

// 6..8
add(6, 'mtv', 'MTV: All-Time Shows', 'series', { kind: 'discover', path: '/discover/tv', params: () => ({ sort_by: 'vote_count.desc', with_networks: NETWORK.MTV }) });
add(7, 'looney', 'Looney Tunes: All-Time Shows', 'series', { kind: 'titles', list: [
  ['Looney Tunes'], ['Merrie Melodies'], ['The Bugs Bunny Show'], ['The Looney Tunes Show'], ['Looney Tunes Cartoons'], ['New Looney Tunes'],
  ['Baby Looney Tunes'], ['Tiny Toon Adventures'], ['Animaniacs'], ['Pinky and the Brain'], ['Taz-Mania'], ['Duck Dodgers'],
  ['The Sylvester & Tweety Mysteries'], ['Loonatics Unleashed'], ['Bugs Bunny Builders'], ['Tiny Toons Looniversity'], ['Wabbit'], ['Space Jam: A New Legacy', null, 'movie']] });
add(8, 'golden-sitcoms', 'Golden Era Sitcoms (80s to Now)', 'series', { kind: 'discover', path: '/discover/tv', keywords: ['sitcom'], params: () => ({
  sort_by: 'vote_count.desc', with_genres: GENRE.comedy, 'first_air_date.gte': '1980-01-01', 'vote_count.gte': 800, with_origin_country: 'US', without_genres: '16' }) });

// 9, 10
add(9, 'oscars', 'Oscar Nominees & Winners', 'movie', { kind: 'discover', path: '/discover/movie', keywordMatch: ['oscar', 'academy award'], params: () => ({
  sort_by: 'vote_count.desc', 'vote_count.gte': 1500 }) }, { fallbackParams: () => ({ sort_by: 'vote_average.desc', 'vote_count.gte': 8000 }) });
add(10, 'awarded-series', 'Award-Winning & Nominated Series', 'series', { kind: 'discover', path: '/discover/tv', keywordMatch: ['emmy', 'golden globe'], params: () => ({
  sort_by: 'vote_count.desc', 'vote_count.gte': 300 }) }, { fallbackParams: () => ({ sort_by: 'vote_average.desc', 'vote_count.gte': 3000 }) });

// 11
add(11, 'wwe', 'WWE Premium Live Events', 'movie', { kind: 'search', queries: [
  'WWE WrestleMania', 'WWE Royal Rumble', 'WWE SummerSlam', 'WWE Survivor Series', 'WWE Money in the Bank', 'WWE Elimination Chamber',
  'WWE Hell in a Cell', 'WWE Backlash', 'WWE Clash at the Castle', 'WWE Crown Jewel', 'WWE Night of Champions', 'WWE Extreme Rules',
  'WWE Fastlane', 'WWE Payback', 'WWE Bad Blood', 'WWE Saturday Night\'s Main Event', 'WWE Tables Ladders Chairs', 'WWE Summerslam', 'WWE King and Queen of the Ring'],
  filter: /\b(WWE|WWF)\b.*\b(WrestleMania|Royal Rumble|SummerSlam|Survivor Series|Money in the Bank|Elimination Chamber|Hell in a Cell|Backlash|Clash at the Castle|Crown Jewel|Night of Champions|Extreme Rules|Fastlane|Payback|Bad Blood|Saturday Night|Tables|King and Queen|Judgment Day|Armageddon|Vengeance|No Mercy|Unforgiven|SmackDown|Bash in Berlin|Clash in Paris|Evolution)/i,
  sort: 'date' });

// 12, 13, 14
add(12, 'adult-animation', 'Adult Comedy Animation', 'series', { kind: 'discover', path: '/discover/tv', keywords: ['adult animation'], params: () => ({
  sort_by: 'vote_count.desc', with_genres: `${GENRE.animation},${GENRE.comedy}`, 'vote_count.gte': 300 }) },
  { fallbackParams: () => ({ sort_by: 'vote_count.desc', with_genres: `${GENRE.animation},${GENRE.comedy}`, 'vote_count.gte': 800, with_original_language: 'en' }) });
add(13, 'impractical', 'Shows Like Impractical Jokers', 'series', { kind: 'titles', list: [
  ['Impractical Jokers'], ['Impractical Jokers: After Party'], ['Impractical Jokers: Dinner Party'], ['Impractical Jokers: Inside Jokes'], ['Punk\'d'],
  ['Just for Laughs Gags'], ['Candid Camera'], ['Trigger Happy TV'], ['Tosh.0'], ['Ridiculousness'], ['Whose Line Is It Anyway?'], ['Nathan for You'],
  ['Jackass'], ['Billy on the Street'], ['Wild \'n Out'], ['The Eric Andre Show']] });
add(14, 'comedy-central', 'Comedy Central Shows', 'series', { kind: 'discover', path: '/discover/tv', params: () => ({ sort_by: 'vote_count.desc', with_networks: NETWORK.COMEDY_CENTRAL }) });

// 15..20
add(15, 'wizarding', 'Wizarding World', 'movie', { kind: 'collections', ids: [1241, 435259] });
add(16, 'spy', 'Spy & Espionage Movies', 'movie', { kind: 'discover', path: '/discover/movie', keywords: ['spy', 'espionage', 'secret agent'], params: () => ({
  sort_by: 'vote_count.desc', 'vote_count.gte': 800 }) });
add(17, 'superhero-series', 'Superhero TV Series', 'series', { kind: 'discover', path: '/discover/tv', keywords: ['superhero'], params: () => ({
  sort_by: 'vote_count.desc', 'vote_count.gte': 150 }) });
add(18, 'nolan', 'Christopher Nolan Collection', 'movie', { kind: 'director', personId: 525 });
add(19, 'villeneuve', 'Denis Villeneuve Collection', 'movie', { kind: 'director', personId: 137427 });
add(20, 'spielberg', 'Steven Spielberg Collection', 'movie', { kind: 'director', personId: 488 });

// 21..26 : Top 50 lists (TMDB rating weighted by minimum vote count)
add(21, 'top-horror', 'Top 50 Horror Movies of All Time', 'movie', { kind: 'discover', path: '/discover/movie', params: () => ({
  sort_by: 'vote_average.desc', with_genres: GENRE.horror, 'vote_count.gte': 4000 }) }, { limit: 50 });
add(22, 'top-mini', 'Top 50 Miniseries of All Time', 'series', { kind: 'discover', path: '/discover/tv', params: () => ({
  sort_by: 'vote_average.desc', with_type: 2, 'vote_count.gte': 400 }) }, { limit: 50 });
add(23, 'top-80s', 'Top 50 Movies of the 80s', 'movie', { kind: 'discover', path: '/discover/movie', params: decade('1980-01-01', '1989-12-31') }, { limit: 50 });
add(24, 'top-90s', 'Top 50 Movies of the 90s', 'movie', { kind: 'discover', path: '/discover/movie', params: decade('1990-01-01', '1999-12-31') }, { limit: 50 });
add(25, 'top-00s', 'Top 50 Movies of the 2000s', 'movie', { kind: 'discover', path: '/discover/movie', params: decade('2000-01-01', '2009-12-31') }, { limit: 50 });
add(26, 'top-10s', 'Top 50 Movies of the 2010s', 'movie', { kind: 'discover', path: '/discover/movie', params: decade('2010-01-01', '2019-12-31') }, { limit: 50 });

// 27..30
add(27, 'world', 'The World Beyond Hollywood', 'movie', { kind: 'discover', path: '/discover/movie', params: () => ({
  sort_by: 'vote_average.desc', 'vote_count.gte': 1500, without_original_language: 'en' }) });
add(28, 'hbo', 'HBO Prestige Collection', 'series', { kind: 'discover', path: '/discover/tv', params: () => ({
  sort_by: 'vote_average.desc', with_networks: NETWORK.HBO, 'vote_count.gte': 500 }) });
add(29, 'simpsons-series', 'The Simpsons Universe', 'series', { kind: 'titles', list: [
  ['The Simpsons'], ['Futurama'], ['Disenchantment'], ['Krapopolis'], ['The Tracey Ullman Show'], ['Family Guy'], ['American Dad!'], ['Bob\'s Burgers'], ['King of the Hill']] });
add(29, 'simpsons-movies', 'The Simpsons Universe', 'movie', { kind: 'titles', list: [
  ['The Simpsons Movie'], ['The Longest Daycare'], ['Playdate with Destiny'], ['The Good, the Bart, and the Loki'], ['Rise of the Duff'], ['Welcome to the Club'],
  ['Bartman Begins'], ['When Billie Met Lisa'], ['Futurama: Bender\'s Big Score'], ['Futurama: The Beast with a Billion Backs'],
  ['Futurama: Bender\'s Game'], ['Futurama: Into the Wild Green Yonder']] });
add(30, 'showtime', 'SHOWTIME Prestige Collection', 'series', { kind: 'discover', path: '/discover/tv', params: () => ({
  sort_by: 'vote_average.desc', with_networks: NETWORK.SHOWTIME, 'vote_count.gte': 300 }) });

module.exports = C;

};
__defs['resolve'] = function(module, exports) {
'use strict';
// Turns a catalogue definition + Stremio "skip" into a list of Stremio metas.
const t = __req('tmdb');
const tvmaze = __req('tvmaze');
const PAGE = 20;
const TTL = 6 * 3600e3;
const memo = new Map();
async function once(key, ttl, fn) {
  const h = memo.get(key); if (h && h.exp > Date.now()) return h.p;
  const p = fn().catch(e => { memo.delete(key); throw e; });
  memo.set(key, { exp: Date.now() + ttl, p }); return p;
}

async function keywordIds(def) {
  const src = def.source; const ids = new Set();
  for (const name of src.keywords || []) { const id = await t.keywordId(name); if (id) ids.add(id); }
  for (const frag of src.keywordMatch || []) {
    const r = await t.api('/search/keyword', { query: frag }, 7 * 86400e3);
    (r.results || []).filter(k => k.name.toLowerCase().includes(frag)).slice(0, 6).forEach(k => ids.add(k.id));
  }
  return [...ids];
}

async function discover(def, skip) {
  const src = def.source; const type = def.type;
  const kw = await once('kw:' + def.id, 7 * 86400e3, () => keywordIds(def));
  const wants = (src.keywords || src.keywordMatch) ? true : false;
  let params = src.params();
  if (wants) {
    if (kw.length) params = { ...params, with_keywords: kw.join('|') };
    else if (def.fallbackParams) params = def.fallbackParams();
  }
  const limit = def.limit || Infinity;
  const page = Math.floor(skip / PAGE) + 1;
  if (skip >= limit) return [];
  const r = await t.api(src.path, { ...params, page, include_adult: false, language: 'en-US' }, TTL);
  let rows = r.results || [];
  if (limit - skip < rows.length) rows = rows.slice(0, limit - skip);
  return t.toMetas(type, rows);
}

async function fullList(def) {
  const src = def.source; const type = def.type;
  return once('list:' + def.id, TTL, async () => {
    let rows = [];
    if (src.kind === 'titles') {
      const found = await t.pool(src.list.filter(x => !x[2] || x[2] === type), 6, ([title, year]) => t.searchTitle(type, title, year));
      const seen = new Set(); rows = found.filter(r => r && !seen.has(r.id) && seen.add(r.id));
      if (type === 'series') { // TVmaze fills the gaps: titles TMDB missed or that lack an IMDb id
        const metas = await t.toMetas(type, rows);
        const have = new Set(metas.map(m => m.name.toLowerCase()));
        const missing = src.list.filter(x => (!x[2] || x[2] === type) && !have.has(x[0].toLowerCase())).map(x => x[0]);
        const extra = (await t.pool(missing, 4, n => tvmaze.findShow(n))).filter(m => m && !metas.some(x => x.id === m.id));
        return [...metas, ...extra];
      }
    } else if (src.kind === 'director') {
      const r = await t.api(`/person/${src.personId}/movie_credits`, {}, TTL);
      const seen = new Set();
      rows = (r.crew || []).filter(c => c.job === 'Director' && c.release_date && c.vote_count > 200 && !seen.has(c.id) && seen.add(c.id))
        .sort((a, b) => a.release_date.localeCompare(b.release_date));
    } else if (src.kind === 'collections') {
      const parts = await t.pool(src.ids, 3, id => t.api(`/collection/${id}`, {}, TTL));
      rows = parts.filter(Boolean).flatMap(c => (c.parts || []).filter(p => p.release_date)).sort((a, b) => a.release_date.localeCompare(b.release_date));
    } else if (src.kind === 'search') {
      const res = await t.pool(src.queries, 5, q => t.api('/search/movie', { query: q }, TTL));
      const seen = new Set();
      rows = res.filter(Boolean).flatMap(r => r.results || []).filter(r => src.filter.test(r.title) && !seen.has(r.id) && seen.add(r.id));
      if (src.sort === 'date') rows.sort((a, b) => (b.release_date || '').localeCompare(a.release_date || ''));
    }
    return t.toMetas(type, rows);
  });
}

async function fromTvmaze(opts) {
  return once('tvmaze:' + JSON.stringify(opts), TTL, () => tvmaze.webPremieres(opts));
}

async function resolve(def, skip = 0) {
  if (def.source.kind === 'tvmaze') return (await fromTvmaze({ days: def.source.days, kind: def.source.mode })).slice(skip, skip + 100);
  if (def.source.kind === 'discover' && def.source.also) {
    // TMDB discover (watch-provider filtered) + TVmaze streaming premieres, TVmaze first, deduped by IMDb id.
    const [tm, tv] = await Promise.all([discover(def, skip), skip === 0 ? fromTvmaze(def.source.also).catch(() => []) : []]);
    const seen = new Set(); return [...tv, ...tm].filter(m => !seen.has(m.id) && seen.add(m.id));
  }
  if (def.source.kind === 'discover') return discover(def, skip);
  const all = await fullList(def);
  return all.slice(skip, skip + 100);
}
module.exports = { resolve };

};
'use strict';
const http = require('http');
const CATS = __req('catalogues');
const { resolve } = __req('resolve');

const PORT = process.env.PORT || 7000;
const manifest = {
  id: 'community.reelvault',
  version: '1.0.0',
  name: 'ReelVault',
  description: 'Fresh weekly releases, prestige collections, director filmographies, Top 50 lists and cult comedy rows.',
  resources: ['catalog'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: [...CATS].sort((a, b) => a.n - b.n).map(c => ({
    type: c.type, id: c.id, name: `${String(c.n).padStart(2, '0')} · ${c.name}`,
    extra: (c.source.kind === 'discover') ? [{ name: 'skip', isRequired: false }] : []
  })),
  behaviorHints: { configurable: false }
};

function send(res, code, body, extra = {}) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', ...extra });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, {});
  const path = decodeURIComponent(req.url.split('?')[0]);
  if (path === '/') { res.writeHead(302, { Location: '/manifest.json' }); return res.end(); }
  if (path === '/manifest.json') return send(res, 200, manifest);
  if (path === '/health') return send(res, 200, { ok: true, tmdbKey: Boolean(process.env.TMDB_API_KEY) });
  if (path === '/diagnose') { // visit once after deploying: shows how many titles every row returns
    const rows = [];
    for (const c of [...CATS].sort((a, b) => a.n - b.n)) {
      try { const n = (await resolve(c, 0)).length; rows.push({ row: c.n, type: c.type, name: c.name, count: n, status: n ? 'ok' : 'EMPTY' }); }
      catch (e) { rows.push({ row: c.n, type: c.type, name: c.name, count: 0, status: 'ERROR: ' + e.message }); }
    }
    return send(res, 200, { empty: rows.filter(r => r.status !== 'ok').length, rows });
  }
  const m = /^\/catalog\/(movie|series)\/([^/]+?)(?:\/([^/]+?))?\.json$/.exec(path);
  if (!m) return send(res, 404, { error: 'not found' });
  const def = CATS.find(c => c.id === m[2] && c.type === m[1]);
  if (!def) return send(res, 200, { metas: [] });
  const skip = /skip=(\d+)/.exec(m[3] || '');
  try {
    send(res, 200, { metas: await resolve(def, skip ? Number(skip[1]) : 0) }, { 'Cache-Control': 'public, max-age=3600' });
  } catch (e) {
    console.error(def.id, e.message);
    send(res, 200, { metas: [] });
  }
});

if (require.main === module) {
  if (!process.env.TMDB_API_KEY) console.warn('WARNING: TMDB_API_KEY is not set - catalogues will be empty.');
  server.listen(PORT, () => console.log(`ReelVault listening on :${PORT} (${manifest.catalogs.length} catalogues)`));
}
module.exports = { server, manifest, resolve, CATS };
