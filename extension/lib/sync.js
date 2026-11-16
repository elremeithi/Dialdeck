// WebDAV sync engine.
//
// Server layout (inside the configured folder, e.g. /DialDeck):
//   data.json              whole dataset (JSON, or AES-GCM ciphertext when encryption is on)
//   keyinfo.json           salt + check value (only when encryption is on)
//   images/<sha256>        thumbnails, logos and backgrounds, content-addressed
//   snapshots/data-YYYY-MM-DD.json   one rolling daily backup per day (kept N days)
//
// Algorithm: download remote -> field-level merge with local -> write merged locally ->
// upload with If-Match on the ETag we downloaded. If another browser wrote in between
// (HTTP 412) we simply repeat. Images are immutable (named by hash) so they never conflict.
import { WebDAV, DavError } from './webdav.js';
import { getState, update, getSyncConfig, getLocal, setLocal } from './store.js';
import { merge, sameData, syncView, purgeTombstones, referencedImages, restoreFrom, clone, emptyState } from './model.js';
import { listImages, getImage, putImageWithHash, hasImage } from './images.js';
import { isEncrypted, encrypt, decrypt, newKeyInfo, keyFromInfo } from './crypto.js';

const enc = new TextEncoder(), dec = new TextDecoder();
let cachedKey = null; // { salt, pass, key }

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
  const folder = folderOf(cfg);
  await dav.ensureDir(folder);
  const probe = `${folder}/.dialdeck-probe`;
  const w = await dav.put(probe, 'ok', { contentType: 'text/plain' });
  if (w.status === 412) throw new DavError('Unexpected 412 on probe', 412);
  await dav.delete(probe).catch(() => {});
  const data = await dav.stat(`${folder}/data.json`);
  const keyinfo = await dav.stat(`${folder}/keyinfo.json`);
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

let running = null;
export function syncNow(opts = {}) {
  // coalesce concurrent calls
  if (running) return running;
  running = doSync(opts).finally(() => { running = null; });
  return running;
}

async function doSync({ force = false } = {}) {
  const cfg = await getSyncConfig();
  if (!cfg.enabled || !cfg.url) { await setStatus({ state: 'off' }); return { skipped: 'disabled' }; }
  const status = await getSyncStatus();
  const dav = davFrom(cfg);
  const folder = folderOf(cfg);
  const dataPath = `${folder}/data.json`;
  await setStatus({ state: 'syncing', startedAt: Date.now() });

  try {
    // Fast path: nothing changed locally and remote ETag unchanged.
    const dirtyAt = await getLocal('dirtyAt', 0);
    if (!force && status.lastEtag && dirtyAt <= (status.at || 0)) {
      const st = await dav.stat(dataPath);
      if (st && st.etag && st.etag === status.lastEtag) {
        await setStatus({ state: 'ok', at: Date.now(), checkedAt: Date.now(), error: null });
        return { unchanged: true };
      }
    }

    await dav.ensureDir(folder);
    const { key, fresh } = await loadKey(dav, folder, cfg, { create: true });

    let result = {};
    for (let attempt = 0; attempt < 5; attempt++) {
      const r = await dav.get(dataPath);
      let remote = null, etag = null;
      if (r.status === 200) {
        etag = r.etag;
        const raw = await decode(r.body, key);
        remote = JSON.parse(dec.decode(raw));
        if (!remote || typeof remote !== 'object' || !remote.groups) throw new Error('data.json on the server is not DialDeck data');
      }

      // Merge into local under the state lock, so concurrent UI edits are not lost.
      // A fresh install seeds sample dials; if the server already has data and the user never
      // touched the samples, drop them instead of merging duplicates into every browser.
      const seedIds = await getLocal('seedIds', null);
      let merged;
      await update(local => {
        const base = remote && isPristine(local, seedIds) ? { ...emptyState(), createdAt: remote.createdAt } : local;
        merged = purgeTombstones(merge(base, remote));
        if (sameData(merged, local)) return false; // nothing new locally
        for (const k of Object.keys(local)) delete local[k];
        Object.assign(local, merged);
      }, { fromSync: true });
      if (seedIds) await setLocal('seedIds', null);
      merged ||= await getState();

      // Images before data so other browsers never see a reference to a missing file.
      if (cfg.syncImages !== false) result.images = await syncImages(dav, folder, merged, key, fresh);

      if (remote && sameData(merged, remote)) {
        result.pushed = false;
        // fetch ETag if server didn't return one on GET
        etag ||= (await dav.stat(dataPath))?.etag;
        await finish(etag);
        break;
      }
      const body = await encode(JSON.stringify(syncView(merged)), key);
      const w = await dav.put(dataPath, body, remote ? { ifMatch: etag, contentType: key ? 'application/octet-stream' : 'application/json' } : { ifNoneMatch: '*', contentType: key ? 'application/octet-stream' : 'application/json' });
      if (w.status === 412) { result.retries = attempt + 1; continue; } // someone else wrote; re-merge
      result.pushed = true;
      const newEtag = w.etag || (await dav.stat(dataPath))?.etag;
      await finish(newEtag);
      await maybeSnapshot(dav, folder, cfg, merged, key);
      break;
    }
    return result;

    async function finish(etag) {
      await setStatus({ state: 'ok', at: Date.now(), checkedAt: Date.now(), lastEtag: etag || null, error: null, encrypted: !!key });
    }
  } catch (e) {
    await setStatus({ state: 'error', error: e.message || String(e), errorAt: Date.now() });
    throw e;
  }
}

async function syncImages(dav, folder, state, key, forceUpload) {
  const dir = `${folder}/images`;
  await dav.ensureDir(dir);
  const remote = new Set((await dav.list(dir) || []).filter(e => !e.isDir).map(e => e.name));
  const needed = referencedImages(state);
  const local = new Set(await listImages());
  let up = 0, down = 0, missing = 0;
  for (const h of needed) {
    if (!local.has(h) && remote.has(h)) {
      const r = await dav.get(`${dir}/${h}`);
      if (r.status === 200) {
        const raw = await decode(r.body, key);
        await putImageWithHash(h, new Blob([raw], { type: sniffType(raw) }));
        local.add(h); down++;
      }
    }
  }
  for (const h of needed) {
    if (local.has(h) && (!remote.has(h) || forceUpload)) {
      const blob = await getImage(h);
      if (!blob) continue;
      await dav.put(`${dir}/${h}`, await encode(await blob.arrayBuffer(), key));
      up++;
    } else if (!local.has(h) && !remote.has(h)) missing++;
  }
  return { up, down, missing };
}

async function maybeSnapshot(dav, folder, cfg, state, key) {
  const day = new Date().toISOString().slice(0, 10);
  const last = await getLocal('lastSnapshotDay', '');
  if (last === day) return;
  const dir = `${folder}/snapshots`;
  await dav.ensureDir(dir);
  await dav.put(`${dir}/data-${day}.json`, await encode(JSON.stringify(syncView(state)), key));
  await setLocal('lastSnapshotDay', day);
  const keep = Math.max(1, cfg.snapshotsKeep || 30);
  const files = (await dav.list(dir) || []).filter(e => /^data-\d{4}-\d{2}-\d{2}\.json$/.test(e.name)).sort((a, b) => b.name.localeCompare(a.name));
  for (const f of files.slice(keep)) await dav.delete(`${dir}/${f.name}`).catch(() => {});
}

export async function listSnapshots() {
  const cfg = await getSyncConfig();
  const dav = davFrom(cfg);
  const files = await dav.list(`${folderOf(cfg)}/snapshots`) || [];
  return files.filter(e => /^data-.*\.json$/.test(e.name)).sort((a, b) => b.name.localeCompare(a.name));
}

export async function snapshotNow() {
  const cfg = await getSyncConfig();
  const dav = davFrom(cfg);
  const folder = folderOf(cfg);
  const { key } = await loadKey(dav, folder, cfg, { create: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  await dav.ensureDir(`${folder}/snapshots`);
  await dav.put(`${folder}/snapshots/data-${stamp}-manual.json`, await encode(JSON.stringify(syncView(await getState())), key));
}

export async function restoreSnapshot(name) {
  const cfg = await getSyncConfig();
  const dav = davFrom(cfg);
  const folder = folderOf(cfg);
  const { key } = await loadKey(dav, folder, cfg, { create: false });
  const r = await dav.get(`${folder}/snapshots/${name}`);
  if (r.status !== 200) throw new Error('Snapshot not found');
  const snap = JSON.parse(dec.decode(await decode(r.body, key)));
  await update(cur => { const next = restoreFrom(cur, snap); for (const k of Object.keys(cur)) delete cur[k]; Object.assign(cur, next); });
  return syncNow({ force: true });
}

// Delete images on the server that nothing references any more.
export async function cleanupServer() {
  const cfg = await getSyncConfig();
  const dav = davFrom(cfg);
  const dir = `${folderOf(cfg)}/images`;
  await syncNow({ force: true });
  const needed = referencedImages(await getState());
  let removed = 0;
  for (const e of (await dav.list(dir) || [])) {
    if (!e.isDir && !needed.has(e.name)) { await dav.delete(`${dir}/${e.name}`); removed++; }
  }
  return { removed };
}

// Wipe server copy and re-upload this browser's data (used after changing encryption).
export async function resetServerFromLocal() {
  const cfg = await getSyncConfig();
  const dav = davFrom(cfg);
  const folder = folderOf(cfg);
  for (const p of ['data.json', 'keyinfo.json']) await dav.delete(`${folder}/${p}`).catch(() => {});
  const imgs = await dav.list(`${folder}/images`).catch(() => null) || [];
  for (const e of imgs) if (!e.isDir) await dav.delete(`${folder}/images/${e.name}`).catch(() => {});
  cachedKey = null;
  await setLocal('syncStatus', { state: 'idle' });
  await setLocal('lastSnapshotDay', '');
  return syncNow({ force: true });
}

export { clone, hasImage };
