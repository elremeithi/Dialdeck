// Persistent state in storage.local, with a cross-context lock so the new tab page,
// popup and background never clobber each other's writes.
import { api } from './util.js';
import { emptyState, SCHEMA, clone } from './model.js';

const KEY = 'state';
const LOCK = 'dialdeck-state';

export async function getState() {
  const r = await api.storage.local.get(KEY);
  return migrate(r[KEY]) || emptyState();
}

function migrate(s) {
  if (!s) return s;
  s.groups ||= {}; s.dials ||= {}; s.settings ||= { _ts: {} };
  s.schema = SCHEMA;
  return s;
}

async function withLock(fn) {
  if (globalThis.navigator?.locks) return navigator.locks.request(LOCK, fn);
  return fn();
}

// update(fn): fn mutates the state in place (may be async). Returns fn's result.
// opts.fromSync marks the write as coming from sync so it doesn't trigger another push.
export async function update(fn, opts = {}) {
  return withLock(async () => {
    const s = await getState();
    const res = await fn(s);
    if (res === false) return false; // abort without writing
    const meta = { [KEY]: s };
    if (!opts.fromSync) meta.dirtyAt = Date.now();
    await api.storage.local.set(meta);
    return res;
  });
}

export async function replaceState(s, opts = {}) {
  return update(cur => { for (const k of Object.keys(cur)) delete cur[k]; Object.assign(cur, clone(s)); }, opts);
}

export function onStateChange(cb) {
  api.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[KEY]) cb(changes[KEY].newValue);
  });
}

// ---- small key/value helpers for non-synced data ----
export async function getLocal(key, def) {
  const r = await api.storage.local.get(key);
  return r[key] ?? def;
}
export async function setLocal(key, value) {
  await api.storage.local.set({ [key]: value });
}

export const SYNC_DEFAULTS = {
  enabled: false,
  url: '',              // e.g. https://cloud.example.com/remote.php/dav/files/alice/
  username: '',
  password: '',         // Nextcloud app password recommended
  folder: 'DialDeck',
  intervalMin: 10,
  encrypt: false,
  passphrase: '',
  syncImages: true,
  snapshotsKeep: 30,
  deviceName: '',
};

export async function getSyncConfig() {
  return { ...SYNC_DEFAULTS, ...(await getLocal('syncConfig', {})) };
}
export async function setSyncConfig(cfg) {
  await setLocal('syncConfig', cfg);
}
