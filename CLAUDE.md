# DialDeck — notes for Claude sessions

## Releasing (do this for every change that ships)
The owner wants every shipped version published as a GitHub Release. Sessions can't create
releases through the API, so `.github/workflows/release.yml` does it on push:
1. Bump `version` in `extension/manifest.base.json` and `package.json`.
2. Add a `## <version>` section at the top of `CHANGELOG.md` (it becomes the release notes).
3. Build: `node build.mjs` and `android/build.sh`. The APK must be signed with the project's own
   key (`android/dialdeck-release.keystore` + `.pass`, git-ignored, owned by the user). If that key isn't
   on this machine, ask the user for it rather than generating a new one; a new key breaks updates.
4. Replace the old files in `builds/` with `dist/dialdeck-{chrome,firefox,android}-<version>.*`.
5. Run the tests (see README "Development"), commit, push to `main`. The workflow publishes
   release `v<version>` with the three builds and SHA256SUMS, and has Mozilla sign the Firefox
   build (repo secrets `AMO_JWT_ISSUER` / `AMO_JWT_SECRET`, owned by the user; never ask for their
   values in chat). Check it under Actions → Release. Mozilla signs each version only once, so
   every release needs a new version number. Run `npx web-ext@10.8.0 lint --source-dir dist/firefox`
   before releasing: 0 errors required.

## Layout
- `extension/` the browser extension (shared UI code, also packaged into the Android app)
- `android/` WebView app + native bridge; `android/www/android-shim.js` emulates the extension APIs
- `test/` unit tests, desktop e2e (`test/e2e.mjs`), sync-format migration (`test/migration.mjs`), Android web-layer and HTTP-client tests

## Privacy rule for sync
The server must never see URLs, titles, group names or image hashes. Everything goes into the
encrypted `dialdeck.bundle` or randomly-named `packs/`; never add per-item or content-addressed
files. `test/e2e.mjs` scans every server file for leaks; keep that check passing.
