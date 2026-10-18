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
  for (let attempt = 0; attempt < 6; attempt++) {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
    if (r.status === 429) { const wait = Number(r.headers && r.headers.get && r.headers.get('retry-after')) || attempt + 1; await new Promise(s => setTimeout(s, Math.min(wait, 8) * 1000)); continue; }
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

const norm = x => String(x || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, ' ').trim();
// Pick the hit whose title really matches the query (exact first, then containment), never just "first result".
function bestMatch(results, title) {
  const q = norm(title); const name = r => norm(r.title || r.name);
  return results.find(r => name(r) === q || norm(r.original_title || r.original_name) === q)
    || results.find(r => { const n = name(r); return Math.min(n.length, q.length) >= 6 && (n.includes(q) || q.includes(n)); }) || null;
}

async function searchTitle(type, title, year) {
  const kind = type === 'movie' ? 'movie' : 'tv';
  if (year) {
    const r = await api(`/search/${kind}`, { query: title, ...(type === 'movie' ? { year } : { first_air_date_year: year }) }, 7 * 86400e3);
    const hit = bestMatch(r.results || [], title); if (hit) return hit;
  }
  const r = await api(`/search/${kind}`, { query: title }, 7 * 86400e3);
  return bestMatch(r.results || [], title);
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
      _date: date,
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
    const r = await fetch(BASE + path, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
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
    _date: show.premiered || '',
    imdbRating: show.rating && show.rating.average ? String(show.rating.average.toFixed ? show.rating.average.toFixed(1) : show.rating.average) : undefined,
    genres: show.genres && show.genres.length ? show.genres : undefined
  };
}

// opts: days (lookback), kind: 'new-series' (S1E1 of a new show) | 'new-shows' (non-scripted premieres) | 'any-premiere' (S1E1 or new season)
// Monday..Sunday (UTC) of the current week (offset 0) or a later/earlier one.
function weekDates(offset) {
  const n = new Date(); const dow = (n.getUTCDay() + 6) % 7;
  const mon = Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate() - dow + offset * 7);
  return Array.from({ length: 7 }, (_, i) => new Date(mon + i * DAY).toISOString().slice(0, 10));
}

// `days` looks back, `ahead` also looks forward (announced premieres and new seasons coming up).
async function webPremieres({ days = 30, kind = 'new-series', week, ahead = 0 } = {}) {
  const dates = week === undefined ? Array.from({ length: days + ahead }, (_, i) => iso(i - ahead)) : weekDates(week);
  const out = []; let idx = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (idx < dates.length) {
      const d = dates[idx++];
      // days in the past hardly change: cache them for a day, only today/yesterday refresh often
      const age = (Date.now() - Date.parse(d)) / DAY;
      try { out.push(...(await get(`/schedule/web?date=${d}`, age > 2 ? DAY : 3 * 3600e3)).map(e => ({ ...e, _date: d }))); } catch { /* skip day */ }
    }
  }));
  const NON_SCRIPTED = /reality|talk|documentary|game show|variety|panel|award/i;
  const seen = new Set(); const metas = [];
  const dir = week >= 1 ? 1 : -1; // next week in calendar order, otherwise newest first
  out.sort((a, b) => dir * (a.airdate || a._date).localeCompare(b.airdate || b._date));
  for (const ep of out) {
    const show = ep._embedded && ep._embedded.show; if (!show || seen.has(show.id)) continue;
    const nonScripted = NON_SCRIPTED.test(show.type || '');
    const premiere = ep.number === 1;
    if (kind === 'new-series' && !(premiere && ep.season === 1 && !nonScripted)) continue;
    if (kind === 'scripted-premiere' && !(premiere && !nonScripted)) continue; // new series AND new seasons of scripted shows
    if (kind === 'new-shows' && !(nonScripted && premiere)) continue;
    if (kind === 'any-premiere' && !premiere) continue;
    const m = toMeta(show); if (!m) continue;
    m._date = ep.airdate || ep._date;                       // sort by when this season/episode dropped, not the show's original premiere
    const label = m._date > iso(0) ? `Coming ${m._date}: ${ep.season > 1 ? 'new season ' + ep.season : 'new series'} premieres.`
      : ep.season > 1 ? `New season ${ep.season} premiered ${m._date}.` : '';
    if (label) m.description = label + (m.description ? ' ' + m.description : '');
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

// Major streaming platforms (TMDB provider ids): Netflix, Prime Video, Disney+, Apple TV+, Paramount+, Hulu, Peacock, Max/HBO Max, Crunchyroll.
// Override with the WATCH_PROVIDERS environment variable (ids separated by |).
const PROVIDERS = process.env.WATCH_PROVIDERS || '8|9|337|350|531|15|386|1899|384|283';
const NETWORK = { HBO: 49, SHOWTIME: 67, MTV: 33, COMEDY_CENTRAL: 47 };
const GENRE = { comedy: 35, animation: 16, horror: 27, docu: 99, reality: 10764, talk: 10767 };

const decade = (from, to) => () => ({
  sort_by: 'vote_average.desc', 'vote_count.gte': 4000,
  'primary_release_date.gte': from, 'primary_release_date.lte': to
});

const T = (...names) => names.map(n => [n]);                       // plain title list
const Y = str => str.split('|').map(x => { const i = x.lastIndexOf('@'); return [x.slice(0, i), x.slice(i + 1)]; }); // "Title@year|..."

const STANDUP_SPECIALS = "Dave Chappelle: Killin' Them Softly@2000|Dave Chappelle: For What It's Worth@2004|Dave Chappelle: Sticks & Stones@2019|Dave Chappelle: The Closer@2021|Dave Chappelle: The Dreamer@2023|Bo Burnham: Inside@2021|Bo Burnham: Make Happy@2016|Bo Burnham: what.@2013|Richard Pryor: Live in Concert@1979|Richard Pryor: Live on the Sunset Strip@1982|Richard Pryor: Here and Now@1983|Eddie Murphy: Delirious@1983|Eddie Murphy Raw@1987|Eddie Murphy: Comedian@2012|George Carlin: Jammin' in New York@1992|George Carlin: Life Is Worth Losing@2005|George Carlin: It's Bad for Ya@2008|George Carlin: You Are All Diseased@1999|Robin Williams: Live on Broadway@2002|Robin Williams: Weapons of Self Destruction@2009|Robin Williams: An Evening at the Met@1986|Jerry Seinfeld: 23 Hours to Kill@2020|Jerry Seinfeld: I'm Telling You for the Last Time@1998|Jerry Seinfeld: Jerry Before Seinfeld@2017|Hannah Gadsby: Nanette@2018|Hannah Gadsby: Douglas@2020|John Mulaney: Kid Gorgeous at Radio City@2018|John Mulaney: The Comeback Kid@2015|John Mulaney: New in Town@2012|John Mulaney: Baby J@2023|Ali Wong: Baby Cobra@2016|Ali Wong: Hard Knock Wife@2018|Ali Wong: Don Wong@2022|Bill Burr: Walk Your Way Out@2017|Bill Burr: I'm Sorry You Feel That Way@2014|Bill Burr: Paper Tiger@2019|Bill Burr: Let It Go@2010|Louis C.K.: Hilarious@2010|Louis C.K.: Chewed Up@2008|Louis C.K.: Shameless@2007|Louis C.K.: Live at the Beacon Theater@2011|Louis C.K.: Oh My God@2013|Louis C.K.: 2017@2017|Chris Rock: Bring the Pain@1996|Chris Rock: Never Scared@2004|Chris Rock: Kill the Messenger@2008|Chris Rock: Tamborine@2018|Chris Rock: Total Blackout@2022|Chris Rock: Selective Outrage@2023|Kevin Hart: Let Me Explain@2013|Kevin Hart: Laugh at My Pain@2011|Kevin Hart: Irresponsible@2019|Kevin Hart: Seriously Funny@2010|Kevin Hart: Zero F**ks Given@2020|Russell Peters: Outsourced@2006|Russell Peters: Red, White and Brown@2008|Russell Peters: Almost Famous@2016|Jim Gaffigan: Mr. Universe@2012|Jim Gaffigan: Beyond the Pale@2006|Jim Gaffigan: Obsessed@2014|Jim Gaffigan: Cinco@2017|Jim Jefferies: Freedumb@2016|Jim Jefferies: BARE@2014|Jim Jefferies: Contraband@2008|Trevor Noah: Afraid of the Dark@2017|Trevor Noah: Son of Patricia@2018|Trevor Noah: I Wish You Would@2022|Trevor Noah: Lost in Translation@2015|Aziz Ansari: Right Now@2022|Aziz Ansari: Buried Alive@2013|Aziz Ansari: Dangerously Delicious@2012|Aziz Ansari: Live at Madison Square Garden@2015|Patton Oswalt: Annihilation@2017|Patton Oswalt: Tragedy Plus Comedy Equals Time@2014|Patton Oswalt: Finest Hour@2011|Patton Oswalt: Werewolves and Lollipops@2007|Mike Birbiglia: My Girlfriend's Boyfriend@2013|Mike Birbiglia: Thank God for Jokes@2017|Mike Birbiglia: The New One@2019|Sebastian Maniscalco: Aren't You Embarrassed?@2014|Sebastian Maniscalco: Stay Hungry@2019|Sebastian Maniscalco: Nobody Does This@2016|Norm Macdonald: Hitler's Dog, Gossip & Trickery@2017|Norm Macdonald: Me Doing Standup@2011|Norm Macdonald: Nothing Special@2022|Steve Martin: Let's Get Small@1977|Steve Martin: A Wild and Crazy Guy@1978|Steve Martin Live@1985|Sam Kinison: Breaking the Rules@1987|Bill Hicks: Relentless@1992|Bill Hicks: Revelations@1993|Bill Hicks: Sane Man@1989|Bill Hicks: One Night Stand@1991|Mitch Hedberg: Mitch All Together@2003|Mitch Hedberg: Strategic Grill Locations@1999|Brian Regan: Standing Up@2007|Brian Regan: I Walked on the Moon@2004|Brian Regan: Nunchucks and Flamethrowers@2017|Brian Regan: On the Rocks@2022|Tom Segura: Mostly Stories@2016|Tom Segura: Disgraceful@2018|Tom Segura: Ball Hog@2020|Tom Segura: Completely Normal@2014|Gabriel Iglesias: I'm Not Fat... I'm Fluffy@2009|Gabriel Iglesias: Hot & Fluffy@2007|Gabriel Iglesias: One Show Fits All@2019|Gabriel Iglesias: Aloha Fluffy@2017|Nate Bargatze: The Tennessee Kid@2023|Nate Bargatze: Hello World@2024|Nate Bargatze: Greatest Average American@2021|Nate Bargatze: Full Time Magic@2023|Taylor Tomlinson: Look at You@2022|Taylor Tomlinson: Have It All@2024|Ricky Gervais: Humanity@2018|Ricky Gervais: SuperNature@2022|Ricky Gervais: Out of England@2008|Ricky Gervais: Politics@2004|Ricky Gervais: Armageddon@2023|Eddie Izzard: Dress to Kill@1999|Eddie Izzard: Glorious@1997|Eddie Izzard: Definite Article@1996|Eddie Izzard: Sexie@2003|Eddie Izzard: Force Majeure@2013|Daniel Tosh: Completely Serious@2007|Daniel Tosh: Happy Thoughts@2011|Daniel Tosh: People Pleaser@2016|Daniel Tosh: Tosh.0@2009|Demetri Martin: Live (At the Time)@2015|Demetri Martin: Person@2007|Demetri Martin: These Are Jokes@2005|Maria Bamford: Old Baby@2017|Maria Bamford: Weakness Is the Brand@2020|Maria Bamford: The Special Special Special!@2012|Tig Notaro: Live@2013|Tig Notaro: Happy To Be Here@2018|Tig Notaro: Boyish Girl Interrupted@2015|Wanda Sykes: I'ma Be Me@2009|Wanda Sykes: Not Normal@2019|Wanda Sykes: Sick & Tired@2006|Jo Koy: Live from Seattle@2017|Jo Koy: In His Elements@2019|Jo Koy: Comin' in Hot@2022|Michael McIntyre: Live and Laughing@2008|Michael McIntyre: Hello Wembley!@2012|Michael McIntyre: Showman@2020|Michael McIntyre: Showman@2021|Billy Connolly: Live in London@1994|Billy Connolly: Was It Something I Said?@2008|Billy Connolly: Two Night Stand@1997|Billy Connolly: Bite Your Bum@2013|Dara Ó Briain: Craic Dealer@2014|Dara Ó Briain: Talks Funny@2012|Dara Ó Briain: Voice of Reason@2011|Jimmy Carr: Funny Business@2016|Jimmy Carr: Telling Jokes@2008|Jimmy Carr: Making People Laugh@2010|Jimmy Carr: Laughing and Joking@2013|Jimmy Carr: His Dark Material@2021|Kate Berlant: Cinnamon in the Wind@2023|Nikki Glaser: Bangin'@2019|Nikki Glaser: Someone You Love@2024|Whitney Cummings: Jokes@2019|Whitney Cummings: I Love You@2014|Sarah Silverman: Jesus Is Magic@2005|Sarah Silverman: We Are Miracles@2013|Sarah Silverman: A Speck of Dust@2017|Amy Schumer: Growing@2019|Amy Schumer: The Leather Special@2017|Amy Schumer: Emergency Contact@2012|Amy Schumer: Cry Baby@2022|Anthony Jeselnik: Thoughts and Prayers@2015|Anthony Jeselnik: Fire in the Maternity Ward@2019|Anthony Jeselnik: Caligula@2013|Anthony Jeselnik: Bones and Silence@2011|Joe Rogan: Strange Times@2018|Joe Rogan: Triggered@2016|Joe Rogan: Rocky Mountain High@2014|Joe Rogan: Live from the Tabernacle@2012|Joe Rogan: Rfactor@2014|Tracy Morgan: Staying Alive@2017|Tracy Morgan: Black and Blue@2010|Tracy Morgan: One Mic Stand@2010|Tracy Morgan: Bring the Pain@2013|Katt Williams: American Hustle@2007|Katt Williams: It's Pimpin' Pimpin'@2008|Katt Williams: Kattpacalypse@2012|Katt Williams: Great America@2018|Katt Williams: World War III@2022|Katt Williams: Witless@2024|Louie Anderson: Big Underwear@2012|Louie Anderson: The Two of Us@2009|Pete Davidson: Alive from New York@2020|Pete Davidson: Turbo Fonzarelli@2024|Pete Holmes: Nice Try, the Devil Is a Liar!@2013|Pete Holmes: Dirty Clean@2016|Pete Holmes: I Am Not for Everyone@2013|Russell Howard: Recalibrate@2017|Russell Howard: Wonderbox@2014|Russell Howard: Round the Bend@2016|Russell Howard: Lighthouse@2022|Frankie Boyle: Live in London@2012|Frankie Boyle: My Name Is Frankie Boyle@2017|Frankie Boyle: Hurt Like You've Never Been Loved@2019|Ron White: They Call Me Tater Salad@2003|Ron White: You Can't Fix Stupid@2006|Ron White: Behavioral Problems@2009|Ron White: A Little Unprofessional@2012|Jeff Foxworthy: Totally Committed@1998|Larry the Cable Guy: Git-R-Done@2004|Bill Engvall: Here's Your Sign Live@2004|Blue Collar Comedy Tour: The Movie@2003|Blue Collar Comedy Tour Rides Again@2004|Kings of Comedy@2000|The Original Kings of Comedy@2000|The Comedy Get Down@2012|Kevin Hart: What Now?@2016|Jerry Seinfeld: Just Say Julia@2000|Mel Brooks: Live@1999|Johnny Carson: Comedy Club@1990|Andrew Dice Clay: Dice Rules@1991|Andrew Dice Clay: The Day the Laughter Died@1990|Jeff Dunham: Arguing with Myself@2006|Jeff Dunham: Spark of Insanity@2007|Jeff Dunham: Minding the Monsters@2012|Jeff Dunham: Controlled Chaos@2011|Jeff Dunham: Relative Disaster@2017|Jeff Dunham: Beside Himself@2019|Jeff Dunham: All Over the Map@2014|Jeff Dunham: Seriously!@2023|Nate Bargatze: Raincoat@2017|Russell Brand: Messiah Complex@2013|Russell Brand: Scandalous@2009|Russell Brand: Doing Life: Live@2007|Russell Brand: Brand X@2012|Gary Gulman: The Great Depresh@2019|Gary Gulman: It's About Time@2016|Gary Gulman: Boyish Man-Child@2012|Gary Gulman: Born on Third Base@2011|Neal Brennan: 3 Mics@2017|Neal Brennan: Unacceptable@2011|Neal Brennan: Blocking the Doorway@2010|Dave Attell: Skanks for the Memories@2004|Dave Attell: Captain Miserable@2007|Dave Attell: Skanks for the Memories@2005|Dave Attell: Road Work@2009|Dave Attell: Cashing In@2012";

const C = [];
const add = (n, id, name, type, source, extra = {}) => C.push({ n, id: `rv-${id}`, name, type, source, ...extra });

// 1 / 2 : weekly-fresh rows (rolling window, cached max 6h)
add(1, 'new-series', 'Recently Added Series & Anime (Newest First)', 'series', { kind: 'discover', path: '/discover/tv', pages: 2, newestFirst: true,
  params: () => ({ sort_by: 'popularity.desc', 'first_air_date.gte': day(45), 'first_air_date.lte': today(), with_watch_monetization_types: 'flatrate',
    watch_region: REGION, with_watch_providers: PROVIDERS, without_genres: '10764,10767,99,10763,10766', 'vote_count.gte': 0 }),
  more: [ // anime series from the same platforms, merged into the same list
    () => ({ sort_by: 'popularity.desc', 'first_air_date.gte': day(45), 'first_air_date.lte': today(), with_genres: GENRE.animation, with_original_language: 'ja',
      with_watch_monetization_types: 'flatrate', watch_region: REGION, with_watch_providers: PROVIDERS })
  ],
  also: { days: 30, kind: 'scripted-premiere' } });
add(2, 'new-shows', 'Recently Added Shows (Newest First)', 'series', { kind: 'discover', path: '/discover/tv', pages: 2, newestFirst: true, params: () => ({
  sort_by: 'popularity.desc', 'first_air_date.gte': day(60), 'first_air_date.lte': today(),
  with_genres: `${GENRE.reality}|${GENRE.talk}|${GENRE.docu}`, watch_region: REGION, with_watch_monetization_types: 'flatrate' }), also: { days: 30, kind: 'new-shows' } });
add(3, 'rent-buy', 'Rent, Buy & Digital Releases (Last 90 Days)', 'movie', { kind: 'discover', path: '/discover/movie', pages: 3, newestFirst: true,
  since: () => day(180), // hard cut-off: the film itself must be recent too, so old re-releases never show
  params: () => ({ sort_by: 'popularity.desc', region: REGION, with_release_type: '4', 'release_date.gte': day(90), 'release_date.lte': today(),
  'primary_release_date.gte': day(180), 'vote_count.gte': 5 }) });
add(5, 'new-standup', 'Recently Added Stand-Up Comedy (Newest First)', 'movie', { kind: 'discover', path: '/discover/movie', pages: 3, newestFirst: true, strict: true,
  keywordMatch: ['stand-up', 'stand up', 'standup'], params: () => ({
  sort_by: 'primary_release_date.desc', with_genres: GENRE.comedy, 'primary_release_date.gte': day(1095), 'primary_release_date.lte': today(), 'vote_count.gte': 3 }) });

// 34 : TVmaze calendar week (Monday-Sunday): next week's streaming premieres, fresh every Monday
add(34, 'tvmaze-next-week', 'Streaming Premieres Next Week', 'series', { kind: 'tvmaze', week: 1, mode: 'any-premiere' });

// 6..8
add(6, 'mtv', 'MTV: All-Time Shows', 'series', { kind: 'discover', path: '/discover/tv', params: () => ({ sort_by: 'vote_count.desc', with_networks: NETWORK.MTV }) });
add(7, 'looney', 'Looney Tunes: All-Time Shows & Spin-offs', 'series', { kind: 'merge', parts: [
  { kind: 'titles', list: T('Looney Tunes','The Looney Tunes Show','Looney Tunes Cartoons','Baby Looney Tunes','New Looney Tunes','Tiny Toon Adventures','Animaniacs','Pinky and the Brain','Taz-Mania','Duck Dodgers','The Sylvester & Tweety Mysteries','Loonatics Unleashed','Tiny Toons Looniversity','Bugs Bunny Builders','Merrie Melodies','The Bugs Bunny Show','The Bugs Bunny and Tweety Show','Pinky, Elmyra & the Brain','Wabbit','Road Runner Show','Freakazoid!','Histeria!') },
  { kind: 'similar', seeds: ['Looney Tunes','Animaniacs','Tiny Toon Adventures'], max: 25, minVotes: 100 }
] });
add(37, 'classic-cartoons', 'Classic Cartoons: Tom & Jerry, Popeye & Hanna-Barbera', 'series', { kind: 'merge', parts: [
  { kind: 'titles', list: T('Tom and Jerry','Scooby-Doo, Where Are You!','The Flintstones','Popeye the Sailor','The Jetsons','The Pink Panther Show','Yogi Bear','The Tom and Jerry Show','Top Cat','Wacky Races','Tom & Jerry Kids Show','The Woody Woodpecker Show','The Adventures of Rocky and Bullwinkle and Friends','Huckleberry Hound','Hong Kong Phooey','What\'s New, Scooby-Doo?','Scooby-Doo and Guess Who?','The New Scooby-Doo Movies','Dastardly and Muttley in Their Flying Machines','Captain Caveman and the Teen Angels','Johnny Quest','Felix the Cat','Mighty Mouse: The New Adventures','Chip \'n Dale: Rescue Rangers','DuckTales','TaleSpin','Darkwing Duck','Courage the Cowardly Dog','Dexter\'s Laboratory','Johnny Bravo','Cow and Chicken','Ed, Edd n Eddy','The Powerpuff Girls','Samurai Jack','Tom and Jerry in New York','Space Ghost Coast to Coast','Garfield and Friends','The Smurfs','He-Man and the Masters of the Universe','Teenage Mutant Ninja Turtles') },
  { kind: 'similar', seeds: ['Tom and Jerry','The Flintstones','Scooby-Doo, Where Are You!','Popeye the Sailor'], max: 40, minVotes: 100 }
] });
add(33, 'looney-movies', 'Looney Tunes & Classic Cartoon Movies', 'movie', { kind: 'titles', list: Y('Space Jam@1996|Space Jam: A New Legacy@2021|Looney Tunes: Back in Action@2003|The Day the Earth Blew Up: A Looney Tunes Movie@2024|Who Framed Roger Rabbit@1988|Bugs Bunny\'s 3rd Movie: 1001 Rabbit Tales@1982|Daffy Duck\'s Movie: Fantastic Island@1983|Daffy Duck\'s Quackbusters@1988|The Bugs Bunny/Road-Runner Movie@1979|Looney Tunes: Rabbits Run@2015|Looney Tunes: Reality Check@2015|Tom and Jerry@2021|Tom and Jerry: The Movie@1992|Tom and Jerry: The Fast and the Furry@2005|Tom and Jerry: Willy Wonka and the Chocolate Factory@2017|Tom and Jerry: Robin Hood and His Merry Mouse@2012|Tom and Jerry Meet Sherlock Holmes@2010|Tom and Jerry: Spy Quest@2015|Scooby-Doo!@2002|Scooby-Doo 2: Monsters Unleashed@2004|Scooby-Doo! and the Witch\'s Ghost@1999|Scooby-Doo on Zombie Island@1998|Scooby-Doo! Curse of the 13th Ghost@2019|The Flintstones@1994|The Flintstones in Viva Rock Vegas@2000|The Man Called Flintstone@1966|Yogi Bear@2010|The Jetsons Movie@1990|Rocky and Bullwinkle@2000|The Pink Panther@2006|Animaniacs: Wakko\'s Wish@1999|Tiny Toon Adventures: How I Spent My Vacation@1992|Pinky and the Brain@1995|Tweety\'s High-Flying Adventure@2000|The Looney Looney Looney Bugs Bunny Movie@1981') });
add(8, 'golden-sitcoms', 'Golden Era Sitcoms (80s to Now)', 'series', { kind: 'merge', parts: [
  { kind: 'titles', list: T('Cheers','Family Ties','The Golden Girls','The Cosby Show','Who\'s the Boss?','Growing Pains','Family Matters','Full House','Roseanne','Married... with Children','Designing Women','Murphy Brown','Night Court','Coach','Wings','ALF','Empty Nest','The Wonder Years','Saved by the Bell','The Fresh Prince of Bel-Air','Seinfeld','Frasier','Friends','Home Improvement','Mad About You','Newsradio','Spin City','The Nanny','3rd Rock from the Sun','Everybody Loves Raymond','Ellen','Sabrina the Teenage Witch','Dharma & Greg','The Drew Carey Show','Becker','Living Single','Martin','Sister, Sister','Will & Grace','That \'70s Show','Malcolm in the Middle','The King of Queens','Scrubs','Arrested Development','Curb Your Enthusiasm','Everybody Hates Chris','The Bernie Mac Show','My Wife and Kids','How I Met Your Mother','The Big Bang Theory','Two and a Half Men','Modern Family','The Office','Parks and Recreation','30 Rock','Community','New Girl','Happy Endings','Cougar Town','2 Broke Girls','Mike & Molly','The Middle','The Goldbergs','Last Man Standing','Black-ish','Fresh Off the Boat','Brooklyn Nine-Nine','It\'s Always Sunny in Philadelphia','The Good Place','Schitt\'s Creek','Superstore','Young Sheldon','Ted Lasso','Abbott Elementary','What We Do in the Shadows','Only Murders in the Building','Only Fools and Horses','Yes Minister','Blackadder','Red Dwarf','Absolutely Fabulous','Father Ted','The IT Crowd','Peep Show','The Inbetweeners','Gavin & Stacey','Derry Girls','Miranda','Friday Night Dinner','Taxi','Mr. Belvedere') },
  { kind: 'discover', path: '/discover/tv', pages: 5, params: () => ({ sort_by: 'vote_count.desc', with_genres: GENRE.comedy, without_genres: '16,10767,10764,10763,99,10762', 'first_air_date.gte': '1980-01-01', with_original_language: 'en', 'vote_count.gte': 250 }) }
] });

// 9, 10
add(9, 'oscars', 'Oscar Nominees & Winners (Best Picture)', 'movie', { kind: 'titles', list: Y(`Wings@1927|The Broadway Melody@1929|All Quiet on the Western Front@1930|Cimarron@1931|Grand Hotel@1932|Cavalcade@1933|It Happened One Night@1934|Mutiny on the Bounty@1935|The Great Ziegfeld@1936|The Life of Emile Zola@1937|You Can't Take It with You@1938|Gone with the Wind@1939|Rebecca@1940|How Green Was My Valley@1941|Mrs. Miniver@1942|Casablanca@1942|Going My Way@1944|The Lost Weekend@1945|The Best Years of Our Lives@1946|Gentleman's Agreement@1947|Hamlet@1948|All the King's Men@1949|All About Eve@1950|Sunset Boulevard@1950|A Streetcar Named Desire@1951|An American in Paris@1951|The Greatest Show on Earth@1952|From Here to Eternity@1953|On the Waterfront@1954|Marty@1955|Around the World in 80 Days@1956|12 Angry Men@1957|The Bridge on the River Kwai@1957|Gigi@1958|Ben-Hur@1959|The Apartment@1960|West Side Story@1961|Lawrence of Arabia@1962|Tom Jones@1963|Dr. Strangelove@1964|Mary Poppins@1964|My Fair Lady@1964|The Sound of Music@1965|A Man for All Seasons@1966|In the Heat of the Night@1967|The Graduate@1967|Bonnie and Clyde@1967|Oliver!@1968|Midnight Cowboy@1969|Butch Cassidy and the Sundance Kid@1969|Patton@1970|The French Connection@1971|A Clockwork Orange@1971|Fiddler on the Roof@1971|The Godfather@1972|Cabaret@1972|The Exorcist@1973|The Sting@1973|Chinatown@1974|The Godfather Part II@1974|One Flew Over the Cuckoo's Nest@1975|Jaws@1975|Dog Day Afternoon@1975|Nashville@1975|Rocky@1976|Taxi Driver@1976|Network@1976|Annie Hall@1977|Star Wars@1977|The Deer Hunter@1978|Apocalypse Now@1979|Kramer vs. Kramer@1979|Ordinary People@1980|Raging Bull@1980|Chariots of Fire@1981|Raiders of the Lost Ark@1981|Reds@1981|Gandhi@1982|E.T. the Extra-Terrestrial@1982|Tootsie@1982|Terms of Endearment@1983|The Right Stuff@1983|Amadeus@1984|Out of Africa@1985|The Color Purple@1985|Witness@1985|Platoon@1986|Hannah and Her Sisters@1986|The Mission@1986|The Last Emperor@1987|Fatal Attraction@1987|Moonstruck@1987|Broadcast News@1987|Rain Man@1988|Mississippi Burning@1988|Working Girl@1988|Dangerous Liaisons@1988|Driving Miss Daisy@1989|Dead Poets Society@1989|Born on the Fourth of July@1989|Field of Dreams@1989|My Left Foot@1989|Dances with Wolves@1990|Awakenings@1990|Ghost@1990|The Godfather Part III@1990|Goodfellas@1990|The Silence of the Lambs@1991|Beauty and the Beast@1991|Bugsy@1991|JFK@1991|The Prince of Tides@1991|Unforgiven@1992|A Few Good Men@1992|The Crying Game@1992|Howards End@1992|Scent of a Woman@1992|Schindler's List@1993|The Fugitive@1993|In the Name of the Father@1993|The Piano@1993|The Remains of the Day@1993|Forrest Gump@1994|Four Weddings and a Funeral@1994|Pulp Fiction@1994|Quiz Show@1994|The Shawshank Redemption@1994|Braveheart@1995|Apollo 13@1995|Babe@1995|Il Postino@1994|Sense and Sensibility@1995|The English Patient@1996|Fargo@1996|Jerry Maguire@1996|Secrets & Lies@1996|Shine@1996|Titanic@1997|As Good as It Gets@1997|The Full Monty@1997|Good Will Hunting@1997|L.A. Confidential@1997|Shakespeare in Love@1998|Elizabeth@1998|Life Is Beautiful@1997|Saving Private Ryan@1998|The Thin Red Line@1998|American Beauty@1999|The Cider House Rules@1999|The Green Mile@1999|The Insider@1999|The Sixth Sense@1999|Gladiator@2000|Chocolat@2000|Crouching Tiger, Hidden Dragon@2000|Erin Brockovich@2000|Traffic@2000|A Beautiful Mind@2001|Gosford Park@2001|In the Bedroom@2001|The Lord of the Rings: The Fellowship of the Ring@2001|Moulin Rouge!@2001|Chicago@2002|Gangs of New York@2002|The Hours@2002|The Lord of the Rings: The Two Towers@2002|The Pianist@2002|The Lord of the Rings: The Return of the King@2003|Lost in Translation@2003|Master and Commander: The Far Side of the World@2003|Mystic River@2003|Seabiscuit@2003|Million Dollar Baby@2004|The Aviator@2004|Finding Neverland@2004|Ray@2004|Sideways@2004|Crash@2004|Brokeback Mountain@2005|Capote@2005|Good Night, and Good Luck.@2005|Munich@2005|The Departed@2006|Babel@2006|Letters from Iwo Jima@2006|Little Miss Sunshine@2006|The Queen@2006|No Country for Old Men@2007|Atonement@2007|Juno@2007|Michael Clayton@2007|There Will Be Blood@2007|Slumdog Millionaire@2008|The Curious Case of Benjamin Button@2008|Frost/Nixon@2008|Milk@2008|The Reader@2008|The Hurt Locker@2008|Avatar@2009|The Blind Side@2009|District 9@2009|An Education@2009|Inglourious Basterds@2009|Precious@2009|A Serious Man@2009|Up@2009|Up in the Air@2009|The King's Speech@2010|127 Hours@2010|Black Swan@2010|The Fighter@2010|Inception@2010|The Kids Are All Right@2010|Toy Story 3@2010|True Grit@2010|Winter's Bone@2010|The Social Network@2010|The Artist@2011|The Descendants@2011|Extremely Loud & Incredibly Close@2011|The Help@2011|Hugo@2011|Midnight in Paris@2011|Moneyball@2011|The Tree of Life@2011|War Horse@2011|Argo@2012|Amour@2012|Beasts of the Southern Wild@2012|Django Unchained@2012|Les Misérables@2012|Life of Pi@2012|Lincoln@2012|Silver Linings Playbook@2012|Zero Dark Thirty@2012|12 Years a Slave@2013|American Hustle@2013|Captain Phillips@2013|Dallas Buyers Club@2013|Gravity@2013|Her@2013|Nebraska@2013|Philomena@2013|The Wolf of Wall Street@2013|Birdman or (The Unexpected Virtue of Ignorance)@2014|American Sniper@2014|Boyhood@2014|The Grand Budapest Hotel@2014|The Imitation Game@2014|Selma@2014|The Theory of Everything@2014|Whiplash@2014|Spotlight@2015|The Big Short@2015|Bridge of Spies@2015|Brooklyn@2015|Mad Max: Fury Road@2015|The Martian@2015|The Revenant@2015|Room@2015|Moonlight@2016|Arrival@2016|Fences@2016|Hacksaw Ridge@2016|Hell or High Water@2016|Hidden Figures@2016|La La Land@2016|Lion@2016|Manchester by the Sea@2016|The Shape of Water@2017|Call Me by Your Name@2017|Darkest Hour@2017|Dunkirk@2017|Get Out@2017|Lady Bird@2017|Phantom Thread@2017|The Post@2017|Three Billboards Outside Ebbing, Missouri@2017|Green Book@2018|Black Panther@2018|BlacKkKlansman@2018|Bohemian Rhapsody@2018|The Favourite@2018|Roma@2018|A Star Is Born@2018|Vice@2018|Parasite@2019|Ford v Ferrari@2019|The Irishman@2019|Jojo Rabbit@2019|Joker@2019|Little Women@2019|Marriage Story@2019|1917@2019|Once Upon a Time in Hollywood@2019|Nomadland@2020|The Father@2020|Judas and the Black Messiah@2021|Mank@2020|Minari@2020|Promising Young Woman@2020|Sound of Metal@2019|The Trial of the Chicago 7@2020|CODA@2021|Belfast@2021|Don't Look Up@2021|Drive My Car@2021|Dune@2021|King Richard@2021|Licorice Pizza@2021|Nightmare Alley@2021|The Power of the Dog@2021|West Side Story@2021|Everything Everywhere All at Once@2022|All Quiet on the Western Front@2022|Avatar: The Way of Water@2022|The Banshees of Inisherin@2022|Elvis@2022|The Fabelmans@2022|Tár@2022|Top Gun: Maverick@2022|Triangle of Sadness@2022|Women Talking@2022|Oppenheimer@2023|American Fiction@2023|Anatomy of a Fall@2023|Barbie@2023|The Holdovers@2023|Killers of the Flower Moon@2023|Maestro@2023|Past Lives@2023|Poor Things@2023|The Zone of Interest@2023|Anora@2024|The Brutalist@2024|A Complete Unknown@2024|Conclave@2024|Dune: Part Two@2024|Emilia Pérez@2024|I'm Still Here@2024|Nickel Boys@2024|The Substance@2024|Wicked@2024`) });
add(10, 'awarded-series', 'Award-Winning & Nominated Series', 'series', { kind: 'merge', parts: [
  { kind: 'titles', list: T('Breaking Bad','Better Call Saul','The Sopranos','The Wire','Mad Men','Game of Thrones','Succession','The Crown','Chernobyl','Band of Brothers','The Pacific','Fargo','True Detective','Westworld','The Handmaid\'s Tale','Veep','Barry','Fleabag','The Marvelous Mrs. Maisel','Ted Lasso','The Bear','Hacks','Shogun','Shōgun','Baby Reindeer','Beef','The White Lotus','Severance','Mr. Robot','Homeland','The Americans','Dexter','Six Feet Under','Lost','24','The West Wing','ER','Friday Night Lights','Boardwalk Empire','Deadwood','Rome','Curb Your Enthusiasm','Modern Family','Seinfeld','Frasier','Cheers','The Office','30 Rock','Parks and Recreation','Schitt\'s Creek','Watchmen','Euphoria','Atlanta','Killing Eve','Big Little Lies','The Queen\'s Gambit','Mare of Easttown','Sharp Objects','Normal People','Angels in America','John Adams','Olive Kitteridge','The People v. O.J. Simpson: American Crime Story','Dopesick','Station Eleven','Slow Horses','Andor','The Last of Us','House of the Dragon','Squid Game','The Diplomat','Reservation Dogs','Abbott Elementary','Only Murders in the Building','What We Do in the Shadows','Arrested Development','Girls','Silicon Valley','Orange Is the New Black','House of Cards','Stranger Things','Ozark','Peaky Blinders','The Leftovers','Rectify','Halt and Catch Fire','Justified','Sons of Anarchy','The Shield','Oz','Treme','Generation Kill','Show Me a Hero','Big Little Lies','Succession') },
  { kind: 'discover', path: '/discover/tv', pages: 4, params: () => ({ sort_by: 'vote_average.desc', 'vote_count.gte': 1500, without_genres: '10767,10764,10763' }) }
] });

// 11
add(11, 'wwe', 'WWE Premium Live Events', 'movie', { kind: 'search', queries: [
  'WWE WrestleMania', 'WWE Royal Rumble', 'WWE SummerSlam', 'WWE Survivor Series', 'WWE Money in the Bank', 'WWE Elimination Chamber',
  'WWE Hell in a Cell', 'WWE Backlash', 'WWE Clash at the Castle', 'WWE Crown Jewel', 'WWE Night of Champions', 'WWE Extreme Rules',
  'WWE Fastlane', 'WWE Payback', 'WWE Bad Blood', 'WWE Saturday Night\'s Main Event', 'WWE Tables Ladders Chairs', 'WWE Summerslam', 'WWE King and Queen of the Ring'],
  filter: /\b(WWE|WWF)\b.*\b(WrestleMania|Royal Rumble|SummerSlam|Survivor Series|Money in the Bank|Elimination Chamber|Hell in a Cell|Backlash|Clash at the Castle|Crown Jewel|Night of Champions|Extreme Rules|Fastlane|Payback|Bad Blood|Saturday Night|Tables|King and Queen|Judgment Day|Armageddon|Vengeance|No Mercy|Unforgiven|SmackDown|Bash in Berlin|Clash in Paris|Evolution)/i,
  sort: 'date' });

// 12, 13, 14
add(12, 'adult-animation', 'Adult Comedy Animation', 'series', { kind: 'merge', parts: [
  { kind: 'titles', list: T('The Simpsons','South Park','Family Guy','Futurama','American Dad!','King of the Hill','Bob\'s Burgers','Rick and Morty','BoJack Horseman','Archer','Big Mouth','Solar Opposites','Harley Quinn','Disenchantment','Krapopolis','Beavis and Butt-Head','Daria','Aqua Teen Hunger Force','Robot Chicken','Venture Bros.','The Boondocks','Metalocalypse','Drawn Together','Sealab 2021','Home Movies','Dr. Katz, Professional Therapist','The Critic','Mike Tyson Mysteries','Bordertown','Brickleberry','Paradise PD','F is for Family','Undone','Tuca & Bertie','Central Park','Hazbin Hotel','Helluva Boss','Invincible','Castlevania','Love, Death & Robots','Close Enough','Final Space','Blue Eye Samurai','Primal','Cleopatra in Space','Smiling Friends','The Cleveland Show','Black Dynamite','Rick and Morty: The Anime','Q-Force','Mr. Pickles','Superjail!','Squidbillies','Moral Orel','Tripping the Rift','Duncanville','Bless the Harts','Dead End: Paranormal Park','Birdgirl','Common Side Effects','The Great North','Hit-Monkey','Bob\'s Burgers','Housebroken','Koala Man','Ren & Stimpy','The Ren & Stimpy Show','Teenage Euthanasia','Rick and Morty') },
  { kind: 'discover', path: '/discover/tv', pages: 5, params: () => ({ sort_by: 'vote_count.desc', with_genres: `${GENRE.animation},${GENRE.comedy}`, without_genres: '10762,10751', 'vote_count.gte': 120, with_original_language: 'en' }) }
] });
add(13, 'impractical', 'Shows Like Impractical Jokers', 'series', { kind: 'merge', parts: [
  { kind: 'titles', list: T('Impractical Jokers','Impractical Jokers: After Party','Impractical Jokers: Dinner Party','Impractical Jokers: Inside Jokes','Punk\'d','Just for Laughs Gags','Candid Camera','Trigger Happy TV','Tosh.0','Ridiculousness','Whose Line Is It Anyway?','Nathan for You','Jackass','Wildboyz','Viva La Bam','Billy on the Street','Wild \'N Out','The Eric Andre Show','Taskmaster','Hot Ones','Drunk History','Lip Sync Battle','Pranked','Scare Tactics','Fear Factor','Boiling Point','Dirty Rotten Cheater','The Jokers','Just for Laughs: All Access','Rob Dyrdek\'s Fantasy Factory','Dude, What Would Happen','Fantasy Factory','Tom Green Show','The Tom Green Show','Comedy Bang! Bang!','Key & Peele','I Think You Should Leave with Tim Robinson','Tim and Eric Awesome Show, Great Job!','Tom Goes to the Mayor','The Rehearsal','Inside Amy Schumer','Reno 911!','Impractical Jokers: Hall of Shame','Just Kidding','What Would You Do?','Carpool Karaoke: The Series','Ridiculousness','Wipeout','Takeshi\'s Castle','MXC','Most Extreme Elimination Challenge','Walk the Prank','Prank Encounters','Revenge Prank','Prank Academy','The Prank Show') },
  { kind: 'similar', seeds: ['Impractical Jokers','Punk\'d','Whose Line Is It Anyway?','Wild \'N Out','Jackass','Tosh.0','Ridiculousness','Nathan for You','Taskmaster'], max: 80, minVotes: 40 }
] });
add(14, 'comedy-central', 'Comedy Central Shows', 'series', { kind: 'discover', path: '/discover/tv', params: () => ({ sort_by: 'vote_count.desc', with_networks: NETWORK.COMEDY_CENTRAL }) });

// 15..20
add(15, 'wizarding', 'Wizarding World, Middle-earth & Fantasy Sagas', 'movie', { kind: 'collections', names: [
  'Harry Potter Collection','Fantastic Beasts Collection','The Lord of the Rings Collection','The Hobbit Collection','The Chronicles of Narnia Collection',
  'The Hunger Games Collection','Pirates of the Caribbean Collection','Percy Jackson Collection','The Twilight Collection','The Maze Runner Collection','Divergent Collection',
  'The Golden Compass Collection','Eragon Collection','How to Train Your Dragon Collection','Shrek Collection','Dune Collection','Star Wars Collection','Willow Collection','Stardust Collection','Maleficent Collection'] });
add(16, 'spy', 'Spy & Espionage Movies', 'movie', { kind: 'discover', path: '/discover/movie', keywords: ['spy', 'espionage', 'secret agent'], params: () => ({
  sort_by: 'vote_count.desc', 'vote_count.gte': 800 }) });
add(17, 'superhero-series', 'Superhero TV Series', 'series', { kind: 'merge', parts: [
  { kind: 'titles', list: T('Arrow','The Flash','Supergirl','DC\'s Legends of Tomorrow','Batwoman','Superman & Lois','Black Lightning','Stargirl','Smallville','Gotham','Titans','Doom Patrol','Peacemaker','Pennyworth','Krypton','Lois & Clark: The New Adventures of Superman','Wonder Woman','Batman','Birds of Prey','Swamp Thing','Constantine','Lucifer','The Sandman','Gen V','The Boys','The Boys Presents: Diabolical','Invincible','Daredevil','Jessica Jones','Luke Cage','Iron Fist','The Punisher','The Defenders','Agents of S.H.I.E.L.D.','Agent Carter','Inhumans','Runaways','Cloak & Dagger','The Gifted','Legion','Helstrom','WandaVision','Loki','The Falcon and the Winter Soldier','Hawkeye','Moon Knight','Ms. Marvel','She-Hulk: Attorney at Law','Secret Invasion','Echo','Agatha All Along','Daredevil: Born Again','Ironheart','Wonder Man','Watchmen','The Umbrella Academy','Heroes','Heroes Reborn','Misfits','The Tick','Powerless','Jupiter\'s Legacy','No Ordinary Family','Sky High','Mystery Men','Hancock','My Hero Academia','One-Punch Man','Mob Psycho 100','Batman: The Animated Series','Superman: The Animated Series','X-Men: The Animated Series','X-Men \'97','Spider-Man: The Animated Series','Spider-Man','Young Justice','Teen Titans','Teen Titans Go!','Justice League','Justice League Unlimited','Batman Beyond','The Batman','Beware the Batman','Harley Quinn','What If...?','Marvel\'s Moon Girl and Devil Dinosaur','Your Friendly Neighborhood Spider-Man','Batman: Caped Crusader','My Adventures with Superman','Ultimate Spider-Man','Avengers Assemble','The Avengers: Earth\'s Mightiest Heroes','Guardians of the Galaxy','Hit-Monkey','Kite Man: Hell Yeah!','Creature Commandos','Harley Quinn','The Incredible Hulk','The Amazing Spider-Man','Captain America','The Adventures of Superman','Adventures of Superman','Super Friends') },
  { kind: 'discover', path: '/discover/tv', pages: 4, keywords: ['superhero'], params: () => ({ sort_by: 'vote_count.desc', 'vote_count.gte': 25 }) }
] });
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
add(27, 'world', 'The World Beyond Hollywood', 'movie', { kind: 'discoverMulti', path: '/discover/movie', pages: 2, sort: 'rating',
  base: () => ({ sort_by: 'vote_average.desc', 'vote_count.gte': 700 }),
  variants: ['fr','es','ja','ko','hi','de','it','zh','cn','pt','sv','da','fa','ru','tr','ar','th','pl','el','he','id','nl','no','fi','cs','hu','ta','te','ml','bn','ro','uk','vi','tl'].map(l => ({ with_original_language: l })) });
add(28, 'hbo', 'HBO Prestige Collection', 'series', { kind: 'discover', path: '/discover/tv', params: () => ({
  sort_by: 'vote_average.desc', with_networks: NETWORK.HBO, 'vote_count.gte': 500 }) });
add(30, 'showtime', 'SHOWTIME Prestige Collection', 'series', { kind: 'discover', path: '/discover/tv', params: () => ({
  sort_by: 'vote_average.desc', with_networks: NETWORK.SHOWTIME, 'vote_count.gte': 300 }) });

// 32 : animated comedy for grown-ups on the big screen (franchise spin-offs and beyond)
add(32, 'adult-animation-movies', 'Adult Comedy Animation Movies', 'movie', { kind: 'merge', parts: [
  { kind: 'titles', list: Y("The Simpsons Movie@2007|South Park: Bigger, Longer & Uncut@1999|South Park: Post COVID@2021|South Park: Post COVID: The Return of COVID@2021|Family Guy Presents: Stewie Griffin: The Untold Story@2005|Family Guy Presents: It's a Trap!@2010|Family Guy Presents: Blue Harvest@2007|Beavis and Butt-Head Do America@1996|Beavis and Butt-Head Do the Universe@2022|Futurama: Bender's Big Score@2007|Futurama: The Beast with a Billion Backs@2008|Futurama: Bender's Game@2008|Futurama: Into the Wild Green Yonder@2009|The Bob's Burgers Movie@2022|Sausage Party@2016|Anomalisa@2015|Fritz the Cat@1972|Heavy Metal@1981|Heavy Metal 2000@2000|Wizards@1977|Fantastic Planet@1973|Waking Life@2001|Mary and Max@2009|Team America: World Police@2004|Allegro non troppo@1976|The Triplets of Belleville@2003|Mad God@2021|Anomalisa@2015") },
  { kind: 'discover', path: '/discover/movie', pages: 4, params: () => ({ sort_by: 'vote_count.desc', with_genres: `${GENRE.animation},${GENRE.comedy}`, without_genres: '10751,10762', 'vote_count.gte': 150 }) }
] });

// 35 / 36 : best-of-all-time stand-up
add(35, 'best-standup-movies', 'Best Stand-Up Comedy of All Time (Specials)', 'movie', { kind: 'merge', parts: [
  { kind: 'titles', list: Y(STANDUP_SPECIALS) },
  { kind: 'discover', path: '/discover/movie', pages: 5, strict: true, keywordMatch: ['stand-up', 'stand up', 'standup'], params: () => ({ sort_by: 'vote_average.desc', 'vote_count.gte': 150, with_genres: GENRE.comedy }) }
] });
add(36, 'best-standup-series', 'Best Stand-Up Comedy of All Time (Series)', 'series', { kind: 'merge', parts: [
  { kind: 'titles', list: T('Comedy Central Presents','Last Comic Standing','Live at the Apollo','Def Comedy Jam','Comedians in Cars Getting Coffee','Stand-Up Revolution','The Standups','Comedy Store','Gotham Comedy Live','Inside Amy Schumer','Mr. Show with Bob and David','Louie','Lady Dynamite','Crashing','Russell Howard\'s Good News','Michael McIntyre\'s Big Show','Mock the Week','8 Out of 10 Cats','Roast Battle','Comedy Central Roast','Insomniac with Dave Attell','Comedy Underground with Dave Attell','Dave Chappelle\'s Chappelle\'s Show','Chappelle\'s Show','The Daily Show','Last Week Tonight with John Oliver','Saturday Night Live','Whose Line Is It Anyway?','Showtime at the Apollo','Kevin Hart: Don\'t F**k This Up','Kevin Hart Presents: Hart of the City','Hart of the City','Jerry Seinfeld: Comedians in Cars Getting Coffee','Comics Unleashed with Byron Allen','Byron Allen Comedy Presents','Evening at the Improv','An Evening at the Improv','Premium Blend','Comedy Central Stand-Up Presents','Comedy Central\'s Stand-Up Presents','The Half Hour','Live from the Comedy Store','Cedric the Entertainer Presents','John Mulaney Presents: Everybody\'s in LA','Taskmaster','Would I Lie to You?','QI','Have I Got News for You','The Jim Jefferies Show','Real Time with Bill Maher','The Comedy Lineup','Netflix Presents: The Characters','The Comedy Get Down','Stand Up Planet','The Comic Strip Presents','Bob Newhart Show') },
  { kind: 'discover', path: '/discover/tv', pages: 3, strict: true, keywordMatch: ['stand-up', 'stand up', 'standup'], params: () => ({ sort_by: 'vote_average.desc', 'vote_count.gte': 40 }) }
] });

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
const dedupe = rows => { const seen = new Set(); return rows.filter(r => r && !seen.has(r.id) && seen.add(r.id)); };

async function keywordIds(src) {
  const ids = new Set();
  for (const name of src.keywords || []) { const id = await t.keywordId(name); if (id) ids.add(id); }
  for (const frag of src.keywordMatch || []) {
    const r = await t.api('/search/keyword', { query: frag }, 7 * 86400e3);
    (r.results || []).filter(k => k.name.toLowerCase().includes(frag)).slice(0, 6).forEach(k => ids.add(k.id));
  }
  return [...ids];
}

// One TMDB discover page (raw rows). Optional keyword restriction.
async function discoverPage(src, def, page, paramsFn = src.params) {
  let params = paramsFn();
  if (src.keywords || src.keywordMatch) {
    const kw = await once('kw:' + def.id + JSON.stringify(src.keywords || src.keywordMatch), 7 * 86400e3, () => keywordIds(src));
    if (kw.length) params = { ...params, with_keywords: kw.join('|') };
    else if (src.strict) return []; // never fall back to unrelated titles
    else if (def.fallbackParams) params = def.fallbackParams();
  }
  const r = await t.api(src.path, { ...params, page, include_adult: false, language: 'en-US' }, TTL);
  return r.results || [];
}

// Loaders: each returns raw TMDB rows (movie or tv shaped).
const loaders = {
  async discover(src, type, def) {
    const pages = Array.from({ length: src.pages || 1 }, (_, i) => i + 1);
    const variants = [src.params, ...(src.more || [])]; // e.g. regular series + anime
    const noProviders = fn => () => { const { with_watch_providers, ...rest } = fn(); return rest; };
    const run = async fns => dedupe((await t.pool(fns.flatMap(fn => pages.map(p => [fn, p])), 4, ([fn, p]) => discoverPage(src, def, p, fn))).filter(Boolean).flat());
    let rows = await run(variants);
    // if the platform filter is too strict for this region, retry without it rather than show a thin row
    if (rows.length < 12 && variants.some(fn => 'with_watch_providers' in fn())) rows = await run(variants.map(noProviders));
    if (src.since) { const min = src.since(); rows = rows.filter(r => (r.release_date || r.first_air_date || '') >= min); }
    if (src.newestFirst) rows.sort((a, b) => (b.release_date || b.first_air_date || '').localeCompare(a.release_date || a.first_air_date || ''));
    return rows;
  },
  // One discover call per variant (e.g. per original language), merged and sorted.
  async discoverMulti(src, type, def) {
    const res = await t.pool(src.variants, 5, async v => {
      const pages = Array.from({ length: src.pages || 1 }, (_, i) => i + 1);
      return (await Promise.all(pages.map(p => t.api(src.path, { ...src.base(), ...v, page: p, include_adult: false, language: 'en-US' }, TTL)))).flatMap(r => r.results || []);
    });
    const rows = dedupe(res.filter(Boolean).flat());
    if (src.sort === 'rating') rows.sort((a, b) => (b.vote_average || 0) - (a.vote_average || 0));
    return rows;
  },
  async titles(src, type) {
    const found = await t.pool(src.list.filter(x => !x[2] || x[2] === type), 6, ([title, year]) => t.searchTitle(type, title, year));
    return dedupe(found);
  },
  // "Shows like X": TMDB recommendations + similar for each seed title.
  async similar(src, type) {
    const kind = type === 'movie' ? 'movie' : 'tv';
    const seeds = dedupe(await t.pool(src.seeds, 4, s => t.searchTitle(type, s)));
    const lists = await t.pool(seeds, 4, async s => {
      const [a, b] = await Promise.all([t.api(`/${kind}/${s.id}/recommendations`, {}, TTL), t.api(`/${kind}/${s.id}/similar`, {}, TTL)]);
      return [...(a.results || []), ...(b.results || [])];
    });
    const seedIds = new Set(seeds.map(s => s.id));
    const count = new Map(); const rows = new Map();
    lists.filter(Boolean).flat().forEach(r => { if (seedIds.has(r.id) || (src.minVotes && r.vote_count < src.minVotes)) return; count.set(r.id, (count.get(r.id) || 0) + 1); rows.set(r.id, r); });
    return [...rows.values()].sort((a, b) => count.get(b.id) - count.get(a.id) || b.vote_count - a.vote_count).slice(0, src.max || 60);
  },
  async director(src) {
    const r = await t.api(`/person/${src.personId}/movie_credits`, {}, TTL);
    return dedupe((r.crew || []).filter(c => c.job === 'Director' && c.release_date && c.vote_count > 200))
      .sort((a, b) => a.release_date.localeCompare(b.release_date));
  },
  // Collections looked up by name (robust to wrong ids); kept in franchise order, oldest film first within each.
  async collections(src) {
    const out = [];
    for (const name of src.names) {
      const s = await t.api('/search/collection', { query: name }, 7 * 86400e3);
      const hit = (s.results || [])[0]; if (!hit) continue;
      const c = await t.api(`/collection/${hit.id}`, {}, TTL);
      out.push(...(c.parts || []).filter(p => p.release_date).sort((a, b) => a.release_date.localeCompare(b.release_date)));
    }
    return dedupe(out);
  },
  async search(src) {
    const res = await t.pool(src.queries, 5, q => t.api('/search/movie', { query: q }, TTL));
    const rows = dedupe(res.filter(Boolean).flatMap(r => r.results || []).filter(r => src.filter.test(r.title)));
    if (src.sort === 'date') rows.sort((a, b) => (b.release_date || '').localeCompare(a.release_date || ''));
    return rows;
  },
  async merge(src, type, def) {
    const parts = await Promise.all(src.parts.map(p => loaders[p.kind](p, type, def).catch(() => [])));
    if (!src.interleave) return dedupe(parts.flat());
    // round-robin so every sub-list shows up near the top (not just the first one)
    const out = []; const max = Math.max(...parts.map(x => x.length));
    for (let i = 0; i < max; i++) for (const x of parts) if (x[i]) out.push(x[i]);
    return dedupe(out);
  }
};

async function fullList(def) {
  return once('list:' + def.id, TTL, async () => {
    const rows = await loaders[def.source.kind](def.source, def.type, def);
    let metas = await t.toMetas(def.type, rows);
    if (def.type === 'series' && def.source.kind !== 'discover') { // TVmaze fills curated titles TMDB missed
      const names = [];
      const collect = s => (s.kind === 'merge' ? s.parts.forEach(collect) : s.kind === 'titles' ? s.list.forEach(x => (!x[2] || x[2] === 'series') && names.push(x[0])) : 0);
      collect(def.source);
      const have = new Set(metas.map(m => m.name.toLowerCase()));
      const extra = (await t.pool(names.filter(n => !have.has(n.toLowerCase())), 4, n => tvmaze.findShow(n))).filter(Boolean);
      metas = [...metas, ...extra];
    }
    const seen = new Set(); const out = metas.filter(m => !seen.has(m.id) && seen.add(m.id));
    if (!out.length) memo.delete('list:' + def.id); // never keep an empty/failed result for 6 hours
    return out;
  });
}

// TVmaze answers instantly from its last good result (refreshing in the background) and, the very first
// time, waits at most `budgetMs`, so a slow TVmaze can never freeze a row.
const tvStore = new Map();
async function fromTvmaze(opts, budgetMs = 6000) {
  const key = JSON.stringify(opts);
  let e = tvStore.get(key); if (!e) { e = { val: null, exp: 0, p: null }; tvStore.set(key, e); }
  if ((!e.val || e.exp <= Date.now()) && !e.p) {
    e.p = tvmaze.webPremieres(opts)
      .then(v => { e.val = v; e.exp = Date.now() + (v.length ? TTL : 5 * 60e3); return v; })
      .catch(() => { e.exp = Date.now() + 60e3; return e.val || []; })
      .finally(() => { e.p = null; });
  }
  if (e.val) return e.val;
  return Promise.race([e.p, new Promise(r => setTimeout(() => r([]), budgetMs))]);
}

async function resolveRaw(def, skip = 0) {
  const src = def.source;
  if (src.kind === 'tvmaze') return (await fromTvmaze({ days: src.days, kind: src.mode, week: src.week }, 15000)).slice(skip, skip + 100);
  if (src.kind === 'discover' && src.also) { // TMDB list + TVmaze streaming premieres, merged newest first
    const [base, tv] = await Promise.all([fullList(def), fromTvmaze(src.also).catch(() => [])]);
    const seen = new Set();
    const all = [...tv, ...base].filter(m => !seen.has(m.id) && seen.add(m.id));
    all.sort((a, b) => (b._date || '').localeCompare(a._date || ''));
    return all.slice(skip, skip + 100);
  }
  if (src.kind === 'discover' && !src.pages) { // live, one TMDB page per Stremio page
    const limit = def.limit || Infinity; if (skip >= limit) return [];
    const tmdbPart = (async () => {
      let rows = await discoverPage(src, def, Math.floor(skip / PAGE) + 1);
      if (limit - skip < rows.length) rows = rows.slice(0, limit - skip);
      return t.toMetas(def.type, rows);
    })();
    const tvPart = src.also && skip === 0 ? fromTvmaze(src.also).catch(() => []) : Promise.resolve([]);
    const [tm, tv] = await Promise.all([tmdbPart, tvPart]);
    const seen = new Set(); return [...tv, ...tm].filter(m => !seen.has(m.id) && seen.add(m.id));
  }
  return (await fullList(def)).slice(skip, skip + 100);
}

async function resolve(def, skip = 0) { // internal sort field never leaves the addon
  return (await resolveRaw(def, skip)).map(({ _date, ...m }) => m);
}

// Pre-load every row in the background so the first Stremio visit is fast.
async function warm(defs) { for (const d of defs) { try { await resolve(d, 0); } catch { /* ignore */ } } }
module.exports = { resolve, warm };

};
'use strict';
const http = require('http');
const CATS = __req('catalogues');
const { resolve, warm } = __req('resolve');

const PORT = process.env.PORT || 7000;
const VERSION = '2026-10-18e';
const manifest = {
  id: 'community.reelvault',
  version: '1.1.0',
  name: 'ReelVault',
  description: 'Fresh weekly releases, prestige collections, director filmographies, Top 50 lists and cult comedy rows.',
  resources: ['catalog'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: [...CATS].sort((a, b) => a.n - b.n).map(c => ({
    type: c.type, id: c.id, name: `${String(c.n).padStart(2, '0')} · ${c.name}`,
    extra: [{ name: 'skip', isRequired: false }]
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
  if (path === '/health') return send(res, 200, { ok: true, version: VERSION, rows: CATS.length, tmdbKey: Boolean(process.env.TMDB_API_KEY) });
  if (path === '/diagnose') { // visit once after deploying: shows how many titles every row returns
    const rows = [];
    for (const c of [...CATS].sort((a, b) => a.n - b.n)) {
      try { const m = await resolve(c, 0); rows.push({ row: c.n, type: c.type, name: c.name, count: m.length, status: m.length ? 'ok' : 'EMPTY', first: m.slice(0, 5).map(x => `${x.name} (${x.releaseInfo || '?'})`) }); }
      catch (e) { rows.push({ row: c.n, type: c.type, name: c.name, count: 0, status: 'ERROR: ' + e.message }); }
    }
    return send(res, 200, { version: VERSION, empty: rows.filter(r => r.status !== 'ok').length, rows });
  }
  const nm = /^\/names\/([^/]+)$/.exec(path); // readable full list of one row, e.g. /names/rv-looney
  if (nm) {
    const def = CATS.find(c => c.id === nm[1]); if (!def) return send(res, 404, { error: 'unknown row id' });
    try { const all = []; for (let skip = 0; skip < 600; skip += 100) { const part = await resolve(def, skip); all.push(...part); if (part.length < 20) break; }
      return send(res, 200, { id: def.id, name: def.name, count: all.length, names: all.map((x, i) => `${i + 1}. ${x.name} (${x.releaseInfo || '?'})`) }); }
    catch (e) { return send(res, 200, { id: def.id, error: e.message }); }
  }
  const m = /^\/catalog\/(movie|series)\/([^/]+?)(?:\/([^/]+?))?\.json$/.exec(path);
  if (!m) return send(res, 404, { error: 'not found' });
  const def = CATS.find(c => c.id === m[2] && c.type === m[1]);
  if (!def) return send(res, 200, { metas: [] });
  const skip = /skip=(\d+)/.exec(m[3] || '');
  try {
    send(res, 200, { metas: await resolve(def, skip ? Number(skip[1]) : 0) }, { 'Cache-Control': 'public, max-age=300' });
  } catch (e) {
    console.error(def.id, e.message);
    send(res, 200, { metas: [] });
  }
});

if (require.main === module) {
  if (!process.env.TMDB_API_KEY) console.warn('WARNING: TMDB_API_KEY is not set - catalogues will be empty.');
  server.listen(PORT, () => { console.log(`ReelVault listening on :${PORT} (${manifest.catalogs.length} catalogues)`); if (process.env.TMDB_API_KEY) warm(CATS); });
}
module.exports = { server, manifest, resolve, CATS };
