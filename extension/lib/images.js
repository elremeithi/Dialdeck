// Content-addressed image store in IndexedDB. Key = sha256 of the bytes.
// Images are referenced from dials/groups/settings by hash and synced as images/<hash>.
import { sha256Hex } from './util.js';

const DB_NAME = 'dialdeck';
const STORE = 'images';
let dbp;

function db() {
  if (!dbp) {
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  return dbp;
}

function tx(mode, fn) {
  return db().then(d => new Promise((res, rej) => {
    const t = d.transaction(STORE, mode);
    const s = t.objectStore(STORE);
    let out;
    Promise.resolve(fn(s)).then(v => { out = v; });
    t.oncomplete = () => res(out);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  }));
}

const reqP = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export async function putImage(blob) {
  const hash = await sha256Hex(blob);
  const ab = await blob.arrayBuffer(); // store as ArrayBuffer: safest across browsers
  await tx('readwrite', s => s.put({ type: blob.type || 'image/png', data: ab, at: Date.now() }, hash));
  return hash;
}

export async function putImageWithHash(hash, blob) {
  const ab = await blob.arrayBuffer();
  await tx('readwrite', s => s.put({ type: blob.type || 'image/png', data: ab, at: Date.now() }, hash));
}

export async function getImage(hash) {
  if (!hash) return null;
  const rec = await tx('readonly', s => reqP(s.get(hash)));
  return rec ? new Blob([rec.data], { type: rec.type }) : null;
}

export async function hasImage(hash) {
  const k = await tx('readonly', s => reqP(s.getKey(hash)));
  return k !== undefined;
}

export async function listImages() {
  return tx('readonly', s => reqP(s.getAllKeys()));
}

export async function deleteImage(hash) {
  return tx('readwrite', s => s.delete(hash));
}

export async function imageMeta(hash) {
  const rec = await tx('readonly', s => reqP(s.get(hash)));
  return rec ? { type: rec.type, at: rec.at, size: rec.data.byteLength } : null;
}

// Object-URL cache for pages
const urlCache = new Map();
export async function imageUrl(hash) {
  if (!hash) return null;
  if (urlCache.has(hash)) return urlCache.get(hash);
  const b = await getImage(hash);
  if (!b) return null;
  const u = URL.createObjectURL(b);
  urlCache.set(hash, u);
  return u;
}
