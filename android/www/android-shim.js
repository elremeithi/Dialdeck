// DialDeck Android shim: provides the subset of the WebExtension API that DialDeck uses,
// so the extension's own code (background.js + ui/*) runs unchanged inside the app's WebView.
// Native services come from window.DDAndroid (see MainActivity.Bridge).
(() => {
  'use strict';
  const B = window.DDAndroid;
  globalThis.DD_ANDROID = true;
  const notAvailable = what => () => Promise.reject(new Error(`${what} is not available in the Android app`));
  const listeners = () => { const l = []; return { addListener: f => l.push(f), removeListener: f => { const i = l.indexOf(f); if (i >= 0) l.splice(i, 1); }, hasListener: f => l.includes(f), _l: l }; };

  // ---------- network: cross-origin requests go through the native client (no CORS, WebDAV methods) ----------
  const pending = new Map();
  let seq = 0;
  window.__ddHttpDone = (id, r) => {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    if (r.error) p.reject(new TypeError('Network error: ' + r.error));
    else p.resolve(r);
  };
  const toB64 = async body => {
    if (body == null) return '';
    let u8;
    if (typeof body === 'string') u8 = new TextEncoder().encode(body);
    else if (body instanceof Blob) u8 = new Uint8Array(await body.arrayBuffer());
    else if (body instanceof ArrayBuffer) u8 = new Uint8Array(body);
    else if (ArrayBuffer.isView(body)) u8 = new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    else if (body instanceof URLSearchParams) u8 = new TextEncoder().encode(body.toString());
    else throw new TypeError('Unsupported request body');
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const req = input instanceof Request ? input : null;
    const url = new URL(req ? req.url : String(input), location.href);
    if (url.origin === location.origin || url.protocol === 'data:' || url.protocol === 'blob:') return nativeFetch(input, init);
    const method = String(init.method || req?.method || 'GET').toUpperCase();
    const headers = {};
    new Headers(init.headers || req?.headers || {}).forEach((v, k) => { headers[k] = v; });
    const body = init.body ?? (req && method !== 'GET' && method !== 'HEAD' ? await req.arrayBuffer() : null);
    const signal = init.signal || req?.signal;
    const id = 'r' + (++seq);
    const r = await new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
      pending.set(id, { resolve, reject });
      signal?.addEventListener('abort', () => { if (pending.delete(id)) reject(new DOMException('Aborted', 'AbortError')); });
      toB64(body).then(b => B.http(id, method, url.href, JSON.stringify(headers), b), e => { pending.delete(id); reject(e); });
    });
    const bin = atob(r.body || '');
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const nullBody = method === 'HEAD' || [204, 205, 304].includes(r.status);
    const status = r.status >= 200 && r.status <= 599 ? r.status : 502;
    const resp = new Response(nullBody ? null : bytes, { status, statusText: r.statusText || '', headers: r.headers || {} });
    Object.defineProperty(resp, 'url', { value: r.url || url.href });
    return resp;
  };

  // ---------- storage.local (IndexedDB-backed, cached in memory) ----------
  const storageChanged = listeners();
  const cache = {};
  const dbReady = new Promise((resolve, reject) => {
    const r = indexedDB.open('dialdeck-kv', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onerror = () => reject(r.error);
    r.onsuccess = () => {
      const db = r.result;
      const t = db.transaction('kv', 'readonly');
      const st = t.objectStore('kv');
      const keysReq = st.getAllKeys(), valsReq = st.getAll();
      t.oncomplete = () => { keysReq.result.forEach((k, i) => { cache[k] = valsReq.result[i]; }); resolve(db); };
      t.onerror = () => reject(t.error);
    };
  });
  const clone = v => (v === undefined ? undefined : structuredClone(v));
  const local = {
    async get(keys) {
      await dbReady;
      const out = {};
      if (keys == null) { for (const k of Object.keys(cache)) out[k] = clone(cache[k]); return out; }
      if (typeof keys === 'string') keys = [keys];
      if (Array.isArray(keys)) { for (const k of keys) if (k in cache) out[k] = clone(cache[k]); return out; }
      for (const [k, def] of Object.entries(keys)) out[k] = k in cache ? clone(cache[k]) : def;
      return out;
    },
    async set(obj) {
      const db = await dbReady;
      const changes = {};
      for (const [k, v] of Object.entries(obj)) { changes[k] = { oldValue: cache[k], newValue: clone(v) }; cache[k] = clone(v); }
      await new Promise((res, rej) => {
        const t = db.transaction('kv', 'readwrite');
        for (const [k, v] of Object.entries(obj)) t.objectStore('kv').put(clone(v), k);
        t.oncomplete = res; t.onerror = () => rej(t.error);
      });
      setTimeout(() => storageChanged._l.forEach(f => f(changes, 'local')), 0);
    },
    async remove(keys) {
      const db = await dbReady;
      if (typeof keys === 'string') keys = [keys];
      const changes = {};
      for (const k of keys) { changes[k] = { oldValue: cache[k] }; delete cache[k]; }
      await new Promise((res, rej) => { const t = db.transaction('kv', 'readwrite'); for (const k of keys) t.objectStore('kv').delete(k); t.oncomplete = res; t.onerror = () => rej(t.error); });
      setTimeout(() => storageChanged._l.forEach(f => f(changes, 'local')), 0);
    },
  };

  // ---------- runtime messaging: page and "background" share one context ----------
  const onMessage = listeners(), onInstalled = listeners(), onStartup = listeners();
  const runtime = {
    id: 'dialdeck-android',
    lastError: undefined,
    getURL: p => new URL(String(p).replace(/^\//, ''), location.origin + '/').href,
    getManifest: () => ({ name: 'DialDeck', version: B?.version?.() || '?' }),
    sendMessage: msg => new Promise(resolve => {
      let done = false, async = false;
      const reply = v => { if (!done) { done = true; resolve(v); } };
      for (const f of onMessage._l) if (f(msg, { id: 'dialdeck-android' }, reply) === true) async = true;
      if (!async && !done) resolve(undefined);
    }),
    onMessage, onInstalled, onStartup,
    openOptionsPage: () => { location.hash = '#settings'; },
  };

  // ---------- opening links: everything external goes to the chosen browser (Waterfox) ----------
  const open = url => {
    const u = new URL(url, location.href);
    if (u.origin === location.origin) {
      if (u.pathname === location.pathname) { location.hash = u.hash; return; }
      location.href = u.href;
      return;
    }
    B.openUrl(u.href);
  };
  const tabs = {
    create: async ({ url }) => { if (url) open(url); return { id: 1 }; },
    update: async (_id, { url } = {}) => { if (url) open(url); return { id: 1 }; },
    query: async () => [],
    getCurrent: async () => ({ id: 0 }),
    get: notAvailable('tabs.get'),
    remove: async () => {},
    captureVisibleTab: notAvailable('Screenshots'),
    onUpdated: listeners(),
  };
  const windows = {
    create: async ({ url, type } = {}) => {
      if (type === 'popup') throw new Error('Screenshots are made by your desktop browsers'); // thumbnail capture
      if (url) open(url);
      return { id: 1, tabs: [{ id: 1 }] };
    },
    remove: async () => {},
    update: async () => {},
  };

  // ---------- alarms (only while the app is open; it also syncs on resume) ----------
  const onAlarm = listeners();
  const timers = new Map();
  const alarms = {
    create: (name, info = {}) => {
      alarms.clear(name);
      const period = (info.periodInMinutes || 0) * 60000, delay = (info.delayInMinutes ?? info.periodInMinutes ?? 0) * 60000;
      const fire = () => onAlarm._l.forEach(f => f({ name }));
      const t = setTimeout(() => { fire(); if (period) timers.set(name, setInterval(fire, period)); }, delay);
      timers.set(name, t);
    },
    clear: async name => { const t = timers.get(name); if (t) { clearTimeout(t); clearInterval(t); timers.delete(name); } return true; },
    onAlarm,
  };

  const noop = () => {};
  globalThis.chrome = {
    storage: { local, onChanged: storageChanged },
    runtime, tabs, windows, alarms,
    contextMenus: { create: noop, removeAll: async () => {}, onClicked: listeners() },
    permissions: { contains: async () => true, request: async () => true },
    action: { setBadgeText: noop, setBadgeBackgroundColor: noop, setTitle: noop },
    commands: { onCommand: listeners() },
    sessions: { getRecentlyClosed: notAvailable('Recently closed tabs'), restore: notAvailable('sessions') },
    topSites: { get: notAvailable('Top sites') },
    bookmarks: { getTree: notAvailable('Bookmarks'), getSubTree: notAvailable('Bookmarks') },
  };

  // install / startup events for background.js (fired once modules have registered listeners)
  document.addEventListener('DOMContentLoaded', () => {
    let first = false;
    try { first = !localStorage.getItem('dd-installed'); localStorage.setItem('dd-installed', '1'); } catch { }
    setTimeout(() => (first ? onInstalled._l.forEach(f => f({ reason: 'install' })) : onStartup._l.forEach(f => f())), 0);
  });

  // ---------- Android integration hooks ----------
  window.ddOnResume = () => { runtime.sendMessage({ cmd: 'sync' }).catch?.(() => {}); };
  // Back button: close the topmost thing; return false to let the app go to the background.
  window.ddBack = () => {
    const menu = document.querySelector('#menu:not([hidden])');
    if (menu) { menu.hidden = true; menu.innerHTML = ''; return true; }
    const modals = document.querySelectorAll('.modal-wrap');
    if (modals.length) { modals[modals.length - 1].querySelector('.x-btn')?.click(); return true; }
    const drawer = document.getElementById('drawer');
    if (drawer && !drawer.hidden) { drawer.querySelector('.x-btn')?.click(); return true; }
    const sb = document.getElementById('sidebar');
    if (sb && !sb.hidden) { sb.querySelector('.x-btn')?.click(); return true; }
    const q = document.getElementById('q');
    if (q && (q.value || document.activeElement === q)) { q.value = ''; q.dispatchEvent(new Event('input')); q.blur(); return true; }
    return false;
  };
  document.documentElement.classList.add('dd-android');
})();
