// Dial tiles, grid rendering, drag & drop, opening dials, dial context menu.
import { api, hostOf, colorFor, escapeHtml, normalizeUrl, titleFromUrl } from '../lib/util.js';
import { dialsOf, moveDial, deleteDial, groupsSorted, patch, newDial } from '../lib/model.js';
import { update } from '../lib/store.js';
import { imageUrl, putImage } from '../lib/images.js';
import { app, h, $, $$, send, toast, undoable, openMenu, confirmBox, favicon } from './core.js';
import { I } from './icons.js';

let editDialFn = () => {}, openFolderFn = () => {}, newFolderFn = () => {};
export function bindGrid({ editDial, openFolder, newFolder }) { editDialFn = editDial; openFolderFn = openFolder; newFolderFn = newFolder; }

// ---------- tiles ----------
export function tileEl(d, { showGroup } = {}) {
  const isFolder = d.type === 'folder';
  const a = h('a', { class: 'dial' + (isFolder ? ' folder' : ''), href: isFolder ? '#' : d.url, draggable: app.settings.lockLayout ? 'false' : 'true', dataset: { id: d.id }, title: isFolder ? d.title : `${d.title}\n${d.url}` });
  const th = h('div', { class: 'thumb' });
  a.append(th);
  if (isFolder) fillFolderThumb(th, d);
  else fillThumb(th, d);
  const t = h('div', { class: 'title' });
  if (!isFolder && app.settings.showFavicons && app.settings.titlePos !== 'overlay') {
    const fav = favicon(d.url);
    if (fav) { const img = h('img', { src: fav, alt: '', loading: 'lazy' }); img.onerror = () => img.remove(); t.append(img); }
  }
  t.append(h('span', {}, d.title || (isFolder ? 'Folder' : titleFromUrl(d.url))));
  if (app.settings.titlePos === 'overlay') th.append(t); else a.append(t);
  a.append(h('button', { class: 'menu-btn', title: 'Options', html: I.dots, onclick: e => { e.preventDefault(); e.stopPropagation(); dialMenu(d, e.clientX, e.clientY); } }));
  if (showGroup) {
    const g = app.state.groups[d.groupId];
    a.append(h('div', { class: 'grp' }, g ? g.title : ''));
  }
  return a;
}

function fillThumb(th, d) {
  const t = d.thumb || {};
  th.style.backgroundColor = t.bg || '';
  if (t.image) {
    if (t.fit === 'contain') th.classList.add('contain');
    const img = h('img', { alt: '', draggable: 'false', decoding: 'async' });
    th.append(img);
    imageUrl(t.image).then(u => {
      if (u) img.src = u;
      else { img.remove(); letter(th, d); }
    });
  } else {
    letter(th, d);
    if ((t.mode === 'auto' || t.mode === 'logo') && !t.failed && /^https?:/.test(d.url)) th.append(h('div', { class: 'pending', title: 'Generating thumbnail…' }));
  }
}

function letter(th, d) {
  const host = hostOf(d.url);
  th.style.backgroundColor = d.thumb?.bg || colorFor(host || d.title);
  const txt = (d.title || host || '?').replace(/^www\./, '').trim();
  const words = txt.replace(/\(\d+\)/g, ' ').split(/[^\p{L}\p{N}]+/u).filter(Boolean); // letters/digits only: "Torrents - TD" → TT, "(258) Subscriptions - YouTube" → SY
  const l = words.length > 1 ? (words[0][0] + words[1][0]) : (words[0] || '?').slice(0, 2);
  th.append(h('div', { class: 'letter' }, l.charAt(0).toUpperCase() + l.slice(1, 2)));
}

function fillFolderThumb(th, d) {
  const kids = dialsOf(app.state, d.groupId, d.id);
  for (const k of kids.slice(0, 4)) {
    const m = h('div', { class: 'mini' });
    if (k.thumb?.bg) m.style.backgroundColor = k.thumb.bg;
    if (k.thumb?.image) {
      if (k.thumb.fit === 'contain') m.classList.add('contain');
      imageUrl(k.thumb.image).then(u => { if (u) m.style.backgroundImage = `url("${u}")`; });
    } else if (k.type === 'folder') m.innerHTML = I.folder;
    else { m.style.backgroundColor = k.thumb?.bg || colorFor(hostOf(k.url)); m.textContent = (k.title || hostOf(k.url) || '?')[0].toUpperCase(); }
    th.append(m);
  }
  th.append(h('div', { class: 'fbadge', html: I.folder }, String(kids.length)));
}

function addTile(groupId, parentId) {
  const a = h('a', { class: 'dial add', href: '#', title: 'Add a dial', draggable: 'false' });
  a.append(h('div', { class: 'thumb', html: I.plus }), h('div', { class: 'title' }, h('span', {}, 'Add dial')));
  a.addEventListener('click', e => { e.preventDefault(); editDialFn(null, { groupId, parentId }); });
  a.addEventListener('contextmenu', e => {
    e.preventDefault();
    openMenu([
      { label: 'Add dial', icon: I.link, onClick: () => editDialFn(null, { groupId, parentId }) },
      { label: 'New folder', icon: I.folder, onClick: () => newFolderFn(groupId, parentId) },
      { label: 'Add all open tabs', icon: I.tabs, onClick: () => addOpenTabs(groupId, parentId) },
    ], e.clientX, e.clientY);
  });
  return a;
}

export async function addOpenTabs(groupId, parentId = null) {
  const tabs = await api.tabs.query({ currentWindow: true });
  const ids = [];
  await update(s => {
    for (const t of tabs) if (/^https?:/.test(t.url)) ids.push(newDial(s, { groupId, parentId, url: t.url, title: t.title }).id);
  });
  ids.forEach(id => send({ cmd: 'thumb', id }));
  toast(`Added ${ids.length} tabs`);
}

// ---------- grid ----------
export function renderGrid(container, groupId, parentId = null) {
  container.innerHTML = '';
  container.dataset.group = groupId;
  container.dataset.parent = parentId || '';
  const list = dialsOf(app.state, groupId, parentId, app.settings.sortMode);
  for (const d of list) container.append(tileEl(d));
  if (app.settings.showAddTile && !app.settings.lockLayout) container.append(addTile(groupId, parentId));
  if (!list.length && !app.settings.showAddTile) {
    container.append(h('div', { class: 'empty' }, h('h2', {}, 'This group is empty'), h('button', { class: 'btn primary', html: I.plus, onclick: () => editDialFn(null, { groupId, parentId }) }, 'Add dial')));
  }
  if (!container._wired) wireGrid(container);
}

let hovered = null;
export function hoveredDial() {
  const el = document.activeElement?.closest?.('.dial[data-id]') || hovered;
  return el?.isConnected ? app.state.dials[el.dataset.id] : null;
}

function wireGrid(grid) {
  grid._wired = true;
  grid.addEventListener('mouseover', e => { hovered = e.target.closest('.dial[data-id]'); });
  grid.addEventListener('mouseleave', () => { hovered = null; });
  grid.addEventListener('click', e => {
    const a = e.target.closest('.dial');
    if (!a || a.classList.contains('add') || e.target.closest('.menu-btn')) return;
    const d = app.state.dials[a.dataset.id];
    if (!d) return;
    if (d.type === 'folder') { e.preventDefault(); openFolderFn(d.id); return; }
    e.preventDefault();
    const mode = (e.ctrlKey || e.metaKey) ? 'background' : e.shiftKey ? 'window' : app.settings.openIn;
    openDial(d, mode);
  });
  grid.addEventListener('auxclick', e => {
    if (e.button !== 1) return;
    const a = e.target.closest('.dial');
    if (!a || a.classList.contains('add')) return;
    e.preventDefault();
    const d = app.state.dials[a.dataset.id];
    if (d?.type === 'folder') openFolderAll(d);
    else if (d) openDial(d, 'background');
  });
  grid.addEventListener('contextmenu', e => {
    const a = e.target.closest('.dial');
    if (!a || a.classList.contains('add')) return;
    e.preventDefault();
    const d = app.state.dials[a.dataset.id];
    if (d) dialMenu(d, e.clientX, e.clientY);
  });
  wireDnD(grid);
}

export async function openDial(d, mode = 'current') {
  send({ cmd: 'visit', id: d.id }).catch(() => {});
  const url = d.url;
  const special = !/^https?:|^ftp:|^file:/i.test(url);
  if (mode === 'background') return api.tabs.create({ url, active: false });
  if (mode === 'new') return api.tabs.create({ url, active: true });
  if (mode === 'window') return api.windows.create({ url });
  if (mode === 'incognito') return api.windows.create({ url, incognito: true }).catch(() => toast('Allow the extension in private windows to use this', { error: true }));
  if (special) { const tab = await api.tabs.getCurrent(); return api.tabs.update(tab.id, { url }); }
  location.href = url;
}

function openFolderAll(d) {
  for (const k of dialsOf(app.state, d.groupId, d.id)) if (k.type === 'link') api.tabs.create({ url: k.url, active: false });
}

export function openGroupAll(groupId) {
  const list = dialsOf(app.state, groupId, null).filter(d => d.type === 'link');
  list.forEach(d => api.tabs.create({ url: d.url, active: false }));
  toast(`Opened ${list.length} tabs`);
}

// ---------- dial context menu ----------
export function dialMenu(d, x, y) {
  const groups = groupsSorted(app.state);
  const folders = Object.values(app.state.dials).filter(f => !f.deleted && f.type === 'folder' && f.groupId === d.groupId && f.id !== d.id);
  const items = d.type === 'folder' ? [
    { label: 'Open folder', icon: I.folder, onClick: () => openFolderFn(d.id) },
    { label: 'Open all in tabs', icon: I.tabs, onClick: () => openFolderAll(d) },
    { label: 'Rename / edit', icon: I.edit, onClick: () => editDialFn(d) },
  ] : [
    { label: 'Open', icon: I.link, onClick: () => openDial(d, 'current') },
    { label: 'Open in new tab', icon: I.ext, onClick: () => openDial(d, 'new') },
    { label: 'Open in background tab', icon: I.tabs, kbd: 'Ctrl+Click', onClick: () => openDial(d, 'background') },
    { label: 'Open in new window', icon: I.ext, kbd: 'Shift+Click', onClick: () => openDial(d, 'window') },
    { label: 'Open in private window', icon: I.incognito, onClick: () => openDial(d, 'incognito') },
    '-',
    { label: 'Edit', icon: I.edit, onClick: () => editDialFn(d) },
    { label: 'Thumbnail', icon: I.image, sub: [
      { label: 'Refresh screenshot', icon: I.refresh, onClick: () => regen(d, 'auto') },
      { label: 'Use site logo', icon: I.globe, onClick: () => regen(d, 'logo') },
      { label: 'Upload image…', icon: I.upload, onClick: () => editDialFn(d, { pickImage: true }) },
      { label: 'Letter tile', icon: I.palette, onClick: () => update(s => { patch(s.dials[d.id], { thumb: { ...s.dials[d.id].thumb, mode: 'letter', image: null, bg: null } }); }) },
    ] },
    { label: 'Copy URL', icon: I.copy, onClick: () => navigator.clipboard.writeText(d.url).then(() => toast('URL copied')) },
  ];
  if (app.settings.lockLayout) { openMenu(items.filter(it => it === '-' || !/Edit|Thumbnail|Rename/.test(it.label)).concat(['-', { label: 'Layout is locked (Settings → Behaviour)', icon: I.lock, onClick: () => {} }]), x, y); return; }
  items.push('-');
  const moveSub = groups.filter(g => g.id !== d.groupId || d.parentId).map(g => ({ label: (g.emoji ? g.emoji + ' ' : '') + g.title, onClick: () => moveTo(d, g.id, null) }));
  const folderSub = folders.filter(f => f.id !== d.parentId).map(f => ({ label: f.title || 'Folder', icon: I.folder, onClick: () => moveTo(d, d.groupId, f.id) }));
  if (d.parentId) folderSub.unshift({ label: 'Out of folder', icon: I.back, onClick: () => moveTo(d, d.groupId, null) });
  if (moveSub.length) items.push({ label: 'Move to group', icon: I.move, sub: moveSub });
  if (folderSub.length && d.type !== 'folder') items.push({ label: 'Move to folder', icon: I.folder, sub: folderSub });
  items.push({ label: 'Duplicate', icon: I.copy, onClick: () => update(s => { const c = newDial(s, { groupId: d.groupId, parentId: d.parentId, url: d.url, title: d.title, type: d.type, thumb: { ...d.thumb } }); patch(c, { order: d.order + 0.5 }); }) });
  items.push('-', { label: 'Delete', icon: I.trash, danger: true, kbd: 'Del', onClick: () => removeDial(d) });
  openMenu(items, x, y);
}

async function regen(d, kind) {
  await update(s => { patch(s.dials[d.id], { thumb: { ...s.dials[d.id].thumb, mode: kind, fit: kind === 'logo' ? 'contain' : 'cover' } }); });
  toast(kind === 'logo' ? 'Fetching logo…' : 'Capturing screenshot…', { ms: 2500 });
  const r = await send({ cmd: 'thumbNow', id: d.id, kind });
  if (!r?.ok) toast('Thumbnail failed: ' + (r?.error || 'unknown'), { error: true });
}

export async function removeDial(d) {
  if (app.settings.confirmDelete && !(await confirmBox(`Delete “${d.title || d.url}”${d.type === 'folder' ? ' and everything in it' : ''}?`))) return;
  await undoable(`Deleted “${d.title || hostOf(d.url)}”`, [d.id], () => update(s => deleteDial(s, d.id)));
}

async function moveTo(d, groupId, parentId) {
  await update(s => moveDial(s, d.id, { groupId, parentId }));
  const g = app.state.groups[groupId];
  toast(`Moved to ${parentId ? 'folder' : (g?.title || 'group')}`);
}

// ---------- drag & drop ----------
const MIME = 'application/x-dialdeck-dial';
let drag = null; // { id, el, grid }

function wireDnD(grid) {
  grid.addEventListener('dragstart', e => {
    const a = e.target.closest('.dial');
    if (!a || a.classList.contains('add') || app.settings.lockLayout) { if (a) e.preventDefault(); return; }
    const d = app.state.dials[a.dataset.id];
    drag = { id: d.id, el: a, grid, startIndex: [...grid.children].indexOf(a) };
    app.dragging = true;
    e.dataTransfer.effectAllowed = 'copyMove';
    e.dataTransfer.setData(MIME, d.id);
    if (d.type === 'link') { e.dataTransfer.setData('text/uri-list', d.url); e.dataTransfer.setData('text/plain', d.url); }
    requestAnimationFrame(() => a.classList.add('dragging'));
  });

  grid.addEventListener('dragover', e => {
    const types = [...e.dataTransfer.types];
    const internal = types.includes(MIME) && drag;
    const external = types.includes('text/uri-list') || types.includes('Files') || types.includes('text/plain');
    if (!internal && !external) return;
    e.preventDefault();
    clearInto(grid);
    const target = tileAt(grid, e.clientX, e.clientY);
    if (internal) {
      e.dataTransfer.dropEffect = 'move';
      if (drag.grid !== grid) return;
      if (!target || target === drag.el) return;
      const r = target.getBoundingClientRect();
      const td = app.state.dials[target.dataset.id];
      const dragged = app.state.dials[drag.id];
      const center = Math.abs(e.clientX - (r.left + r.width / 2)) < r.width * 0.22 && Math.abs(e.clientY - (r.top + r.height / 2)) < r.height * 0.3;
      if (td?.type === 'folder' && dragged?.type !== 'folder' && center) { target.classList.add('drop-into'); return; }
      if (app.settings.sortMode !== 'manual') return;
      const after = e.clientX > r.left + r.width / 2;
      const ref = after ? target.nextSibling : target;
      if (ref !== drag.el && ref !== drag.el.nextSibling) grid.insertBefore(drag.el, ref);
    } else {
      e.dataTransfer.dropEffect = 'copy';
      if (types.includes('Files') && target) target.classList.add('drop-into');
    }
  });

  grid.addEventListener('dragleave', e => { if (!grid.contains(e.relatedTarget)) clearInto(grid); });

  grid.addEventListener('drop', async e => {
    e.preventDefault();
    const into = grid.querySelector('.drop-into');
    clearInto(grid);
    const groupId = grid.dataset.group, parentId = grid.dataset.parent || null;
    if (drag && e.dataTransfer.types.includes(MIME)) {
      const id = drag.id;
      if (into && drag.grid === grid) {
        await update(s => moveDial(s, id, { groupId, parentId: into.dataset.id }));
        toast('Moved into folder');
      } else if (drag.grid === grid) {
        const ids = $$('.dial[data-id]', grid).map(x => x.dataset.id);
        const index = ids.indexOf(id);
        const others = ids.filter(x => x !== id);
        if (index !== drag.startIndex) await update(s => moveDial(s, id, { groupId, parentId, index: Math.min(index, others.length) }));
      }
      return;
    }
    // external drops
    const files = [...e.dataTransfer.files].filter(f => f.type.startsWith('image/'));
    if (files.length && into) {
      const hash = await putImage(files[0]);
      await update(s => { const d = s.dials[into.dataset.id]; patch(d, { thumb: { ...d.thumb, mode: 'custom', image: hash, fit: 'cover', at: Date.now() } }); });
      toast('Thumbnail updated');
      return;
    }
    const raw = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
    const urls = raw.split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith('#')).map(normalizeUrl).filter(Boolean);
    if (!urls.length) return;
    const target = tileAt(grid, e.clientX, e.clientY);
    let index = target ? $$('.dial[data-id]', grid).indexOf(target) : undefined;
    if (index < 0) index = undefined;
    const title = e.dataTransfer.getData('text/x-moz-url')?.split('\n')[1] || '';
    for (const url of urls) {
      const r = await send({ cmd: 'addDial', url, title: urls.length === 1 ? title : '', groupId, parentId });
      if (r?.ok && index != null) await update(s => moveDial(s, r.id, { groupId, parentId, index: index++ }));
    }
    toast(urls.length > 1 ? `Added ${urls.length} dials` : `Added ${hostOf(urls[0])}`);
  });

  grid.addEventListener('dragend', () => endDrag());
}

export function endDrag() {
  if (drag) drag.el.classList.remove('dragging');
  $$('.drop-into').forEach(x => x.classList.remove('drop-into'));
  $$('.gtab.drop').forEach(x => x.classList.remove('drop'));
  drag = null;
  app.dragging = false;
  if (app.pendingRender) { app.pendingRender = false; app.render(); }
}

export function currentDrag() { return drag; }

function clearInto(grid) { $$('.drop-into', grid).forEach(x => x.classList.remove('drop-into')); }

function tileAt(grid, x, y) {
  const el = document.elementFromPoint(x, y)?.closest('.dial');
  if (el && grid.contains(el) && !el.classList.contains('add')) return el;
  return null;
}

export { escapeHtml };
