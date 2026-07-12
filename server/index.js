// TREK × Japan — server entry (type: trip-page, TREK >= 3.2.1).
// Built CommonJS, runs in an isolated child process; all host access via `ctx`.
//
// This build exercises the full TREK 3.2.1 plugin surface:
//  - trip-scoped, collaborative own-DB data (db:own) shared by trip members
//  - db:read:trips / db:read:users  (membership gate + collaborator names)
//  - db:read:packing / db:read:files  (native packing list + trip documents)
//  - db:read:costs / db:write:costs  (native budget items; requiredAddons: budget)
//  - db:write:trips / places / days / itinerary  (write into the trip planner)
//  - db:meta  (plugin-private KV on trip/place/day entities)
//  - events:subscribe  (react to core trip events -> live activity feed)
//  - hook:place-detail-provider + hook:trip-warning-provider  (enrich core UI)
//  - ws:broadcast:trip / ws:broadcast:user  (notify core clients on changes)
//  - http:outbound to open-meteo / er-api / jma  (weather, FX, quakes)
const { definePlugin } = require('trek-plugin-sdk');

// ---------------------------------------------------------------------------
// Bundled datasets
// ---------------------------------------------------------------------------
const PHRASES = require('./data/nihongo-phrases.json');
const PREFECTURES = require('./data/prefectures.json');
const ETIQUETTE = require('./data/etiquette.json');
const GOMI = require('./data/gomi.json');
const MATSURI = require('./data/matsuri.json');
const SAKURA = require('./data/sakura.json');
const CITIES = require('./data/cities.json');
const TRANSPORT = require('./data/transport.json');
const SPOTS = require('./data/spots.json');
const DISHES = require('./data/dishes.json');
const POI = require('./data/poi.json');
const SMOKING = require('./data/smoking.json'); // ~1300 designated smoking areas — OpenStreetMap (ODbL) + Tokyo Open Data 台東区 (CC BY 4.0)
const SMOKING_VENUES = require('./data/smoking_venues.json'); // ~3500 venues that permit indoor smoking (cafés/izakaya) — OpenStreetMap (ODbL)

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
const TRIP_PREF_KEYS = ['weather_lat', 'weather_lon', 'weather_city', 'warnings_muted'];

// Read a money value / currency from a native TREK cost item whose exact field
// names we don't hard-depend on (schema may vary across builds).
function costAmount(c) {
  // TREK's BudgetItem uses `total_price` (SDK type). Keep fallbacks for safety.
  var keys = ['total_price', 'amount', 'value', 'total', 'price'];
  for (var i = 0; i < keys.length; i++) { var v = c[keys[i]]; if (typeof v === 'number') return v; if (typeof v === 'string' && v !== '' && !isNaN(parseFloat(v))) return parseFloat(v); }
  return null;
}
function costCurrency(c) { return c.currency || c.currency_code || null; }

// Look up coordinates for a place name (matsuri city / sakura city) from the
// bundled gazetteer, so a plugin-created place lands in Japan, not at 0,0.
function cityCoords(name) {
  if (!name) return null;
  var q = String(name).toLowerCase();
  for (var i = 0; i < CITIES.length; i++) {
    var c = CITIES[i];
    var base = c.name.toLowerCase().replace(/\s*\(.*\)\s*/, '');
    if (q.indexOf(base) >= 0 || q.indexOf(c.name.toLowerCase()) >= 0) return { lat: c.lat, lng: c.lon };
  }
  return null;
}
const CURRENCY_SYMBOL = { EUR: '€', USD: '$', GBP: '£', CHF: 'Fr.' };
const FX_TTL = 6 * 60 * 60 * 1000, WEATHER_TTL = 30 * 60 * 1000, QUAKE_TTL = 15 * 60 * 1000, FETCH_TIMEOUT = 8000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function json(status, obj, cacheControl) {
  const headers = { 'content-type': 'application/json' };
  if (cacheControl) headers['cache-control'] = cacheControl;
  return { status, headers, body: JSON.stringify(obj) };
}
function nowIso() { return new Date().toISOString(); }
function toNum(v, fb) { const n = typeof v === 'number' ? v : parseFloat(v); return Number.isFinite(n) ? n : fb; }
function requireUser(req) { const id = req.user && req.user.id; if (id == null) { const e = new Error('no user'); e.status = 401; throw e; } return id; }
async function readBody(req) { let b = req.body; if (typeof b === 'string') { try { b = JSON.parse(b); } catch (_) { b = {}; } } return b && typeof b === 'object' ? b : {}; }
function getTripIdFromQuery(req) { const raw = req.query && (req.query.tripId != null ? req.query.tripId : req.query.trip_id); return toNum(raw, null); }

// Run a ctx.* call that may fail on missing addon / edit-permission / feature —
// or on a host that doesn't provide the namespace at all (`ctx.meta` undefined).
// Takes a THUNK so a synchronous access throw (undefined method) is caught too.
async function attempt(thunk) { try { return { ok: true, value: await thunk() }; } catch (e) { return { ok: false, error: String(e && e.message || e) }; } }

async function safeBroadcastTrip(ctx, tripId, event, data) { try { await ctx.ws.broadcastToTrip(tripId, event, data); } catch (_) {} }
async function safeBroadcastUser(ctx, userId, event, data) { try { await ctx.ws.broadcastToUser(userId, event, data); } catch (_) {} }

async function upsertTripCache(ctx, tripId, trip) {
  const t = tripDates(trip);
  await ctx.db.exec('INSERT INTO trip_cache(trip_id, title, start, end, updated_at) VALUES(?, ?, ?, ?, ?) ON CONFLICT(trip_id) DO UPDATE SET title=excluded.title, start=excluded.start, end=excluded.end, updated_at=excluded.updated_at',
    tripId, t.title || null, t.start || null, t.end || null, nowIso());
}

// Membership gate for shared, trip-scoped routes.
async function requireTrip(req, ctx, bodyTripId) {
  const userId = requireUser(req);
  const tripId = bodyTripId != null ? toNum(bodyTripId, null) : getTripIdFromQuery(req);
  if (tripId == null) { const e = new Error('tripId required'); e.status = 400; throw e; }
  let trip;
  try { trip = await ctx.trips.getById(tripId, userId); }
  catch (e) { const err = new Error('not a member of this trip'); err.status = 403; throw err; }
  if (!trip) { const err = new Error('trip not found'); err.status = 404; throw err; }
  await upsertTripCache(ctx, tripId, trip);
  return { userId, tripId, trip };
}

// cache
async function cacheGet(ctx, key) { const rows = await ctx.db.query('SELECT json, fetched_at FROM cache WHERE key = ?', key); if (!rows.length) return null; let p = null; try { p = JSON.parse(rows[0].json); } catch (_) {} return { data: p, fetched_at: rows[0].fetched_at }; }
async function cacheSet(ctx, key, data) { const at = nowIso(); await ctx.db.exec('INSERT INTO cache(key, json, fetched_at) VALUES(?, ?, ?) ON CONFLICT(key) DO UPDATE SET json=excluded.json, fetched_at=excluded.fetched_at', key, JSON.stringify(data), at); return at; }
function isStale(e, ttl) { if (!e || !e.fetched_at) return true; const t = Date.parse(e.fetched_at); return !Number.isFinite(t) || (Date.now() - t) > ttl; }

// prefs
async function loadUserPrefs(ctx, userId) {
  const out = Object.assign({}, USER_PREF_DEFAULTS);
  for (const k of USER_PREF_KEYS) if (ctx.config && ctx.config[k] != null && ctx.config[k] !== '') out[k] = String(ctx.config[k]);
  const rows = await ctx.db.query('SELECT key, value FROM user_prefs WHERE user_id = ?', userId);
  for (const r of rows) if (USER_PREF_KEYS.includes(r.key)) out[r.key] = r.value;
  return out;
}
async function saveUserPref(ctx, userId, key, value) { await ctx.db.exec('INSERT INTO user_prefs(user_id, key, value) VALUES(?, ?, ?) ON CONFLICT(user_id, key) DO UPDATE SET value=excluded.value', userId, key, value == null ? '' : String(value)); }
async function loadTripPrefs(ctx, tripId) { const out = {}; const rows = await ctx.db.query('SELECT key, value FROM trip_prefs WHERE trip_id = ?', tripId); for (const r of rows) if (TRIP_PREF_KEYS.includes(r.key)) out[r.key] = r.value; return out; }
async function saveTripPref(ctx, tripId, key, value) { await ctx.db.exec('INSERT INTO trip_prefs(trip_id, key, value) VALUES(?, ?, ?) ON CONFLICT(trip_id, key) DO UPDATE SET value=excluded.value', tripId, key, value == null ? '' : String(value)); }

async function resolveNames(ctx, ids) {
  const uniq = Array.from(new Set(ids.filter(function (x) { return x != null; })));
  const map = {};
  for (const id of uniq) { try { const u = await ctx.users.getById(id); map[id] = u ? (u.display_name || u.username || ('#' + id)) : ('#' + id); } catch (_) { map[id] = '#' + id; } }
  return map;
}
function coords(tp) { const lat = toNum(tp.weather_lat, null), lon = toNum(tp.weather_lon, null); return (lat != null && lon != null) ? { lat, lon } : null; }

// TREK's Reservation shape is loose ({ id, type, [k]: unknown }); read the
// common fields defensively so flights/trains/stays render whatever the host has.
function pick(o, keys) { for (const k of keys) { if (o[k] != null && o[k] !== '') return o[k]; } return null; }
function normReservation(x) {
  if (!x || typeof x !== 'object') return null;
  const type = String(pick(x, ['type', 'kind', 'category']) || 'reservation').toLowerCase();
  return {
    id: x.id,
    type,
    title: pick(x, ['title', 'name', 'label', 'description', 'summary', 'provider', 'carrier', 'hotel']),
    start: pick(x, ['start', 'start_date', 'startDate', 'date', 'depart', 'departure', 'check_in', 'checkIn', 'from_date']),
    end: pick(x, ['end', 'end_date', 'endDate', 'until', 'arrive', 'arrival', 'check_out', 'checkOut', 'to_date']),
    from: pick(x, ['from', 'origin', 'from_location', 'departure_place', 'pickup']),
    to: pick(x, ['to', 'destination', 'to_location', 'arrival_place', 'dropoff']),
    location: pick(x, ['location', 'place', 'address', 'city']),
    ref: pick(x, ['confirmation', 'reference', 'ref', 'booking_ref', 'pnr', 'code']),
  };
}

// remote refreshers
function haversineKm(aLat, aLon, bLat, bLon) { const R = 6371, r = Math.PI / 180; const dLat = (bLat - aLat) * r, dLon = (bLon - aLon) * r; const s = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(dLon / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(s)); }
// Live "near me" categories that are too dense to bundle (konbini alone ~56k) —
// fetched on demand from OpenStreetMap via Overpass around the user's location.
const OVERPASS_FILTERS = { konbini: ['"amenity"="convenience"'], atm: ['"amenity"="atm"'], pharmacy: ['"amenity"="pharmacy"'], vending: ['"amenity"="vending_machine"'] };
async function timedFetch(url) { const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT), headers: { accept: 'application/json' } }); if (!res.ok) throw new Error('http ' + res.status); return res.json(); }
async function timedFetchText(url) { const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT), headers: { accept: 'application/rss+xml, application/xml, text/xml, */*' } }); if (!res.ok) throw new Error('http ' + res.status); return res.text(); }
// Minimal RSS reader: pull a tag's text out of an <item> block, unwrap CDATA,
// strip inner tags and decode the handful of entities the feed actually uses.
function rssTag(block, tag) {
  const m = new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)<\\/' + tag + '>', 'i').exec(block);
  if (!m) return null;
  let v = m[1].trim().replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '').trim().replace(/<[^>]+>/g, '');
  v = v.replace(/&#8217;/g, '’').replace(/&#8216;/g, '‘').replace(/&#8220;/g, '“').replace(/&#8221;/g, '”')
       .replace(/&#8230;/g, '…').replace(/&#8211;/g, '–').replace(/&#8212;/g, '—')
       .replace(/&quot;/g, '"').replace(/&(?:apos|#0?39);/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  return v.trim();
}
async function refreshNews(ctx) {
  const raw = await timedFetchText('https://japantoday.com/category/national/feed');
  const items = []; const re = /<item[\s\S]*?<\/item>/gi; let m;
  while ((m = re.exec(raw)) && items.length < 10) {
    const b = m[0]; const title = rssTag(b, 'title'); if (!title) continue;
    items.push({ title, link: rssTag(b, 'link'), date: rssTag(b, 'pubDate') });
  }
  const data = { items }; return { data, fetched_at: await cacheSet(ctx, 'news', data) };
}
async function refreshFx(ctx) {
  // Prefer the host FX broker (rates:read, no egress, cached upstream); fall back
  // to the direct er-api call so this keeps working on hosts without the broker.
  let rates = null, source = null;
  const br = await attempt(function () { return ctx.rates && ctx.rates.get ? ctx.rates.get('JPY') : null; });
  if (br.ok && br.value && typeof br.value === 'object') { rates = br.value; source = 'host'; }
  if (!rates) { const raw = await timedFetch('https://open.er-api.com/v6/latest/JPY'); rates = (raw && raw.rates) || {}; source = raw && (raw.time_last_update_utc || null); }
  const data = { base: 'JPY', rates: { EUR: rates.EUR, USD: rates.USD, GBP: rates.GBP, CHF: rates.CHF }, source_updated: source };
  return { data, fetched_at: await cacheSet(ctx, 'fx', data) };
}
async function refreshWeather(ctx, lat, lon, key) {
  const url = 'https://api.open-meteo.com/v1/forecast?latitude=' + encodeURIComponent(lat) + '&longitude=' + encodeURIComponent(lon) + '&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&forecast_days=5&timezone=Asia%2FTokyo';
  const raw = await timedFetch(url);
  const data = { lat, lon, current: raw && raw.current ? { temp: raw.current.temperature_2m, humidity: raw.current.relative_humidity_2m, code: raw.current.weather_code, wind: raw.current.wind_speed_10m } : null, daily: raw && raw.daily && Array.isArray(raw.daily.time) ? raw.daily.time.map(function (d, i) { return { date: d, code: raw.daily.weather_code[i], tmax: raw.daily.temperature_2m_max[i], tmin: raw.daily.temperature_2m_min[i], pop: raw.daily.precipitation_probability_max ? raw.daily.precipitation_probability_max[i] : null }; }) : [] };
  return { data, fetched_at: await cacheSet(ctx, key || 'weather', data) };
}
async function refreshQuake(ctx) { const raw = await timedFetch('https://www.jma.go.jp/bosai/quake/data/list.json'); const list = Array.isArray(raw) ? raw.slice(0, 12) : []; const data = { items: list.map(function (q) { return { time: q.at || q.rdt || null, place: q.anm || q.en_anm || '', mag: q.mag != null ? q.mag : null, intensity: q.maxi || null }; }) }; return { data, fetched_at: await cacheSet(ctx, 'quake', data) }; }

// dates
function dayOfYear(d) { const s = Date.UTC(d.getUTCFullYear(), 0, 0); return Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - s) / 86400000); }
function daysUntil(iso) { if (!iso) return null; const t = Date.parse(iso); if (!Number.isFinite(t)) return null; const td = new Date(); return Math.round((t - Date.UTC(td.getUTCFullYear(), td.getUTCMonth(), td.getUTCDate())) / 86400000); }
function tripDates(trip) { return { title: trip.title || trip.name || null, start: trip.start_date || trip.startDate || null, end: trip.end_date || trip.endDate || null }; }
function mmToMonth(md) { return md ? parseInt(String(md).split('-')[0], 10) : null; }
// First YYYY-MM-DD inside the trip window whose month matches `month`
// (so a matsuri known only by month lands on a real itinerary day).
function dateForMonth(trip, month) {
  const td = tripDates(trip);
  if (!td.start) return null;
  const s = new Date(td.start); if (isNaN(s.getTime())) return td.start;
  const e = td.end ? new Date(td.end) : s; const ed = isNaN(e.getTime()) ? s : e;
  if (month == null) return td.start;
  let d = Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), s.getUTCDate());
  const end = Date.UTC(ed.getUTCFullYear(), ed.getUTCMonth(), ed.getUTCDate());
  let guard = 0;
  while (d <= end && guard < 400) {
    const dt = new Date(d);
    if (dt.getUTCMonth() + 1 === month) return dt.toISOString().slice(0, 10);
    d += 86400000; guard++;
  }
  return td.start;
}
function tripMonths(start, end) { if (!start) return null; const s = new Date(start); if (isNaN(s.getTime())) return null; const e = end ? new Date(end) : s; const ed = isNaN(e.getTime()) ? s : e; const m = new Set(); let y = s.getUTCFullYear(), mo = s.getUTCMonth(); const ey = ed.getUTCFullYear(), em = ed.getUTCMonth(); let g = 0; while ((y < ey || (y === ey && mo <= em)) && g < 24) { m.add(mo + 1); mo++; if (mo > 11) { mo = 0; y++; } g++; } return Array.from(m); }
// Does [start,end] overlap the MM-DD..MM-DD window in any spanned year?
function overlapsSeason(start, end, fromMD, toMD) {
  if (!start) return false; const s = new Date(start); if (isNaN(s.getTime())) return false; const e = end ? new Date(end) : s; const ed = isNaN(e.getTime()) ? s : e;
  for (let y = s.getUTCFullYear(); y <= ed.getUTCFullYear(); y++) {
    const a = Date.parse(y + '-' + fromMD + 'T00:00:00Z'), b = Date.parse(y + '-' + toMD + 'T23:59:59Z');
    if (Number.isFinite(a) && Number.isFinite(b) && ed.getTime() >= a && s.getTime() <= b) return true;
  }
  return false;
}

async function logActivity(ctx, tripId, event) {
  await ctx.db.exec('INSERT INTO activity(trip_id, event, at) VALUES(?, ?, ?)', tripId, event, nowIso());
  // keep only the most recent 200 per trip
  await ctx.db.exec('DELETE FROM activity WHERE trip_id = ? AND id NOT IN (SELECT id FROM activity WHERE trip_id = ? ORDER BY id DESC LIMIT 200)', tripId, tripId);
}

// personal IC adjust
async function icAdjust(req, ctx, kind) {
  const userId = requireUser(req);
  const body = await readBody(req);
  const amount = Math.max(0, Math.round(toNum(body.amount, 0)));
  if (!amount) return json(400, { error: 'amount required' });
  const b = await ctx.db.query('SELECT yen FROM ic_balance WHERE user_id = ?', userId);
  const cur = b.length ? b[0].yen : 0;
  const next = kind === 'charge' ? cur + amount : Math.max(0, cur - amount);
  const at = nowIso();
  await ctx.db.exec('INSERT INTO ic_balance(user_id, yen, updated_at) VALUES(?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET yen=excluded.yen, updated_at=excluded.updated_at', userId, next, at);
  await ctx.db.exec('INSERT INTO ic_ledger(user_id, kind, amount, balance_after, at) VALUES(?, ?, ?, ?, ?)', userId, kind, amount, next, at);
  await safeBroadcastUser(ctx, userId, 'ic:changed', { yen: next });
  // (≥3.3) Proactive host notification (notify:send) when a spend drops your own
  // IC balance below your threshold — so you top up before the next gate. Scope is
  // forced to the acting user; fail-safe on hosts without the broker.
  if (kind === 'spend') {
    const prefs = await loadUserPrefs(ctx, userId);
    const threshold = Math.round(toNum(prefs.low_ic_threshold, 1000));
    if (threshold > 0 && next < threshold && (next + amount) >= threshold) {
      await attempt(function () {
        return ctx.notify && ctx.notify.send({
          title: (prefs.ic_card || 'IC') + ' balance low',
          body: 'Your ' + (prefs.ic_card || 'IC card') + ' is down to ¥' + next.toLocaleString('en-US') + '. Top up at a konbini or station machine before your next ride.',
          scope: 'user', targetId: userId,
        });
      });
    }
  }
  return json(200, { yen: next, kind, amount });
}

function wrapHandler(fn) {
  return async function (req, ctx) {
    try { return await fn(req, ctx); }
    catch (e) { const status = e && e.status ? e.status : 500; if (status >= 500) ctx.log.error('route error', { path: req.path, msg: String(e && e.message) }); return json(status, { error: (e && e.message) || 'error' }); }
  };
}

// ---------------------------------------------------------------------------
// Definition
// ---------------------------------------------------------------------------
const PLUGIN = {
  async onLoad(ctx) {
    // shared, per-trip
    await ctx.db.migrate('t001_checklist', 'CREATE TABLE IF NOT EXISTS checklist (trip_id INTEGER NOT NULL, item_id TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0, by_user INTEGER, at TEXT, PRIMARY KEY(trip_id, item_id))');
    await ctx.db.migrate('t002_budget', 'CREATE TABLE IF NOT EXISTS budget (trip_id INTEGER PRIMARY KEY, planned_yen INTEGER NOT NULL DEFAULT 0)');
    await ctx.db.migrate('t003_spend', 'CREATE TABLE IF NOT EXISTS spend (id INTEGER PRIMARY KEY, trip_id INTEGER NOT NULL, user_id INTEGER NOT NULL, amount_yen INTEGER NOT NULL, note TEXT, at TEXT)');
    await ctx.db.migrate('t004_food', 'CREATE TABLE IF NOT EXISTS food_tally (trip_id INTEGER NOT NULL, kind TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, at TEXT, PRIMARY KEY(trip_id, kind))');
    await ctx.db.migrate('t005_visited', 'CREATE TABLE IF NOT EXISTS visited_prefs (trip_id INTEGER NOT NULL, code TEXT NOT NULL, by_user INTEGER, at TEXT, PRIMARY KEY(trip_id, code))');
    await ctx.db.migrate('t006_collect', 'CREATE TABLE IF NOT EXISTS collect (trip_id INTEGER NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL, by_user INTEGER, at TEXT, PRIMARY KEY(trip_id, kind, key))');
    await ctx.db.migrate('t007_trip_prefs', 'CREATE TABLE IF NOT EXISTS trip_prefs (trip_id INTEGER NOT NULL, key TEXT NOT NULL, value TEXT, PRIMARY KEY(trip_id, key))');
    await ctx.db.migrate('t008_trip_cache', 'CREATE TABLE IF NOT EXISTS trip_cache (trip_id INTEGER PRIMARY KEY, title TEXT, start TEXT, end TEXT, updated_at TEXT)');
    await ctx.db.migrate('t009_activity', 'CREATE TABLE IF NOT EXISTS activity (id INTEGER PRIMARY KEY, trip_id INTEGER NOT NULL, event TEXT, at TEXT)');
    await ctx.db.migrate('t010_place_notes', 'CREATE TABLE IF NOT EXISTS place_notes (place_id INTEGER PRIMARY KEY, trip_id INTEGER, note TEXT, by_user INTEGER, at TEXT)');
    await ctx.db.migrate('t011_cost_sync', 'CREATE TABLE IF NOT EXISTS cost_sync (spend_id INTEGER PRIMARY KEY, cost_id INTEGER, at TEXT)');
    await ctx.db.migrate('t012_pinned_tips', 'CREATE TABLE IF NOT EXISTS pinned_tips (trip_id INTEGER PRIMARY KEY, text TEXT, by_user INTEGER, at TEXT)');
    await ctx.db.migrate('t013_transport_legs', 'CREATE TABLE IF NOT EXISTS transport_legs (trip_id INTEGER NOT NULL, leg_key TEXT NOT NULL, qty INTEGER NOT NULL DEFAULT 0, by_user INTEGER, at TEXT, PRIMARY KEY(trip_id, leg_key))');
    // personal, per-user
    await ctx.db.migrate('u001_user_prefs', 'CREATE TABLE IF NOT EXISTS user_prefs (user_id INTEGER NOT NULL, key TEXT NOT NULL, value TEXT, PRIMARY KEY(user_id, key))');
    await ctx.db.migrate('u002_phrase_favs', 'CREATE TABLE IF NOT EXISTS phrase_favs (user_id INTEGER NOT NULL, phrase_id TEXT NOT NULL, at TEXT, PRIMARY KEY(user_id, phrase_id))');
    await ctx.db.migrate('u003_phrase_state', 'CREATE TABLE IF NOT EXISTS phrase_state (user_id INTEGER PRIMARY KEY, offset INTEGER NOT NULL DEFAULT 0)');
    await ctx.db.migrate('u004_ic_balance', 'CREATE TABLE IF NOT EXISTS ic_balance (user_id INTEGER PRIMARY KEY, yen INTEGER NOT NULL DEFAULT 0, updated_at TEXT)');
    await ctx.db.migrate('u005_ic_ledger', 'CREATE TABLE IF NOT EXISTS ic_ledger (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, kind TEXT NOT NULL, amount INTEGER NOT NULL, balance_after INTEGER NOT NULL, at TEXT)');
    await ctx.db.migrate('g001_cache', 'CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, json TEXT, fetched_at TEXT)');
    // (≥3.3) Persistent, userless scheduling (jobs:run). This is the reliable way
    // to keep FX / earthquake / news caches warm — `jobs[]` are not guaranteed to
    // fire on every host. Upsert-by-name, so re-arming on each load is idempotent.
    // Fail-safe: a host without ctx.scheduler simply serves caches on demand.
    await attempt(function () { return ctx.scheduler && ctx.scheduler.every(6 * 60 * 60 * 1000, 'fx'); });
    await attempt(function () { return ctx.scheduler && ctx.scheduler.every(15 * 60 * 1000, 'quake'); });
    await attempt(function () { return ctx.scheduler && ctx.scheduler.every(30 * 60 * 1000, 'news'); });
    ctx.log.info('TREK x Japan (trip-page) loaded');
  },

  async onUnload(ctx) { ctx.log.info('TREK x Japan unloading'); },

  // (≥3.3) Persistent scheduler callback (jobs:run) — userless, like a job. Keeps
  // the shared caches warm so weather/quake/news are instant when someone opens
  // the tab. Named timers map 1:1 to the refreshers.
  async scheduled(input, ctx) {
    const name = input && input.name;
    try {
      if (name === 'fx') await refreshFx(ctx);
      else if (name === 'quake') await refreshQuake(ctx);
      else if (name === 'news') await refreshNews(ctx);
    } catch (e) { ctx.log.warn('scheduled ' + name, { msg: String(e && e.message) }); }
  },

  // (≥3.3) GDPR erasure (hook:user-data) — a TREK account was deleted; drop
  // everything personal we hold about it from our OWN db. Userless, idempotent
  // (the host retries until it succeeds). Shared trip content is left intact but
  // de-attributed so no deleted user stays named on a board.
  async deleteUserData(input, ctx) {
    const id = toNum(input && input.userId, null); if (id == null) return;
    const personal = ['user_prefs', 'phrase_favs', 'phrase_state', 'ic_balance', 'ic_ledger'];
    for (const t of personal) { await attempt(function () { return ctx.db.exec('DELETE FROM ' + t + ' WHERE user_id = ?', id); }); }
    const attributed = ['checklist', 'visited_prefs', 'collect', 'pinned_tips', 'place_notes', 'transport_legs'];
    for (const t of attributed) { await attempt(function () { return ctx.db.exec('UPDATE ' + t + ' SET by_user = NULL WHERE by_user = ?', id); }); }
    ctx.log.info('deleteUserData done', { userId: id });
  },

  // (≥3.3) GDPR portability (hook:user-data) — return everything we hold about a
  // user from our own db, as a JSON-serialisable value the host aggregates.
  async exportUserData(input, ctx) {
    const id = toNum(input && input.userId, null); const out = { plugin: 'trek-x-japan' };
    if (id == null) return out;
    const q = async function (label, sql) { const r = await attempt(function () { return ctx.db.query(sql, id); }); out[label] = r.ok ? r.value : []; };
    await q('preferences', 'SELECT key, value FROM user_prefs WHERE user_id = ?');
    await q('phrase_favorites', 'SELECT phrase_id, at FROM phrase_favs WHERE user_id = ?');
    await q('phrase_state', 'SELECT offset FROM phrase_state WHERE user_id = ?');
    await q('ic_balance', 'SELECT yen, updated_at FROM ic_balance WHERE user_id = ?');
    await q('ic_ledger', 'SELECT kind, amount, balance_after, at FROM ic_ledger WHERE user_id = ? ORDER BY id');
    await q('checklist_items_done', 'SELECT trip_id, item_id, at FROM checklist WHERE by_user = ?');
    await q('prefectures_stamped', 'SELECT trip_id, code, at FROM visited_prefs WHERE by_user = ?');
    await q('collections', 'SELECT trip_id, kind, key, at FROM collect WHERE by_user = ?');
    await q('expenses', 'SELECT trip_id, amount_yen, note, at FROM spend WHERE user_id = ?');
    return out;
  },

  // (≥3.2.1) WIRED reactive hook. No user, only { event, tripId }. We keep a
  // per-trip activity feed the UI polls via GET /activity.
  events: [
    { on: '*', async handler(payload, ctx) {
      try {
        const tripId = toNum(payload && payload.tripId, null);
        if (tripId == null) return;
        await logActivity(ctx, tripId, String(payload.event || 'event'));
      } catch (e) { ctx.log.warn('event handler', { msg: String(e && e.message) }); }
    } },
  ],

  // (≥3.2.1) WIRED provider hooks. Called by core with the plugin ctx (no user),
  // additive and fail-safe.
  hooks: {
    // Enrich a place's detail panel with any note this plugin pinned to it.
    placeDetailProvider: {
      async getDetails(placeId, ctx) {
        const out = [];
        try {
          const rows = await ctx.db.query('SELECT note FROM place_notes WHERE place_id = ?', toNum(placeId, -1));
          if (rows.length && rows[0].note) out.push({ label: 'TREK × Japan', value: rows[0].note });
        } catch (_) {}
        return out;
      },
    },
    // Raise trip-planner warnings from the plugin's own trip state.
    warningProvider: {
      async getWarnings(tripId, ctx) {
        const out = [];
        const id = toNum(tripId, null); if (id == null) return out;
        try {
          const tp = {}; const pr = await ctx.db.query('SELECT key, value FROM trip_prefs WHERE trip_id = ?', id);
          pr.forEach(function (r) { tp[r.key] = r.value; });
          if (tp.warnings_muted === '1') return out;   // user muted plugin warnings in Settings
          if (!(tp.weather_lat && tp.weather_lon)) out.push({ level: 'info', message: 'TREK × Japan: set a weather location to see the forecast & typhoon risk.' });
          const b = await ctx.db.query('SELECT planned_yen FROM budget WHERE trip_id = ?', id);
          const planned = b.length ? b[0].planned_yen : 0;
          const sp = await ctx.db.query('SELECT COALESCE(SUM(amount_yen),0) AS s FROM spend WHERE trip_id = ?', id);
          const spent = sp.length ? sp[0].s : 0;
          if (planned > 0 && spent > planned) out.push({ level: 'warning', message: 'TREK × Japan: trip budget exceeded (¥' + spent.toLocaleString('en-US') + ' of ¥' + planned.toLocaleString('en-US') + ').' });
          const tc = await ctx.db.query('SELECT start, end FROM trip_cache WHERE trip_id = ?', id);
          if (tc.length) {
            const s = tc[0].start, e = tc[0].end;
            if (overlapsSeason(s, e, '04-29', '05-06')) out.push({ level: 'info', message: 'TREK × Japan: your dates hit Golden Week — book transport & lodging early, expect crowds.' });
            if (overlapsSeason(s, e, '12-28', '01-04')) out.push({ level: 'info', message: 'TREK × Japan: New Year (o-shogatsu) — many shops and sights close; plan around it.' });
            if (overlapsSeason(s, e, '08-10', '08-17')) out.push({ level: 'info', message: 'TREK × Japan: Obon week — domestic travel peaks and prices rise.' });
            // Prep checklist behind with departure imminent.
            const dStart = daysUntil(s), dEnd = daysUntil(e);
            if (dStart != null && dStart >= 0 && dStart <= 7) {
              const cl = await ctx.db.query('SELECT COALESCE(SUM(done),0) AS d FROM checklist WHERE trip_id = ?', id);
              const done = cl.length ? cl[0].d : 0, total = CHECKLIST_ITEMS.length;
              if (total > 0 && done < Math.ceil(total * 0.6)) out.push({ level: 'warning', message: 'TREK × Japan: departure in ' + dStart + ' day' + (dStart === 1 ? '' : 's') + ', prep checklist only ' + done + '/' + total + ' done.' });
            }
            // In-Japan nudge to start the shared prefecture passport.
            if (dStart != null && dEnd != null && dStart <= 0 && dEnd >= 0) {
              const vp = await ctx.db.query('SELECT COUNT(*) AS n FROM visited_prefs WHERE trip_id = ?', id);
              if ((vp.length ? vp[0].n : 0) === 0) out.push({ level: 'info', message: 'TREK × Japan: you are in Japan — start stamping the prefecture passport together.' });
            }
          }
        } catch (e) { ctx.log.warn('warnings', { msg: String(e && e.message) }); }
        return out;
      },
    },
    // (3.3.x) Contribute markers to the trip map: curated spots + practical POIs
    // (smoking areas, foreign-card ATMs, lockers, luggage forwarding). Userless.
    mapMarkerProvider: {
      async getMarkers(tripId, ctx) {
        const out = [];
        try {
          SPOTS.forEach(function (s) { if (s.lat != null && s.lon != null) out.push({ id: 'spot-' + s.key, lat: s.lat, lng: s.lon, label: s.name, popupText: (s.city ? s.city + ' — ' : '') + s.en }); });
          POI.forEach(function (p) { if (p.lat != null && p.lon != null) out.push({ id: 'poi-' + p.key, lat: p.lat, lng: p.lon, label: p.name, popupText: p.en }); });
          // Only the authoritative (official 台東区) smoking areas go on the trip
          // map — the full ~1300-area / ~3500-venue set is far too dense to pin and
          // is served location-aware (nearest-first) via the Essentials tab instead.
          SMOKING.forEach(function (s, i) { if (s.official) out.push({ id: 'smk-' + i, lat: s.lat, lng: s.lon, label: s.name || 'Smoking area', popupText: 'Designated smoking area' + (s.near ? ' · ' + s.near : '') }); });
        } catch (_) {}
        return out;
      },
    },
    // (3.3.x) Badge on the trip's dashboard card: countdown from cached dates.
    tripCardProvider: {
      async getCards(tripIds, ctx) {
        const out = [];
        try {
          const ids = Array.isArray(tripIds) ? tripIds : [];
          for (const rawId of ids) {
            const id = toNum(rawId, null); if (id == null) continue;
            const tc = await ctx.db.query('SELECT start, end FROM trip_cache WHERE trip_id = ?', id);
            if (!tc.length) continue;
            const d = daysUntil(tc[0].start), dEnd = daysUntil(tc[0].end);
            let val = null;
            if (d != null && d > 0) val = d + ' day' + (d === 1 ? '' : 's') + ' to go';
            else if (d === 0) val = 'Departure day';
            else if (dEnd != null && dEnd >= 0) val = 'In Japan · ' + dEnd + ' left';
            if (val) out.push({ tripId: id, id: 'trek-japan', label: 'TREK × Japan', value: val });
          }
        } catch (_) {}
        return out;
      },
    },
    // (3.3.x) Add a Japan section to the exported trip PDF: emergency numbers &
    // phrases, prep-checklist status and the shared budget. Userless.
    pdfSectionProvider: {
      async getSections(tripId, ctx) {
        const id = toNum(tripId, null); const sections = [];
        try {
          const emg = PHRASES.filter(function (p) { return p.category === EMERGENCY_PHRASE_CATEGORY; }).slice(0, 8);
          sections.push({
            title: 'TREK x Japan — Emergency',
            paragraphs: ['Police 110  ·  Fire / Ambulance 119', 'Show the Japanese phrase if you need help.'],
            table: { headers: ['English', 'Japanese', 'Romaji'], rows: emg.map(function (p) { return [p.en, p.jp, p.romaji]; }) },
          });
          if (id != null) {
            const cl = await ctx.db.query('SELECT COALESCE(SUM(done),0) AS d FROM checklist WHERE trip_id = ?', id);
            const done = cl.length ? cl[0].d : 0, total = CHECKLIST_ITEMS.length;
            sections.push({ title: 'TREK x Japan — Prep checklist', paragraphs: [done + ' of ' + total + ' items done.'], table: { headers: ['Item'], rows: CHECKLIST_ITEMS.map(function (i) { return [i.en]; }) } });
            const b = await ctx.db.query('SELECT planned_yen FROM budget WHERE trip_id = ?', id);
            const planned = b.length ? b[0].planned_yen : 0;
            const sp = await ctx.db.query('SELECT COALESCE(SUM(amount_yen),0) AS s FROM spend WHERE trip_id = ?', id);
            const spent = sp.length ? sp[0].s : 0;
            if (planned > 0 || spent > 0) sections.push({ title: 'TREK x Japan — Budget', paragraphs: ['Planned: JPY ' + planned.toLocaleString('en-US'), 'Spent: JPY ' + spent.toLocaleString('en-US'), 'Remaining: JPY ' + (planned - spent).toLocaleString('en-US')] });
          }
        } catch (_) {}
        return sections;
      },
    },
  },

  jobs: [
    { id: 'fx-refresh', schedule: '0 */6 * * *', async handler(ctx) { try { await refreshFx(ctx); } catch (e) { ctx.log.error('fx job', { msg: String(e && e.message) }); } } },
    { id: 'quake-refresh', schedule: '*/15 * * * *', async handler(ctx) { try { await refreshQuake(ctx); } catch (e) { ctx.log.error('quake job', { msg: String(e && e.message) }); } } },
    { id: 'news-refresh', schedule: '*/30 * * * *', async handler(ctx) { try { await refreshNews(ctx); } catch (e) { ctx.log.error('news job', { msg: String(e && e.message) }); } } },
  ],

  routes: [
    // ---- meta + prefs -------------------------------------------------------
    { method: 'GET', path: '/meta', auth: true, async handler(req, ctx) {
      const { userId, tripId, trip } = await requireTrip(req, ctx);
      const td = tripDates(trip);
      const prefs = await loadUserPrefs(ctx, userId);
      // Source of truth is our own trip-scoped table (shared, always available);
      // fall back to the native ctx.meta mirror only if the row is missing.
      const pinRows = await ctx.db.query('SELECT text, by_user FROM pinned_tips WHERE trip_id = ?', tripId);
      let pinned = pinRows.length ? pinRows[0].text : null;
      let pinnedBy = null;
      if (pinned != null && pinRows[0].by_user != null) { const nm = await resolveNames(ctx, [pinRows[0].by_user]); pinnedBy = nm[pinRows[0].by_user] || null; }
      if (pinned == null) { const m = await attempt(() => ctx.meta.get('trip', tripId, 'pinned_tips')); if (m.ok && m.value) pinned = String(m.value); }
      return json(200, {
        me: { id: userId, name: (req.user && req.user.username) || null },
        trip: { title: td.title, start: td.start, end: td.end, currency: trip.currency || null, days_until_start: daysUntil(td.start), days_until_end: daysUntil(td.end) },
        prefs, currency_symbol: CURRENCY_SYMBOL[prefs.home_currency] || prefs.home_currency,
        pinned_tips: pinned || null,
        pinned_by: pinnedBy,
        counts: { phrases: PHRASES.length, prefectures: PREFECTURES.length, etiquette: ETIQUETTE.length, gomi: GOMI.length, matsuri: MATSURI.length, sakura: SAKURA.length, checklist: CHECKLIST_ITEMS.length },
      });
    } },
    { method: 'GET', path: '/prefs', auth: true, async handler(req, ctx) { const { userId, tripId } = await requireTrip(req, ctx); return json(200, { prefs: await loadUserPrefs(ctx, userId), trip_prefs: await loadTripPrefs(ctx, tripId) }); } },
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
      const items = CHECKLIST_ITEMS.map(function (it) { const r = map[it.id]; return { id: it.id, en: it.en, de: it.de, group: it.group, done: !!(r && r.done), by: r && r.done ? (names[r.by_user] || null) : null }; });
      return json(200, { trip: { title: td.title, start: td.start, end: td.end, days_until_start: daysUntil(td.start), days_until_end: daysUntil(td.end) }, items, done: items.filter(function (i) { return i.done; }).length, total: items.length });
    } },
    { method: 'POST', path: '/checklist/toggle', auth: true, async handler(req, ctx) {
      const body = await readBody(req);
      const { userId, tripId } = await requireTrip(req, ctx, body.tripId);
      const itemId = String(body.item_id || '');
      if (!CHECKLIST_ITEMS.some(function (i) { return i.id === itemId; })) return json(400, { error: 'unknown item' });
      const cur = await ctx.db.query('SELECT done FROM checklist WHERE trip_id = ? AND item_id = ?', tripId, itemId);
      const next = cur.length && cur[0].done ? 0 : 1;
      await ctx.db.exec('INSERT INTO checklist(trip_id, item_id, done, by_user, at) VALUES(?, ?, ?, ?, ?) ON CONFLICT(trip_id, item_id) DO UPDATE SET done=excluded.done, by_user=excluded.by_user, at=excluded.at', tripId, itemId, next, userId, nowIso());
      await safeBroadcastTrip(ctx, tripId, 'checklist:changed', { item_id: itemId, done: !!next });
      return json(200, { item_id: itemId, done: !!next });
    } },

    // Native TREK packing list (db:read:packing) + trip files (db:read:files)
    { method: 'GET', path: '/trip/packing', auth: true, async handler(req, ctx) {
      const { tripId } = await requireTrip(req, ctx);
      const r = await attempt(() => ctx.packing.list(tripId));
      if (!r.ok) return json(200, { available: false, error: r.error, items: [] });
      const items = (r.value || []).map(function (p) { return { id: p.id, name: p.name || p.title || '', packed: !!(p.is_packed || p.packed), bag: (p.bag && (p.bag.name || p.bag)) || null, qty: p.quantity || p.qty || null }; });
      return json(200, { available: true, items });
    } },
    { method: 'GET', path: '/trip/files', auth: true, async handler(req, ctx) {
      const { tripId } = await requireTrip(req, ctx);
      const r = await attempt(() => ctx.files.list(tripId));
      if (!r.ok) return json(200, { available: false, error: r.error, files: [] });
      const files = (r.value || []).map(function (f) { return { id: f.id, name: f.name || f.filename || f.original_name || '', size: f.size || f.size_bytes || null, kind: f.mime_type || f.type || null }; });
      return json(200, { available: true, files });
    } },
    // Live activity feed (fed by the events subscription)
    { method: 'GET', path: '/activity', auth: true, async handler(req, ctx) {
      const { tripId } = await requireTrip(req, ctx);
      const rows = await ctx.db.query('SELECT event, at FROM activity WHERE trip_id = ? ORDER BY id DESC LIMIT 30', tripId);
      const counts = await ctx.db.query('SELECT event, COUNT(*) AS n FROM activity WHERE trip_id = ? GROUP BY event ORDER BY n DESC', tripId);
      return json(200, { recent: rows, counts });
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
      await ctx.db.exec('INSERT INTO phrase_state(user_id, offset) VALUES(?, ?) ON CONFLICT(user_id) DO UPDATE SET offset=excluded.offset', userId, offset);
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

    // ---- 3. Culture & gomi -------------------------------------------------
    { method: 'GET', path: '/etiquette', auth: true, async handler(req, ctx) { return json(200, { items: ETIQUETTE, categories: Array.from(new Set(ETIQUETTE.map(function (e) { return e.category; }))) }, 'max-age=3600'); } },
    { method: 'GET', path: '/gomi', auth: true, async handler(req, ctx) {
      const q = String((req.query && (req.query.q || req.query.query)) || '').trim().toLowerCase();
      let items = GOMI;
      if (q) items = GOMI.filter(function (g) { return (g.item_en && g.item_en.toLowerCase().includes(q)) || (g.item_de && g.item_de.toLowerCase().includes(q)) || (g.bin_en && g.bin_en.toLowerCase().includes(q)) || (g.bin_de && g.bin_de.toLowerCase().includes(q)); });
      return json(200, { items, total: GOMI.length, query: q });
    } },

    // ---- 4. Shared budget + native TREK budget (costs) ---------------------
    { method: 'GET', path: '/budget/state', auth: true, async handler(req, ctx) {
      const { userId, tripId } = await requireTrip(req, ctx);
      const prefs = await loadUserPrefs(ctx, userId);
      const b = await ctx.db.query('SELECT planned_yen FROM budget WHERE trip_id = ?', tripId);
      const planned = b.length ? b[0].planned_yen : 0;
      const spends = await ctx.db.query('SELECT id, user_id, amount_yen, note, at FROM spend WHERE trip_id = ? ORDER BY id DESC LIMIT 100', tripId);
      const totalRows = await ctx.db.query('SELECT COALESCE(SUM(amount_yen),0) AS s FROM spend WHERE trip_id = ?', tripId);
      const spent = totalRows.length ? totalRows[0].s : 0;
      const names = await resolveNames(ctx, spends.map(function (s) { return s.user_id; }));
      const synced = await ctx.db.query('SELECT spend_id FROM cost_sync');
      const syncedSet = {}; synced.forEach(function (r) { syncedSet[r.spend_id] = true; });
      let fx = await cacheGet(ctx, 'fx');
      if (isStale(fx, FX_TTL)) { const r = await attempt(() => refreshFx(ctx)); if (r.ok) fx = r.value; }
      const rate = fx && fx.data && fx.data.rates ? fx.data.rates[prefs.home_currency] : null;
      return json(200, {
        planned_yen: planned, spent_yen: spent, remaining_yen: planned - spent,
        spends: spends.map(function (s) { return { id: s.id, amount_yen: s.amount_yen, note: s.note, at: s.at, by: names[s.user_id] || null, synced: !!syncedSet[s.id] }; }),
        currency: prefs.home_currency, currency_symbol: CURRENCY_SYMBOL[prefs.home_currency] || prefs.home_currency,
        rate, fx_fetched_at: fx ? fx.fetched_at : null,
        planned_home: rate != null ? planned * rate : null, spent_home: rate != null ? spent * rate : null, remaining_home: rate != null ? (planned - spent) * rate : null,
      });
    } },
    { method: 'POST', path: '/budget/plan', auth: true, async handler(req, ctx) { const body = await readBody(req); const { tripId } = await requireTrip(req, ctx, body.tripId); const yen = Math.max(0, Math.round(toNum(body.planned_yen, 0))); await ctx.db.exec('INSERT INTO budget(trip_id, planned_yen) VALUES(?, ?) ON CONFLICT(trip_id) DO UPDATE SET planned_yen=excluded.planned_yen', tripId, yen); return json(200, { planned_yen: yen }); } },
    { method: 'POST', path: '/budget/spend', auth: true, async handler(req, ctx) {
      const body = await readBody(req);
      const { userId, tripId } = await requireTrip(req, ctx, body.tripId);
      const amount = Math.round(toNum(body.amount_yen, 0));
      if (!amount) return json(400, { error: 'amount required' });
      await ctx.db.exec('INSERT INTO spend(trip_id, user_id, amount_yen, note, at) VALUES(?, ?, ?, ?, ?)', tripId, userId, amount, String(body.note || '').slice(0, 200), nowIso());
      const totalRows = await ctx.db.query('SELECT COALESCE(SUM(amount_yen),0) AS s FROM spend WHERE trip_id = ?', tripId);
      await safeBroadcastTrip(ctx, tripId, 'spend:added', { amount_yen: amount });
      return json(200, { spent_yen: totalRows[0].s });
    } },
    { method: 'GET', path: '/fx', auth: true, async handler(req, ctx) {
      const { userId } = await requireTrip(req, ctx);
      const prefs = await loadUserPrefs(ctx, userId);
      let fx = await cacheGet(ctx, 'fx'); if (isStale(fx, FX_TTL)) { const r = await attempt(() => refreshFx(ctx)); if (r.ok) fx = r.value; }
      const rate = fx && fx.data && fx.data.rates ? fx.data.rates[prefs.home_currency] : null;
      return json(200, { base: 'JPY', currency: prefs.home_currency, symbol: CURRENCY_SYMBOL[prefs.home_currency] || prefs.home_currency, rate, rates: fx && fx.data ? fx.data.rates : null, per_1000_yen: rate != null ? 1000 * rate : null, fetched_at: fx ? fx.fetched_at : null, source_updated: fx && fx.data ? fx.data.source_updated : null });
    } },
    // Native budget items (Costs addon) — read (getByTrip + listMine), create, update, delete
    { method: 'GET', path: '/costs', auth: true, async handler(req, ctx) {
      const { tripId } = await requireTrip(req, ctx);
      const byTrip = await attempt(() => ctx.costs.getByTrip(tripId));
      if (!byTrip.ok) return json(200, { available: false, error: byTrip.error, items: [] });
      const mine = await attempt(() => ctx.costs.listMine());
      const norm = function (c) { return { id: c.id, name: c.name || c.title || '', amount: costAmount(c), currency: costCurrency(c) }; };
      return json(200, { available: true, items: (byTrip.value || []).map(norm), mine_count: mine.ok ? (mine.value || []).length : null });
    } },
    { method: 'POST', path: '/costs/add', auth: true, async handler(req, ctx) {
      const body = await readBody(req);
      const { tripId } = await requireTrip(req, ctx, body.tripId);
      const name = String(body.name || '').slice(0, 200); if (!name) return json(400, { error: 'name required' });
      const amount = Math.round(toNum(body.amount, 0));
      const r = await attempt(() => ctx.costs.create(tripId, { name, total_price: amount, currency: 'JPY' }));
      if (!r.ok) return json(400, { error: r.error });
      await logActivity(ctx, tripId, 'budget:created');
      return json(200, { item: r.value });
    } },
    { method: 'POST', path: '/costs/update', auth: true, async handler(req, ctx) {
      const body = await readBody(req);
      const { tripId } = await requireTrip(req, ctx, body.tripId);
      const itemId = toNum(body.itemId, null); if (itemId == null) return json(400, { error: 'itemId required' });
      const input = {}; if (body.name != null) input.name = String(body.name).slice(0, 200); if (body.amount != null) input.total_price = Math.round(toNum(body.amount, 0));
      const r = await attempt(() => ctx.costs.update(tripId, itemId, input));
      if (!r.ok) return json(400, { error: r.error });
      return json(200, { item: r.value });
    } },
    { method: 'POST', path: '/costs/delete', auth: true, async handler(req, ctx) {
      const body = await readBody(req);
      const { tripId } = await requireTrip(req, ctx, body.tripId);
      const itemId = toNum(body.itemId, null); if (itemId == null) return json(400, { error: 'itemId required' });
      const r = await attempt(() => ctx.costs.delete(tripId, itemId));
      if (!r.ok) return json(400, { error: r.error });
      return json(200, { deleted: r.value && r.value.deleted !== false });
    } },
    // Push all un-synced plugin expenses into TREK's native budget
    { method: 'POST', path: '/costs/sync', auth: true, async handler(req, ctx) {
      const body = await readBody(req);
      const { tripId } = await requireTrip(req, ctx, body.tripId);
      const spends = await ctx.db.query('SELECT id, amount_yen, note FROM spend WHERE trip_id = ?', tripId);
      const done = await ctx.db.query('SELECT spend_id FROM cost_sync');
      const doneSet = {}; done.forEach(function (r) { doneSet[r.spend_id] = true; });
      let created = 0, failed = 0, first_error = null;
      for (const s of spends) {
        if (doneSet[s.id]) continue;
        const r = await attempt(() => ctx.costs.create(tripId, { name: s.note || 'Expense', total_price: s.amount_yen, currency: 'JPY' }));
        if (r.ok) { created++; await ctx.db.exec('INSERT INTO cost_sync(spend_id, cost_id, at) VALUES(?, ?, ?)', s.id, (r.value && r.value.id) || null, nowIso()); }
        else { failed++; if (!first_error) first_error = r.error; }
      }
      return json(200, { created, failed, error: first_error });
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
      await ctx.db.exec('INSERT INTO ic_balance(user_id, yen, updated_at) VALUES(?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET yen=excluded.yen, updated_at=excluded.updated_at', userId, yen, at);
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
      return json(200, { food: foodMap, prefectures: PREFECTURES, visited: visited.map(function (v) { return v.code; }), visited_by: visited.reduce(function (a, v) { a[v.code] = names[v.by_user] || null; return a; }, {}), collections });
    } },
    { method: 'POST', path: '/food/inc', auth: true, async handler(req, ctx) {
      const body = await readBody(req);
      const { tripId } = await requireTrip(req, ctx, body.tripId);
      const kind = String(body.kind || '').slice(0, 40); if (!kind) return json(400, { error: 'kind required' });
      const delta = Math.trunc(toNum(body.delta, 1)) || 1;
      const cur = await ctx.db.query('SELECT count FROM food_tally WHERE trip_id = ? AND kind = ?', tripId, kind);
      const next = Math.max(0, (cur.length ? cur[0].count : 0) + delta);
      await ctx.db.exec('INSERT INTO food_tally(trip_id, kind, count, at) VALUES(?, ?, ?, ?) ON CONFLICT(trip_id, kind) DO UPDATE SET count=excluded.count, at=excluded.at', tripId, kind, next, nowIso());
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
      await safeBroadcastTrip(ctx, tripId, 'prefecture:changed', { code, visited });
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

    // ---- 7. Season & events + write into the trip planner ------------------
    { method: 'GET', path: '/season', auth: true, async handler(req, ctx) {
      const { trip, tripId } = await requireTrip(req, ctx);
      const td = tripDates(trip);
      const months = tripMonths(td.start, td.end);
      const visited = await ctx.db.query('SELECT code FROM visited_prefs WHERE trip_id = ?', tripId);
      const visitedSet = new Set(visited.map(function (v) { return v.code; }));
      const prefBy = {}; PREFECTURES.forEach(function (p) { prefBy[p.code] = p; });
      const enr = function (code) { const p = prefBy[code]; return p ? { pref_name: p.name, region: p.region, pref_jp: p.jp } : {}; };
      const sakura = SAKURA.map(function (s) { return Object.assign({}, s, enr(s.prefecture_code), { in_window: months == null ? false : months.includes(mmToMonth(s.sakura_avg)), koyo_in_window: months == null ? false : months.includes(mmToMonth(s.koyo_avg)) }); });
      const matsuri = MATSURI.map(function (m) { return Object.assign({}, m, enr(m.prefecture_code), { in_window: months == null ? false : months.includes(m.month), nearby: visitedSet.has(m.prefecture_code) }); }).sort(function (a, b) { return (Number(b.in_window) - Number(a.in_window)) || (Number(b.nearby) - Number(a.nearby)) || (a.month - b.month); });
      return json(200, { sakura, matsuri, trip_months: months, trip: { start: td.start, end: td.end } });
    } },
    // Current planner places (db:read:trips)
    { method: 'GET', path: '/itinerary', auth: true, async handler(req, ctx) {
      const { tripId } = await requireTrip(req, ctx);
      const r = await attempt(() => ctx.trips.getPlaces(tripId));
      const places = r.ok ? (r.value || []).map(function (p) { return { id: p.id, name: p.name || p.title || '', notes: p.notes || null }; }) : [];
      return json(200, { available: r.ok, error: r.ok ? null : r.error, places });
    } },
    // Add an event/city to the planner: create a place (+ optional day + assignment),
    // tag it via ctx.meta and mirror the note for the place-detail hook.
    { method: 'POST', path: '/itinerary/add', auth: true, async handler(req, ctx) {
      const body = await readBody(req);
      const { userId, tripId, trip } = await requireTrip(req, ctx, body.tripId);
      const name = String(body.name || '').slice(0, 200); if (!name) return json(400, { error: 'name required' });
      const notes = String(body.notes || '').slice(0, 2000);
      // Geo-locate: explicit lat/lng (e.g. a curated spot) wins, else look the
      // city up in the bundled gazetteer so the pin still lands in Japan.
      const blat = toNum(body.lat, null), blng = toNum(body.lng != null ? body.lng : body.lon, null);
      const geo = cityCoords(body.city || name);
      const placeInput = { name, notes };
      if (blat != null && blng != null) { placeInput.lat = blat; placeInput.lng = blng; }
      else if (geo) { placeInput.lat = geo.lat; placeInput.lng = geo.lng; }
      const placeRes = await attempt(() => ctx.places.create(tripId, placeInput));
      if (!placeRes.ok) return json(400, { error: placeRes.error });
      const place = placeRes.value; const placeId = place && place.id;
      // Resolve a date: explicit body.date, else a date inside the trip window
      // that matches the event's month (so the matsuri lands on the itinerary).
      let dateStr = body.date ? String(body.date) : null;
      if (!dateStr && body.month != null) dateStr = dateForMonth(trip, toNum(body.month, null));
      let dayId = null, assigned = false;
      if (dateStr && placeId != null) {
        const dayRes = await attempt(() => ctx.days.create(tripId, { date: dateStr }));
        if (dayRes.ok && dayRes.value) { dayId = dayRes.value.id; const asg = await attempt(() => ctx.itinerary.assign(tripId, dayId, placeId)); assigned = asg.ok; }
      }
      // Short, distinct note for the place-detail hook (not a copy of the description).
      const hookNote = String(body.hook_note || ('Added from TREK × Japan' + (body.tag ? ' · ' + String(body.tag).slice(0, 40) : ''))).slice(0, 200);
      if (placeId != null) {
        await attempt(() => ctx.meta.set('place', placeId, 'source', 'trek-x-japan'));
        await attempt(() => ctx.meta.set('place', placeId, 'note', hookNote));
        await ctx.db.exec('INSERT INTO place_notes(place_id, trip_id, note, by_user, at) VALUES(?, ?, ?, ?, ?) ON CONFLICT(place_id) DO UPDATE SET note=excluded.note, by_user=excluded.by_user, at=excluded.at', placeId, tripId, hookNote, userId, nowIso());
      }
      return json(200, { place: place, day_id: dayId, assigned, located: (blat != null && blng != null) || !!geo });
    } },
    { method: 'POST', path: '/itinerary/place/update', auth: true, async handler(req, ctx) {
      const body = await readBody(req);
      const { tripId } = await requireTrip(req, ctx, body.tripId);
      const placeId = toNum(body.placeId, null); if (placeId == null) return json(400, { error: 'placeId required' });
      const input = {}; if (body.name != null) input.name = String(body.name).slice(0, 200); if (body.notes != null) input.notes = String(body.notes).slice(0, 2000);
      const r = await attempt(() => ctx.places.update(tripId, placeId, input));
      if (!r.ok) return json(400, { error: r.error });
      if (body.notes != null) { await attempt(() => ctx.meta.set('place', placeId, 'note', String(body.notes).slice(0, 2000))); await ctx.db.exec('INSERT INTO place_notes(place_id, trip_id, note, at) VALUES(?, ?, ?, ?) ON CONFLICT(place_id) DO UPDATE SET note=excluded.note, at=excluded.at', placeId, tripId, String(body.notes).slice(0, 2000), nowIso()); }
      return json(200, { place: r.value });
    } },
    { method: 'POST', path: '/itinerary/place/delete', auth: true, async handler(req, ctx) {
      const body = await readBody(req);
      const { tripId } = await requireTrip(req, ctx, body.tripId);
      const placeId = toNum(body.placeId, null); if (placeId == null) return json(400, { error: 'placeId required' });
      const r = await attempt(() => ctx.places.delete(tripId, placeId));
      if (!r.ok) return json(400, { error: r.error });
      await attempt(() => ctx.meta.delete('place', placeId, 'note'));
      await ctx.db.exec('DELETE FROM place_notes WHERE place_id = ?', placeId);
      return json(200, { deleted: r.value && r.value.deleted !== false });
    } },
    { method: 'POST', path: '/itinerary/day/update', auth: true, async handler(req, ctx) {
      const body = await readBody(req);
      const { tripId } = await requireTrip(req, ctx, body.tripId);
      const dayId = toNum(body.dayId, null); if (dayId == null) return json(400, { error: 'dayId required' });
      const input = {}; if (body.title != null) input.title = String(body.title).slice(0, 200); if (body.notes != null) input.notes = String(body.notes).slice(0, 2000);
      const r = await attempt(() => ctx.days.update(tripId, dayId, input));
      if (!r.ok) return json(400, { error: r.error });
      return json(200, { day: r.value });
    } },
    { method: 'POST', path: '/itinerary/unassign', auth: true, async handler(req, ctx) {
      const body = await readBody(req);
      const { tripId } = await requireTrip(req, ctx, body.tripId);
      const assignmentId = toNum(body.assignmentId, null); if (assignmentId == null) return json(400, { error: 'assignmentId required' });
      const r = await attempt(() => ctx.itinerary.unassign(tripId, assignmentId));
      if (!r.ok) return json(400, { error: r.error });
      return json(200, { deleted: r.value && r.value.deleted !== false });
    } },

    // ---- 8. Safety & weather ------------------------------------------------
    { method: 'GET', path: '/safety', auth: true, async handler(req, ctx) {
      const { tripId } = await requireTrip(req, ctx);
      const tp = await loadTripPrefs(ctx, tripId);
      const c = coords(tp);
      let weatherKey = 'weather'; if (c) weatherKey = 'weather:' + c.lat.toFixed(3) + ',' + c.lon.toFixed(3);
      let weather = c ? await cacheGet(ctx, weatherKey) : null;
      if (c && isStale(weather, WEATHER_TTL)) { const r = await attempt(() => refreshWeather(ctx, c.lat, c.lon, weatherKey)); if (r.ok) weather = r.value; }
      let quake = await cacheGet(ctx, 'quake'); if (isStale(quake, QUAKE_TTL)) { const r = await attempt(() => refreshQuake(ctx)); if (r.ok) quake = r.value; }
      return json(200, {
        location: c ? { lat: c.lat, lon: c.lon, city: tp.weather_city || null } : { city: tp.weather_city || null, configured: false },
        weather: weather && weather.data ? weather.data : null, weather_fetched_at: weather ? weather.fetched_at : null,
        quakes: quake && quake.data ? quake.data.items : [], quake_fetched_at: quake ? quake.fetched_at : null,
        emergency: PHRASES.filter(function (p) { return p.category === EMERGENCY_PHRASE_CATEGORY; }),
      });
    } },

    // ---- Trip-level integrations: ctx.trips.update + ctx.meta (get/set/list/delete)
    { method: 'POST', path: '/trip/currency', auth: true, async handler(req, ctx) {
      const body = await readBody(req);
      const { tripId } = await requireTrip(req, ctx, body.tripId);
      const r = await attempt(() => ctx.trips.update(tripId, { currency: 'JPY' }));
      if (!r.ok) return json(400, { error: r.error });
      return json(200, { trip: r.value, currency: (r.value && r.value.currency) || null });
    } },
    // Local city search (bundled JP gazetteer) — fills the trip weather location.
    { method: 'GET', path: '/geocode', auth: true, async handler(req, ctx) {
      requireUser(req);
      const q = String((req.query && (req.query.q || req.query.query)) || '').trim().toLowerCase();
      let items = CITIES;
      if (q) items = CITIES.filter(function (c) { return c.name.toLowerCase().includes(q) || (c.pref && c.pref.toLowerCase().includes(q)); });
      return json(200, { results: items.slice(0, 12).map(function (c) { return { name: c.name, pref: c.pref || null, lat: c.lat, lon: c.lon }; }), total: CITIES.length });
    } },
    { method: 'GET', path: '/trip/meta', auth: true, async handler(req, ctx) {
      const { tripId } = await requireTrip(req, ctx);
      const r = await attempt(() => ctx.meta.list('trip', tripId));
      return json(200, { available: r.ok, meta: r.ok ? r.value : {}, error: r.ok ? null : r.error });
    } },
    { method: 'POST', path: '/trip/pin', auth: true, async handler(req, ctx) {
      const body = await readBody(req);
      const { userId, tripId } = await requireTrip(req, ctx, body.tripId);
      const text = String(body.text || '').slice(0, 4000);
      // Persist in our own shared table (the reliable store); mirror into the
      // native ctx.meta best-effort so other TREK surfaces can see it too, but
      // never fail the request when that host namespace is unavailable.
      if (!text) {
        await ctx.db.exec('DELETE FROM pinned_tips WHERE trip_id = ?', tripId);
        await attempt(() => ctx.meta.delete('trip', tripId, 'pinned_tips'));
        await safeBroadcastTrip(ctx, tripId, 'pin:changed', {});
        return json(200, { pinned_tips: null, cleared: true });
      }
      await ctx.db.exec('INSERT INTO pinned_tips(trip_id, text, by_user, at) VALUES(?, ?, ?, ?) ON CONFLICT(trip_id) DO UPDATE SET text=excluded.text, by_user=excluded.by_user, at=excluded.at', tripId, text, userId, nowIso());
      await attempt(() => ctx.meta.set('trip', tripId, 'pinned_tips', text));
      await safeBroadcastTrip(ctx, tripId, 'pin:changed', {});
      return json(200, { pinned_tips: text });
    } },
    // ---- Transport: JR Pass planner (shared per-trip leg selection) ---------
    { method: 'GET', path: '/transport', auth: true, async handler(req, ctx) {
      const { tripId } = await requireTrip(req, ctx);
      const rows = await ctx.db.query('SELECT leg_key, qty FROM transport_legs WHERE trip_id = ?', tripId);
      const selected = {}; rows.forEach(function (r) { if (r.qty > 0) selected[r.leg_key] = r.qty; });
      return json(200, { jr_pass: TRANSPORT.jr_pass, legs: TRANSPORT.legs, fares_note: TRANSPORT.fares_note, selected });
    } },
    { method: 'POST', path: '/transport/leg', auth: true, async handler(req, ctx) {
      const body = await readBody(req);
      const { userId, tripId } = await requireTrip(req, ctx, body.tripId);
      const key = String(body.key || '');
      if (!TRANSPORT.legs.some(function (l) { return l.key === key; })) return json(400, { error: 'unknown leg' });
      let qty = Math.max(0, Math.min(20, Math.round(toNum(body.qty, 0))));
      if (qty === 0) await ctx.db.exec('DELETE FROM transport_legs WHERE trip_id = ? AND leg_key = ?', tripId, key);
      else await ctx.db.exec('INSERT INTO transport_legs(trip_id, leg_key, qty, by_user, at) VALUES(?, ?, ?, ?, ?) ON CONFLICT(trip_id, leg_key) DO UPDATE SET qty=excluded.qty, by_user=excluded.by_user, at=excluded.at', tripId, key, qty, userId, nowIso());
      await safeBroadcastTrip(ctx, tripId, 'transport:changed', {});
      return json(200, { key, qty });
    } },
    // ---- Spots: curated must-see catalogue (add straight to the planner) -----
    { method: 'GET', path: '/spots', auth: true, async handler(req, ctx) {
      await requireTrip(req, ctx);
      const cities = [];
      SPOTS.forEach(function (s) { if (cities.indexOf(s.city) < 0) cities.push(s.city); });
      return json(200, { cities, spots: SPOTS });
    } },
    // ---- Dishes: menu decoder ------------------------------------------------
    { method: 'GET', path: '/dishes', auth: true, async handler(req, ctx) {
      await requireTrip(req, ctx);
      const cats = [];
      DISHES.forEach(function (dsh) { if (cats.indexOf(dsh.cat) < 0) cats.push(dsh.cat); });
      return json(200, { cats, dishes: DISHES });
    } },
    // ---- Essentials: konbini chains, ATMs, lockers, luggage, drugstores … -----
    { method: 'GET', path: '/poi', auth: true, async handler(req, ctx) {
      await requireTrip(req, ctx);
      const cats = [];
      POI.forEach(function (p) { if (cats.indexOf(p.cat) < 0) cats.push(p.cat); });
      return json(200, { cats, poi: POI });
    } },
    // ---- Smoking: every designated smoking AREA + every indoor smoking-OK VENUE
    // in Japan (bundled). kind=venue switches to cafés/izakaya that still permit
    // smoking after the 2020 indoor ban. lat/lon → nearest-first with distances.
    { method: 'GET', path: '/smoking', auth: true, async handler(req, ctx) {
      await requireTrip(req, ctx);
      const kind = String((req.query && req.query.kind) || 'area') === 'venue' ? 'venue' : 'area';
      const DATA = kind === 'venue' ? SMOKING_VENUES : SMOKING;
      const lat = toNum(req.query && req.query.lat, null), lon = toNum(req.query && req.query.lon, null);
      const cityCounts = {};
      DATA.forEach(function (s) { if (s.near) cityCounts[s.near] = (cityCounts[s.near] || 0) + 1; });
      const cities = Object.keys(cityCounts).map(function (n) { return { name: n, n: cityCounts[n] }; }).sort(function (a, b) { return b.n - a.n; });
      const attribution = kind === 'venue'
        ? 'OpenStreetMap contributors (ODbL)'
        : 'OpenStreetMap contributors (ODbL) · Tokyo Open Data 台東区 (CC BY 4.0)';
      if (lat != null && lon != null) {
        const withD = DATA.map(function (s) { return { lat: s.lat, lon: s.lon, name: s.name || null, en: s.en || null, near: s.near || null, type: s.type || null, smk: s.smk || null, official: !!s.official, hours: s.hours || null, km: haversineKm(lat, lon, s.lat, s.lon) }; });
        withD.sort(function (a, b) { return a.km - b.km; });
        return json(200, { kind, count: DATA.length, cities, nearest: withD.slice(0, 60), attribution });
      }
      // Venues (~3500) are too large to ship whole — return city counts only and
      // let the client fetch nearest-first once it has a location. Areas (~1300)
      // are light enough to bundle so nearest is instant on "use my location".
      if (kind === 'venue') return json(200, { kind, count: DATA.length, cities, points: [], attribution });
      return json(200, { kind, count: DATA.length, cities, points: DATA, attribution });
    } },
    // ---- Nearby (live): konbini / ATMs / pharmacies around a point (Overpass) --
    { method: 'GET', path: '/nearby', auth: true, async handler(req, ctx) {
      await requireTrip(req, ctx);
      const lat = toNum(req.query && req.query.lat, null), lon = toNum(req.query && req.query.lon, null);
      const kind = String((req.query && req.query.kind) || 'konbini');
      const filter = OVERPASS_FILTERS[kind];
      if (lat == null || lon == null) return json(400, { error: 'lat/lon required' });
      if (!filter) return json(400, { error: 'unknown kind' });
      const key = 'nearby:' + kind + ':' + lat.toFixed(3) + ',' + lon.toFixed(3);
      const cached = await cacheGet(ctx, key);
      if (cached && cached.data && !isStale(cached, 60 * 60 * 1000)) return json(200, cached.data, 'private, max-age=300');
      try {
        const r = 0.018;
        const bbox = (lat - r) + ',' + (lon - r * 1.25) + ',' + (lat + r) + ',' + (lon + r * 1.25);
        const q = '[out:json][timeout:20];(' + filter.map(function (f) { return 'node[' + f + '](' + bbox + ');'; }).join('') + ');out 80;';
        const res = await fetch('https://overpass-api.de/api/interpreter', { method: 'POST', signal: AbortSignal.timeout(FETCH_TIMEOUT + 6000), headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: 'data=' + encodeURIComponent(q) });
        if (!res.ok) throw new Error('http ' + res.status);
        const j = await res.json();
        const items = (j.elements || []).map(function (e) {
          const t = e.tags || {};
          return { lat: e.lat, lon: e.lon, name: t['brand:en'] || t.brand || t.name || null, km: haversineKm(lat, lon, e.lat, e.lon) };
        }).filter(function (x) { return x.lat != null && x.lon != null; });
        items.sort(function (a, b) { return a.km - b.km; });
        const data = { kind, items: items.slice(0, 40), attribution: 'OpenStreetMap contributors (ODbL)' };
        await cacheSet(ctx, key, data);
        return json(200, data, 'private, max-age=300');
      } catch (e) { return json(200, { kind, items: [], error: 'unavailable' }); }
    } },
    // On-demand translator via the keyless MyMemory API (EN/DE <-> JA).
    { method: 'POST', path: '/translate', auth: true, async handler(req, ctx) {
      requireUser(req);
      const body = await readBody(req);
      const q = String(body.q || '').slice(0, 500).trim();
      if (!q) return json(400, { error: 'empty' });
      const dir = String(body.dir || 'en-ja');
      const pair = dir === 'ja-en' ? 'ja|en' : dir === 'de-ja' ? 'de|ja' : dir === 'ja-de' ? 'ja|de' : 'en|ja';
      try {
        const raw = await timedFetch('https://api.mymemory.translated.net/get?q=' + encodeURIComponent(q) + '&langpair=' + pair);
        const t = raw && raw.responseData && raw.responseData.translatedText;
        if (!t) return json(200, { text: null, error: 'no result' });
        return json(200, { text: String(t), match: (raw.responseData && raw.responseData.match) || null });
      } catch (e) { return json(200, { text: null, error: 'unavailable' }); }
    } },
    // Latest Japan news (English) — cached RSS from Japan Today.
    { method: 'GET', path: '/news', auth: true, async handler(req, ctx) {
      requireUser(req);
      const cached = await cacheGet(ctx, 'news');
      if (cached && cached.data && !isStale(cached, 30 * 60 * 1000)) return json(200, { items: cached.data.items || [], fetched_at: cached.fetched_at, source: 'Japan Today' }, 'private, max-age=300');
      try { const r = await refreshNews(ctx); return json(200, { items: r.data.items || [], fetched_at: r.fetched_at, source: 'Japan Today' }, 'private, max-age=300'); }
      catch (e) {
        if (cached && cached.data) return json(200, { items: cached.data.items || [], fetched_at: cached.fetched_at, source: 'Japan Today', stale: true });
        return json(200, { items: [], error: 'unavailable' });
      }
    } },
    // Native TREK reservations (flights / trains / stays from Transports & Book).
    { method: 'GET', path: '/reservations', auth: true, async handler(req, ctx) {
      const { tripId, userId } = await requireTrip(req, ctx);
      const r = await attempt(() => ctx.trips.getReservations(tripId, userId));
      if (!r.ok) return json(200, { available: false, items: [] });
      const items = (Array.isArray(r.value) ? r.value : []).map(normReservation).filter(Boolean);
      items.sort(function (a, b) { return String(a.start || '~').localeCompare(String(b.start || '~')); });
      return json(200, { available: true, items });
    } },
  ],
};

PLUGIN.routes = PLUGIN.routes.map(function (r) { return Object.assign({}, r, { handler: wrapHandler(r.handler) }); });

module.exports = definePlugin(PLUGIN);
