// Background: context menus, thumbnail capture, visit tracking, periodic sync.
import { api, normalizeUrl, titleFromUrl, debounce } from './lib/util.js';
import { getState, update, getSyncConfig, getLocal, setLocal } from './lib/store.js';
import { emptyState, newGroup, newDial, groupsSorted, settingsOf, patch, allLiveDials } from './lib/model.js';
import { enqueueThumb, enqueueIcon, captureVisible, fetchPageTitle, generate } from './lib/thumbs.js';
import { putImage } from './lib/images.js';
import { syncNow, getSyncStatus, listSnapshots, snapshotNow, cleanupServer, resetServerFromLocal, restoreSnapshot } from './lib/sync.js';

const SYNC_ALARM = 'dialdeck-sync';

// ---------- first run ----------
api.runtime.onInstalled.addListener(async ({ reason }) => {
  const s = await getState();
  if (reason === 'install' && !Object.keys(s.groups).length) {
    await update(st => {
      const home = newGroup(st, 'Home', { emoji: '🏠' });
      const work = newGroup(st, 'Work', { emoji: '💼' });
      for (const [url, title] of [
        ['https://www.wikipedia.org/', 'Wikipedia'], ['https://github.com/', 'GitHub'],
        ['https://www.youtube.com/', 'YouTube'], ['https://news.ycombinator.com/', 'Hacker News'],
      ]) newDial(st, { groupId: home.id, url, title, thumb: { mode: 'logo', image: null, bg: null, fit: 'contain', at: 0 } });
      newDial(st, { groupId: work.id, url: 'https://nextcloud.com/', title: 'Nextcloud', thumb: { mode: 'logo', image: null, bg: null, fit: 'contain', at: 0 } });
    });
    const st = await getState();
    await setLocal('seedIds', [...Object.keys(st.groups), ...Object.keys(st.dials)]);
    for (const d of allLiveDials(st)) enqueueThumb(d.id, 'logo');
    api.tabs.create({ url: api.runtime.getURL('newtab.html#welcome') });
  }
  await rebuildMenus();
  await scheduleSync();
});

api.runtime.onStartup?.addListener(async () => {
  await rebuildMenus();
  await scheduleSync();
  syncNow().catch(() => {});
});

// ---------- context menus ----------
const rebuildMenus = debounce(async () => {
  try {
    await api.contextMenus.removeAll();
    const s = await getState();
    const groups = groupsSorted(s);
    const contexts = ['page', 'link', 'frame', 'image'];
    api.contextMenus.create({ id: 'dd-root', title: 'Add to DialDeck', contexts });
    for (const g of groups) api.contextMenus.create({ id: 'dd-add:' + g.id, parentId: 'dd-root', title: `${g.emoji ? g.emoji + ' ' : ''}${g.title}`, contexts });
    api.contextMenus.create({ id: 'dd-sep', parentId: 'dd-root', type: 'separator', contexts });
    api.contextMenus.create({ id: 'dd-newgroup', parentId: 'dd-root', title: 'New group…', contexts: ['page', 'link'] });
    api.contextMenus.create({ id: 'dd-addall', parentId: 'dd-root', title: 'Add all tabs in this window as a new group', contexts: ['page'] });
    api.contextMenus.create({ id: 'dd-setthumb', title: 'Use this image as a DialDeck thumbnail for this site', contexts: ['image'] });
  } catch (e) { console.warn('menus', e); }
}, 300);

api.contextMenus.onClicked.addListener(async (info, tab) => {
  const url = normalizeUrl(info.linkUrl || info.pageUrl || tab?.url);
  if (info.menuItemId === 'dd-addall') return addAllTabs(tab.windowId);
  if (info.menuItemId === 'dd-setthumb') return setImageThumb(info.srcUrl, info.pageUrl);
  if (!url) return;
  let groupId;
  if (info.menuItemId === 'dd-newgroup') {
    groupId = await update(s => newGroup(s, new URL(url).hostname.replace(/^www\./, '')).id);
  } else if (String(info.menuItemId).startsWith('dd-add:')) groupId = String(info.menuItemId).slice(7);
  if (!groupId) return;
  const isPage = !info.linkUrl;
  const title = isPage ? (tab?.title || titleFromUrl(url)) : (info.selectionText || info.linkText || '');
  await addDial({ url, title, groupId, fromTab: isPage ? tab : null });
});

async function setImageThumb(src, pageUrl) {
  try {
    const blob = await (await fetch(src)).blob();
    const hash = await putImage(blob);
    const host = new URL(pageUrl).hostname;
    await update(s => {
      let n = 0;
      for (const d of allLiveDials(s)) {
        try { if (new URL(d.url).hostname === host) { patch(d, { thumb: { ...d.thumb, mode: 'custom', image: hash, fit: 'cover', at: Date.now() } }); n++; } } catch { }
      }
      if (!n) return false;
    });
  } catch (e) { console.warn(e); }
}

async function addAllTabs(windowId) {
  const tabs = await api.tabs.query({ windowId });
  const ids = [];
  await update(s => {
    const g = newGroup(s, 'Tabs ' + new Date().toLocaleDateString());
    for (const t of tabs) {
      const url = normalizeUrl(t.url);
      if (!url || !/^https?:/.test(url)) continue;
      ids.push(newDial(s, { groupId: g.id, url, title: t.title || titleFromUrl(url) }).id);
    }
  });
  ids.forEach(id => enqueueThumb(id));
}

export async function addDial({ url, title, groupId, fromTab, parentId = null, mode }) {
  const st = settingsOf(await getState());
  const thumbMode = mode || st.defaultThumbMode;
  const id = await update(s => {
    if (!s.groups[groupId] || s.groups[groupId].deleted) groupId = groupsSorted(s)[0]?.id || newGroup(s, 'Home').id;
    return newDial(s, { groupId, parentId, url, title: title || titleFromUrl(url), thumb: { mode: thumbMode, image: null, bg: null, fit: thumbMode === 'logo' ? 'contain' : 'cover', at: 0 } }).id;
  });
  // If we're adding the page the user is looking at, screenshot it immediately (no extra window).
  if (fromTab && fromTab.active && thumbMode === 'auto') {
    try {
      const hash = await putImage(await captureVisible(fromTab.windowId));
      await update(s => { patch(s.dials[id], { thumb: { ...s.dials[id].thumb, image: hash, at: Date.now() } }); });
      return id;
    } catch (e) { console.warn('visible capture failed', e); }
  }
  if (thumbMode === 'auto' || thumbMode === 'logo') enqueueThumb(id);
  if (!title) fetchPageTitle(url).then(t => t && update(s => { const d = s.dials[id]; if (!d || d._ts.title > d.createdAt + 5) return false; patch(d, { title: t }); }));
  return id;
}

// ---------- capture-on-visit & visit counting ----------
const urlKey = u => { try { const x = new URL(u); return (x.hostname.replace(/^www\./, '') + x.pathname.replace(/\/$/, '') + x.search).toLowerCase(); } catch { return u; } };

api.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.status !== 'complete' || !tab.url || !/^https?:/.test(tab.url)) return;
  const s = await getState();
  const key = urlKey(tab.url);
  const matches = allLiveDials(s).filter(d => d.type === 'link' && urlKey(d.url) === key);
  if (!matches.length) return;
  const st = settingsOf(s);
  const stale = d => d.thumb?.mode === 'auto' && (!d.thumb.image || (st.thumbRefreshDays > 0 && Date.now() - (d.thumb.at || 0) > st.thumbRefreshDays * 864e5));
  if (st.captureOnVisit && tab.active && matches.some(stale)) {
    setTimeout(async () => {
      try {
        const [cur] = await api.tabs.query({ active: true, windowId: tab.windowId });
        if (!cur || cur.id !== tabId || urlKey(cur.url) !== key) return;
        const hash = await putImage(await captureVisible(tab.windowId));
        await update(x => { for (const d of matches) if (x.dials[d.id] && stale(x.dials[d.id])) patch(x.dials[d.id], { thumb: { ...x.dials[d.id].thumb, image: hash, at: Date.now() } }); });
      } catch (e) { /* page not capturable */ }
    }, st.captureDelay);
  }
});

// ---------- messages from pages ----------
api.runtime.onMessage.addListener((msg, sender, reply) => {
  (async () => {
    switch (msg.cmd) {
      case 'thumb': enqueueThumb(msg.id, msg.kind || 'auto'); return { ok: true };
      case 'thumbNow': await generate(msg.id, msg.kind || 'auto'); return { ok: true };
      case 'refreshGroup': {
        const s = await getState();
        for (const d of allLiveDials(s)) if (d.groupId === msg.groupId && d.type === 'link' && ['auto', 'logo'].includes(d.thumb?.mode)) enqueueThumb(d.id);
        return { ok: true };
      }
      case 'refreshMissing': {
        const s = await getState();
        let n = 0;
        for (const d of allLiveDials(s)) if (d.type === 'link' && !d.thumb?.image && ['auto', 'logo'].includes(d.thumb?.mode)) { enqueueThumb(d.id); n++; }
        return { ok: true, n };
      }
      case 'addDial': return { ok: true, id: await addDial(msg) };
      case 'addCurrent': {
        const [tab] = await api.tabs.query({ active: true, currentWindow: true });
        return { ok: true, id: await addDial({ url: normalizeUrl(tab.url), title: msg.title || tab.title, groupId: msg.groupId, fromTab: tab, mode: msg.mode }) };
      }
      case 'fetchTitle': {
        const s0 = await getState(); const d0 = s0.dials[msg.id];
        if (!d0) return { ok: false };
        const t = await fetchPageTitle(d0.url);
        if (t) await update(s => { const d = s.dials[msg.id]; if (!d || d.title !== d0.title) return false; patch(d, { title: t }); });
        return { ok: true, title: t };
      }
      case 'visit': {
        await update(s => { const d = s.dials[msg.id]; if (!d) return false; patch(d, { visits: (d.visits || 0) + 1, lastVisit: Date.now() }); });
        return { ok: true };
      }
      case 'sync': { const result = await syncNow({ force: !!msg.force }); fillMissingThumbs(); return { ok: true, result }; }
      case 'syncConfigChanged': await scheduleSync(); return { ok: true, result: await syncNow({ force: true }) };
      case 'listSnapshots': return { ok: true, result: await listSnapshots() };
      case 'snapshotNow': await snapshotNow(); return { ok: true };
      case 'restoreSnapshot': await snapshotNow().catch(() => {}); return { ok: true, result: await restoreSnapshot(msg.name) };
      case 'cleanupServer': return { ok: true, result: await cleanupServer() };
      case 'resetServer': return { ok: true, result: await resetServerFromLocal() };
      case 'status': return { ok: true, status: await getSyncStatus() };
      default: return { ok: false, error: 'unknown command' };
    }
  })().then(reply, e => reply({ ok: false, error: e.message || String(e) }));
  return true;
});

api.commands?.onCommand.addListener(async cmd => {
  if (cmd === 'add-current') {
    const s = await getState();
    const last = await getLocal('lastGroup', null);
    const groupId = (last && s.groups[last] && !s.groups[last].deleted) ? last : groupsSorted(s)[0]?.id;
    const [tab] = await api.tabs.query({ active: true, currentWindow: true });
    if (tab && /^https?:/.test(tab.url)) {
      await addDial({ url: tab.url, title: tab.title, groupId, fromTab: tab });
      api.action.setBadgeText({ text: '✓', tabId: tab.id });
      setTimeout(() => api.action.setBadgeText({ text: '', tabId: tab.id }), 1500);
    }
  }
});

// ---------- sync scheduling ----------
async function scheduleSync() {
  const cfg = await getSyncConfig();
  await api.alarms.clear(SYNC_ALARM);
  if (cfg.enabled) api.alarms.create(SYNC_ALARM, { periodInMinutes: Math.max(1, Number(cfg.intervalMin) || 10), delayInMinutes: 1 });
  await updateBadge();
}

api.alarms.onAlarm.addListener(a => { if (a.name === SYNC_ALARM) syncNow().then(fillMissingThumbs, () => {}); });

// Dials added on another device (e.g. the Android app, which can't take screenshots) arrive
// without a thumbnail: make them here. Each dial is retried at most every 12 hours.
// Site icons: every dial gets its favicon fetched once (on whichever device gets there first) and
// synced; sites without a usable icon are retried at most weekly per device.
async function fillMissingIcons(s) {
  if (settingsOf(s).syncFavicons === false) return;
  const tried = await getLocal('iconTried', {});
  const now = Date.now();
  let changed = false;
  for (const d of allLiveDials(s)) {
    if (d.type !== 'link' || d.icon || !/^https?:/.test(d.url)) continue;
    const key = d.id + '|' + d.url; // an edited address gets a fresh attempt
    if (now - (tried[key] || 0) < 7 * 864e5) continue;
    tried[key] = now; changed = true;
    enqueueIcon(d.id);
  }
  if (changed) {
    for (const key of Object.keys(tried)) { const x = s.dials[key.split('|')[0]]; if (!x || x.deleted || x.icon || now - tried[key] > 30 * 864e5) delete tried[key]; }
    await setLocal('iconTried', tried);
  }
}

async function fillMissingThumbs() {
  try {
    const s = await getState();
    const tried = await getLocal('thumbTried', {});
    const now = Date.now();
    let changed = false;
    for (const d of allLiveDials(s)) {
      const mode = d.thumb?.mode;
      if (d.type !== 'link' || d.thumb?.image || !['auto', 'logo'].includes(mode) || !/^https?:/.test(d.url)) continue;
      if (globalThis.DD_ANDROID && mode === 'auto') continue;
      if (now - (tried[d.id] || 0) < 12 * 3600e3) continue;
      tried[d.id] = now; changed = true;
      enqueueThumb(d.id);
    }
    await fillMissingIcons(s);
    if (changed) {
      for (const id of Object.keys(tried)) if (!s.dials[id] || s.dials[id].deleted || now - tried[id] > 30 * 864e5) delete tried[id];
      await setLocal('thumbTried', tried);
    }
  } catch (e) { console.warn('fillMissingThumbs', e); }
}

// new / imported / synced dials pick up missing icons a few seconds after they appear
const fillSoon = debounce(() => fillMissingThumbs(), 5000);
const pushSoon = debounce(() => syncNow().catch(() => {}), 4000);

api.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.state) { rebuildMenus(); fillSoon(); }
  if (changes.dirtyAt) getSyncConfig().then(c => c.enabled && pushSoon());
  if (changes.syncStatus) updateBadge();
});

async function updateBadge() {
  const st = await getSyncStatus();
  const cfg = await getSyncConfig();
  const err = cfg.enabled && st.state === 'error';
  api.action.setBadgeText({ text: err ? '!' : '' });
  if (err) api.action.setBadgeBackgroundColor({ color: '#d33' });
  api.action.setTitle({ title: err ? `DialDeck — sync error: ${st.error}` : 'DialDeck' });
}

// Make sure menus exist when the worker wakes up for any reason.
rebuildMenus();
// Ensure there is always at least an empty valid state
getState().then(s => { if (!s.createdAt) update(x => { Object.assign(x, emptyState(), x); }); });
setLocal('bgAlive', Date.now());
