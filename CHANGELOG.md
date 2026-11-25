# Changelog

## 1.6.0
- **Private sync format.** The server now holds one bundle file with all dials and settings, plus a few image packs with random names. It no longer holds a data file plus one file per image named after the image's hash. With end-to-end encryption, the server can't see URLs, titles or images, or tell which sites you use. Previously, hash-named image files could reveal a site, because a site's icon hashes the same for everyone.
- **End-to-end encryption is on by default** for new sync setups. Turning it on later re-encrypts everything already on the server, including older snapshots, and deletes the unencrypted copies.
- **Automatic migration:** the first sync converts a 1.5-or-older server and deletes the old files. **Update DialDeck on every device:** older versions stop with an error instead of writing the old format again.
- "Re-pack server images" (Settings → Sync) rewrites the image packs and removes images nothing uses any more.

## 1.5.0
- **Synced site icons (favicons).** Each dial's icon is fetched once, by whichever device gets there first, then synced through your Nextcloud (encrypted if end-to-end encryption is on). Every browser and the Android app show the same icons without asking each website again. Dials on the same site share one stored icon.
- Icons come from the browser's own cache where possible (Chrome), otherwise from the site's declared icon, `/favicon.ico` or its touch icon, and are stored as small 64×64 images (SVG icons stay vector). Sites without an icon fall back to the browser favicon or letter badges, and are retried weekly.
- Changing a dial's address fetches a fresh icon. You can turn this off under Settings → Thumbnails → "Sync site icons".

## 1.4.2
- **Firefox and Waterfox: Mozilla-signed builds.** Each release now includes `dialdeck-firefox-<version>-signed.xpi`, which installs permanently in regular Firefox and Waterfox (no more "Firefox has prevented this site from installing an unverified add-on").
- The Firefox build declares that DialDeck collects no data (now required by Mozilla), and requires Firefox 140 or later (Waterfox is based on 140 ESR).

## 1.4.1
- List rows always keep their width (2 tiles by default). The list's **Columns** setting is now a maximum, so it no longer squeezes rows to less than a tile wide.
- Grid and list column widths are explicit, so they no longer depend on each browser engine's track sizing (more consistent in Firefox and Waterfox).

## 1.4.0
- **Android app**: the same interface and Nextcloud sync. Dials and searches open in Waterfox (or a browser you choose), and **Share → DialDeck** from Waterfox adds the current page.
- Phone-friendly menus (bottom sheet, tap-to-open submenus), and **Move earlier / Move later** for reordering on touch screens.
- Desktop browsers generate missing thumbnails for dials added on other devices after each sync.
- Fixes: the top bar overflowed on narrow screens; Escape didn't close settings from a focused field; settings could reopen right after closing.

## 1.3.0
- Each tab (group) can use its own layout, List or Tiles: use the toolbar toggle, or right-click a tab → Layout.
- Every list and tile size can be overridden per tab.

## 1.2.0
- New **List** layout: each dial is a row two tiles wide with the site logo or favicon and the page title, fully customisable.
- **OLED black** theme and background (the default).

## 1.1.0
- Dedicated Group Speed Dial importer (`backup_*.group_speed_dial`).
- Fixed column counts shrink tiles to fit the window; the first import replaces the sample groups.

## 1.0.0
- First release: grouped speed dials, folders, thumbnails, search, sidebar and popup, plus WebDAV/Nextcloud sync with field-level merging, snapshots and optional end-to-end encryption.
