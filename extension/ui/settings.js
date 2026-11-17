// Settings drawer.
import { api, fmtTime, escapeHtml } from '../lib/util.js';
import { setSettings, groupsSorted, DEFAULT_SETTINGS, referencedImages } from '../lib/model.js';
import { update, getSyncConfig, setSyncConfig, getLocal } from '../lib/store.js';
import { putImage, listImages, deleteImage, imageMeta } from '../lib/images.js';
import { testConnection, getSyncStatus } from '../lib/sync.js';
import { app, h, $, $$, send, toast, seg, toggle, range, field, pickFile, confirmBox } from './core.js';
import { applyAppearance } from './appearance.js';
import { exportBackup, importFile, exportBookmarksHtml, bookmarkFolders, importBrowserFolder } from './io.js';
import { ENGINES } from './search.js';
import { I } from './icons.js';

const TABS = [
  ['look', 'Appearance'], ['layout', 'Layout'], ['behaviour', 'Behaviour'], ['thumbs', 'Thumbnails'],
  ['sync', 'Sync'], ['backup', 'Backup & import'], ['about', 'About'],
];
let currentTab = 'look';

const set = (k, v) => update(s => setSettings(s, { [k]: v }));
const live = k => (v, final) => { app.settings[k] = v; applyAppearance(); if (final !== false) set(k, v); };

export function openSettings(tab) {
  if (tab) currentTab = tab;
  const d = $('#drawer');
  d.hidden = false;
  d.innerHTML = '';
  const body = h('div', { class: 'pbody' });
  const tabs = h('div', { class: 'ptabs' }, TABS.map(([id, label]) => h('button', { class: id === currentTab ? 'on' : '', onclick: () => { currentTab = id; openSettings(); } }, label)));
  const panel = h('div', { class: 'panel' }, h('div', { class: 'phead' }, h('h2', {}, 'Settings'), h('button', { class: 'x-btn', html: I.close, onclick: closeSettings })), tabs, body);
  d.append(panel);
  d.onmousedown = e => { if (e.target === d) closeSettings(); };
  ({ look, layout, behaviour, thumbs, sync, backup, about })[currentTab](body);
}
export function closeSettings() { $('#drawer').hidden = true; $('#drawer').innerHTML = ''; if (location.hash.startsWith('#settings')) history.replaceState(null, '', location.pathname); }
export function settingsOpen() { return !$('#drawer').hidden; }

// ---------------- Appearance ----------------
const GRADIENTS = [
  'linear-gradient(135deg,#1f2a44 0%,#3a2f5b 55%,#5b3a4f 100%)',
  'linear-gradient(135deg,#0f2027,#203a43,#2c5364)',
  'linear-gradient(135deg,#232526,#414345)',
  'linear-gradient(135deg,#1e3c72,#2a5298)',
  'linear-gradient(135deg,#42275a,#734b6d)',
  'linear-gradient(135deg,#134e5e,#71b280)',
  'linear-gradient(135deg,#e0eafc,#cfdef3)',
  'linear-gradient(135deg,#fbc2eb,#a6c1ee)',
  'linear-gradient(135deg,#f6d365,#fda085)',
  'linear-gradient(135deg,#a1c4fd,#c2e9fb)',
  'linear-gradient(160deg,#0b0b0f,#1b1b24 60%,#2b2238)',
  'radial-gradient(circle at 20% 20%,#3b4371,#151826 70%)',
];

function look(b) {
  const s = app.settings;
  b.append(
    h('h3', {}, 'Theme'),
    field('Colour scheme', seg([['auto', 'Auto'], ['light', 'Light'], ['dark', 'Dark'], ['oled', 'OLED black']], s.theme, v => live('theme')(v))),
    field('Accent colour', colorInput(s.accent, live('accent'))),
    h('h3', {}, 'Background'),
    field('Type', seg([['black', 'OLED black'], ['gradient', 'Gradient'], ['color', 'Colour'], ['image', 'Image'], ['none', 'None']], s.bgType, v => { live('bgType')(v); setTimeout(() => openSettings(), 50); })),
  );
  if (s.bgType === 'gradient') {
    const sw = h('div', { class: 'bg-swatches' }, GRADIENTS.map(g => h('button', { style: { background: g }, class: g === s.bgGradient ? 'on' : '', onclick: e => { $$('.bg-swatches button').forEach(x => x.classList.remove('on')); e.currentTarget.classList.add('on'); live('bgGradient')(g); } })));
    const css = h('input', { class: 'inp', value: s.bgGradient });
    css.addEventListener('change', () => live('bgGradient')(css.value));
    b.append(sw, field('Custom CSS gradient', css));
  }
  if (s.bgType === 'color') b.append(field('Colour', colorInput(s.bgColor, live('bgColor'))));
  if (s.bgType === 'image') {
    b.append(h('div', { class: 'row', style: { marginBottom: '12px' } },
      h('button', { class: 'btn', html: I.upload, onclick: async () => { const f = await pickFile('image/*'); if (f) { const hsh = await putImage(f); await set('bgImage', hsh); toast('Background set'); } } }, 'Upload image'),
      h('button', { class: 'btn', html: I.link, onclick: async () => {
        const u = prompt('Image URL'); if (!u) return;
        try { const bl = await (await fetch(u)).blob(); if (!bl.type.startsWith('image/')) throw 0; await set('bgImage', await putImage(bl)); } catch { toast('Could not load image', { error: true }); }
      } }, 'From URL'),
    ), field('Fit', seg([['cover', 'Fill'], ['contain', 'Fit'], ['tile', 'Tile']], s.bgFit, live('bgFit'))));
  }
  b.append(
    range('Dim', s.bgDim, 0, 0.8, 0.05, live('bgDim'), v => Math.round(v * 100) + '%'),
    range('Blur', s.bgBlur, 0, 30, 1, live('bgBlur'), v => v + 'px'),
    h('h3', {}, 'Dials'),
    field('Hover effect', seg([['lift', 'Lift'], ['zoom', 'Zoom'], ['glow', 'Glow'], ['none', 'None']], s.hoverEffect, live('hoverEffect'))),
    toggle('Drop shadow', s.shadow, live('shadow')),
    range('Corner radius', s.radius, 0, 32, 1, live('radius'), v => v + 'px'),
    range('Opacity (until hovered)', s.dialOpacity, 0.3, 1, 0.05, live('dialOpacity'), v => Math.round(v * 100) + '%'),
    h('h3', {}, 'Titles'),
    toggle('Show titles', s.showTitles, live('showTitles')),
    field('Title position', seg([['below', 'Below'], ['overlay', 'Overlay'], ['hover', 'On hover']], s.titlePos, v => { live('titlePos')(v); app.render(); })),
    toggle('Show favicons next to titles', s.showFavicons, v => { live('showFavicons')(v); }),
    range('Title size', s.titleSize, 10, 20, 1, live('titleSize'), v => v + 'px'),
    field('Title colour', h('div', { class: 'row' }, colorInput(s.titleColor || (document.documentElement.dataset.theme === 'light' ? '#1a1f2c' : '#f4f6fb'), live('titleColor')), h('button', { class: 'btn', onclick: () => { live('titleColor')(''); } }, 'Follow theme')), 'Pick a colour that reads well on your wallpaper.'),
    h('h3', {}, 'Group bar'),
    toggle('Show group bar', s.showGroupBar, live('showGroupBar')),
    field('Position', seg([['top', 'Top'], ['bottom', 'Bottom']], s.groupBarPos, live('groupBarPos'))),
    field('Style', seg([['pills', 'Pills'], ['tabs', 'Tabs'], ['underline', 'Underline']], s.groupBarStyle, live('groupBarStyle'))),
    toggle('Show dial counts', s.showGroupCounts, live('showGroupCounts')),
    h('h3', {}, 'Widgets'),
    toggle('Show clock', s.showClock, live('showClock')),
    toggle('24-hour clock', s.clock24h, live('clock24h')),
    toggle('Show search box', s.showSearch, live('showSearch')),
    h('h3', {}, 'Advanced'),
    field('Font family', inputSetting('font', s.font === 'system' ? '' : s.font, 'system default — e.g. "Inter", sans-serif', v => v || 'system')),
    field('Custom CSS', (() => { const t = h('textarea', { class: 'inp', placeholder: '.dial .title { font-weight: 600 }' }); t.value = s.customCss; t.addEventListener('change', () => live('customCss')(t.value)); return t; })(), 'Applied to the new tab page. Synced to all browsers.'),
    h('button', { class: 'btn danger', onclick: async () => { if (await confirmBox('Reset all appearance and layout settings to defaults? Dials and groups are kept.', { ok: 'Reset' })) { const keep = ['defaultGroup']; const reset = {}; for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) if (!keep.includes(k)) reset[k] = v; await update(s2 => setSettings(s2, reset)); openSettings(); } } }, 'Reset to defaults'),
  );
}

function colorInput(value, onChange) {
  const c = h('input', { type: 'color', value });
  c.addEventListener('input', () => onChange(c.value, false));
  c.addEventListener('change', () => onChange(c.value, true));
  return c;
}
function inputSetting(key, value, placeholder, map = v => v) {
  const i = h('input', { class: 'inp', value: value ?? '', placeholder });
  i.addEventListener('change', () => live(key)(map(i.value.trim())));
  return i;
}

// ---------------- Layout ----------------
function layout(b) {
  const s = app.settings;
  const rerender = k => v => { live(k)(v); app.render(); };
  b.append(
    h('h3', {}, 'Dial style'),
    field('Layout', seg([['list', 'List', I.list], ['grid', 'Tiles', I.grid]], s.dialLayout, v => { rerender('dialLayout')(v); setTimeout(() => openSettings(), 50); })),
  );
  if (s.dialLayout !== 'grid') b.append(
    h('h3', {}, 'List'),
    range('Row width (in tile widths)', s.listSpan, 1, 5, 0.5, live('listSpan'), v => v + '×'),
    range('Columns (0 = fit to window)', s.listColumns, 0, 8, 1, live('listColumns'), v => v || 'auto'),
    range('Row height', s.listHeight, 32, 110, 2, live('listHeight'), v => v + 'px'),
    range('Row spacing', s.listRowGap, 0, 40, 1, live('listRowGap'), v => v + 'px'),
    range('Icon size', s.listIconSize, 14, 80, 1, live('listIconSize'), v => v + 'px'),
    field('Icon', seg([['auto', 'Logo → favicon'], ['favicon', 'Favicon'], ['thumb', 'Thumbnail'], ['letter', 'Letters'], ['none', 'None']], s.listIconSource, rerender('listIconSource')),
      'Logo → favicon uses the site logo when one was fetched, otherwise the browser favicon.'),
    field('Row style', seg([['card', 'Card'], ['flat', 'Flat'], ['outline', 'Outline']], s.listStyle, live('listStyle'))),
    range('Title size', s.listTitleSize, 10, 22, 1, live('listTitleSize'), v => v + 'px'),
    field('Title lines', seg([[1, '1 line'], [2, 'Up to 2 lines']], Number(s.listTitleLines), live('listTitleLines'))),
    toggle('Show site address under the title', s.listShowUrl, rerender('listShowUrl')),
    h('p', { class: 'hint' }, 'Row width is measured in tile widths, so “Dial width” and “Spacing” below scale it too.'),
  );
  b.append(
    h('h3', {}, s.dialLayout === 'grid' ? 'Grid' : 'Tiles (also sets the list unit width)'),
    range('Columns (0 = fit to window)', s.columns, 0, 14, 1, live('columns'), v => v || 'auto'),
    range('Dial width', s.dialWidth, 100, 420, 5, live('dialWidth'), v => v + 'px'),
    field('Aspect ratio', seg([['16/10', '16:10'], ['16/9', '16:9'], ['4/3', '4:3'], ['1/1', '1:1'], ['3/4', '3:4'], ['2/1', '2:1']], s.dialRatio, live('dialRatio'))),
    range('Spacing', s.gap, 4, 60, 1, live('gap'), v => v + 'px'),
    range('Max page width', s.maxWidth, 700, 3000, 50, live('maxWidth'), v => v + 'px'),
    toggle('Centre dials vertically', s.verticalCenter, live('verticalCenter')),
    toggle('Show “add dial” tile', s.showAddTile, v => { live('showAddTile')(v); }),
    h('p', { class: 'hint' }, 'Each group can override the layout (list or tiles), columns, width and ratio: right-click a group tab → Edit group.'),
    h('h3', {}, 'Sorting'),
    field('Order dials by', seg([['manual', 'Manual (drag)'], ['title', 'Title'], ['visits', 'Most visited'], ['recent', 'Recently visited']], s.sortMode, live('sortMode'))),
  );
}

// ---------------- Behaviour ----------------
function behaviour(b) {
  const s = app.settings;
  const groups = groupsSorted(app.state);
  const def = h('select', { class: 'inp' }, h('option', { value: '' }, 'Last used group'), groups.map(g => h('option', { value: g.id, selected: s.defaultGroup === g.id }, g.title)));
  def.addEventListener('change', () => { set('defaultGroup', def.value || null); set('rememberLastGroup', !def.value); });
  const eng = h('select', { class: 'inp' }, Object.entries(ENGINES).map(([k, e]) => h('option', { value: k, selected: s.searchEngine === k }, e.name)));
  const custom = h('input', { class: 'inp', value: s.customSearchUrl, placeholder: 'https://searx.example.com/search?q=%s' });
  eng.addEventListener('change', () => live('searchEngine')(eng.value));
  custom.addEventListener('change', () => live('customSearchUrl')(custom.value.trim()));
  b.append(
    h('h3', {}, 'Opening dials'),
    field('Click opens in', seg([['current', 'Same tab'], ['new', 'New tab'], ['background', 'Background tab']], s.openIn, live('openIn'))),
    h('p', { class: 'hint' }, 'Ctrl/⌘+click: background tab · Shift+click: new window · Middle-click: background tab (folders: open all).'),
    h('h3', {}, 'Groups'),
    field('New tab opens', def),
    toggle('Mouse wheel switches groups', s.wheelSwitch, live('wheelSwitch'), 'When the page itself does not need to scroll.'),
    toggle('Ask before deleting', s.confirmDelete, live('confirmDelete'), 'Deletions can always be undone from the toast.'),
    toggle('Lock layout', s.lockLayout, v => { live('lockLayout')(v); app.render(); }, 'Disables dragging, adding and editing dials — handy on a shared or family computer.'),
    field('Focus on new tab', seg([['page', 'Page (keyboard shortcuts)'], ['search', 'Search box']], s.newTabFocus, live('newTabFocus'))),
    h('h3', {}, 'Search'),
    field('Search engine', eng),
    field('Custom search URL', custom, 'Use <code>%s</code> for the query — perfect for a self-hosted SearXNG.'),
    toggle('Typing filters your dials', s.searchFiltersDials, live('searchFiltersDials')),
    h('h3', {}, 'Keyboard shortcuts'),
    h('div', { class: 'card hint', html: `<code>/</code> search · <code>1</code>–<code>9</code> open dial · <code>Alt+1</code>–<code>9</code> switch group · <code>[</code> <code>]</code> previous/next group · <code>N</code> new dial · <code>E</code>/<code>F2</code> edit hovered dial · <code>Del</code> delete hovered dial · <code>G</code> new group · <code>S</code> sync · <code>,</code> settings · <code>Esc</code> close<br>Browser-wide: <code>Alt+Shift+D</code> adds the current page (change at <code>chrome://extensions/shortcuts</code>).` }),
  );
}

// ---------------- Thumbnails ----------------
function thumbs(b) {
  const s = app.settings;
  b.append(
    h('h3', {}, 'New dials'),
    field('Default thumbnail', seg([['auto', 'Screenshot'], ['logo', 'Site logo'], ['letter', 'Letter tile']], s.defaultThumbMode, live('defaultThumbMode'))),
    h('h3', {}, 'Screenshots'),
    toggle('Capture when I visit a dial\'s page', s.captureOnVisit, live('captureOnVisit'), 'Grabs a fresh screenshot of the visible tab when a dial without one (or with a stale one) is visited — no extra windows.'),
    range('Wait after page load', s.captureDelay, 0, 8000, 250, live('captureDelay'), v => (v / 1000).toFixed(2) + 's'),
    range('Auto-refresh screenshots older than', s.thumbRefreshDays, 0, 90, 1, live('thumbRefreshDays'), v => v ? v + ' days' : 'never'),
    range('Capture viewport width', s.captureWidth, 800, 1920, 40, live('captureWidth'), v => v + 'px'),
    range('Capture viewport height', s.captureHeight, 500, 1200, 20, live('captureHeight'), v => v + 'px'),
    range('Stored thumbnail width', s.thumbWidth, 240, 1200, 20, live('thumbWidth'), v => v + 'px'),
    h('h3', {}, 'Logos'),
    toggle('Use DuckDuckGo icon service as fallback', s.useFaviconService, live('useFaviconService'), 'Off by default for privacy: logos are fetched directly from each site.'),
    h('h3', {}, 'Maintenance'),
    h('div', { class: 'row' },
      h('button', { class: 'btn', html: I.refresh, onclick: async () => { const r = await send({ cmd: 'refreshMissing' }); toast(`Generating ${r?.n || 0} missing thumbnails…`); } }, 'Generate missing'),
      h('button', { class: 'btn', html: I.trash, onclick: cleanLocalImages }, 'Clean unused images'),
    ),
  );
  const info = h('p', { class: 'hint' });
  b.append(info);
  listImages().then(async keys => { let total = 0; for (const k of keys) total += (await imageMeta(k))?.size || 0; info.textContent = `${keys.length} images stored locally (${(total / 1048576).toFixed(1)} MB).`; });
}

async function cleanLocalImages() {
  const used = referencedImages(app.state);
  let n = 0;
  for (const k of await listImages()) if (!used.has(k)) { await deleteImage(k); n++; }
  toast(`Removed ${n} unused images`);
  openSettings();
}

// ---------------- Sync ----------------
async function sync(b) {
  const cfg = await getSyncConfig();
  const st = await getSyncStatus();
  const inp = (k, attrs = {}) => { const i = h('input', { class: 'inp', value: cfg[k] ?? '', ...attrs }); i.addEventListener('input', () => { cfg[k] = attrs.type === 'number' ? +i.value : i.value.trim(); }); return i; };

  const statusCard = h('div', { class: 'card' });
  const renderStatus = s2 => {
    const state = cfg.enabled ? (s2.state || 'idle') : 'off';
    statusCard.innerHTML = '';
    statusCard.append(
      h('div', { class: 'status-line' }, h('span', { class: 'dot ' + state }), h('b', {}, { ok: 'Synced', error: 'Sync error', syncing: 'Syncing…', off: 'Sync is off', idle: 'Not synced yet' }[state] || state), h('span', { class: 'hint', style: { marginLeft: 'auto' } }, s2.at ? 'Last sync ' + fmtTime(s2.at) : '')),
      s2.state === 'error' && cfg.enabled ? h('div', { class: 'hint', style: { color: 'var(--danger)', marginTop: '6px' } }, s2.error) : null,
      s2.encrypted ? h('div', { class: 'hint', style: { marginTop: '6px' }, html: I.lock + ' End-to-end encrypted' }) : null,
    );
  };
  renderStatus(st);
  const onCh = (ch, area) => { if (area === 'local' && ch.syncStatus && $('#drawer .pbody') === b) renderStatus(ch.syncStatus.newValue); };
  api.storage.onChanged.addListener(onCh);

  const enabled = toggle('Enable WebDAV sync', cfg.enabled, v => { cfg.enabled = v; });
  const enc = toggle('End-to-end encryption', cfg.encrypt, v => { cfg.encrypt = v; pass.disabled = !v; }, 'Strongly recommended when your server is reachable from the internet. The passphrase never leaves your browsers; lose it and the server copy is unreadable (local data stays).');
  const pass = inp('passphrase', { type: 'password', placeholder: 'Encryption passphrase (same on every browser)', autocomplete: 'new-password' });
  pass.disabled = !cfg.encrypt;
  const imgs = toggle('Sync thumbnails & backgrounds', cfg.syncImages, v => { cfg.syncImages = v; }, 'Otherwise each browser generates its own thumbnails.');

  const ensurePermission = async () => {
    try {
      const origin = new URL(cfg.url).origin + '/*';
      if (await api.permissions.contains({ origins: [origin] })) return true;
      return await api.permissions.request({ origins: [origin] });
    } catch { return false; }
  };

  const doSave = async (thenSync) => {
    if (!/^https?:\/\//i.test(cfg.url || '')) { toast('Enter the WebDAV URL', { error: true }); return; }
    if (!cfg.url.endsWith('/')) cfg.url += '/';
    if (/^http:\/\//i.test(cfg.url) && !/^http:\/\/(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(cfg.url)) toast('Warning: plain HTTP over the internet sends your password unencrypted. Use HTTPS.', { error: true, ms: 8000 });
    if (!(await ensurePermission())) { toast('Site access to the server was not granted', { error: true }); return; }
    if (cfg.encrypt && !cfg.passphrase) { toast('Enter an encryption passphrase', { error: true }); return; }
    await setSyncConfig(cfg);
    if (thenSync) {
      const r = await send({ cmd: 'syncConfigChanged' });
      if (r?.ok) toast('Synced'); else toast('Sync failed: ' + (r?.error || 'unknown'), { error: true, ms: 9000 });
    } else toast('Saved');
  };

  b.append(
    statusCard,
    h('h3', {}, 'Server'),
    enabled,
    field('WebDAV URL', inp('url', { placeholder: 'https://cloud.example.com/remote.php/dav/files/USERNAME/' }), 'Nextcloud: <code>https://YOUR-DOMAIN/remote.php/dav/files/USERNAME/</code> (Files → ⚙ Files settings → WebDAV shows it).'),
    h('div', { class: 'row' }, h('div', { class: 'grow' }, field('Username', inp('username', { autocomplete: 'username' }))), h('div', { class: 'grow' }, field('App password', inp('password', { type: 'password', autocomplete: 'current-password' })))),
    h('p', { class: 'hint', html: 'Create an app password in Nextcloud: <b>Personal settings → Security → Devices &amp; sessions → Create new app password</b>. It works with 2FA and can be revoked anytime.' }),
    field('Folder on the server', inp('folder', { placeholder: 'DialDeck' })),
    field('Sync every (minutes)', inp('intervalMin', { type: 'number', min: 1, max: 1440 }), 'Changes are also pushed ~4 s after you make them and pulled whenever a new tab opens.'),
    imgs,
    h('h3', {}, 'Privacy'),
    enc, pass,
    h('div', { class: 'row', style: { marginTop: '14px' } },
      h('button', { class: 'btn', onclick: async e => {
        if (!(await ensurePermission())) return toast('Site access not granted', { error: true });
        e.target.disabled = true;
        try {
          const r = await testConnection(cfg);
          toast(`Connection OK — ${r.hasData ? 'existing DialDeck data found' + (r.encrypted ? ' (encrypted)' : '') : 'folder ready, no data yet'}`, { ms: 7000 });
        } catch (err) { toast('Connection failed: ' + err.message, { error: true, ms: 10000 }); } finally { e.target.disabled = false; }
      } }, 'Test connection'),
      h('button', { class: 'btn', onclick: () => doSave(false) }, 'Save'),
      h('button', { class: 'btn primary', html: I.sync, onclick: () => doSave(true) }, 'Save & sync now'),
    ),
  );

  // snapshots
  const snapBox = h('div', { class: 'snap-list' }, h('p', { class: 'hint' }, cfg.enabled ? 'Loading…' : 'Enable sync to see server snapshots.'));
  b.append(h('h3', {}, 'Server snapshots'), h('p', { class: 'hint' }, `A snapshot of all dials is kept on the server once per day (last ${cfg.snapshotsKeep} days). Restoring replaces the data in every synced browser.`), snapBox,
    h('div', { class: 'row', style: { marginTop: '8px' } },
      h('button', { class: 'btn', onclick: async () => { const r = await send({ cmd: 'snapshotNow' }); r?.ok ? (toast('Snapshot saved'), loadSnaps()) : toast(r?.error, { error: true }); } }, 'Take snapshot now'),
      h('button', { class: 'btn', onclick: async () => { const r = await send({ cmd: 'cleanupServer' }); r?.ok ? toast(`Removed ${r.result.removed} unused images from server`) : toast(r?.error, { error: true }); } }, 'Clean up server images'),
      h('button', { class: 'btn danger', onclick: async () => {
        if (!(await confirmBox('Delete the data on the server and upload this browser\'s copy instead? Use this after changing the encryption passphrase. Other browsers will merge their local data back in on their next sync.', { ok: 'Re-upload' }))) return;
        const r = await send({ cmd: 'resetServer' }); r?.ok ? toast('Server re-initialised from this browser') : toast(r?.error, { error: true });
      } }, 'Re-upload from this browser'),
    ));
  const loadSnaps = async () => {
    if (!cfg.enabled) return;
    const r = await send({ cmd: 'listSnapshots' });
    snapBox.innerHTML = '';
    if (!r?.ok) { snapBox.append(h('p', { class: 'hint' }, r?.error || 'Could not list snapshots')); return; }
    if (!r.result.length) snapBox.append(h('p', { class: 'hint' }, 'No snapshots yet.'));
    for (const f of r.result) snapBox.append(h('div', { class: 'row' }, h('span', {}, f.name.replace(/^data-|\.json$/g, '')), h('span', { class: 'hint' }, (f.size / 1024).toFixed(0) + ' KB'),
      h('button', { class: 'btn', onclick: async () => {
        if (!(await confirmBox(`Restore snapshot ${f.name}? Current dials will be replaced in all synced browsers (a snapshot of today is kept).`, { ok: 'Restore', danger: true }))) return;
        const res = await send({ cmd: 'restoreSnapshot', name: f.name });
        res?.ok ? toast('Snapshot restored') : toast(res?.error, { error: true });
      } }, 'Restore')));
  };
  loadSnaps();
}

// ---------------- Backup ----------------
async function backup(b) {
  const mode = { v: 'merge' };
  const folders = await bookmarkFolders().catch(() => []);
  const fsel = h('select', { class: 'inp' }, folders.map(f => h('option', { value: f.id }, '  '.repeat(f.depth) + f.title)));
  const asGroups = { v: true };
  b.append(
    h('h3', {}, 'Backup file'),
    h('p', { class: 'hint' }, 'A single JSON file with all groups, dials, settings and images. Independent of WebDAV sync.'),
    h('div', { class: 'row' },
      h('button', { class: 'btn primary', html: I.download, onclick: () => exportBackup() }, 'Export backup'),
      h('button', { class: 'btn', html: I.download, onclick: () => exportBackup({ images: false }) }, 'Export without images'),
    ),
    h('h3', {}, 'Import'),
    h('p', { class: 'hint' }, 'Accepts DialDeck backups, browser bookmark HTML exports, and JSON backups from other speed-dial add-ons (Group Speed Dial, Speed Dial 2, FVD…) — groups and dials are detected automatically.'),
    field('When importing a DialDeck backup', seg([['merge', 'Merge with current'], ['replace', 'Replace everything']], 'merge', v => { mode.v = v; })),
    h('button', { class: 'btn', html: I.upload, onclick: async () => {
      const f = await pickFile(''); // any file: Group Speed Dial backups are named backup.group_speed_dial
      if (!f) return;
      try { toast(await importFile(f, { mode: mode.v }), { ms: 6000 }); } catch (e) { toast('Import failed: ' + e.message, { error: true, ms: 8000 }); }
    } }, 'Import file…'),
    h('h3', {}, 'Browser bookmarks'),
    field('Bookmark folder', fsel),
    toggle('Each sub-folder becomes a group', true, v => { asGroups.v = v; }),
    h('div', { class: 'row' },
      h('button', { class: 'btn', html: I.bookmark, onclick: async () => { try { toast(await importBrowserFolder(fsel.value, { subfoldersAsGroups: asGroups.v })); } catch (e) { toast(e.message, { error: true }); } } }, 'Import folder'),
      h('button', { class: 'btn', html: I.download, onclick: exportBookmarksHtml }, 'Export dials as bookmarks HTML'),
    ),
    h('h3', {}, 'Danger zone'),
    h('button', { class: 'btn danger', html: I.trash, onclick: async () => {
      if (!(await confirmBox('Delete ALL groups and dials? If sync is on, this propagates to every browser (server snapshots let you roll back).', { ok: 'Delete everything' }))) return;
      await update(s => { for (const g of Object.values(s.groups)) if (!g.deleted) { g.deleted = true; g._ts.deleted = Date.now(); } for (const d of Object.values(s.dials)) if (!d.deleted) { d.deleted = true; d._ts.deleted = Date.now(); } });
      toast('Everything deleted');
    } }, 'Delete all dials'),
  );
}

// ---------------- About ----------------
function about(b) {
  const m = api.runtime.getManifest();
  b.append(
    h('h3', {}, 'DialDeck ' + m.version),
    h('p', {}, 'Grouped speed dials with self-hosted sync. Your data lives in this browser and, if you enable it, on your own WebDAV server — nothing is sent anywhere else.'),
    h('div', { class: 'card hint', html: `
      <b>Where data lives</b><br>
      • Groups, dials, settings → <code>storage.local</code><br>
      • Images → IndexedDB (content-addressed, SHA-256)<br>
      • Server → <code>&lt;folder&gt;/data.json</code>, <code>images/</code>, <code>snapshots/</code><br><br>
      <b>Conflict handling</b><br>Every field carries its own timestamp, so edits made on different browsers merge instead of overwriting each other. Uploads use ETag <code>If-Match</code> so two browsers can never clobber the server copy.` }),
    h('button', { class: 'btn', onclick: () => { location.hash = '#welcome'; location.reload(); } }, 'Show welcome screen'),
  );
}

export { escapeHtml, getLocal };
