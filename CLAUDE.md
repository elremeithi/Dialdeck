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
   release `v<version>` with the three builds and SHA256SUMS. Check it under Actions → Release.

## Layout
- `extension/` the browser extension (shared UI code, also packaged into the Android app)
- `android/` WebView app + native bridge; `android/www/android-shim.js` emulates the extension APIs
- `test/` unit tests, desktop e2e (`test/e2e.mjs`), Android web-layer and HTTP-client tests
