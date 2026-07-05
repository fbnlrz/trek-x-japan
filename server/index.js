// TREK × Japan — server entry (type: trip-page, TREK >= 3.2.1).
// Built CommonJS, runs in an isolated child process; all host access via `ctx`.
//
// Collaboration model: this is a trip-scoped page, so `tripId` is always known
// (the client reads it from trek:context and passes it on every call). Trip
// planning data — checklist, budget, expenses, food tally, prefecture passport,
// collections and the weather location — is stored per TRIP and SHARED by all
// trip members; every trip-scoped route membership-checks the acting user with
// `ctx.trips.getById(tripId, userId)` before reading or writing. Genuinely
// personal things — IC-card balance, phrase favourites, display currency — stay
// keyed per USER.
const { definePlugin } = require('trek-plugin-sdk');

// ---------------------------------------------------------------------------
// Bundled datasets (shipped inside server/ — required at load, read-only).
// ---------------------------------------------------------------------------
const PHRASES = require('./data/nihongo-phrases.json');
const PREFECTURES = require('./data/prefectures.json');
const ETIQUETTE = require('./data/etiquette.json');
const GOMI = require('./data/gomi.json');
const MATSURI = require('./data/matsuri.json');
const SAKURA = require('./data/sakura.json');

const CHECKLIST_ITEMS = [
  { id: 'jr_pass', en: 'JR Pass ordered / activated', de: 'JR Pass bestellt / aktiviert', group: 'docs' },
  { id: 'passport', en: 'Passports valid 6+ months', de: 'Reisepässe 6+ Monate gültig', group: 'docs' },
  { id: 'visit_japan_web', en: 'Visit Japan Web registered', de: 'Visit Japan Web registriert', group: 'docs' },
  { id: 'travel_insurance', en: 'Travel insurance booked', de: 'Reiseversicherung gebucht', group: 'docs' },
  { id: 'pocket_wifi', en: 'Pocket WiFi reserved', de: 'Pocket-WiFi reserviert', group: 'connectivity' },
  { id: 'esim', en: 'eSIMs installed', de: 'eSIMs installiert', group: 'connectivity' },
  { id: 'ic_card_app', en: 'IC cards (Suica/Pasmo) in wallet apps', de: 'IC-Karten (Suica/Pasmo) in Wallet-Apps', group: 'connectivity' },
  { id: 'cash', en: 'Cash / yen withdrawn', de: 'Bargeld / Yen abgehoben', group: 'money' },
  { id: 'adapter', en: 'Type A power adapters', de: 'Typ-A Stromadapter', group: 'gear' },
  { id: 'power_bank', en: 'Power banks charged', de: 'Powerbanks geladen', group: 'gear' },
  { id: 'meds', en: 'Medication + prescription copies', de: 'Medikamente + Rezeptkopien', group: 'gear' },
  { id: 'shoes', en: 'Comfortable walking shoes (easy off)', de: 'Bequeme Schuhe (leicht auszuziehen)', group: 'gear' },
  { id: 'translation_app', en: 'Offline translation app', de: 'Offline-Übersetzungs-App', group: 'connectivity' },
  { id: 'maps_offline', en: 'Offline maps downloaded', de: 'Offline-Karten geladen', group: 'connectivity' },
  { id: 'reservations', en: 'Key reservations (ryokan, restaurants)', de: 'Wichtige Reservierungen (Ryokan, Restaurants)', group: 'docs' },
  { id: 'trash_bag', en: 'Small bag for your trash', de: 'Kleiner Beutel für Müll', group: 'gear' },
];

const EMERGENCY_PHRASE_CATEGORY = 'emergency';

const USER_PREF_KEYS = ['home_currency', 'low_ic_threshold', 'ic_card'];
const USER_PREF_DEFAULTS = { home_currency: 'EUR', low_ic_threshold: '1000' };
const TRIP_PREF_KEYS = ['weather_lat', 'weather_lon', 'weather_city'];

const CURRENCY_SYMBOL = { EUR: '€', USD: '$', GBP: '£', CHF: 'Fr.' };

const FX_TTL = 6 * 60 * 60 * 1000;
const WEATHER_TTL = 30 * 60 * 1000;
const QUAKE_TTL = 15 * 60 * 1000;
const FETCH_TIMEOUT = 8000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function json(status, obj, cacheControl) {
  const headers = { 'content-type': 'application/json' };
  if (cacheControl) headers['cache-control'] = cacheControl;
  return { status, headers, body: JSON.stringify(obj) };
}
function nowIso() { return new Date().toISOString(); }
function toNum(v, fallback) { const n = typeof v === 'number' ? v : parseFloat(v); return Number.isFinite(n) ? n : fallback; }
function requireUser(req) {
  const id = req.user && req.user.id;
  if (id == null) { const e = new Error('no user'); e.status = 401; throw e; }
  return id;
}
async function readBody(req) {
  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch (_) { b = {}; } }
  return b && typeof b === 'object' ? b : {};
}
function getTripIdFromQuery(req) {
  const raw = req.query && (req.query.tripId != null ? req.query.tripId : req.query.trip_id);
  return toNum(raw, null);
}

// Membership gate for every SHARED, trip-scoped route. Returns the trip so the
// handler can also use its dates/title; throws 403 if the acting user is not a
// member (ctx.trips is membership-checked by the host).
async function requireTrip(req, ctx, bodyTripId) {
  const userId = requireUser(req);
  const tripId = bodyTripId != null ? toNum(bodyTripId, null) : getTripIdFromQuery(req);
  if (tripId == null) { const e = new Error('tripId required'); e.status = 400; throw e; }
  let trip;
  try { trip = await ctx.trips.getById(tripId, userId); }
  catch (e) { const err = new Error('not a member of this trip'); err.status = 403; throw err; }
  if (!trip) { const err = new Error('trip not found'); err.status = 404; throw err; }
  return { userId, tripId, trip };
}

// cache
async function cacheGet(ctx, key) {
  const rows = await ctx.db.query('SELECT json, fetched_at FROM cache WHERE key = ?', key);
  if (!rows.length) return null;
  let parsed = null; try { parsed = JSON.parse(rows[0].json); } catch (_) {}
  return { data: parsed, fetched_at: rows[0].fetched_at };
}
async function cacheSet(ctx, key, data) {
  const at = nowIso();
  await ctx.db.exec('INSERT INTO cache(key, json, fetched_at) VALUES(?, ?, ?) ON CONFLICT(key) DO UPDATE SET json = excluded.json, fetched_at = excluded.fetched_at', key, JSON.stringify(data), at);
  return at;
}
function isStale(entry, ttl) {
  if (!entry || !entry.fetched_at) return true;
  const t = Date.parse(entry.fetched_at);
  return !Number.isFinite(t) || (Date.now() - t) > ttl;
}

// prefs
async function loadUserPrefs(ctx, userId) {
  const out = Object.assign({}, USER_PREF_DEFAULTS);
  for (const k of USER_PREF_KEYS) if (ctx.config && ctx.config[k] != null && ctx.config[k] !== '') out[k] = String(ctx.config[k]);
  const rows = await ctx.db.query('SELECT key, value FROM user_prefs WHERE user_id = ?', userId);
  for (const r of rows) if (USER_PREF_KEYS.includes(r.key)) out[r.key] = r.value;
  return out;
}
async function saveUserPref(ctx, userId, key, value) {
  await ctx.db.exec('INSERT INTO user_prefs(user_id, key, value) VALUES(?, ?, ?) ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value', userId, key, value == null ? '' : String(value));
}
async function loadTripPrefs(ctx, tripId) {
  const out = {};
  const rows = await ctx.db.query('SELECT key, value FROM trip_prefs WHERE trip_id = ?', tripId);
  for (const r of rows) if (TRIP_PREF_KEYS.includes(r.key)) out[r.key] = r.value;
  return out;
}
async function saveTripPref(ctx, tripId, key, value) {
  await ctx.db.exec('INSERT INTO trip_prefs(trip_id, key, value) VALUES(?, ?, ?) ON CONFLICT(trip_id, key) DO UPDATE SET value = excluded.value', tripId, key, value == null ? '' : String(value));
}

// Resolve user ids -> display names (co-members only; best-effort).
async function resolveNames(ctx, ids) {
  const uniq = Array.from(new Set(ids.filter(function (x) { return x != null; })));
  const map = {};
  for (const id of uniq) {
    try {
      const u = await ctx.users.getById(id);
      if (u) map[id] = u.display_name || u.username || ('#' + id);
      else map[id] = '#' + id;
    } catch (_) { map[id] = '#' + id; }
  }
  return map;
}

function coords(tripPrefs) {
  const lat = toNum(tripPrefs.weather_lat, null);
  const lon = toNum(tripPrefs.weather_lon, null);
  if (lat != null && lon != null) return { lat, lon };
  return null;
}

// remote refreshers
async function timedFetch(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT), headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error('http ' + res.status);
  return res.json();
}
async function refreshFx(ctx) {
  const raw = await timedFetch('https://open.er-api.com/v6/latest/JPY');
  const rates = (raw && raw.rates) || {};
  const data = { base: 'JPY', rates: { EUR: rates.EUR, USD: rates.USD, GBP: rates.GBP, CHF: rates.CHF }, source_updated: raw && (raw.time_last_update_utc || null) };
  return { data, fetched_at: await cacheSet(ctx, 'fx', data) };
}
async function refreshWeather(ctx, lat, lon, cacheKey) {
  const url = 'https://api.open-meteo.com/v1/forecast?latitude=' + encodeURIComponent(lat) + '&longitude=' + encodeURIComponent(lon)
    + '&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m'
    + '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&forecast_days=5&timezone=Asia%2FTokyo';
  const raw = await timedFetch(url);
  const data = {
    lat, lon,
    current: raw && raw.current ? { temp: raw.current.temperature_2m, humidity: raw.current.relative_humidity_2m, code: raw.current.weather_code, wind: raw.current.wind_speed_10m } : null,
    daily: raw && raw.daily && Array.isArray(raw.daily.time) ? raw.daily.time.map(function (d, i) {
      return { date: d, code: raw.daily.weather_code[i], tmax: raw.daily.temperature_2m_max[i], tmin: raw.daily.temperature_2m_min[i], pop: raw.daily.precipitation_probability_max ? raw.daily.precipitation_probability_max[i] : null };
    }) : [],
  };
  return { data, fetched_at: await cacheSet(ctx, cacheKey || 'weather', data) };
}
async function refreshQuake(ctx) {
  const raw = await timedFetch('https://www.jma.go.jp/bosai/quake/data/list.json');
  const list = Array.isArray(raw) ? raw.slice(0, 12) : [];
  const data = { items: list.map(function (q) { return { time: q.at || q.rdt || null, place: q.anm || q.en_anm || '', mag: q.mag != null ? q.mag : null, intensity: q.maxi || null }; }) };
  return { data, fetched_at: await cacheSet(ctx, 'quake', data) };
}

// dates
function dayOfYear(d) { const start = Date.UTC(d.getUTCFullYear(), 0, 0); return Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - start) / 86400000); }
function daysUntil(iso) {
  if (!iso) return null;
  const t = Date.parse(iso); if (!Number.isFinite(t)) return null;
  const today = new Date();
  return Math.round((t - Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())) / 86400000);
}
function tripDates(trip) {
  return { title: trip.title || trip.name || null, start: trip.start_date || trip.startDate || null, end: trip.end_date || trip.endDate || null };
}
function tripMonths(start, end) {
  if (!start) return null;
  const s = new Date(start); if (isNaN(s.getTime())) return null;
  const e = end ? new Date(end) : s; const ed = isNaN(e.getTime()) ? s : e;
  const months = new Set(); let y = s.getUTCFullYear(), m = s.getUTCMonth();
  const ey = ed.getUTCFullYear(), em = ed.getUTCMonth(); let guard = 0;
  while ((y < ey || (y === ey && m <= em)) && guard < 24) { months.add(m + 1); m++; if (m > 11) { m = 0; y++; } guard++; }
  return Array.from(months);
}

// shared IC adjust (personal)
async function icAdjust(req, ctx, kind) {
  const userId = requireUser(req);
  const body = await readBody(req);
  const amount = Math.max(0, Math.round(toNum(body.amount, 0)));
  if (!amount) return json(400, { error: 'amount required' });
  const b = await ctx.db.query('SELECT yen FROM ic_balance WHERE user_id = ?', userId);
  const cur = b.length ? b[0].yen : 0;
  const next = kind === 'charge' ? cur + amount : Math.max(0, cur - amount);
  const at = nowIso();
  await ctx.db.exec('INSERT INTO ic_balance(user_id, yen, updated_at) VALUES(?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET yen = excluded.yen, updated_at = excluded.updated_at', userId, next, at);
  await ctx.db.exec('INSERT INTO ic_ledger(user_id, kind, amount, balance_after, at) VALUES(?, ?, ?, ?, ?)', userId, kind, amount, next, at);
  return json(200, { yen: next, kind, amount });
}

// Wrap a route handler so thrown guard errors (requireUser/requireTrip) become
// clean HTTP responses instead of a PLUGIN_ERROR/502.
function wrapHandler(fn) {
  return async function (req, ctx) {
    try { return await fn(req, ctx); }
    catch (e) {
      const status = e && e.status ? e.status : 500;
      if (status >= 500) ctx.log.error('route error', { path: req.path, msg: String(e && e.message) });
      return json(status, { error: (e && e.message) || 'error' });
    }
  };
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------
const PLUGIN = {
  async onLoad(ctx) {
    // Trip-scoped (shared) tables
    await ctx.db.migrate('t001_checklist', 'CREATE TABLE IF NOT EXISTS checklist (trip_id INTEGER NOT NULL, item_id TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0, by_user INTEGER, at TEXT, PRIMARY KEY(trip_id, item_id))');
    await ctx.db.migrate('t002_budget', 'CREATE TABLE IF NOT EXISTS budget (trip_id INTEGER PRIMARY KEY, planned_yen INTEGER NOT NULL DEFAULT 0)');
    await ctx.db.migrate('t003_spend', 'CREATE TABLE IF NOT EXISTS spend (id INTEGER PRIMARY KEY, trip_id INTEGER NOT NULL, user_id INTEGER NOT NULL, amount_yen INTEGER NOT NULL, note TEXT, at TEXT)');
    await ctx.db.migrate('t004_food', 'CREATE TABLE IF NOT EXISTS food_tally (trip_id INTEGER NOT NULL, kind TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, at TEXT, PRIMARY KEY(trip_id, kind))');
    await ctx.db.migrate('t005_visited', 'CREATE TABLE IF NOT EXISTS visited_prefs (trip_id INTEGER NOT NULL, code TEXT NOT NULL, by_user INTEGER, at TEXT, PRIMARY KEY(trip_id, code))');
    await ctx.db.migrate('t006_collect', 'CREATE TABLE IF NOT EXISTS collect (trip_id INTEGER NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL, by_user INTEGER, at TEXT, PRIMARY KEY(trip_id, kind, key))');
    await ctx.db.migrate('t007_trip_prefs', 'CREATE TABLE IF NOT EXISTS trip_prefs (trip_id INTEGER NOT NULL, key TEXT NOT NULL, value TEXT, PRIMARY KEY(trip_id, key))');
    // User-scoped (personal) tables
    await ctx.db.migrate('u001_user_prefs', 'CREATE TABLE IF NOT EXISTS user_prefs (user_id INTEGER NOT NULL, key TEXT NOT NULL, value TEXT, PRIMARY KEY(user_id, key))');
    await ctx.db.migrate('u002_phrase_favs', 'CREATE TABLE IF NOT EXISTS phrase_favs (user_id INTEGER NOT NULL, phrase_id TEXT NOT NULL, at TEXT, PRIMARY KEY(user_id, phrase_id))');
    await ctx.db.migrate('u003_phrase_state', 'CREATE TABLE IF NOT EXISTS phrase_state (user_id INTEGER PRIMARY KEY, offset INTEGER NOT NULL DEFAULT 0)');
    await ctx.db.migrate('u004_ic_balance', 'CREATE TABLE IF NOT EXISTS ic_balance (user_id INTEGER PRIMARY KEY, yen INTEGER NOT NULL DEFAULT 0, updated_at TEXT)');
    await ctx.db.migrate('u005_ic_ledger', 'CREATE TABLE IF NOT EXISTS ic_ledger (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, kind TEXT NOT NULL, amount INTEGER NOT NULL, balance_after INTEGER NOT NULL, at TEXT)');
    // Global cache
    await ctx.db.migrate('g001_cache', 'CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, json TEXT, fetched_at TEXT)');
    ctx.log.info('TREK x Japan (trip-page) loaded');
  },

  async onUnload(ctx) { ctx.log.info('TREK x Japan unloading'); },

  // Declared for completeness; TREK has no cron runner (routes refresh caches
  // on demand with a staleness guard).
  jobs: [
    { id: 'fx-refresh', schedule: '0 */6 * * *', async handler(ctx) { try { await refreshFx(ctx); } catch (e) { ctx.log.error('fx job', { msg: String(e && e.message) }); } } },
    { id: 'quake-refresh', schedule: '*/15 * * * *', async handler(ctx) { try { await refreshQuake(ctx); } catch (e) { ctx.log.error('quake job', { msg: String(e && e.message) }); } } },
  ],

  routes: [
    // ---- meta + prefs -------------------------------------------------------
    { method: 'GET', path: '/meta', auth: true, async handler(req, ctx) {
      const { userId, trip } = await requireTrip(req, ctx);
      const td = tripDates(trip);
      const prefs = await loadUserPrefs(ctx, userId);
      return json(200, {
        me: { id: userId, name: (req.user && req.user.username) || null },
        trip: { title: td.title, start: td.start, end: td.end, days_until_start: daysUntil(td.start), days_until_end: daysUntil(td.end) },
        prefs, currency_symbol: CURRENCY_SYMBOL[prefs.home_currency] || prefs.home_currency,
        counts: { phrases: PHRASES.length, prefectures: PREFECTURES.length, etiquette: ETIQUETTE.length, gomi: GOMI.length, matsuri: MATSURI.length, sakura: SAKURA.length, checklist: CHECKLIST_ITEMS.length },
      });
    } },
    { method: 'GET', path: '/prefs', auth: true, async handler(req, ctx) {
      const { userId, tripId } = await requireTrip(req, ctx);
      return json(200, { prefs: await loadUserPrefs(ctx, userId), trip_prefs: await loadTripPrefs(ctx, tripId) });
    } },
    { method: 'POST', path: '/prefs', auth: true, async handler(req, ctx) {
      const body = await readBody(req);
      const { userId, tripId } = await requireTrip(req, ctx, body.tripId);
      const up = (body.prefs && typeof body.prefs === 'object') ? body.prefs : {};
      for (const k of USER_PREF_KEYS) if (Object.prototype.hasOwnProperty.call(up, k)) await saveUserPref(ctx, userId, k, up[k]);
      const tp = (body.trip_prefs && typeof body.trip_prefs === 'object') ? body.trip_prefs : {};
      for (const k of TRIP_PREF_KEYS) if (Object.prototype.hasOwnProperty.call(tp, k)) await saveTripPref(ctx, tripId, k, tp[k]);
      return json(200, { prefs: await loadUserPrefs(ctx, userId), trip_prefs: await loadTripPrefs(ctx, tripId) });
    } },

    // ---- 1. Countdown & shared checklist -----------------------------------
    { method: 'GET', path: '/checklist', auth: true, async handler(req, ctx) {
      const { trip, tripId } = await requireTrip(req, ctx);
      const td = tripDates(trip);
      const rows = await ctx.db.query('SELECT item_id, done, by_user, at FROM checklist WHERE trip_id = ?', tripId);
      const map = {}; rows.forEach(function (r) { map[r.item_id] = r; });
      const names = await resolveNames(ctx, rows.map(function (r) { return r.by_user; }));
      const items = CHECKLIST_ITEMS.map(function (it) {
        const r = map[it.id];
        return { id: it.id, en: it.en, de: it.de, group: it.group, done: !!(r && r.done), by: r && r.done ? (names[r.by_user] || null) : null };
      });
      return json(200, {
        trip: { title: td.title, start: td.start, end: td.end, days_until_start: daysUntil(td.start), days_until_end: daysUntil(td.end) },
        items, done: items.filter(function (i) { return i.done; }).length, total: items.length,
      });
    } },
    { method: 'POST', path: '/checklist/toggle', auth: true, async handler(req, ctx) {
      const body = await readBody(req);
      const { userId, tripId } = await requireTrip(req, ctx, body.tripId);
      const itemId = String(body.item_id || '');
      if (!CHECKLIST_ITEMS.some(function (i) { return i.id === itemId; })) return json(400, { error: 'unknown item' });
      const cur = await ctx.db.query('SELECT done FROM checklist WHERE trip_id = ? AND item_id = ?', tripId, itemId);
      const next = cur.length && cur[0].done ? 0 : 1;
      await ctx.db.exec('INSERT INTO checklist(trip_id, item_id, done, by_user, at) VALUES(?, ?, ?, ?, ?) ON CONFLICT(trip_id, item_id) DO UPDATE SET done = excluded.done, by_user = excluded.by_user, at = excluded.at', tripId, itemId, next, userId, nowIso());
      return json(200, { item_id: itemId, done: !!next });
    } },

    // ---- 2. Nihongo (personal) ---------------------------------------------
    { method: 'GET', path: '/nihongo/state', auth: true, async handler(req, ctx) {
      const userId = requireUser(req);
      const st = await ctx.db.query('SELECT offset FROM phrase_state WHERE user_id = ?', userId);
      const offset = st.length ? st[0].offset : 0;
      const idx = (((dayOfYear(new Date()) + offset) % PHRASES.length) + PHRASES.length) % PHRASES.length;
      const favRows = await ctx.db.query('SELECT phrase_id FROM phrase_favs WHERE user_id = ?', userId);
      return json(200, { phrase_of_day: PHRASES[idx], phrases: PHRASES, categories: Array.from(new Set(PHRASES.map(function (p) { return p.category; }))), favorites: favRows.map(function (r) { return r.phrase_id; }) });
    } },
    { method: 'POST', path: '/nihongo/next', auth: true, async handler(req, ctx) {
      const userId = requireUser(req);
      const st = await ctx.db.query('SELECT offset FROM phrase_state WHERE user_id = ?', userId);
      const offset = (st.length ? st[0].offset : 0) + 1;
      await ctx.db.exec('INSERT INTO phrase_state(user_id, offset) VALUES(?, ?) ON CONFLICT(user_id) DO UPDATE SET offset = excluded.offset', userId, offset);
      const idx = (((dayOfYear(new Date()) + offset) % PHRASES.length) + PHRASES.length) % PHRASES.length;
      return json(200, { phrase_of_day: PHRASES[idx] });
    } },
    { method: 'POST', path: '/nihongo/favorite', auth: true, async handler(req, ctx) {
      const userId = requireUser(req);
      const body = await readBody(req);
      const pid = String(body.phrase_id || '');
      if (!PHRASES.some(function (p) { return p.id === pid; })) return json(400, { error: 'unknown phrase' });
      const cur = await ctx.db.query('SELECT phrase_id FROM phrase_favs WHERE user_id = ? AND phrase_id = ?', userId, pid);
      let faved;
      if (cur.length) { await ctx.db.exec('DELETE FROM phrase_favs WHERE user_id = ? AND phrase_id = ?', userId, pid); faved = false; }
      else { await ctx.db.exec('INSERT INTO phrase_favs(user_id, phrase_id, at) VALUES(?, ?, ?)', userId, pid, nowIso()); faved = true; }
      return json(200, { phrase_id: pid, favorite: faved });
    } },

    // ---- 3. Culture & gomi (local) -----------------------------------------
    { method: 'GET', path: '/etiquette', auth: true, async handler(req, ctx) {
      return json(200, { items: ETIQUETTE, categories: Array.from(new Set(ETIQUETTE.map(function (e) { return e.category; }))) }, 'max-age=3600');
    } },
    { method: 'GET', path: '/gomi', auth: true, async handler(req, ctx) {
      const q = String((req.query && (req.query.q || req.query.query)) || '').trim().toLowerCase();
      let items = GOMI;
      if (q) items = GOMI.filter(function (g) {
        return (g.item_en && g.item_en.toLowerCase().includes(q)) || (g.item_de && g.item_de.toLowerCase().includes(q)) || (g.bin_en && g.bin_en.toLowerCase().includes(q)) || (g.bin_de && g.bin_de.toLowerCase().includes(q));
      });
      return json(200, { items, total: GOMI.length, query: q });
    } },

    // ---- 4. Shared budget ---------------------------------------------------
    { method: 'GET', path: '/budget/state', auth: true, async handler(req, ctx) {
      const { userId, tripId } = await requireTrip(req, ctx);
      const prefs = await loadUserPrefs(ctx, userId);
      const b = await ctx.db.query('SELECT planned_yen FROM budget WHERE trip_id = ?', tripId);
      const planned = b.length ? b[0].planned_yen : 0;
      const spends = await ctx.db.query('SELECT id, user_id, amount_yen, note, at FROM spend WHERE trip_id = ? ORDER BY id DESC LIMIT 100', tripId);
      const totalRows = await ctx.db.query('SELECT COALESCE(SUM(amount_yen),0) AS s FROM spend WHERE trip_id = ?', tripId);
      const spent = totalRows.length ? totalRows[0].s : 0;
      const names = await resolveNames(ctx, spends.map(function (s) { return s.user_id; }));
      let fx = await cacheGet(ctx, 'fx');
      if (isStale(fx, FX_TTL)) { try { fx = await refreshFx(ctx); } catch (e) { ctx.log.warn('fx', { msg: String(e && e.message) }); } }
      const rate = fx && fx.data && fx.data.rates ? fx.data.rates[prefs.home_currency] : null;
      return json(200, {
        planned_yen: planned, spent_yen: spent, remaining_yen: planned - spent,
        spends: spends.map(function (s) { return { id: s.id, amount_yen: s.amount_yen, note: s.note, at: s.at, by: names[s.user_id] || null }; }),
        currency: prefs.home_currency, currency_symbol: CURRENCY_SYMBOL[prefs.home_currency] || prefs.home_currency,
        rate, fx_fetched_at: fx ? fx.fetched_at : null,
        planned_home: rate != null ? planned * rate : null, spent_home: rate != null ? spent * rate : null, remaining_home: rate != null ? (planned - spent) * rate : null,
      });
    } },
    { method: 'POST', path: '/budget/plan', auth: true, async handler(req, ctx) {
      const body = await readBody(req);
      const { tripId } = await requireTrip(req, ctx, body.tripId);
      const yen = Math.max(0, Math.round(toNum(body.planned_yen, 0)));
      await ctx.db.exec('INSERT INTO budget(trip_id, planned_yen) VALUES(?, ?) ON CONFLICT(trip_id) DO UPDATE SET planned_yen = excluded.planned_yen', tripId, yen);
      return json(200, { planned_yen: yen });
    } },
    { method: 'POST', path: '/budget/spend', auth: true, async handler(req, ctx) {
      const body = await readBody(req);
      const { userId, tripId } = await requireTrip(req, ctx, body.tripId);
      const amount = Math.round(toNum(body.amount_yen, 0));
      if (!amount) return json(400, { error: 'amount required' });
      await ctx.db.exec('INSERT INTO spend(trip_id, user_id, amount_yen, note, at) VALUES(?, ?, ?, ?, ?)', tripId, userId, amount, String(body.note || '').slice(0, 200), nowIso());
      const totalRows = await ctx.db.query('SELECT COALESCE(SUM(amount_yen),0) AS s FROM spend WHERE trip_id = ?', tripId);
      return json(200, { spent_yen: totalRows[0].s });
    } },
    { method: 'GET', path: '/fx', auth: true, async handler(req, ctx) {
      const { userId } = await requireTrip(req, ctx);
      const prefs = await loadUserPrefs(ctx, userId);
      let fx = await cacheGet(ctx, 'fx');
      if (isStale(fx, FX_TTL)) { try { fx = await refreshFx(ctx); } catch (e) { ctx.log.warn('fx', { msg: String(e && e.message) }); } }
      const rate = fx && fx.data && fx.data.rates ? fx.data.rates[prefs.home_currency] : null;
      return json(200, { base: 'JPY', currency: prefs.home_currency, symbol: CURRENCY_SYMBOL[prefs.home_currency] || prefs.home_currency, rate, rates: fx && fx.data ? fx.data.rates : null, per_1000_yen: rate != null ? 1000 * rate : null, fetched_at: fx ? fx.fetched_at : null, source_updated: fx && fx.data ? fx.data.source_updated : null });
    } },

    // ---- 5. IC card (personal) ---------------------------------------------
    { method: 'GET', path: '/ic/state', auth: true, async handler(req, ctx) {
      const userId = requireUser(req);
      const prefs = await loadUserPrefs(ctx, userId);
      const b = await ctx.db.query('SELECT yen, updated_at FROM ic_balance WHERE user_id = ?', userId);
      const yen = b.length ? b[0].yen : 0;
      const ledger = await ctx.db.query('SELECT id, kind, amount, balance_after, at FROM ic_ledger WHERE user_id = ? ORDER BY id DESC LIMIT 50', userId);
      const threshold = Math.round(toNum(prefs.low_ic_threshold, 1000));
      return json(200, { yen, updated_at: b.length ? b[0].updated_at : null, card: prefs.ic_card || null, low_threshold: threshold, low: yen < threshold, ledger });
    } },
    { method: 'POST', path: '/ic/charge', auth: true, async handler(req, ctx) { return icAdjust(req, ctx, 'charge'); } },
    { method: 'POST', path: '/ic/spend', auth: true, async handler(req, ctx) { return icAdjust(req, ctx, 'spend'); } },
    { method: 'POST', path: '/ic/set', auth: true, async handler(req, ctx) {
      const userId = requireUser(req);
      const body = await readBody(req);
      const yen = Math.max(0, Math.round(toNum(body.yen, 0)));
      const at = nowIso();
      await ctx.db.exec('INSERT INTO ic_balance(user_id, yen, updated_at) VALUES(?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET yen = excluded.yen, updated_at = excluded.updated_at', userId, yen, at);
      await ctx.db.exec('INSERT INTO ic_ledger(user_id, kind, amount, balance_after, at) VALUES(?, ?, ?, ?, ?)', userId, 'set', yen, yen, at);
      return json(200, { yen });
    } },

    // ---- 6. Shared food, passport & collections ----------------------------
    { method: 'GET', path: '/collect/state', auth: true, async handler(req, ctx) {
      const { tripId } = await requireTrip(req, ctx);
      const food = await ctx.db.query('SELECT kind, count FROM food_tally WHERE trip_id = ?', tripId);
      const foodMap = {}; food.forEach(function (f) { foodMap[f.kind] = f.count; });
      const visited = await ctx.db.query('SELECT code, by_user FROM visited_prefs WHERE trip_id = ?', tripId);
      const col = await ctx.db.query('SELECT kind, key, by_user, at FROM collect WHERE trip_id = ? ORDER BY at DESC', tripId);
      const names = await resolveNames(ctx, visited.map(function (v) { return v.by_user; }).concat(col.map(function (c) { return c.by_user; })));
      const collections = { onsen: [], goshuin: [], 'eki-stamp': [] };
      col.forEach(function (c) { if (!collections[c.kind]) collections[c.kind] = []; collections[c.kind].push({ key: c.key, at: c.at, by: names[c.by_user] || null }); });
      return json(200, {
        food: foodMap, prefectures: PREFECTURES,
        visited: visited.map(function (v) { return v.code; }),
        visited_by: visited.reduce(function (acc, v) { acc[v.code] = names[v.by_user] || null; return acc; }, {}),
        collections,
      });
    } },
    { method: 'POST', path: '/food/inc', auth: true, async handler(req, ctx) {
      const body = await readBody(req);
      const { tripId } = await requireTrip(req, ctx, body.tripId);
      const kind = String(body.kind || '').slice(0, 40);
      if (!kind) return json(400, { error: 'kind required' });
      const delta = Math.trunc(toNum(body.delta, 1)) || 1;
      const cur = await ctx.db.query('SELECT count FROM food_tally WHERE trip_id = ? AND kind = ?', tripId, kind);
      const next = Math.max(0, (cur.length ? cur[0].count : 0) + delta);
      await ctx.db.exec('INSERT INTO food_tally(trip_id, kind, count, at) VALUES(?, ?, ?, ?) ON CONFLICT(trip_id, kind) DO UPDATE SET count = excluded.count, at = excluded.at', tripId, kind, next, nowIso());
      return json(200, { kind, count: next });
    } },
    { method: 'POST', path: '/prefectures/toggle', auth: true, async handler(req, ctx) {
      const body = await readBody(req);
      const { userId, tripId } = await requireTrip(req, ctx, body.tripId);
      const code = String(body.code || '');
      if (!PREFECTURES.some(function (p) { return p.code === code; })) return json(400, { error: 'unknown prefecture' });
      const cur = await ctx.db.query('SELECT code FROM visited_prefs WHERE trip_id = ? AND code = ?', tripId, code);
      let visited;
      if (cur.length) { await ctx.db.exec('DELETE FROM visited_prefs WHERE trip_id = ? AND code = ?', tripId, code); visited = false; }
      else { await ctx.db.exec('INSERT INTO visited_prefs(trip_id, code, by_user, at) VALUES(?, ?, ?, ?)', tripId, code, userId, nowIso()); visited = true; }
      const cnt = await ctx.db.query('SELECT COUNT(*) AS n FROM visited_prefs WHERE trip_id = ?', tripId);
      return json(200, { code, visited, total_visited: cnt[0].n });
    } },
    { method: 'POST', path: '/collect/add', auth: true, async handler(req, ctx) {
      const body = await readBody(req);
      const { userId, tripId } = await requireTrip(req, ctx, body.tripId);
      const kind = String(body.kind || '');
      const key = String(body.key || '').trim().slice(0, 120);
      if (!['onsen', 'goshuin', 'eki-stamp'].includes(kind)) return json(400, { error: 'unknown kind' });
      if (!key) return json(400, { error: 'key required' });
      const cur = await ctx.db.query('SELECT key FROM collect WHERE trip_id = ? AND kind = ? AND key = ?', tripId, kind, key);
      let added;
      if (cur.length) { await ctx.db.exec('DELETE FROM collect WHERE trip_id = ? AND kind = ? AND key = ?', tripId, kind, key); added = false; }
      else { await ctx.db.exec('INSERT INTO collect(trip_id, kind, key, by_user, at) VALUES(?, ?, ?, ?, ?)', tripId, kind, key, userId, nowIso()); added = true; }
      return json(200, { kind, key, added });
    } },

    // ---- 7. Season & events -------------------------------------------------
    { method: 'GET', path: '/season', auth: true, async handler(req, ctx) {
      const { trip, tripId } = await requireTrip(req, ctx);
      const td = tripDates(trip);
      const months = tripMonths(td.start, td.end);
      const visited = await ctx.db.query('SELECT code FROM visited_prefs WHERE trip_id = ?', tripId);
      const visitedSet = new Set(visited.map(function (v) { return v.code; }));
      const matsuri = MATSURI.map(function (m) { return Object.assign({}, m, { in_window: months == null ? false : months.includes(m.month), nearby: visitedSet.has(m.prefecture_code) }); })
        .sort(function (a, b) { return (Number(b.in_window) - Number(a.in_window)) || (Number(b.nearby) - Number(a.nearby)) || (a.month - b.month); });
      return json(200, { sakura: SAKURA, matsuri, trip_months: months, trip: { start: td.start, end: td.end } });
    } },

    // ---- 8. Safety & weather ------------------------------------------------
    { method: 'GET', path: '/safety', auth: true, async handler(req, ctx) {
      const { tripId } = await requireTrip(req, ctx);
      const tp = await loadTripPrefs(ctx, tripId);
      const c = coords(tp);
      let weatherKey = 'weather';
      if (c) weatherKey = 'weather:' + c.lat.toFixed(3) + ',' + c.lon.toFixed(3);
      let weather = c ? await cacheGet(ctx, weatherKey) : null;
      if (c && isStale(weather, WEATHER_TTL)) { try { weather = await refreshWeather(ctx, c.lat, c.lon, weatherKey); } catch (e) { ctx.log.warn('weather', { msg: String(e && e.message) }); } }
      let quake = await cacheGet(ctx, 'quake');
      if (isStale(quake, QUAKE_TTL)) { try { quake = await refreshQuake(ctx); } catch (e) { ctx.log.warn('quake', { msg: String(e && e.message) }); } }
      return json(200, {
        location: c ? { lat: c.lat, lon: c.lon, city: tp.weather_city || null } : { city: tp.weather_city || null, configured: false },
        weather: weather && weather.data ? weather.data : null, weather_fetched_at: weather ? weather.fetched_at : null,
        quakes: quake && quake.data ? quake.data.items : [], quake_fetched_at: quake ? quake.fetched_at : null,
        emergency: PHRASES.filter(function (p) { return p.category === EMERGENCY_PHRASE_CATEGORY; }),
      });
    } },
  ],
};

// Convert each handler through the guard wrapper before export.
PLUGIN.routes = PLUGIN.routes.map(function (r) {
  return Object.assign({}, r, { handler: wrapHandler(r.handler) });
});

module.exports = definePlugin(PLUGIN);
