# Dev / screenshot tooling (not shipped)

These files reproduce the store screenshots. They are **not** part of the plugin
artifact — `pack` only zips `server/` and `client/`, and `docs/` is excluded.

To re-shoot:

1. Copy `harness.html` and `hero.html` into `client/` (the dev server serves
   `client/` under `/ui`, so they must live there while shooting).
2. `npx trek-plugin-sdk dev .` and seed some data via the API.
3. `node shoot.js` (needs Chromium + playwright-core) writes PNGs into `docs/`.
4. **Delete `client/harness.html` and `client/hero.html` again before `pack`.**
