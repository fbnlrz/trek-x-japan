# TREK × Japan — trip-page (3.2.1) build & release plan

This plugin is built as a **`trip-page`** (TREK 3.2.1+): a collaborative tab
**inside a trip**, scoped to the open trip, with data shared by all trip members.

## Status / tooling gate

- **Code: done.** Manifest `type: "trip-page"`, `trek: ">=3.2.1 <4.0.0"`; server
  and client implement the collaborative, trip-scoped model; verified end-to-end
  against the SDK dev server (which accepts `trip-page`).
- **Not yet publishable.** The published SDK on npm is **1.2.1**, whose
  `validate` rejects `type: trip-page`
  (`error: type must be one of integration/page/widget`), so `validate` / `pack`
  / `publish` — and the registry CI (v3-2-1 manifest-parity schema) — cannot pass
  until **SDK 1.3.0 / TREK 3.2.1** are released.
- **Plan:** when SDK ≥ 1.3.0 ships, run `validate` → `pack` → `preflight` →
  `publish` (registry PR opened manually; `gh` is not installed here). Bump
  nothing else — the code is ready.

## How to finish once the SDK is ready

```bash
npx trek-plugin-sdk@latest validate .
npx trek-plugin-sdk@latest pack .
# tag vX.Y.Z == manifest version, GitHub release with plugin.zip, then:
npx trek-plugin-sdk@latest entry --repo fbnlrz/trek-x-japan --tag v1.0.0 \
  --out registry/plugins/trek-x-japan.json
npx trek-plugin-sdk@latest preflight --repo fbnlrz/trek-x-japan --tag v1.0.0
# open the one-file PR to mauriceboe/TREK-Plugins (registry/plugins/trek-x-japan.json)
```

## Collaboration data model (implemented)

`tripId` is always present from `trek:context` (trip-page); the client injects it
into every route call. Each shared route membership-checks the acting user with
`ctx.trips.getById(tripId, userId)` before reading/writing.

**Shared, keyed by `trip_id`** (all trip members see/edit the same rows):

| Table | Notes |
|---|---|
| `checklist(trip_id, item_id, done, by_user, at)` | prep/packing; records who ticked |
| `budget(trip_id, planned_yen)` | one planned budget per trip |
| `spend(id, trip_id, user_id, amount_yen, note, at)` | expense log, author tagged |
| `food_tally(trip_id, kind, count, at)` | shared konbini/ramen/… counters |
| `visited_prefs(trip_id, code, by_user, at)` | prefecture passport; who stamped |
| `collect(trip_id, kind, key, by_user, at)` | onsen/goshuin/eki; who added |
| `trip_prefs(trip_id, key, value)` | shared weather location |

**Personal, keyed by `user_id`:**

| Table | Notes |
|---|---|
| `user_prefs(user_id, key, value)` | home_currency, ic_card, low_ic_threshold |
| `phrase_favs(user_id, phrase_id, at)` | phrasebook favourites |
| `phrase_state(user_id, offset)` | phrase-of-the-day rotation |
| `ic_balance(user_id, yen, updated_at)` | personal Suica balance |
| `ic_ledger(id, user_id, kind, amount, balance_after, at)` | personal IC history |

**Global:** `cache(key, json, fetched_at)` — FX / weather / quake caches.

Member display names for the "by …" labels come from `ctx.users.getById`
(`db:read:users`), which returns only self or a trip co-member.

## Optional future refinement

- Consider `ctx.meta` (`db:meta`, 3.2.1) to attach some of this data directly to
  the TREK trip/place/day entities instead of the plugin's own tables — useful if
  the data should travel with the entity or be visible to other plugins. Not
  required; the `db:own` model above is self-contained.

## Local dev / screenshots

- `dev-fixtures.json` seeds trip 1 with two members (Mika, Yuki) so collaboration
  attribution is visible.
- The dev server accepts `trip-page`; develop and screenshot as usual. The
  harness in `docs/dev/harness.html` posts `trek:context` with a `tripId`.
- `docs/dev/shoot.js` regenerates the hero + per-tab screenshots.
