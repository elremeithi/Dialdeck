// New tab page controller.
import { api, debounce } from '../lib/util.js';
import { getState, onStateChange, getLocal, setLocal, getSyncConfig, update } from '../lib/store.js';
import { groupsSorted, dialsOf, moveDial, placeOrder, patch } from '../lib/model.js';
import { app, setState, h, $, $$, send, toast, modal, openMenu } from './core.js';
import { applyAppearance } from './appearance.js';
import { renderGrid, bindGrid, openDial, currentDrag, endDrag, hoveredDial, removeDial } from './grid.js';
import { editDial, editGroup, openFolder, newFolder, refreshFolders, groupMenu, renderLock, setGroupMode } from './dialogs.js';
import { openSettings, settingsOpen, closeSettings } from './settings.js';
import { initSearch, filter } from './search.js';
import { toggleSidebar } from './sidebar.js';
import { I } from './icons.js';

bindGrid({ editDial, openFolder, newFolder });

// ---------- group selection ----------
app.selectGroup = gid => {
  if (!gid || app.groupId === gid) { if (gid) render(); return; }
  app.groupId = gid;
  if (app.settings.rememberLastGroup) setLocal('lastGroup', gid);
  render();
};

function pickInitialGroup(last) {
  const groups = groupsSorted(app.state);
  const hashG = new URLSearchParams(location.hash.slice(1)).get('g');
  const ok = id => id && app.state.groups[id] && !app.state.groups[id].deleted;
  if (ok(hashG)) return hashG;
  if (!app.settings.rememberLastGroup && ok(app.settings.defaultGroup)) return app.settings.defaultGroup;
  if (ok(last)) return last;
  return groups[0]?.id || null;
}

// ---------- rendering ----------
function render() {
  if (app.dragging) { app.pendingRender = true; return; }
  const groups = groupsSorted(app.state);
  if (!app.state.groups[app.groupId] || app.state.groups[app.groupId].deleted) app.groupId = groups[0]?.id || null;
  applyAppearance();
  renderGroupBar(groups);
  renderMain();
  refreshFolders();
  app.paintEngine?.();
  $('#search').hidden = !app.settings.showSearch;
  $('#clock').hidden = !app.settings.showClock;
  $('#btn-sidebar').hidden = !app.settings.showSidebarButton;
  paintLayoutBtn();
  tickClock();
}
app.render = render;

function renderMain() {
  const grid = $('#grid'), lock = $('#lock-screen');
  if (app.searching) { filter($('#q').value); return; }
  $('#search-results').hidden = true;
  const g = app.state.groups[app.groupId];
  if (!g) {
    lock.hidden = true; grid.hidden = false;
    grid.innerHTML = '';
    grid.append(h('div', { class: 'empty', style: { gridColumn: '1 / -1' } }, h('h2', {}, 'No groups yet'), h('p', {}, 'Create a group to start adding speed dials.'), h('button', { class: 'btn primary', html: I.plus, onclick: () => editGroup(null, { isNew: true }) }, 'Create group')));
    return;
  }
  if (g.lockHash && !app.unlocked.has(g.id)) {
    grid.hidden = true; lock.hidden = false;
    renderLock(lock, g, render);
    return;
  }
  lock.hidden = true; grid.hidden = false;
  renderGrid(grid, g.id, null);
}
app.renderMainOnly = renderMain;

function renderGroupBar(groups) {
  const bar = $('#groupbar');
  bar.hidden = !app.settings.showGroupBar;
  bar.className = 'style-' + app.settings.groupBarStyle;
  bar.innerHTML = '';
  for (const g of groups) {
    const count = Object.values(app.state.dials).filter(d => !d.deleted && d.groupId === g.id && d.type === 'link').length;
    const b = h('button', { class: 'gtab' + (g.id === app.groupId ? ' active' : ''), draggable: 'true', dataset: { gid: g.id }, style: g.color ? { '--gcolor': g.color } : null, title: 'Double-click to rename · right-click for options' },
      g.emoji ? h('span', {}, g.emoji) : null,
      h('span', { class: 'gt' }, g.title),
      g.lockHash ? h('span', { class: 'lk', html: app.unlocked.has(g.id) ? I.unlock : I.lock }) : null,
      app.settings.showGroupCounts ? h('span', { class: 'count' }, String(count)) : null);
    b.addEventListener('click', () => app.selectGroup(g.id));
    b.addEventListener('auxclick', e => { if (e.button === 1) { e.preventDefault(); import('./grid.js').then(m => m.openGroupAll(g.id)); } });
    b.addEventListener('dblclick', () => inlineRename(b, g));
    b.addEventListener('contextmenu', e => { e.preventDefault(); groupMenu(g, e.clientX, e.clientY); });
    wireGroupTabDnD(b, g);
    bar.append(b);
  }
  const add = h('button', { class: 'gtab add', title: 'New group', html: I.plus, onclick: () => editGroup(null, { isNew: true }) });
  bar.append(add);
}

function inlineRename(btn, g) {
  const inp = h('input', { value: g.title });
  inp.style.width = Math.max(6, g.title.length + 1) + 'ch';
  const span = btn.querySelector('.gt');
  span.replaceWith(inp);
  inp.focus(); inp.select();
  let done = false;
  const commit = save => {
    if (done) return; done = true;
    const v = inp.value.trim();
    if (save && v && v !== g.title) update(s => { patch(s.groups[g.id], { title: v }); });
    else render();
  };
  inp.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') commit(true); if (e.key === 'Escape') commit(false); });
  inp.addEventListener('blur', () => commit(true));
  inp.addEventListener('click', e => e.stopPropagation());
}

// Group tabs: reorder by dragging; drop a dial on a tab to move it there;
// hover a tab while dragging a dial to preview that group.
let groupDrag = null;
function wireGroupTabDnD(b, g) {
  b.addEventListener('dragstart', e => {
    groupDrag = g.id;
    e.dataTransfer.setData('application/x-dialdeck-group', g.id);
    e.dataTransfer.effectAllowed = 'move';
    b.classList.add('dragging');
  });
  b.addEventListener('dragend', () => { groupDrag = null; b.classList.remove('dragging'); $$('.gtab.drop').forEach(x => x.classList.remove('drop')); });
  b.addEventListener('dragover', e => {
    const types = [...e.dataTransfer.types];
    if (types.includes('application/x-dialdeck-dial') || (groupDrag && groupDrag !== g.id) || types.includes('text/uri-list')) {
      e.preventDefault();
      b.classList.add('drop');
    }
  });
  b.addEventListener('dragleave', () => b.classList.remove('drop'));
  b.addEventListener('drop', async e => {
    e.preventDefault();
    b.classList.remove('drop');
    const types = [...e.dataTransfer.types];
    if (types.includes('application/x-dialdeck-group') && groupDrag && groupDrag !== g.id) {
      const moving = groupDrag;
      const r = b.getBoundingClientRect();
      const after = e.clientX > r.left + r.width / 2;
      await update(s => {
        const list = groupsSorted(s).filter(x => x.id !== moving);
        let idx = list.findIndex(x => x.id === g.id) + (after ? 1 : 0);
        patch(s.groups[moving], { order: placeOrder(list, idx) });
      });
      return;
    }
    const dr = currentDrag();
    if (dr) {
      const id = dr.id;
      endDrag();
      if (app.state.dials[id]?.groupId === g.id && !app.state.dials[id]?.parentId) return;
      await update(s => moveDial(s, id, { groupId: g.id, parentId: null }));
      toast(`Moved to ${g.title}`, { action: 'Go', onAction: () => app.selectGroup(g.id) });
      return;
    }
    const url = (e.dataTransfer.getData('text/uri-list') || '').split('\n').find(l => l && !l.startsWith('#'));
    if (url) { await send({ cmd: 'addDial', url: url.trim(), groupId: g.id }); toast(`Added to ${g.title}`); }
  });
}

// ---------- per-tab layout toggle ----------
function paintLayoutBtn() {
  const b = $('#btn-layout');
  const g = app.state.groups[app.groupId];
  b.hidden = !g || app.settings.lockLayout;
  if (!g) return;
  const list = app.layoutMode === 'list';
  b.innerHTML = list ? I.grid : I.list;
  b.title = `“${g.title}” uses ${list ? 'List' : 'Tiles'}${g.layout?.mode ? '' : ' (default)'} — click to switch this tab to ${list ? 'Tiles' : 'List'}; right-click for options`;
}

// ---------- sync indicator ----------
async function paintSync() {
  const btn = $('#btn-sync');
  const cfg = await getSyncConfig();
  const st = await getLocal('syncStatus', { state: 'off' });
  btn.className = 'icon-btn';
  if (!cfg.enabled) { btn.innerHTML = I.cloudOff; btn.title = 'Sync is off — click to set up your Nextcloud / WebDAV'; return; }
  if (st.state === 'syncing') { btn.innerHTML = I.sync; btn.classList.add('spin'); btn.title = 'Syncing…'; }
  else if (st.state === 'error') { btn.innerHTML = I.cloudErr; btn.classList.add('err'); btn.title = 'Sync error: ' + st.error + '\nClick to retry, right-click for settings'; }
  else { btn.innerHTML = I.cloudOk; btn.title = 'Synced ' + (st.at ? new Date(st.at).toLocaleString() : '') + '\nClick to sync now, right-click for settings'; }
}

async function syncClick() {
  const cfg = await getSyncConfig();
  if (!cfg.enabled) return openSettings('sync');
  const r = await send({ cmd: 'sync', force: true });
  if (!r?.ok) toast('Sync failed: ' + r?.error, { error: true, action: 'Settings', onAction: () => openSettings('sync'), ms: 8000 });
}

// ---------- clock ----------
let clockTimer;
function tickClock() {
  clearTimeout(clockTimer);
  if (!app.settings.showClock) return;
  const d = new Date();
  $('#clock').innerHTML = '';
  $('#clock').append(d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: !app.settings.clock24h }), h('small', {}, d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })));
  clockTimer = setTimeout(tickClock, 60000 - (d.getSeconds() * 1000 + d.getMilliseconds()) + 50);
}

// ---------- keyboard ----------
function typing(e) { const t = e.target; return t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName); }

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && settingsOpen() && !$('.modal-wrap') && !$('#menu:not([hidden])')) { closeSettings(); return; } // even from a settings field
  if (typing(e) || $('.modal-wrap')) return;
  if (e.ctrlKey || e.metaKey) return;
  const groups = groupsSorted(app.state);
  const idx = groups.findIndex(g => g.id === app.groupId);
  if (e.altKey && /^[1-9]$/.test(e.key)) { const g = groups[+e.key - 1]; if (g) { e.preventDefault(); app.selectGroup(g.id); } return; }
  if (e.altKey) return;
  if (e.key === '/') { e.preventDefault(); $('#q').focus(); return; }
  if (e.key === ']' || e.key === 'PageDown') { if (groups.length) app.selectGroup(groups[(idx + 1) % groups.length].id); return; }
  if (e.key === '[' || e.key === 'PageUp') { if (groups.length) app.selectGroup(groups[(idx - 1 + groups.length) % groups.length].id); return; }
  if (/^[1-9]$/.test(e.key)) {
    const g = app.state.groups[app.groupId];
    if (g?.lockHash && !app.unlocked.has(g.id)) return;
    const d = dialsOf(app.state, app.groupId, null, app.settings.sortMode)[+e.key - 1];
    if (d) { d.type === 'folder' ? openFolder(d.id) : openDial(d, e.shiftKey ? 'new' : app.settings.openIn); }
    return;
  }
  if (e.key === 'Delete' && !app.settings.lockLayout) { const d = hoveredDial(); if (d) { e.preventDefault(); removeDial(d); } return; }
  if ((e.key === 'e' || e.key === 'E' || e.key === 'F2') && !app.settings.lockLayout) { const d = hoveredDial(); if (d) { e.preventDefault(); editDial(d); return; } }
  if ((e.key === 'n' || e.key === 'N') && !app.settings.lockLayout) { e.preventDefault(); if (app.groupId) editDial(null, { groupId: app.groupId }); return; }
  if (e.key === 'g' || e.key === 'G') { e.preventDefault(); editGroup(null, { isNew: true }); return; }
  if (e.key === 's' || e.key === 'S') { syncClick(); return; }
  if (e.key === ',') { settingsOpen() ? closeSettings() : openSettings(); return; }
  if (e.key === 'Escape') { if (settingsOpen()) closeSettings(); else toggleSidebar(false); return; }
  if (e.key.length === 1 && /\S/.test(e.key) && app.settings.showSearch) { $('#q').focus(); } // start typing to search
});

// ---------- mouse wheel group switching ----------
let wheelLock = 0;
function wheelSwitch(e, force) {
  if (!force && !app.settings.wheelSwitch) return;
  if (!force && (document.documentElement.scrollHeight > innerHeight + 4 || e.target.closest('.modal-wrap, #drawer, #sidebar, #menu, #search-results'))) return;
  if (Math.abs(e.deltaY) < 4 || Date.now() < wheelLock) return;
  const groups = groupsSorted(app.state);
  const idx = groups.findIndex(g => g.id === app.groupId);
  const next = groups[(idx + (e.deltaY > 0 ? 1 : -1) + groups.length) % groups.length];
  if (next) { wheelLock = Date.now() + 350; app.selectGroup(next.id); }
}
$('#groupbar').addEventListener('wheel', e => { e.preventDefault(); wheelSwitch(e, true); }, { passive: false });
addEventListener('wheel', e => wheelSwitch(e, false), { passive: true });

// ---------- permissions banner (Firefox treats host permissions as optional) ----------
async function checkPermissions() {
  const ok = await api.permissions.contains({ origins: ['<all_urls>'] }).catch(() => true);
  $('.perm-banner')?.remove();
  if (ok) return;
  const banner = h('div', { class: 'perm-banner' }, h('span', {}, 'DialDeck needs access to websites to capture thumbnails, fetch logos and reach your WebDAV server.'),
    h('button', { class: 'btn primary', onclick: async () => { if (await api.permissions.request({ origins: ['<all_urls>'] })) { banner.remove(); send({ cmd: 'refreshMissing' }); } } }, 'Grant access'));
  $('#main').prepend(banner);
}

// ---------- welcome ----------
function welcome() {
  const m = modal({
    title: 'Welcome to DialDeck', icon: I.grid, body: h('div', {},
      h('p', {}, 'Your speed dials, organised in groups — synced to your own Nextcloud or any WebDAV server.'),
      h('ul', { class: 'hint', style: { lineHeight: '1.8' } },
        h('li', {}, 'Right-click any page → “Add to DialDeck”, or use the toolbar button / Alt+Shift+D.'),
        h('li', {}, 'Drag dials to reorder, onto a group tab to move, onto a folder to file them. Drop links or images from other pages straight onto the grid.'),
        h('li', {}, 'Right-click dials and group tabs for everything else. Press , for settings.'),
        h('li', {}, 'Already used another speed dial? Settings → Backup & import.'),
      ),
    ),
    footer: [
      h('button', { class: 'btn', onclick: () => { m.close(); openSettings('backup'); } }, 'Import…'),
      h('button', { class: 'btn', html: I.cloud, onclick: () => { m.close(); openSettings('sync'); } }, 'Set up sync'),
      h('button', { class: 'btn primary', onclick: () => m.close() }, 'Start'),
    ],
    onClose: () => history.replaceState(null, '', location.pathname),
  });
}

function route() {
  const hsh = location.hash;
  if (hsh.startsWith('#settings')) openSettings(hsh.split('/')[1] || undefined);
  else if (hsh === '#welcome') welcome();
}

// ---------- boot ----------
async function init() {
  setState(await getState());
  app.groupId = pickInitialGroup(await getLocal('lastGroup', null));
  initSearch();
  render();
  document.body.classList.remove('loading');
  if (app.settings.newTabFocus === 'search') $('#q').focus();

  onStateChange(debounce(s => { setState(s); render(); }, 30));
  api.storage.onChanged.addListener((ch, area) => { if (area === 'local' && (ch.syncStatus || ch.syncConfig)) paintSync(); });
  paintSync();

  $('#btn-settings').innerHTML = I.gear;
  $('#btn-settings').addEventListener('click', () => settingsOpen() ? closeSettings() : openSettings());
  $('#btn-sidebar').innerHTML = I.side;
  $('#btn-sidebar').addEventListener('click', () => toggleSidebar());
  $('#btn-sync').addEventListener('click', syncClick);
  $('#btn-layout').addEventListener('click', () => { if (app.groupId) setGroupMode(app.groupId, app.layoutMode === 'list' ? 'grid' : 'list'); });
  $('#btn-layout').addEventListener('contextmenu', e => {
    e.preventDefault();
    const g = app.state.groups[app.groupId];
    if (!g) return;
    const def = app.settings.dialLayout === 'grid' ? 'Tiles' : 'List';
    openMenu([
      ...[['list', 'List for this tab'], ['grid', 'Tiles for this tab'], ['', `Use default (${def})`]].map(([m, label]) => ({ label: ((g.layout?.mode || '') === m ? '✓ ' : '\u2003') + label, onClick: () => setGroupMode(g.id, m) })),
      '-',
      { label: 'Sizes for this tab…', icon: I.edit, onClick: () => editGroup(g) },
      { label: 'Default layout & sizes…', icon: I.gear, onClick: () => openSettings('layout') },
    ], e.clientX, e.clientY);
  });
  $('#btn-sync').addEventListener('contextmenu', e => { e.preventDefault(); openSettings('sync'); });
  addEventListener('hashchange', route);
  route();
  checkPermissions();

  // Pull remote changes when a new tab opens (cheap: ETag check), at most every 30 s.
  const cfg = await getSyncConfig();
  if (cfg.enabled) {
    const st = await getLocal('syncStatus', {});
    if (Date.now() - (st.checkedAt || 0) > 30000) send({ cmd: 'sync' }).catch(() => {});
  }
}

init();
