// WebDAV sync engine (format v2: one bundle + image packs).
//
// Server layout (inside the configured folder, e.g. /DialDeck):
//   dialdeck.bundle          everything except images: groups, dials, settings, and an index of which
//                            pack holds which image. gzip-compressed JSON, AES-GCM encrypted when
//                            end-to-end encryption is on.
//   packs/<random>.pack      images (thumbnails, logos, site icons, backgrounds) packed together,
//                            encrypted when E2E is on. Random names: nothing about the content (no URLs,
//                            no image hashes) is visible on the server.
//   keyinfo.json             salt + check value for the E2E key (only when encryption is on)
//   snapshots/YYYY-MM-DD.bundle   one encrypted copy of the bundle per day (kept N days)
//
// Older versions stored data.json + images/<sha256> (content-addressed file names, which let anyone
// with server access test whether a given site's icon was present). The first v2 sync migrates that
// layout, deletes it, and leaves a small stub data.json that makes old clients stop with an error
// instead of re-creating per-item files.
//
// Algorithm: download bundle -> field-level merge with local -> write merged locally -> fetch the
// packs holding images this device lacks -> upload images the server lacks as a new pack -> upload the
// bundle with If-Match on the ETag we downloaded (HTTP 412 = another device wrote: repeat).
import { WebDAV, DavError } from './webdav.js';
import { getState, update, getSyncConfig, getLocal, setLocal } from './store.js';
import { merge, sameData, syncView, purgeTombstones, referencedImages, restoreFrom, clone, emptyState } from './model.js';
import { listImages, getImage, putImageWithHash, hasImage } from './images.js';
import { isEncrypted, encrypt, decrypt, newKeyInfo, keyFromInfo } from './crypto.js';
import { stableStringify } from './util.js';

const enc = new TextEncoder(), dec = new TextDecoder();
let cachedKey = null; // { salt, pass, key }
const PACK_MAX = 4 * 1024 * 1024; // bytes of images per pack
const STUB = { format: 'dialdeck-moved', version: 2, note: 'DialDeck now keeps everything in dialdeck.bundle. Update DialDeck on this device (1.6.0 or later).' };

const paths = folder => ({
  folder,
  bundle: `${folder}/dialdeck.bundle`,
  keyinfo: `${folder}/keyinfo.json`,
  packs: `${folder}/packs`,
  pack: id => `${folder}/packs/${id}.pack`,
  snapshots: `${folder}/snapshots`,
  legacyData: `${folder}/data.json`,
  legacyImages: `${folder}/images`,
});

export async function getSyncStatus() {
  return getLocal('syncStatus', { state: 'off' });
}
async function setStatus(patch) {
  const cur = await getSyncStatus();
  await setLocal('syncStatus', { ...cur, ...patch });
}

function isPristine(s, seedIds) {
  if (!seedIds?.length) return false;
  const seed = new Set(seedIds);
  const live = [...Object.values(s.groups), ...Object.values(s.dials)];
  return live.length === seed.size && live.every(e => seed.has(e.id) && !e.deleted);
}

export function davFrom(cfg) {
  return new WebDAV({ url: cfg.url, username: cfg.username, password: cfg.password });
}
const folderOf = cfg => (cfg.folder || 'DialDeck').replace(/^\/+|\/+$/g, '');

export async function testConnection(cfg) {
  const dav = davFrom(cfg);
  const root = await dav.propfind('', 0);
  if (!root) throw new DavError('Base URL not found (404). For Nextcloud use https://HOST/remote.php/dav/files/USERNAME/', 404);
  const P = paths(folderOf(cfg));
  await dav.ensureDir(P.folder);
  const probe = `${P.folder}/.dialdeck-probe`;
  const w = await dav.put(probe, 'ok', { contentType: 'text/plain' });
  if (w.status === 412) throw new DavError('Unexpected 412 on probe', 412);
  await dav.delete(probe).catch(() => {});
  const data = (await dav.stat(P.bundle)) || (await dav.stat(P.legacyData));
  const keyinfo = await dav.stat(P.keyinfo);
  return { ok: true, hasData: !!data, encrypted: !!keyinfo, modified: data?.modified || 0 };
}

async function loadKey(dav, folder, cfg, { create }) {
  const r = await dav.get(`${folder}/keyinfo.json`, 'text');
  if (r.status === 404) {
    if (!cfg.encrypt) return { key: null };
    if (!create) return { key: null };
    if (!cfg.passphrase) throw new Error('Encryption is enabled but no passphrase is set');
    const { info, key } = await newKeyInfo(cfg.passphrase);
    const w = await dav.put(`${folder}/keyinfo.json`, JSON.stringify(info), { ifNoneMatch: '*', contentType: 'application/json' });
    if (w.status === 412) return loadKey(dav, folder, cfg, { create }); // someone else just created it
    cachedKey = { salt: info.salt, pass: cfg.passphrase, key };
    return { key, fresh: true };
  }
  const info = JSON.parse(r.body);
  if (!cfg.encrypt || !cfg.passphrase) throw new Error('The data on the server is end-to-end encrypted. Enable encryption and enter the passphrase in Sync settings.');
  if (cachedKey && cachedKey.salt === info.salt && cachedKey.pass === cfg.passphrase) return { key: cachedKey.key };
  const key = await keyFromInfo(cfg.passphrase, info);
  cachedKey = { salt: info.salt, pass: cfg.passphrase, key };
  return { key };
}

async function decode(buf, key) {
  if (isEncrypted(buf)) {
    if (!key) throw new Error('Server data is encrypted but no key is available');
    buf = await decrypt(key, buf);
  }
  return buf;
}
async function encode(data, key) {
  const buf = typeof data === 'string' ? enc.encode(data).buffer : data;
  return key ? encrypt(key, buf) : buf;
}

// ---------- bundle & pack formats (pure; exported for tests) ----------
async function pipe(u8, stream) {
  return new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(stream)).arrayBuffer());
}
export const gzip = u8 => pipe(u8, new CompressionStream('gzip'));
export const gunzip = u8 => pipe(u8, new DecompressionStream('gzip'));

export async function encodeBundle(obj, key) {
  const z = await gzip(enc.encode(JSON.stringify(obj)));
  return key ? encrypt(key, z.buffer) : z.buffer;
}
export async function decodeBundle(buf, key) {
  let u8 = new Uint8Array(await decode(buf, key));
  if (u8[0] === 0x1f && u8[1] === 0x8b) u8 = await gunzip(u8);
  const b = JSON.parse(dec.decode(u8));
  if (!b || b.format !== 'dialdeck-bundle' || !b.data?.groups) throw new Error('dialdeck.bundle on the server is not DialDeck data');
  b.index ||= {};
  return b;
}

// Pack: "DDP1" | u32 header length | JSON [{h, t, o, n}] | image bytes...
export function buildPack(entries) {
  let o = 0;
  const head = entries.map(e => { const r = { h: e.h, t: e.type, o, n: e.bytes.length }; o += e.bytes.length; return r; });
  const hj = enc.encode(JSON.stringify(head));
  const out = new Uint8Array(8 + hj.length + o);
  out.set(enc.encode('DDP1'), 0);
  new DataView(out.buffer).setUint32(4, hj.length);
  out.set(hj, 8);
  let p = 8 + hj.length;
  for (const e of entries) { out.set(e.bytes, p); p += e.bytes.length; }
  return out;
}
export function parsePack(buf) {
  const u8 = new Uint8Array(buf);
  if (dec.decode(u8.subarray(0, 4)) !== 'DDP1') throw new Error('Not a DialDeck image pack');
  const len = new DataView(u8.buffer, u8.byteOffset).getUint32(4);
  const head = JSON.parse(dec.decode(u8.subarray(8, 8 + len)));
  const base = 8 + len;
  return head.map(r => ({ h: r.h, type: r.t, bytes: u8.slice(base + r.o, base + r.o + r.n) }));
}
const randomId = () => [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('');

export function sniffType(buf) {
  const b = new Uint8Array(buf.slice(0, 16));
  if (b[0] === 0x89 && b[1] === 0x50) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (b[0] === 0x47 && b[1] === 0x49) return 'image/gif';
  if (b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  if (b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0) return 'image/x-icon';
  const head = dec.decode(b);
  if (/<\?xml|<svg/i.test(head)) return 'image/svg+xml';
  return 'application/octet-stream';
}

// ---------- sync ----------
let running = null;
export function syncNow(opts = {}) {
  // coalesce concurrent calls
  if (running) return running;
  running = doSync(opts).finally(() => { running = null; });
  return running;
}

async function doSync({ force = false, repack = false } = {}) {
  const cfg = await getSyncConfig();
  if (!cfg.enabled || !cfg.url) { await setStatus({ state: 'off' }); return { skipped: 'disabled' }; }
  const status = await getSyncStatus();
  const dav = davFrom(cfg);
  const P = paths(folderOf(cfg));
  await setStatus({ state: 'syncing', startedAt: Date.now() });

  try {
    // Fast path: nothing changed locally and the bundle's ETag is unchanged.
    const dirtyAt = await getLocal('dirtyAt', 0);
    if (!force && !repack && status.lastEtag && status.format === 2 && dirtyAt <= (status.at || 0)) {
      const st = await dav.stat(P.bundle);
      if (st && st.etag && st.etag === status.lastEtag) {
        await setStatus({ state: 'ok', at: Date.now(), checkedAt: Date.now(), error: null });
        return { unchanged: true };
      }
    }

    await dav.ensureDir(P.folder);
    const { key } = await loadKey(dav, P.folder, cfg, { create: true });

    const result = { up: 0, down: 0, missing: 0 };
    const myPacks = {}; // hash -> pack id uploaded during this sync (kept across 412 retries)
    let migrated = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      let remote = null, etag = null, legacy = false, remotePlain = false;
      const r = await dav.get(P.bundle);
      if (r.status === 200) {
        etag = r.etag;
        remotePlain = !isEncrypted(r.body);
        remote = await decodeBundle(r.body, key);
      } else {
        // v1 server layout: read data.json once, then migrate it to a bundle
        const lr = await dav.get(P.legacyData);
        if (lr.status === 200) {
          const j = JSON.parse(dec.decode(await decode(lr.body, key)));
          if (j && j.groups) { remote = { data: j, index: {} }; legacy = true; }
        }
      }

      // Merge into local under the state lock, so concurrent UI edits are not lost.
      // A fresh install seeds sample dials; if the server already has data and the user never
      // touched the samples, drop them instead of merging duplicates into every browser.
      const seedIds = await getLocal('seedIds', null);
      let merged;
      await update(local => {
        const base = remote && isPristine(local, seedIds) ? { ...emptyState(), createdAt: remote.data.createdAt } : local;
        merged = purgeTombstones(merge(base, remote?.data));
        if (sameData(merged, local)) return false; // nothing new locally
        for (const k of Object.keys(local)) delete local[k];
        Object.assign(local, merged);
      }, { fromSync: true });
      if (seedIds) await setLocal('seedIds', null);
      merged ||= await getState();

      // Images: packs first, so other devices never see an index entry for a missing pack.
      const index = { ...(remote?.index || {}), ...myPacks };
      const reEncrypt = !!key && remotePlain; // encryption was just turned on: re-pack plaintext images
      if (cfg.syncImages !== false) {
        const res = await syncImages(dav, P, merged, key, index, myPacks, { legacy, repack: (repack || reEncrypt) && attempt === 0 });
        for (const k of ['up', 'down', 'missing']) result[k] += res[k];
      }
      const refs = referencedImages(merged);
      for (const h of Object.keys(index)) if (!refs.has(h)) delete index[h];

      const bundle = { format: 'dialdeck-bundle', v: 2, data: syncView(merged), index };
      if (remote && !legacy && !reEncrypt && sameData(merged, remote.data) && stableStringify(index) === stableStringify(remote.index)) {
        result.pushed = false;
        etag ||= (await dav.stat(P.bundle))?.etag;
        await finish(etag);
        break;
      }
      const body = await encodeBundle(bundle, key);
      const w = await dav.put(P.bundle, body, remote && !legacy ? { ifMatch: etag, contentType: 'application/octet-stream' } : { ifNoneMatch: '*', contentType: 'application/octet-stream' });
      if (w.status === 412) { result.retries = attempt + 1; continue; } // someone else wrote; re-merge
      result.pushed = true;
      await finish(w.etag || (await dav.stat(P.bundle))?.etag);
      if (legacy) { await retireLegacy(dav, P); migrated = result.migrated = true; }
      await maybeSnapshot(dav, P, cfg, body, migrated);
      // packs no longer referenced by the index: delete (only old ones, unless re-packing or migrating,
      // so a pack another device uploaded a moment ago is never removed before its bundle lands)
      result.packsDeleted = await gcPacks(dav, P, index, Object.values(myPacks), (repack || reEncrypt) ? 0 : 3600e3);
      if (reEncrypt) result.snapshotsEncrypted = await encryptOldSnapshots(dav, P, key);
      break;
    }
    return result;

    async function finish(etag) {
      await setStatus({ state: 'ok', at: Date.now(), checkedAt: Date.now(), lastEtag: etag || null, error: null, encrypted: !!key, format: 2 });
    }
  } catch (e) {
    await setStatus({ state: 'error', error: e.message || String(e), errorAt: Date.now() });
    throw e;
  }
}

async function syncImages(dav, P, state, key, index, myPacks, { legacy, repack }) {
  const needed = referencedImages(state);
  const local = new Set(await listImages());
  let up = 0, down = 0;

  // download: fetch each pack that holds images this device lacks
  const byPack = {};
  for (const h of needed) if (!local.has(h) && index[h]) (byPack[index[h]] ||= []).push(h);
  for (const [id, hs] of Object.entries(byPack)) {
    const r = await dav.get(P.pack(id));
    if (r.status !== 200) { for (const h of hs) delete index[h]; continue; } // pack gone: let a device that has the image re-upload it
    for (const e of parsePack(await decode(r.body, key))) {
      if (!needed.has(e.h) || local.has(e.h)) continue;
      await putImageWithHash(e.h, new Blob([e.bytes], { type: e.type || sniffType(e.bytes.buffer) }));
      local.add(e.h); down++;
    }
  }
  // v1 layout: individual images/<hash> files (read once during migration)
  if (legacy) {
    for (const h of needed) {
      if (local.has(h)) continue;
      const r = await dav.get(`${P.legacyImages}/${h}`);
      if (r.status !== 200) continue;
      const raw = await decode(r.body, key);
      await putImageWithHash(h, new Blob([raw], { type: sniffType(raw) }));
      local.add(h); down++;
    }
  }

  // upload: images the server doesn't have (or all of them when re-packing), in new packs
  const toUp = [...needed].filter(h => local.has(h) && (repack ? !myPacks[h] : !index[h]));
  let batch = [], size = 0;
  const flush = async () => {
    if (!batch.length) return;
    const id = randomId();
    await dav.ensureDir(P.packs);
    const w = await dav.put(P.pack(id), await encode(buildPack(batch).buffer, key), { ifNoneMatch: '*', contentType: 'application/octet-stream' });
    if (w.status === 412) throw new Error('pack name collision'); // 128-bit random: practically impossible
    for (const e of batch) { index[e.h] = id; myPacks[e.h] = id; up++; }
    batch = []; size = 0;
  };
  for (const h of toUp) {
    const blob = await getImage(h);
    if (!blob) continue;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (size + bytes.length > PACK_MAX) await flush();
    batch.push({ h, type: blob.type, bytes });
    size += bytes.length;
  }
  await flush();
  const missing = [...needed].filter(h => !local.has(h) && !index[h]).length;
  return { up, down, missing };
}

async function gcPacks(dav, P, index, keep, minAgeMs) {
  const live = new Set([...Object.values(index), ...keep]);
  const now = Date.now();
  let n = 0;
  for (const e of (await dav.list(P.packs).catch(() => null)) || []) {
    const id = e.name.replace(/\.pack$/, '');
    if (e.isDir || live.has(id) || !e.name.endsWith('.pack')) continue;
    if (minAgeMs && e.modified && now - e.modified < minAgeMs) continue;
    if (await dav.delete(P.pack(id)).catch(() => false)) n++;
  }
  return n;
}

// After migrating: remove the v1 files (their names and plaintext could reveal sites) and leave a
// stub data.json so a not-yet-updated DialDeck stops with an error instead of re-creating them.
async function retireLegacy(dav, P) {
  await dav.put(P.legacyData, JSON.stringify(STUB), { contentType: 'application/json' }).catch(() => {});
  for (const e of (await dav.list(P.legacyImages).catch(() => null)) || []) if (!e.isDir) await dav.delete(`${P.legacyImages}/${e.name}`).catch(() => {});
  await dav.delete(`${P.legacyImages}/`).catch(() => {});
  for (const e of (await dav.list(P.snapshots).catch(() => null)) || []) if (/^data-.*\.json$/.test(e.name)) await dav.delete(`${P.snapshots}/${e.name}`).catch(() => {});
}

// Encryption was just turned on: re-encrypt snapshots written before, so no plaintext copy remains.
async function encryptOldSnapshots(dav, P, key) {
  let n = 0;
  for (const e of (await dav.list(P.snapshots).catch(() => null)) || []) {
    if (e.isDir || !e.name.endsWith('.bundle')) continue;
    const r = await dav.get(`${P.snapshots}/${e.name}`);
    if (r.status !== 200 || isEncrypted(r.body)) continue;
    const b = await decodeBundle(r.body, null);
    await dav.put(`${P.snapshots}/${e.name}`, await encodeBundle(b, key), { contentType: 'application/octet-stream' });
    n++;
  }
  return n;
}

async function maybeSnapshot(dav, P, cfg, bundleBytes, now) {
  const day = new Date().toISOString().slice(0, 10);
  const last = await getLocal('lastSnapshotDay', '');
  if (last === day && !now) return;
  await dav.ensureDir(P.snapshots);
  await dav.put(`${P.snapshots}/${day}.bundle`, bundleBytes, { contentType: 'application/octet-stream' });
  await setLocal('lastSnapshotDay', day);
  const keep = Math.max(1, cfg.snapshotsKeep || 30);
  const files = (await dav.list(P.snapshots) || []).filter(e => /^\d{4}-\d{2}-\d{2}\.bundle$/.test(e.name)).sort((a, b) => b.name.localeCompare(a.name));
  for (const f of files.slice(keep)) await dav.delete(`${P.snapshots}/${f.name}`).catch(() => {});
}

export async function listSnapshots() {
  const cfg = await getSyncConfig();
  const dav = davFrom(cfg);
  const files = await dav.list(paths(folderOf(cfg)).snapshots) || [];
  return files.filter(e => /\.bundle$|^data-.*\.json$/.test(e.name)).sort((a, b) => b.name.localeCompare(a.name));
}

export async function snapshotNow() {
  const cfg = await getSyncConfig();
  const dav = davFrom(cfg);
  const P = paths(folderOf(cfg));
  await syncNow({ force: true });
  const r = await dav.get(P.bundle);
  if (r.status !== 200) throw new Error('Nothing to snapshot yet: sync first');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  await dav.ensureDir(P.snapshots);
  await dav.put(`${P.snapshots}/${stamp}-manual.bundle`, r.body, { contentType: 'application/octet-stream' });
}

export async function restoreSnapshot(name) {
  const cfg = await getSyncConfig();
  const dav = davFrom(cfg);
  const P = paths(folderOf(cfg));
  const { key } = await loadKey(dav, P.folder, cfg, { create: false });
  const r = await dav.get(`${P.snapshots}/${name}`);
  if (r.status !== 200) throw new Error('Snapshot not found');
  const snap = name.endsWith('.bundle') ? (await decodeBundle(r.body, key)).data : JSON.parse(dec.decode(await decode(r.body, key)));
  await update(cur => { const next = restoreFrom(cur, snap); for (const k of Object.keys(cur)) delete cur[k]; Object.assign(cur, next); });
  return syncNow({ force: true });
}

// Re-pack all images into fresh packs and delete the old ones (drops images nothing uses any more).
export async function cleanupServer() {
  const before = (await davFrom(await getSyncConfig()).list(paths(folderOf(await getSyncConfig())).packs).catch(() => null) || []).length;
  const r = await syncNow({ force: true, repack: true });
  return { removed: r.packsDeleted || 0, packsBefore: before };
}

// Wipe the server copy and re-upload this browser's data (used after changing the passphrase).
export async function resetServerFromLocal() {
  const cfg = await getSyncConfig();
  const dav = davFrom(cfg);
  const P = paths(folderOf(cfg));
  for (const p of [P.bundle, P.keyinfo, P.legacyData]) await dav.delete(p).catch(() => {});
  for (const dir of [P.packs, P.legacyImages]) {
    for (const e of (await dav.list(dir).catch(() => null)) || []) if (!e.isDir) await dav.delete(`${dir}/${e.name}`).catch(() => {});
  }
  cachedKey = null;
  await setLocal('syncStatus', { state: 'idle' });
  await setLocal('lastSnapshotDay', '');
  return syncNow({ force: true });
}

export { clone, hasImage };
