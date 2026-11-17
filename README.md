# DialDeck: grouped speed dials with self-hosted sync

DialDeck is a new-tab speed dial extension modelled on the Group Speed Dial workflow. Your data stays in your browser and on **your own Nextcloud (or any WebDAV server)**. No third-party cloud, account or tracking is involved.

- **Browsers:** Chrome, Edge, Brave, Vivaldi and Opera (Manifest V3), plus Firefox 128+.
- **Sync:** WebDAV, built for Nextcloud on Unraid behind an nginx reverse proxy.
- **Encryption:** optional end-to-end encryption (AES-256-GCM), so your server only stores ciphertext.

---

## Features

| Area | What you get |
|---|---|
| **Groups** | Unlimited groups shown as tabs (pills, tabs or underline style; top or bottom). Each group can have an emoji and a colour. Drag tabs to reorder them and double-click to rename. Middle-click opens every dial in the group. Each group can override columns, dial size and aspect ratio, and can have its own background. You can choose a start group or reopen the last one you used. A group can be locked behind a PIN as a privacy screen. |
| **Dials** | Click, Ctrl/⌘-click (opens in a background tab), Shift-click (new window), middle-click, or open in a private window. Drag to reorder. Drop a dial on a group tab to move it, or onto a folder to file it. Duplicate, copy the URL, or move to another group or folder from the menu. Deletion has undo, and visits are counted. You can sort manually or by title, most visited or recently visited. |
| **Folders** | Folders hold dials and can contain sub-folders. A folder tile previews its contents in a 2×2 grid and opens in an overlay. "Open all" opens everything inside, and you can drag a dial out of a folder. |
| **Thumbnails** | Four kinds: **page screenshot** (taken in the background, or captured when you visit the page), **site logo** (apple-touch-icon, web manifest, SVG or favicon, placed on a matching background colour), **custom image** (upload, URL, paste, or drag an image onto a dial) and **letter tile**. Old screenshots can be refreshed automatically. Missing thumbnails can be regenerated in bulk. |
| **Adding** | The "+" tile, the toolbar popup (takes an instant screenshot of the current page), the right-click menu on a page or link, the `Alt+Shift+D` shortcut, dragging links from any page onto the grid, adding all tabs in a window as a group, and a sidebar listing recently closed tabs, top sites, open tabs and bookmarks. |
| **Layouts** | **List** (the default): each dial is a row two tiles wide, showing the site logo or favicon and the page title. Row width, columns, height, spacing, icon size and source (logo, favicon, thumbnail, letters or none), card/flat/outline style, title size, one or two title lines, and an optional site address are all adjustable. **Tiles**: classic thumbnail tiles. Each group can use its own layout. |
| **Look** | OLED black (the default: pure #000 background and surfaces), dark, light or auto theme. Accent colour. Gradient, colour or image background, with dim and blur. Dial width, columns, aspect ratio, spacing, corner radius, opacity, shadow and hover effect (lift, zoom or glow). Title position (below, overlay or on hover), size and colour. Favicons, clock, custom font and custom CSS. |
| **Search** | Google, DuckDuckGo, Bing, Brave, Startpage, Ecosia, Kagi, Qwant, your browser's default engine, or a custom URL such as your own SearXNG. Typing filters dials across every group, and you can pick a result with ↓ and Enter. |
| **Keyboard** | `/` search · `1`–`9` open dial · `Alt+1`–`9` switch group · `[` `]` previous/next group · `N` new dial · `G` new group · `E`/`F2` edit hovered dial · `Del` delete hovered dial · `S` sync · `,` settings. The mouse wheel over the group bar switches groups, and you can turn that on for the whole page. |
| **Sync** | WebDAV to Nextcloud, ownCloud, Apache, nginx-dav, rclone and similar servers. Edits merge field by field, so changing a dial on two machines never loses either change. ETag/`If-Match` makes uploads safe even when two browsers sync at once. Images are deduplicated by content hash. The server keeps a daily snapshot (30 days by default, with restore). |
| **Backup & import** | A full JSON backup that includes images. Import from Group Speed Dial, Speed Dial 2, FVD and similar JSON backups (groups are detected automatically). Import browser bookmark folders (sub-folders become groups) or a bookmarks HTML file. Export your dials as bookmarks HTML. |
| **Safety** | "Lock layout" prevents accidental changes on a shared computer. You can ask for confirmation before deletes. Every deletion can be undone. |

**What Group Speed Dial has that DialDeck doesn't:** its proprietary cloud account (replaced by your own WebDAV) and its paid "Premium" server features.

---

## 1. Install the extension

Ready-built packages are in the [`builds/`](builds/) folder: [`dialdeck-chrome-1.2.0.zip`](builds/dialdeck-chrome-1.2.0.zip) and [`dialdeck-firefox-1.2.0.xpi`](builds/dialdeck-firefox-1.2.0.xpi). On GitHub, open a file and click **Download raw file**. To build them yourself, run `node build.mjs`; the output goes to `dist/` and no npm install is needed.

**Chrome / Edge / Brave / Vivaldi**
1. Unzip `dialdeck-chrome-<version>.zip` somewhere permanent.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and pick the unzipped folder.
4. Open a new tab. If the browser asks whether to keep the changed new tab page, choose **Keep it**.

**Firefox**
- To try it out: open `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on**, and pick the downloaded `.xpi` (or `dist/firefox/manifest.json` if you built it yourself). It is removed when Firefox restarts.
- To keep it permanently: sign the `.xpi` for free as an *unlisted* add-on on addons.mozilla.org (`web-ext sign --channel=unlisted`). Alternatively, use Firefox Developer Edition or ESR with `xpinstall.signatures.required = false`.
- On first open, click **Grant access** on the banner. Firefox treats site access as optional, and DialDeck needs it for thumbnails and to reach your server.

---

## 2. Set up sync with Nextcloud (Unraid + nginx)

### On the server (once)

1. **Create an app password** in Nextcloud: *Personal settings → Security → Devices & sessions → "Create new app password"*. Name it `DialDeck`. Use this instead of your main password: it works with 2FA and can be revoked on its own.
2. **Find your WebDAV URL** in Nextcloud Files under *⚙ Files settings → WebDAV*. It looks like this:
   `https://cloud.example.com/remote.php/dav/files/YOUR_USERNAME/`
3. **Check your nginx proxy.** Run this from any machine that has `curl`:
   ```bash
   ./server/check-webdav.sh https://cloud.example.com/remote.php/dav/files/YOUR_USERNAME/ YOUR_USERNAME
   ```
   It confirms that every WebDAV method, ETag, `If-Match` conflict protection and large uploads all make it through your proxy. If anything fails, `server/nginx-nextcloud.conf` has the fix, with notes for plain nginx, SWAG and Nginx Proxy Manager.

### In each browser

Open a new tab and press `,`, or click the cloud icon. Then go to **Sync** and:

1. Turn on **Enable WebDAV sync**.
2. Enter the WebDAV URL, your username and the app password.
3. Turn on **End-to-end encryption** and choose a passphrase. This is recommended because your server is reachable from the internet. Use **the same passphrase in every browser**.
4. Click **Test connection**, then **Save & sync now**.

On the second and later browsers, the sample dials created at install are discarded as long as you haven't edited them. That way they don't get merged in as duplicates.

### What ends up on the server

```
DialDeck/
├── data.json        groups, dials, settings (ciphertext if E2E is on)
├── keyinfo.json     random salt + check value (only with E2E; contains no key)
├── images/<sha256>  thumbnails, logos, backgrounds (ciphertext if E2E is on)
└── snapshots/       data-YYYY-MM-DD.json, one per day, kept 30 days
```

**When sync runs:** about 4 seconds after any change, whenever a new tab opens (a cheap ETag check, at most every 30 seconds), and on a timer (every 10 minutes by default).

### Security notes

- Requests are sent **without cookies**. This avoids Nextcloud's "CSRF check failed" error when you're also logged into Nextcloud in the same browser, and it means DialDeck can't act as your web session.
- The app password is stored in the extension's local storage. That's normal for sync clients, but it's why you should use a revocable app password. With E2E on, a compromised server, or anyone reading your Nextcloud files, sees only random bytes.
- E2E encryption uses PBKDF2-SHA256 with 600,000 iterations to derive an AES-256-GCM key, and every file gets a fresh IV. **If you lose the passphrase, the server copy can't be read.** Your local data is unaffected, and **Re-upload from this browser** re-creates the server copy with a new passphrase.
- The group PIN lock is a privacy screen only. Data in the browser profile isn't encrypted.
- A plain-HTTP URL is only accepted without a warning for LAN addresses.

---

## 3. Moving from Group Speed Dial

1. In Group Speed Dial, export a backup (its settings → Backup → Export).
2. In DialDeck, go to **Settings → Backup & import → Import file…** and pick that file (usually named `backup.group_speed_dial`; any file name is accepted).

The importer detects groups and dials from the JSON structure, and turns any embedded data-URL thumbnails into custom images. It generates screenshots and logos for the rest. If an export from another add-on doesn't import cleanly, export your bookmarks as HTML instead, or import a bookmark folder directly.

---

## Development

```bash
node build.mjs                                  # builds dist/chrome, dist/firefox + zip/xpi
node --test test/*.test.mjs                     # unit tests: merge logic, URL handling, WebDAV client
node tools/dev-webdav.mjs 8765 ./.dav-data      # local WebDAV server (user test / pass test), Nextcloud-style URLs
NODE_PATH=$(npm root -g) node test/e2e.mjs      # two Chromium profiles syncing via the dev server (needs Playwright)
python3 tools/make-icons.py extension/icons     # regenerate icons (needs Pillow)
```

### How it's built

```
extension/
├── background.js         context menus, thumbnail queue, capture-on-visit, sync scheduling, message API
├── newtab.html, popup.html, options.html
├── lib/
│   ├── model.js          data model + field-level last-writer-wins merge (pure, unit-tested)
│   ├── store.js          storage.local with a cross-context Web Lock (no lost writes between tabs/popup/background)
│   ├── images.js         IndexedDB, content-addressed image store
│   ├── sync.js           WebDAV sync engine (merge → images → If-Match upload → snapshot)
│   ├── webdav.js         small WebDAV client (PROPFIND parser works in service workers)
│   ├── crypto.js         optional E2E encryption
│   └── thumbs.js         screenshots (Chrome: unfocused popup window · Firefox: tabs.captureTab), logos
└── ui/                   new tab page modules (grid + DnD, dialogs, settings, search, sidebar, import/export)
```

**Data model.** Every group, dial and the settings object stores a `_ts` map of *field → last-modified time*. Merging two copies keeps the newest value of each field. Deletes are tombstones, which are purged after 90 days. Dial order uses fractional positions, so moving one dial only changes that dial's `order` field.
