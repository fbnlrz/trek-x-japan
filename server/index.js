// TREK × Japan — server entry. Built CommonJS, runs in an isolated child process.
// Everything reaches TREK through `ctx` over RPC.
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

// ---------------------------------------------------------------------------
// Static prep/packing checklist (id + labels). Local; only the per-user done
// flags are persisted.
// ---------------------------------------------------------------------------
const CHECKLIST_ITEMS = [
  { id: 'jr_pass', en: 'JR Pass ordered / activated', de: 'JR Pass bestellt / aktiviert', group: 'docs' },
  { id: 'passport', en: 'Passport valid 6+ months', de: 'Reisepass 6+ Monate gültig', group: 'docs' },
  { id: 'visit_japan_web', en: 'Visit Japan Web registered', de: 'Visit Japan Web registriert', group: 'docs' },
  { id: 'travel_insurance', en: 'Travel insurance booked', de: 'Reiseversicherung gebucht', group: 'docs' },
  { id: 'pocket_wifi', en: 'Pocket WiFi reserved', de: 'Pocket-WiFi reserviert', group: 'connectivity' },
  { id: 'esim', en: 'eSIM installed', de: 'eSIM installiert', group: 'connectivity' },
  { id: 'ic_card_app', en: 'IC card (Suica/Pasmo) in wallet app', de: 'IC-Karte (Suica/Pasmo) in Wallet-App', group: 'connectivity' },
  { id: 'cash', en: 'Cash / yen withdrawn', de: 'Bargeld / Yen abgehoben', group: 'money' },
  { id: 'card_notify', en: 'Bank notified of travel', de: 'Bank über Reise informiert', group: 'money' },
  { id: 'adapter', en: 'Type A power adapter', de: 'Typ-A Stromadapter', group: 'gear' },
  { id: 'power_bank', en: 'Power bank charged', de: 'Powerbank geladen', group: 'gear' },
  { id: 'meds', en: 'Medication + copy of prescription', de: 'Medikamente + Rezeptkopie', group: 'gear' },
  { id: 'shoes', en: 'Comfortable walking shoes (easy off)', de: 'Bequeme Schuhe (leicht auszuziehen)', group: 'gear' },
  { id: 'coin_purse', en: 'Coin purse for change', de: 'Münzbörse für Kleingeld', group: 'gear' },
  { id: 'translation_app', en: 'Offline translation app', de: 'Offline-Übersetzungs-App', group: 'connectivity' },
  { id: 'maps_offline', en: 'Offline maps downloaded', de: 'Offline-Karten geladen', group: 'connectivity' },
  { id: 'reservations', en: 'Key reservations (ryokan, restaurants)', de: 'Wichtige Reservierungen (Ryokan, Restaurants)', group: 'docs' },
  { id: 'trash_bag', en: 'Small bag for your trash', de: 'Kleiner Beutel für Müll', group: 'gear' },
];

const EMERGENCY_PHRASE_CATEGORY = 'emergency';

// ---------------------------------------------------------------------------
// Preference model. TREK 3.2.0 does not surface `scope:user` settings into
// `ctx.config`, so we persist per-user preferences in our own DB table and
// merge them over any instance-scoped defaults from `ctx.config`.
// ---------------------------------------------------------------------------
const PREF_KEYS = [
  'home_currency', 'low_ic_threshold', 'ic_card',
  'home_lat', 'home_lon', 'weather_city',
  'trip_start', 'trip_end', 'trip_id',
];
const PREF_DEFAULTS = { home_currency: 'EUR', low_ic_threshold: '1000' };

const CURRENCY_SYMBOL = { EUR: '€', USD: '$', GBP: '£', CHF: 'Fr.' };

// Cache freshness windows (ms).
const FX_TTL = 6 * 60 * 60 * 1000;      // 6h
const WEATHER_TTL = 30 * 60 * 1000;     // 30min
const QUAKE_TTL = 15 * 60 * 1000;       // 15min

const FETCH_TIMEOUT = 8000;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
function json(status, obj, cacheControl) {
  const headers = { 'content-type': 'application/json' };
  if (cacheControl) headers['cache-control'] = cacheControl;
  return { status, headers, body: JSON.stringify(obj) };
}
function nowIso() { return new Date().toISOString(); }
function toNum(v, fallback) {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}
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

async function timedFetch(url) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
    headers: { 'accept': 'application/json' },
  });
  if (!res.ok) throw new Error('http ' + res.status);
  return res.json();
}

// --- cache table access ---
async function cacheGet(ctx, key) {
  const rows = await ctx.db.query('SELECT json, fetched_at FROM cache WHERE key = ?', key);
  if (!rows.length) return null;
  let parsed = null;
  try { parsed = JSON.parse(rows[0].json); } catch (_) { parsed = null; }
  return { data: parsed, fetched_at: rows[0].fetched_at };
}
async function cacheSet(ctx, key, data) {
  const at = nowIso();
  await ctx.db.exec(
    'INSERT INTO cache(key, json, fetched_at) VALUES(?, ?, ?) ' +
    'ON CONFLICT(key) DO UPDATE SET json = excluded.json, fetched_at = excluded.fetched_at',
    key, JSON.stringify(data), at);
  return at;
}
function isStale(entry, ttl) {
  if (!entry || !entry.fetched_at) return true;
  const t = Date.parse(entry.fetched_at);
  return !Number.isFinite(t) || (Date.now() - t) > ttl;
}

// --- preferences ---
async function loadPrefs(ctx, userId) {
  const out = Object.assign({}, PREF_DEFAULTS);
  // instance-scoped values (if an admin ever sets any) as a base layer
  for (const k of PREF_KEYS) {
    if (ctx.config && ctx.config[k] != null && ctx.config[k] !== '') out[k] = String(ctx.config[k]);
  }
  const rows = await ctx.db.query('SELECT key, value FROM prefs WHERE user_id = ?', userId);
  for (const r of rows) if (PREF_KEYS.includes(r.key)) out[r.key] = r.value;
  return out;
}
async function savePref(ctx, userId, key, value) {
  await ctx.db.exec(
    'INSERT INTO prefs(user_id, key, value) VALUES(?, ?, ?) ' +
    'ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value',
    userId, key, value == null ? '' : String(value));
}

// Resolve weather coordinates from prefs (lat/lon win; else null).
function coords(prefs) {
  const lat = toNum(prefs.home_lat, null);
  const lon = toNum(prefs.home_lon, null);
  if (lat != null && lon != null) return { lat, lon };
  return null;
}

// ---------------------------------------------------------------------------
// Remote refreshers (used by both cron jobs and — with a staleness guard — by
// routes, since TREK 3.2.x does not actually schedule plugin jobs).
// ---------------------------------------------------------------------------
async function refreshFx(ctx) {
  const raw = await timedFetch('https://open.er-api.com/v6/latest/JPY');
  const rates = (raw && raw.rates) || {};
  const data = {
    base: 'JPY',
    rates: { EUR: rates.EUR, USD: rates.USD, GBP: rates.GBP, CHF: rates.CHF },
    source_updated: raw && (raw.time_last_update_utc || null),
  };
  const at = await cacheSet(ctx, 'fx', data);
  return { data, fetched_at: at };
}

async function refreshWeather(ctx, lat, lon, cacheKey) {
  const url = 'https://api.open-meteo.com/v1/forecast'
    + '?latitude=' + encodeURIComponent(lat)
    + '&longitude=' + encodeURIComponent(lon)
    + '&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m'
    + '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max'
    + '&forecast_days=5&timezone=Asia%2FTokyo';
  const raw = await timedFetch(url);
  const data = {
    lat, lon,
    current: raw && raw.current ? {
      temp: raw.current.temperature_2m,
      humidity: raw.current.relative_humidity_2m,
      code: raw.current.weather_code,
      wind: raw.current.wind_speed_10m,
    } : null,
    daily: raw && raw.daily && Array.isArray(raw.daily.time) ? raw.daily.time.map((d, i) => ({
      date: d,
      code: raw.daily.weather_code[i],
      tmax: raw.daily.temperature_2m_max[i],
      tmin: raw.daily.temperature_2m_min[i],
      pop: raw.daily.precipitation_probability_max ? raw.daily.precipitation_probability_max[i] : null,
    })) : [],
  };
  const at = await cacheSet(ctx, cacheKey || 'weather', data);
  return { data, fetched_at: at };
}

async function refreshQuake(ctx) {
  const raw = await timedFetch('https://www.jma.go.jp/bosai/quake/data/list.json');
  const list = Array.isArray(raw) ? raw.slice(0, 12) : [];
  const data = {
    items: list.map((q) => ({
      time: q.at || q.rdt || null,
      place: q.anm || q.en_anm || '',
      mag: q.mag != null ? q.mag : null,
      intensity: q.maxi || null,
    })),
  };
  const at = await cacheSet(ctx, 'quake', data);
  return { data, fetched_at: at };
}

// ---------------------------------------------------------------------------
// Feature helpers
// ---------------------------------------------------------------------------
function dayOfYear(d) {
  const start = Date.UTC(d.getUTCFullYear(), 0, 0);
  return Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - start) / 86400000);
}
function daysUntil(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const today = new Date();
  const midnight = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Math.round((t - midnight) / 86400000);
}

// Resolve the trip window: prefer a linked TREK trip (via ctx.trips in the
// route handler, membership-checked), else the trip_start/trip_end prefs.
async function resolveTrip(ctx, userId, prefs) {
  const tripId = toNum(prefs.trip_id, null);
  if (tripId != null) {
    try {
      const trip = await ctx.trips.getById(tripId, userId);
      if (trip) {
        return {
          source: 'trek',
          title: trip.title || trip.name || null,
          start: trip.start_date || trip.startDate || null,
          end: trip.end_date || trip.endDate || null,
        };
      }
    } catch (e) {
      // no membership / no such trip / addon issue — fall through to prefs
      ctx.log.warn('trip lookup failed', { msg: String(e && e.message) });
    }
  }
  return { source: 'prefs', title: null, start: prefs.trip_start || null, end: prefs.trip_end || null };
}

function tripMonths(start, end) {
  if (!start) return null;
  const s = new Date(start);
  if (isNaN(s.getTime())) return null;
  const e = end ? new Date(end) : s;
  const months = new Set();
  let y = s.getUTCFullYear(), m = s.getUTCMonth();
  const ed = isNaN(e.getTime()) ? s : e;
  const ey = ed.getUTCFullYear(), em = ed.getUTCMonth();
  let guard = 0;
  while ((y < ey || (y === ey && m <= em)) && guard < 24) {
    months.add(m + 1);
    m++; if (m > 11) { m = 0; y++; }
    guard++;
  }
  return Array.from(months);
}

// IC balance adjust shared handler
async function icAdjust(req, ctx, kind) {
  const userId = requireUser(req);
  const body = await readBody(req);
  const amount = Math.max(0, Math.round(toNum(body.amount, 0)));
  if (!amount) return json(400, { error: 'amount required' });
  const b = await ctx.db.query('SELECT yen FROM ic_balance WHERE user_id = ?', userId);
  const cur = b.length ? b[0].yen : 0;
  const next = kind === 'charge' ? cur + amount : Math.max(0, cur - amount);
  const at = nowIso();
  await ctx.db.exec(
    'INSERT INTO ic_balance(user_id, yen, updated_at) VALUES(?, ?, ?) ' +
    'ON CONFLICT(user_id) DO UPDATE SET yen = excluded.yen, updated_at = excluded.updated_at', userId, next, at);
  await ctx.db.exec('INSERT INTO ic_ledger(user_id, kind, amount, balance_after, at) VALUES(?, ?, ?, ?, ?)',
    userId, kind, amount, next, at);
  return json(200, { yen: next, kind, amount });
}

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------
module.exports = definePlugin({
  async onLoad(ctx) {
    await ctx.db.migrate('001_checklist',
      'CREATE TABLE IF NOT EXISTS checklist (user_id INTEGER NOT NULL, item_id TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0, at TEXT, PRIMARY KEY(user_id, item_id))');
    await ctx.db.migrate('002_phrase_favs',
      'CREATE TABLE IF NOT EXISTS phrase_favs (user_id INTEGER NOT NULL, phrase_id TEXT NOT NULL, at TEXT, PRIMARY KEY(user_id, phrase_id))');
    await ctx.db.migrate('003_visited_prefs',
      'CREATE TABLE IF NOT EXISTS visited_prefs (user_id INTEGER NOT NULL, code TEXT NOT NULL, at TEXT, PRIMARY KEY(user_id, code))');
    await ctx.db.migrate('004_ic_balance',
      'CREATE TABLE IF NOT EXISTS ic_balance (user_id INTEGER PRIMARY KEY, yen INTEGER NOT NULL DEFAULT 0, updated_at TEXT)');
    await ctx.db.migrate('005_ic_ledger',
      'CREATE TABLE IF NOT EXISTS ic_ledger (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, kind TEXT NOT NULL, amount INTEGER NOT NULL, balance_after INTEGER NOT NULL, at TEXT)');
    await ctx.db.migrate('006_budget',
      'CREATE TABLE IF NOT EXISTS budget (user_id INTEGER PRIMARY KEY, planned_yen INTEGER NOT NULL DEFAULT 0)');
    await ctx.db.migrate('007_spend',
      'CREATE TABLE IF NOT EXISTS spend (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, amount_yen INTEGER NOT NULL, note TEXT, at TEXT)');
    await ctx.db.migrate('008_food_tally',
      'CREATE TABLE IF NOT EXISTS food_tally (user_id INTEGER NOT NULL, kind TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, at TEXT, PRIMARY KEY(user_id, kind))');
    await ctx.db.migrate('009_collect',
      'CREATE TABLE IF NOT EXISTS collect (user_id INTEGER NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL, at TEXT, PRIMARY KEY(user_id, kind, key))');
    await ctx.db.migrate('010_cache',
      'CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, json TEXT, fetched_at TEXT)');
    await ctx.db.migrate('011_prefs',
      'CREATE TABLE IF NOT EXISTS prefs (user_id INTEGER NOT NULL, key TEXT NOT NULL, value TEXT, PRIMARY KEY(user_id, key))');
    await ctx.db.migrate('012_phrase_state',
      'CREATE TABLE IF NOT EXISTS phrase_state (user_id INTEGER PRIMARY KEY, offset INTEGER NOT NULL DEFAULT 0)');
    ctx.log.info('TREK x Japan loaded');
  },

  async onUnload(ctx) { ctx.log.info('TREK x Japan unloading'); },

  // Declared for spec completeness. NOTE: TREK 3.2.0/3.2.1 has no cron runner,
  // so these never actually fire — the routes below refresh the same caches
  // on demand (with a staleness guard) so the page still works. Weather uses a
  // default location here because jobs have no acting user / user prefs.
  jobs: [
    { id: 'fx-refresh', schedule: '0 */6 * * *',
      async handler(ctx) { try { await refreshFx(ctx); } catch (e) { ctx.log.error('fx job failed', { msg: String(e && e.message) }); } } },
    { id: 'weather-refresh', schedule: '*/30 * * * *',
      async handler(ctx) { try { await refreshWeather(ctx, 35.6895, 139.6917, 'weather'); } catch (e) { ctx.log.error('weather job failed', { msg: String(e && e.message) }); } } },
    { id: 'quake-refresh', schedule: '*/15 * * * *',
      async handler(ctx) { try { await refreshQuake(ctx); } catch (e) { ctx.log.error('quake job failed', { msg: String(e && e.message) }); } } },
  ],

  routes: [
    // ---- meta / preferences -------------------------------------------------
    { method: 'GET', path: '/meta', auth: true, async handler(req, ctx) {
      const userId = requireUser(req);
      const prefs = await loadPrefs(ctx, userId);
      return json(200, {
        prefs,
        currency_symbol: CURRENCY_SYMBOL[prefs.home_currency] || prefs.home_currency,
        counts: {
          phrases: PHRASES.length, prefectures: PREFECTURES.length,
          etiquette: ETIQUETTE.length, gomi: GOMI.length,
          matsuri: MATSURI.length, sakura: SAKURA.length,
          checklist: CHECKLIST_ITEMS.length,
        },
      });
    } },
    { method: 'GET', path: '/prefs', auth: true, async handler(req, ctx) {
      const userId = requireUser(req);
      return json(200, { prefs: await loadPrefs(ctx, userId) });
    } },
    { method: 'POST', path: '/prefs', auth: true, async handler(req, ctx) {
      const userId = requireUser(req);
      const body = await readBody(req);
      const patch = body.prefs && typeof body.prefs === 'object' ? body.prefs : body;
      for (const k of PREF_KEYS) {
        if (Object.prototype.hasOwnProperty.call(patch, k)) await savePref(ctx, userId, k, patch[k]);
      }
      return json(200, { prefs: await loadPrefs(ctx, userId) });
    } },

    // ---- 1. Countdown & checklist ------------------------------------------
    { method: 'GET', path: '/checklist', auth: true, async handler(req, ctx) {
      const userId = requireUser(req);
      const prefs = await loadPrefs(ctx, userId);
      const trip = await resolveTrip(ctx, userId, prefs);
      const rows = await ctx.db.query('SELECT item_id, done FROM checklist WHERE user_id = ?', userId);
      const doneMap = {};
      for (const r of rows) doneMap[r.item_id] = !!r.done;
      const items = CHECKLIST_ITEMS.map((it) => ({ id: it.id, en: it.en, de: it.de, group: it.group, done: !!doneMap[it.id] }));
      const doneCount = items.filter((i) => i.done).length;
      return json(200, {
        trip: { source: trip.source, title: trip.title, start: trip.start, end: trip.end,
          days_until_start: daysUntil(trip.start), days_until_end: daysUntil(trip.end) },
        items, done: doneCount, total: items.length,
      });
    } },
    { method: 'POST', path: '/checklist/toggle', auth: true, async handler(req, ctx) {
      const userId = requireUser(req);
      const body = await readBody(req);
      const itemId = String(body.item_id || '');
      if (!CHECKLIST_ITEMS.some((i) => i.id === itemId)) return json(400, { error: 'unknown item' });
      const cur = await ctx.db.query('SELECT done FROM checklist WHERE user_id = ? AND item_id = ?', userId, itemId);
      const next = cur.length && cur[0].done ? 0 : 1;
      await ctx.db.exec(
        'INSERT INTO checklist(user_id, item_id, done, at) VALUES(?, ?, ?, ?) ' +
        'ON CONFLICT(user_id, item_id) DO UPDATE SET done = excluded.done, at = excluded.at',
        userId, itemId, next, nowIso());
      return json(200, { item_id: itemId, done: !!next });
    } },

    // ---- 2. Nihongo phrasebook ---------------------------------------------
    { method: 'GET', path: '/nihongo/state', auth: true, async handler(req, ctx) {
      const userId = requireUser(req);
      const st = await ctx.db.query('SELECT offset FROM phrase_state WHERE user_id = ?', userId);
      const offset = st.length ? st[0].offset : 0;
      const base = dayOfYear(new Date());
      const idx = (((base + offset) % PHRASES.length) + PHRASES.length) % PHRASES.length;
      const favRows = await ctx.db.query('SELECT phrase_id FROM phrase_favs WHERE user_id = ?', userId);
      const categories = Array.from(new Set(PHRASES.map((p) => p.category)));
      return json(200, {
        phrase_of_day: PHRASES[idx],
        phrases: PHRASES,
        categories,
        favorites: favRows.map((r) => r.phrase_id),
      });
    } },
    { method: 'POST', path: '/nihongo/next', auth: true, async handler(req, ctx) {
      const userId = requireUser(req);
      const st = await ctx.db.query('SELECT offset FROM phrase_state WHERE user_id = ?', userId);
      const offset = (st.length ? st[0].offset : 0) + 1;
      await ctx.db.exec(
        'INSERT INTO phrase_state(user_id, offset) VALUES(?, ?) ' +
        'ON CONFLICT(user_id) DO UPDATE SET offset = excluded.offset', userId, offset);
      const base = dayOfYear(new Date());
      const idx = (((base + offset) % PHRASES.length) + PHRASES.length) % PHRASES.length;
      return json(200, { phrase_of_day: PHRASES[idx] });
    } },
    { method: 'POST', path: '/nihongo/favorite', auth: true, async handler(req, ctx) {
      const userId = requireUser(req);
      const body = await readBody(req);
      const pid = String(body.phrase_id || '');
      if (!PHRASES.some((p) => p.id === pid)) return json(400, { error: 'unknown phrase' });
      const cur = await ctx.db.query('SELECT phrase_id FROM phrase_favs WHERE user_id = ? AND phrase_id = ?', userId, pid);
      let faved;
      if (cur.length) {
        await ctx.db.exec('DELETE FROM phrase_favs WHERE user_id = ? AND phrase_id = ?', userId, pid);
        faved = false;
      } else {
        await ctx.db.exec('INSERT INTO phrase_favs(user_id, phrase_id, at) VALUES(?, ?, ?)', userId, pid, nowIso());
        faved = true;
      }
      return json(200, { phrase_id: pid, favorite: faved });
    } },

    // ---- 3. Culture & gomi --------------------------------------------------
    { method: 'GET', path: '/etiquette', auth: true, async handler(req, ctx) {
      const categories = Array.from(new Set(ETIQUETTE.map((e) => e.category)));
      return json(200, { items: ETIQUETTE, categories }, 'max-age=3600');
    } },
    { method: 'GET', path: '/gomi', auth: true, async handler(req, ctx) {
      const q = String((req.query && (req.query.q || req.query.query)) || '').trim().toLowerCase();
      let items = GOMI;
      if (q) {
        items = GOMI.filter((g) =>
          (g.item_en && g.item_en.toLowerCase().includes(q)) ||
          (g.item_de && g.item_de.toLowerCase().includes(q)) ||
          (g.bin_en && g.bin_en.toLowerCase().includes(q)) ||
          (g.bin_de && g.bin_de.toLowerCase().includes(q)));
      }
      return json(200, { items, total: GOMI.length, query: q });
    } },

    // ---- 4. Yen & budget ----------------------------------------------------
    { method: 'GET', path: '/budget/state', auth: true, async handler(req, ctx) {
      const userId = requireUser(req);
      const prefs = await loadPrefs(ctx, userId);
      const b = await ctx.db.query('SELECT planned_yen FROM budget WHERE user_id = ?', userId);
      const planned = b.length ? b[0].planned_yen : 0;
      const spends = await ctx.db.query('SELECT id, amount_yen, note, at FROM spend WHERE user_id = ? ORDER BY id DESC LIMIT 100', userId);
      const totalRows = await ctx.db.query('SELECT COALESCE(SUM(amount_yen),0) AS s FROM spend WHERE user_id = ?', userId);
      const spent = totalRows.length ? totalRows[0].s : 0;
      let fx = await cacheGet(ctx, 'fx');
      if (isStale(fx, FX_TTL)) { try { fx = await refreshFx(ctx); } catch (e) { ctx.log.warn('fx refresh failed', { msg: String(e && e.message) }); } }
      const rate = fx && fx.data && fx.data.rates ? fx.data.rates[prefs.home_currency] : null;
      return json(200, {
        planned_yen: planned, spent_yen: spent, remaining_yen: planned - spent,
        spends,
        currency: prefs.home_currency, currency_symbol: CURRENCY_SYMBOL[prefs.home_currency] || prefs.home_currency,
        rate, fx_fetched_at: fx ? fx.fetched_at : null,
        planned_home: rate != null ? planned * rate : null,
        spent_home: rate != null ? spent * rate : null,
        remaining_home: rate != null ? (planned - spent) * rate : null,
      });
    } },
    { method: 'POST', path: '/budget/plan', auth: true, async handler(req, ctx) {
      const userId = requireUser(req);
      const body = await readBody(req);
      const yen = Math.max(0, Math.round(toNum(body.planned_yen, 0)));
      await ctx.db.exec(
        'INSERT INTO budget(user_id, planned_yen) VALUES(?, ?) ' +
        'ON CONFLICT(user_id) DO UPDATE SET planned_yen = excluded.planned_yen', userId, yen);
      return json(200, { planned_yen: yen });
    } },
    { method: 'POST', path: '/budget/spend', auth: true, async handler(req, ctx) {
      const userId = requireUser(req);
      const body = await readBody(req);
      const amount = Math.round(toNum(body.amount_yen, 0));
      if (!amount) return json(400, { error: 'amount required' });
      const note = String(body.note || '').slice(0, 200);
      await ctx.db.exec('INSERT INTO spend(user_id, amount_yen, note, at) VALUES(?, ?, ?, ?)', userId, amount, note, nowIso());
      const totalRows = await ctx.db.query('SELECT COALESCE(SUM(amount_yen),0) AS s FROM spend WHERE user_id = ?', userId);
      return json(200, { spent_yen: totalRows[0].s });
    } },
    { method: 'GET', path: '/fx', auth: true, async handler(req, ctx) {
      const userId = requireUser(req);
      const prefs = await loadPrefs(ctx, userId);
      let fx = await cacheGet(ctx, 'fx');
      if (isStale(fx, FX_TTL)) { try { fx = await refreshFx(ctx); } catch (e) { ctx.log.warn('fx refresh failed', { msg: String(e && e.message) }); } }
      const rate = fx && fx.data && fx.data.rates ? fx.data.rates[prefs.home_currency] : null;
      return json(200, {
        base: 'JPY', currency: prefs.home_currency, symbol: CURRENCY_SYMBOL[prefs.home_currency] || prefs.home_currency,
        rate, rates: fx && fx.data ? fx.data.rates : null,
        per_1000_yen: rate != null ? 1000 * rate : null,
        fetched_at: fx ? fx.fetched_at : null, source_updated: fx && fx.data ? fx.data.source_updated : null,
      });
    } },

    // ---- 5. IC card ---------------------------------------------------------
    { method: 'GET', path: '/ic/state', auth: true, async handler(req, ctx) {
      const userId = requireUser(req);
      const prefs = await loadPrefs(ctx, userId);
      const b = await ctx.db.query('SELECT yen, updated_at FROM ic_balance WHERE user_id = ?', userId);
      const yen = b.length ? b[0].yen : 0;
      const ledger = await ctx.db.query('SELECT id, kind, amount, balance_after, at FROM ic_ledger WHERE user_id = ? ORDER BY id DESC LIMIT 50', userId);
      const threshold = Math.round(toNum(prefs.low_ic_threshold, 1000));
      return json(200, {
        yen, updated_at: b.length ? b[0].updated_at : null,
        card: prefs.ic_card || null, low_threshold: threshold, low: yen < threshold,
        ledger,
      });
    } },
    { method: 'POST', path: '/ic/charge', auth: true, async handler(req, ctx) { return icAdjust(req, ctx, 'charge'); } },
    { method: 'POST', path: '/ic/spend', auth: true, async handler(req, ctx) { return icAdjust(req, ctx, 'spend'); } },
    { method: 'POST', path: '/ic/set', auth: true, async handler(req, ctx) {
      const userId = requireUser(req);
      const body = await readBody(req);
      const yen = Math.max(0, Math.round(toNum(body.yen, 0)));
      const at = nowIso();
      await ctx.db.exec(
        'INSERT INTO ic_balance(user_id, yen, updated_at) VALUES(?, ?, ?) ' +
        'ON CONFLICT(user_id) DO UPDATE SET yen = excluded.yen, updated_at = excluded.updated_at', userId, yen, at);
      await ctx.db.exec('INSERT INTO ic_ledger(user_id, kind, amount, balance_after, at) VALUES(?, ?, ?, ?, ?)', userId, 'set', yen, yen, at);
      return json(200, { yen });
    } },

    // ---- 6. Food & collect --------------------------------------------------
    { method: 'GET', path: '/collect/state', auth: true, async handler(req, ctx) {
      const userId = requireUser(req);
      const food = await ctx.db.query('SELECT kind, count FROM food_tally WHERE user_id = ?', userId);
      const foodMap = {};
      for (const f of food) foodMap[f.kind] = f.count;
      const visited = await ctx.db.query('SELECT code FROM visited_prefs WHERE user_id = ?', userId);
      const col = await ctx.db.query('SELECT kind, key, at FROM collect WHERE user_id = ? ORDER BY at DESC', userId);
      const collections = { onsen: [], goshuin: [], 'eki-stamp': [] };
      for (const c of col) { if (!collections[c.kind]) collections[c.kind] = []; collections[c.kind].push({ key: c.key, at: c.at }); }
      return json(200, {
        food: foodMap,
        prefectures: PREFECTURES,
        visited: visited.map((v) => v.code),
        collections,
      });
    } },
    { method: 'POST', path: '/food/inc', auth: true, async handler(req, ctx) {
      const userId = requireUser(req);
      const body = await readBody(req);
      const kind = String(body.kind || '').slice(0, 40);
      if (!kind) return json(400, { error: 'kind required' });
      const delta = Math.trunc(toNum(body.delta, 1)) || 1;
      const cur = await ctx.db.query('SELECT count FROM food_tally WHERE user_id = ? AND kind = ?', userId, kind);
      const next = Math.max(0, (cur.length ? cur[0].count : 0) + delta);
      await ctx.db.exec(
        'INSERT INTO food_tally(user_id, kind, count, at) VALUES(?, ?, ?, ?) ' +
        'ON CONFLICT(user_id, kind) DO UPDATE SET count = excluded.count, at = excluded.at', userId, kind, next, nowIso());
      return json(200, { kind, count: next });
    } },
    { method: 'POST', path: '/prefectures/toggle', auth: true, async handler(req, ctx) {
      const userId = requireUser(req);
      const body = await readBody(req);
      const code = String(body.code || '');
      if (!PREFECTURES.some((p) => p.code === code)) return json(400, { error: 'unknown prefecture' });
      const cur = await ctx.db.query('SELECT code FROM visited_prefs WHERE user_id = ? AND code = ?', userId, code);
      let visited;
      if (cur.length) { await ctx.db.exec('DELETE FROM visited_prefs WHERE user_id = ? AND code = ?', userId, code); visited = false; }
      else { await ctx.db.exec('INSERT INTO visited_prefs(user_id, code, at) VALUES(?, ?, ?)', userId, code, nowIso()); visited = true; }
      const cnt = await ctx.db.query('SELECT COUNT(*) AS n FROM visited_prefs WHERE user_id = ?', userId);
      return json(200, { code, visited, total_visited: cnt[0].n });
    } },
    { method: 'POST', path: '/collect/add', auth: true, async handler(req, ctx) {
      const userId = requireUser(req);
      const body = await readBody(req);
      const kind = String(body.kind || '');
      const key = String(body.key || '').trim().slice(0, 120);
      if (!['onsen', 'goshuin', 'eki-stamp'].includes(kind)) return json(400, { error: 'unknown kind' });
      if (!key) return json(400, { error: 'key required' });
      const cur = await ctx.db.query('SELECT key FROM collect WHERE user_id = ? AND kind = ? AND key = ?', userId, kind, key);
      let added;
      if (cur.length) { await ctx.db.exec('DELETE FROM collect WHERE user_id = ? AND kind = ? AND key = ?', userId, kind, key); added = false; }
      else { await ctx.db.exec('INSERT INTO collect(user_id, kind, key, at) VALUES(?, ?, ?, ?)', userId, kind, key, nowIso()); added = true; }
      return json(200, { kind, key, added });
    } },

    // ---- 7. Season & events -------------------------------------------------
    { method: 'GET', path: '/season', auth: true, async handler(req, ctx) {
      const userId = requireUser(req);
      const prefs = await loadPrefs(ctx, userId);
      const trip = await resolveTrip(ctx, userId, prefs);
      const months = tripMonths(trip.start, trip.end);
      const visited = await ctx.db.query('SELECT code FROM visited_prefs WHERE user_id = ?', userId);
      const visitedSet = new Set(visited.map((v) => v.code));
      const matsuri = MATSURI.map((m) => Object.assign({}, m, {
        in_window: months == null ? false : months.includes(m.month),
        nearby: visitedSet.has(m.prefecture_code),
      })).sort((a, b) => (Number(b.in_window) - Number(a.in_window)) || (Number(b.nearby) - Number(a.nearby)) || (a.month - b.month));
      return json(200, {
        sakura: SAKURA,
        matsuri,
        trip_months: months,
        trip: { source: trip.source, start: trip.start, end: trip.end },
      });
    } },

    // ---- 8. Safety & weather ------------------------------------------------
    { method: 'GET', path: '/safety', auth: true, async handler(req, ctx) {
      const userId = requireUser(req);
      const prefs = await loadPrefs(ctx, userId);
      const c = coords(prefs);
      let weatherKey = 'weather';
      if (c) weatherKey = 'weather:' + c.lat.toFixed(3) + ',' + c.lon.toFixed(3);
      let weather = await cacheGet(ctx, weatherKey);
      if (c && isStale(weather, WEATHER_TTL)) {
        try { weather = await refreshWeather(ctx, c.lat, c.lon, weatherKey); }
        catch (e) { ctx.log.warn('weather refresh failed', { msg: String(e && e.message) }); }
      }
      let quake = await cacheGet(ctx, 'quake');
      if (isStale(quake, QUAKE_TTL)) {
        try { quake = await refreshQuake(ctx); }
        catch (e) { ctx.log.warn('quake refresh failed', { msg: String(e && e.message) }); }
      }
      const emergency = PHRASES.filter((p) => p.category === EMERGENCY_PHRASE_CATEGORY);
      return json(200, {
        location: c ? { lat: c.lat, lon: c.lon, city: prefs.weather_city || null } : { city: prefs.weather_city || null, configured: false },
        weather: weather && weather.data ? weather.data : null,
        weather_fetched_at: weather ? weather.fetched_at : null,
        quakes: quake && quake.data ? quake.data.items : [],
        quake_fetched_at: quake ? quake.fetched_at : null,
        emergency,
      });
    } },
  ],
});
