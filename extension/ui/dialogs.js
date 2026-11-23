// Dial editor, group editor, folder overlay, lock screen.
import { normalizeUrl, titleFromUrl, sha256Hex, hostOf } from '../lib/util.js';
import { newDial, newGroup, patch, deleteGroup, groupsSorted, moveDial, dialsOf, setSettings, compactLayout } from '../lib/model.js';
import { api } from '../lib/util.js';
import { update, getState } from '../lib/store.js';
import { putImage, imageUrl } from '../lib/images.js';
import { app, setState, h, $, send, toast, modal, seg, field, toggle, range, pickFile, undoable, confirmBox, openMenu } from './core.js';
import { tileEl, renderGrid, removeDial, openGroupAll, currentDrag, endDrag } from './grid.js';
import { I } from './icons.js';

// ---------- dial editor ----------
export async function editDial(d, ctx = {}) {
  const isNew = !d;
  const isFolder = d?.type === 'folder';
  const draft = isNew
    ? { id: 'draft', type: 'link', url: ctx.url || '', title: ctx.title || '', groupId: ctx.groupId, parentId: ctx.parentId || null, thumb: { mode: app.settings.defaultThumbMode, image: null, bg: null, fit: 'cover' } }
    : JSON.parse(JSON.stringify(d));
  const origUrl = draft.url;

  const preview = h('div', { class: 'preview-tile grid', style: { '--cols': '1', gridTemplateColumns: '1fr' } });
  const refresh = () => { preview.innerHTML = ''; preview.append(tileEl(draft)); };

  const url = h('input', { class: 'inp', value: draft.url, placeholder: 'https://example.com', autofocus: true });
  const title = h('input', { class: 'inp', value: draft.title, placeholder: 'Title (optional — fetched automatically)' });
  url.addEventListener('input', () => { draft.url = normalizeUrl(url.value) || url.value; refresh(); });
  url.addEventListener('blur', () => { const n = normalizeUrl(url.value); if (n) { url.value = n; draft.url = n; refresh(); } });
  title.addEventListener('input', () => { draft.title = title.value; refresh(); });

  const groupSel = h('select', { class: 'inp' }, groupsSorted(app.state).map(g => h('option', { value: g.id, selected: g.id === draft.groupId }, (g.emoji ? g.emoji + ' ' : '') + g.title)));
  groupSel.addEventListener('change', () => { draft.groupId = groupSel.value; draft.parentId = null; });

  const thumbBox = h('div');
  const renderThumbOpts = () => {
    thumbBox.innerHTML = '';
    const t = draft.thumb;
    thumbBox.append(seg([
      ['auto', 'Screenshot', I.image], ['logo', 'Logo', I.globe], ['custom', 'Custom', I.upload], ['letter', 'Letter', I.palette],
    ], t.mode, mode => {
      const keep = mode === 'custom' && t.mode === 'custom';
      draft.thumb = { ...t, mode, image: keep ? t.image : (mode === d?.thumb?.mode ? d.thumb.image : null), fit: mode === 'logo' ? 'contain' : (mode === 'custom' ? t.fit : 'cover') };
      renderThumbOpts(); refresh();
    }));
    const opts = h('div', { class: 'row', style: { marginTop: '10px' } });
    if (t.mode === 'custom') {
      const urlIn = h('input', { class: 'inp grow', placeholder: 'Image URL — or upload / paste / drop an image' });
      urlIn.addEventListener('change', async () => {
        try { const b = await (await fetch(urlIn.value)).blob(); if (!b.type.startsWith('image/')) throw 0; await setImg(b); } catch { toast('Could not load that image', { error: true }); }
      });
      opts.append(h('button', { class: 'btn', html: I.upload, type: 'button', onclick: async () => { const f = await pickFile('image/*'); if (f) setImg(f); } }, 'Upload'), urlIn);
      opts.append(seg([['cover', 'Fill'], ['contain', 'Fit']], t.fit || 'cover', v => { draft.thumb.fit = v; refresh(); }));
    }
    if (t.mode === 'auto' && !isNew) opts.append(h('span', { class: 'hint' }, 'Captured automatically. Saving with a changed URL re-captures it.'));
    if (['logo', 'letter', 'custom'].includes(t.mode)) {
      const col = h('input', { type: 'color', value: toHex(t.bg) || '#ffffff', title: 'Tile background' });
      col.addEventListener('input', () => { draft.thumb.bg = col.value; refresh(); });
      opts.append(h('span', { class: 'lbl' }, 'Background'), col, h('button', { class: 'btn', type: 'button', onclick: () => { draft.thumb.bg = null; refresh(); } }, 'Auto'));
    }
    thumbBox.append(opts);
  };
  const setImg = async blob => {
    draft.thumb = { ...draft.thumb, mode: 'custom', image: await putImage(blob), at: Date.now() };
    renderThumbOpts(); refresh();
  };

  const body = h('div', {},
    preview,
    isFolder ? null : field('URL', url),
    field(isFolder ? 'Folder name' : 'Title', title),
    field('Group', groupSel),
    isFolder ? null : field('Thumbnail', thumbBox),
  );
  // paste / drop image anywhere in the dialog
  body.addEventListener('paste', e => { const f = [...(e.clipboardData?.files || [])].find(f => f.type.startsWith('image/')); if (f) { e.preventDefault(); setImg(f); } });
  body.addEventListener('dragover', e => { if ([...e.dataTransfer.types].includes('Files')) e.preventDefault(); });
  body.addEventListener('drop', e => { const f = [...e.dataTransfer.files].find(f => f.type.startsWith('image/')); if (f) { e.preventDefault(); setImg(f); } });

  const save = async () => {
    const u = normalizeUrl(url.value);
    if (!isFolder && !u) { url.focus(); toast('Enter a valid URL', { error: true }); return; }
    draft.url = u;
    const titleVal = title.value.trim();
    let id = d?.id;
    const urlChanged = !isNew && u !== origUrl;
    await update(s => {
      if (isNew) {
        id = newDial(s, { groupId: draft.groupId, parentId: draft.parentId, url: u, title: titleVal || titleFromUrl(u), thumb: draft.thumb }).id;
      } else {
        const x = s.dials[id];
        const fields = { title: titleVal || (isFolder ? 'Folder' : titleFromUrl(u)), thumb: urlChanged && ['auto', 'logo'].includes(draft.thumb.mode) ? { ...draft.thumb, image: null } : draft.thumb };
        if (!isFolder) fields.url = u;
        if (urlChanged) fields.icon = null; // a new address gets its own site icon
        patch(x, fields);
        if (x.groupId !== draft.groupId) moveDial(s, id, { groupId: draft.groupId, parentId: null });
      }
    });
    saved = true;
    m.close();
    if (ctx.fromShare) { toast(`Added to ${app.state.groups[draft.groupId]?.title || 'DialDeck'}`); setTimeout(() => window.DDAndroid?.shareDone(), 700); }
    if (!isFolder && ['auto', 'logo'].includes(draft.thumb.mode) && (isNew || urlChanged || !draft.thumb.image)) send({ cmd: 'thumb', id, kind: draft.thumb.mode });
    if (isNew && !titleVal) send({ cmd: 'fetchTitle', id }).catch(() => {});
  };
  [url, title].forEach(i => i.addEventListener('keydown', e => { if (e.key === 'Enter') save(); }));

  let saved = false;
  const m = modal({
    title: isNew ? 'Add dial' : (isFolder ? 'Edit folder' : 'Edit dial'), icon: isFolder ? I.folder : I.link, body,
    onClose: () => { if (ctx.fromShare && !saved) window.DDAndroid?.shareDone(); },
    footer: [
      !isNew ? h('button', { class: 'btn danger left', html: I.trash, onclick: () => { m.close(); removeDial(d); } }, 'Delete') : null,
      h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'),
      h('button', { class: 'btn primary', onclick: save }, isNew ? 'Add' : 'Save'),
    ],
  });
  renderThumbOpts(); refresh();
  if (ctx.pickImage) { draft.thumb.mode = 'custom'; renderThumbOpts(); const f = await pickFile('image/*'); if (f) setImg(f); }
}

function toHex(c) { return /^#[0-9a-f]{6}$/i.test(c || '') ? c : null; }

// ---------- folders ----------
export async function newFolder(groupId, parentId = null) {
  const id = await update(s => newDial(s, { groupId, parentId, type: 'folder', title: 'New folder', thumb: { mode: 'folder' } }).id);
  setState(await getState()); // don't wait for the storage change event
  openFolder(id, { rename: true });
}

const openFolders = []; // stack of { id, grid, titleInput, close }

export function openFolder(id, { rename } = {}) {
  const d = app.state.dials[id];
  if (!d) return;
  const titleIn = h('input', { value: d.title || 'Folder', 'aria-label': 'Folder name' });
  titleIn.addEventListener('change', () => { const v = titleIn.value.trim() || 'Folder'; update(s => { patch(s.dials[id], { title: v }); }); });
  titleIn.addEventListener('keydown', e => { if (e.key === 'Enter') titleIn.blur(); });
  const grid = h('div', { class: 'grid' });
  const outZone = h('div', { class: 'hint', style: { textAlign: 'center', padding: '6px', border: '1px dashed var(--border)', borderRadius: '8px' } }, 'Drag a dial here to move it out of this folder');
  outZone.addEventListener('dragover', e => { if (currentDrag()) { e.preventDefault(); outZone.style.borderColor = 'var(--accent)'; } });
  outZone.addEventListener('dragleave', () => { outZone.style.borderColor = ''; });
  outZone.addEventListener('drop', async e => {
    e.preventDefault(); outZone.style.borderColor = '';
    const dr = currentDrag(); if (!dr) return;
    const did = dr.id; endDrag();
    const parent = app.state.dials[id]?.parentId || null;
    await update(s => moveDial(s, did, { groupId: d.groupId, parentId: parent }));
  });
  const entry = { id, grid, titleIn };
  const m = modal({
    title: h('span', { class: 'row', html: I.folder }, titleIn), body: h('div', {}, outZone, grid), cls: 'folder-view',
    footer: [
      h('button', { class: 'btn left', html: I.tabs, onclick: () => { for (const k of dialsOf(app.state, d.groupId, id)) if (k.type === 'link') api.tabs.create({ url: k.url, active: false }); } }, 'Open all'),
      h('button', { class: 'btn', html: I.folder, onclick: () => newFolder(d.groupId, id) }, 'New subfolder'),
      h('button', { class: 'btn danger', html: I.trash, onclick: () => { m.close(); removeDial(app.state.dials[id]); } }, 'Delete folder'),
      h('button', { class: 'btn primary', onclick: () => m.close() }, 'Done'),
    ],
    onClose: () => { const i = openFolders.indexOf(entry); if (i >= 0) openFolders.splice(i, 1); },
  });
  entry.close = m.close;
  openFolders.push(entry);
  renderGrid(grid, d.groupId, id);
  if (rename) setTimeout(() => { titleIn.focus(); titleIn.select(); }, 50);
}

export function refreshFolders() {
  for (const f of [...openFolders]) {
    const d = app.state.dials[f.id];
    if (!d || d.deleted) { f.close(); continue; }
    if (document.activeElement !== f.titleIn) f.titleIn.value = d.title;
    renderGrid(f.grid, d.groupId, f.id);
  }
}

// ---------- groups ----------
export async function editGroup(g, { isNew } = {}) {
  const draft = g ? JSON.parse(JSON.stringify(g)) : { title: '', emoji: '', color: null, layout: null, bg: null, lockHash: null };
  const title = h('input', { class: 'inp grow', value: draft.title, placeholder: 'Group name', autofocus: true });
  const emoji = h('input', { class: 'inp', value: draft.emoji || '', placeholder: '🙂', style: { width: '64px', textAlign: 'center' }, maxlength: 4 });
  const color = h('input', { type: 'color', value: draft.color || app.settings.accent });
  let useColor = !!draft.color;
  color.addEventListener('input', () => { useColor = true; });

  const L = { ...(draft.layout || {}) };
  let override = Object.keys(L).some(k => k !== 'mode');
  const layoutBox = h('div');
  const renderLayout = () => {
    layoutBox.innerHTML = '';
    const st = app.settings;
    const mode = L.mode || (st.dialLayout === 'grid' ? 'grid' : 'list');
    const val = k => L[k] ?? st[k];
    layoutBox.append(
      field('Layout for this tab', seg([['', `Default (${st.dialLayout === 'grid' ? 'Tiles' : 'List'})`], ['list', 'List', I.list], ['grid', 'Tiles', I.grid]], L.mode || '', v => { L.mode = v || undefined; renderLayout(); })),
      toggle('Custom sizes for this tab', override, v => { override = v; renderLayout(); }, 'Otherwise this tab uses the sizes from Settings → Layout.'),
    );
    if (!override) return;
    if (mode === 'list') layoutBox.append(
      range('Row width (in tile widths)', val('listSpan'), 1, 5, 0.5, v => { L.listSpan = v; }, v => v + '×'),
      range('Max columns (0 = as many as fit)', val('listColumns'), 0, 8, 1, v => { L.listColumns = v; }, v => v || 'auto'),
      range('Row height', val('listHeight'), 32, 110, 2, v => { L.listHeight = v; }, v => v + 'px'),
      range('Icon size', val('listIconSize'), 14, 80, 1, v => { L.listIconSize = v; }, v => v + 'px'),
      range('Row spacing', val('listRowGap'), 0, 40, 1, v => { L.listRowGap = v; }, v => v + 'px'),
      range('Title size', val('listTitleSize'), 10, 22, 1, v => { L.listTitleSize = v; }, v => v + 'px'),
      field('Icon', seg([['auto', 'Logo → favicon'], ['favicon', 'Favicon'], ['thumb', 'Thumbnail'], ['letter', 'Letters'], ['none', 'None']], val('listIconSource'), v => { L.listIconSource = v; })),
      field('Row style', seg([['card', 'Card'], ['flat', 'Flat'], ['outline', 'Outline']], val('listStyle'), v => { L.listStyle = v; })),
      field('Title lines', seg([[1, '1 line'], [2, 'Up to 2']], Number(val('listTitleLines')), v => { L.listTitleLines = v; })),
      toggle('Show site address', val('listShowUrl'), v => { L.listShowUrl = v; }),
    );
    else layoutBox.append(
      range('Columns (0 = auto)', val('columns'), 0, 14, 1, v => { L.columns = v; }, v => v || 'auto'),
      field('Aspect ratio', seg([['16/10', '16:10'], ['16/9', '16:9'], ['4/3', '4:3'], ['1/1', '1:1'], ['3/4', '3:4'], ['2/1', '2:1']], val('dialRatio'), v => { L.dialRatio = v; })),
    );
    layoutBox.append(
      range(mode === 'list' ? 'Tile width (list width unit)' : 'Dial width', val('dialWidth'), 100, 420, 5, v => { L.dialWidth = v; }, v => v + 'px'),
      range('Spacing', val('gap'), 4, 60, 1, v => { L.gap = v; }, v => v + 'px'),
    );
  };
  renderLayout();

  const bg = draft.bg || { type: 'inherit' };
  const bgBox = h('div');
  const renderBg = () => {
    bgBox.innerHTML = '';
    bgBox.append(seg([['inherit', 'Global'], ['color', 'Colour'], ['image', 'Image']], bg.type, v => { bg.type = v; renderBg(); }));
    if (bg.type === 'color') { const c = h('input', { type: 'color', value: bg.value || '#222833' }); c.addEventListener('input', () => { bg.value = c.value; }); bgBox.append(' ', c); }
    if (bg.type === 'image') bgBox.append(' ', h('button', { class: 'btn', html: I.upload, onclick: async () => { const f = await pickFile('image/*'); if (f) { bg.image = await putImage(f); toast('Image selected'); } } }, bg.image ? 'Replace image' : 'Choose image'));
  };
  renderBg();

  let pin = undefined; // undefined = unchanged, '' = remove
  const lockBox = h('div', { class: 'row' });
  const renderLock = () => {
    lockBox.innerHTML = '';
    const has = pin === undefined ? !!draft.lockHash : !!pin;
    lockBox.append(h('span', { class: 'hint grow' }, has ? 'This group asks for a PIN.' : 'Hide this group\'s dials behind a PIN.'));
    lockBox.append(h('button', { class: 'btn', html: has ? I.unlock : I.lock, onclick: async () => {
      if (has) { pin = ''; renderLock(); return; }
      const p = window.prompt('Choose a PIN / password for this group');
      if (p) { pin = p; renderLock(); }
    } }, has ? 'Remove lock' : 'Set PIN'));
  };
  renderLock();

  const save = async () => {
    const t = title.value.trim() || 'Untitled';
    let lockHash;
    let gid = g?.id;
    await update(async s => {
      const target = g ? s.groups[g.id] : newGroup(s, t);
      gid = target.id;
      if (pin !== undefined) lockHash = pin ? await sha256Hex(target.id + ':' + pin) : null;
      const fields = { title: t, emoji: emoji.value.trim(), color: useColor ? color.value : null, layout: compactLayout(override ? L : { mode: L.mode }), bg: bg.type === 'inherit' ? null : { ...bg } };
      if (pin !== undefined) fields.lockHash = lockHash;
      patch(target, fields);
    });
    if (pin) { app.unlocked.add(gid); saveUnlocked(); }
    m.close();
    if (!g) app.selectGroup(gid);
  };
  title.addEventListener('keydown', e => { if (e.key === 'Enter') save(); });

  const m = modal({
    title: g ? 'Edit group' : 'New group', icon: I.grid,
    body: h('div', {},
      field('Name', h('div', { class: 'row' }, emoji, title)),
      field('Tab colour', h('div', { class: 'row' }, color, h('button', { class: 'btn', onclick: () => { useColor = false; color.value = app.settings.accent; } }, 'Use accent'))),
      g || !isNew ? h('div', {}, h('div', { class: 'lbl' }, 'Layout'), layoutBox, h('div', { class: 'lbl', style: { marginTop: '10px' } }, 'Background'), bgBox, h('div', { class: 'lbl', style: { marginTop: '14px' } }, 'Lock'), lockBox) : null,
    ),
    footer: [
      g ? h('button', { class: 'btn danger left', html: I.trash, onclick: () => { m.close(); removeGroup(g); } }, 'Delete group') : null,
      h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'),
      h('button', { class: 'btn primary', onclick: save }, g ? 'Save' : 'Create'),
    ],
  });
}

export async function removeGroup(g) {
  const count = Object.values(app.state.dials).filter(d => d.groupId === g.id && !d.deleted).length;
  if (count && !(await confirmBox(`Delete group “${g.title}” and its ${count} dial${count === 1 ? '' : 's'}?`))) return;
  await undoable(`Deleted group “${g.title}”`, [g.id], () => update(s => deleteGroup(s, g.id)));
}

export function groupMenu(g, x, y) {
  const locked = g.lockHash && app.unlocked.has(g.id);
  openMenu([
    { label: 'Add dial', icon: I.plus, onClick: () => { app.selectGroup(g.id); editDial(null, { groupId: g.id }); } },
    { label: 'New folder', icon: I.folder, onClick: () => { app.selectGroup(g.id); newFolder(g.id); } },
    { label: 'Open all in tabs', icon: I.tabs, onClick: () => openGroupAll(g.id) },
    { label: 'Refresh thumbnails', icon: I.refresh, onClick: () => send({ cmd: 'refreshGroup', groupId: g.id }).then(() => toast('Refreshing thumbnails in the background…')) },
    '-',
    { label: 'Layout', icon: (g.layout?.mode || (app.settings.dialLayout === 'grid' ? 'grid' : 'list')) === 'grid' ? I.grid : I.list, sub: [
      ['', `Default (${app.settings.dialLayout === 'grid' ? 'Tiles' : 'List'})`], ['list', 'List'], ['grid', 'Tiles'],
    ].map(([m, label]) => ({ label: ((g.layout?.mode || '') === m ? '✓ ' : '\u2003') + label, onClick: () => setGroupMode(g.id, m) })) },
    { label: 'Edit group…', icon: I.edit, onClick: () => editGroup(g) },
    { label: 'Set as start group', icon: I.star, onClick: () => update(s => setSettings(s, { defaultGroup: g.id, rememberLastGroup: false })).then(() => toast(`“${g.title}” opens first in new tabs`)) },
    locked ? { label: 'Lock now', icon: I.lock, onClick: () => { app.unlocked.delete(g.id); saveUnlocked(); app.render(); } } : null,
    '-',
    { label: 'Delete group', icon: I.trash, danger: true, onClick: () => removeGroup(g) },
  ], x, y);
}

// Set (or clear, with '') one tab's layout mode, keeping its other overrides.
export function setGroupMode(gid, mode) {
  return update(s => { const g = s.groups[gid]; if (g) patch(g, { layout: compactLayout({ ...(g.layout || {}), mode: mode || undefined }) }); });
}

// ---------- lock ----------
export function saveUnlocked() { sessionStorage.setItem('dd-unlocked', JSON.stringify([...app.unlocked])); }

export function renderLock(container, g, onUnlock) {
  container.innerHTML = '';
  const inp = h('input', { class: 'inp', type: 'password', placeholder: '••••', autofocus: true });
  const err = h('div', { class: 'err' });
  const go = async () => {
    if ((await sha256Hex(g.id + ':' + inp.value)) === g.lockHash) { app.unlocked.add(g.id); saveUnlocked(); onUnlock(); }
    else { err.textContent = 'Wrong PIN'; inp.select(); }
  };
  inp.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
  container.append(h('div', { class: 'box', html: I.lock }, h('h3', {}, `“${g.title}” is locked`), inp, err, h('button', { class: 'btn primary', onclick: go }, 'Unlock'),
    h('div', { class: 'hint', style: { marginTop: '12px' } }, 'Privacy screen only — data is stored unencrypted in this browser.')));
  setTimeout(() => inp.focus(), 30);
}

export { hostOf, imageUrl };
