// Data model + conflict-free merge.
//
// Every entity (group, dial, the settings object) is a flat object carrying `_ts`,
// a map of field -> last-modified timestamp. Merging two replicas takes, per field,
// the value with the newest timestamp (field-level last-writer-wins). Deletions are
// tombstones (`deleted: true`), so concurrent edits on two browsers merge cleanly:
// e.g. renaming a dial on the laptop while re-ordering it on the desktop keeps both.
import { uid, stableStringify } from './util.js';

export const SCHEMA = 2;

export const DEFAULT_SETTINGS = {
  // appearance
  theme: 'oled',              // auto | light | dark | oled (pure black surfaces)
  accent: '#5b8cff',
  font: 'system',
  bgType: 'black',            // black (OLED) | color | gradient | image | none
  bgColor: '#1d2230',
  bgGradient: 'linear-gradient(135deg,#1f2a44 0%,#3a2f5b 55%,#5b3a4f 100%)',
  bgImage: null,              // image hash
  bgFit: 'cover',
  bgDim: 0.15,
  bgBlur: 0,
  // layout
  dialLayout: 'list',         // grid (thumbnail tiles) | list (icon + title rows)
  listSpan: 2,                // list row width, in tile widths
  listHeight: 52,
  listIconSize: 26,
  listIconSource: 'auto',     // auto (site logo, else favicon) | favicon | thumb | letter | none
  listStyle: 'card',          // card | flat | outline
  listRowGap: 10,
  listColumns: 0,             // 0 = fit to window
  listTitleSize: 14,
  listTitleLines: 1,
  listShowUrl: false,
  columns: 0,                 // 0 = auto
  dialWidth: 210,
  dialRatio: '16/10',
  gap: 22,
  radius: 12,
  maxWidth: 1500,
  verticalCenter: false,
  showTitles: true,
  titlePos: 'below',          // below | overlay | hidden-hover
  titleSize: 13,
  titleColor: '',             // '' = follow theme; any CSS colour to suit your wallpaper
  showFavicons: true,
  shadow: true,
  hoverEffect: 'lift',        // lift | zoom | glow | none
  dialOpacity: 1,
  showAddTile: true,
  // group bar
  showGroupBar: true,
  groupBarPos: 'top',         // top | bottom
  groupBarStyle: 'pills',     // pills | tabs | underline
  showGroupCounts: false,
  wheelSwitch: false,         // mouse wheel over page switches groups
  // behaviour
  openIn: 'current',          // current | new | background
  folderOpenIn: 'overlay',
  rememberLastGroup: true,
  defaultGroup: null,
  confirmDelete: false,
  lockLayout: false,          // prevent accidental drags / edits
  sortMode: 'manual',         // manual | title | visits | recent
  newTabFocus: 'page',        // page | search
  // search
  showSearch: true,
  searchEngine: 'google',
  customSearchUrl: 'https://search.example.com/?q=%s',
  searchFiltersDials: true,
  // widgets
  showClock: false,
  clock24h: true,
  showSidebarButton: true,
  // thumbnails
  defaultThumbMode: 'auto',   // auto (screenshot) | logo | letter
  captureOnVisit: true,
  captureDelay: 1500,
  captureWidth: 1280,
  captureHeight: 800,
  thumbWidth: 560,
  thumbRefreshDays: 0,        // 0 = never auto-refresh
  useFaviconService: false,   // allow DuckDuckGo icon service as logo fallback
  customCss: '',
};

export function emptyState() {
  const t = Date.now();
  return { schema: SCHEMA, groups: {}, dials: {}, settings: { _ts: {} }, createdAt: t };
}

export function make(fields, t = Date.now()) {
  const e = { ...fields, _ts: {} };
  for (const k of Object.keys(fields)) if (k !== 'id') e._ts[k] = t;
  return e;
}

export function patch(e, fields, t = Date.now()) {
  e._ts ||= {};
  for (const [k, v] of Object.entries(fields)) {
    if (k === 'id' || k === '_ts') continue;
    if (stableStringify(e[k]) === stableStringify(v) && e._ts[k]) continue;
    e[k] = v;
    e._ts[k] = Math.max(t, (e._ts[k] || 0) + 1);
  }
  return e;
}

// ---------- groups ----------
export function newGroup(s, title, extra = {}) {
  const order = nextOrder(groupsSorted(s));
  const g = make({ id: uid('g'), title: title || 'New group', order, color: null, emoji: '', layout: null, bg: null, lockHash: null, deleted: false, ...extra });
  s.groups[g.id] = g;
  return g;
}

export function groupsSorted(s) {
  return Object.values(s.groups).filter(g => !g.deleted).sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

export function deleteGroup(s, id, t = Date.now()) {
  const g = s.groups[id];
  if (!g) return;
  patch(g, { deleted: true }, t);
  for (const d of Object.values(s.dials)) if (d.groupId === id && !d.deleted) patch(d, { deleted: true }, t);
}

// ---------- dials ----------
export function newDial(s, { groupId, parentId = null, url = '', title = '', type = 'link', thumb, index } = {}) {
  const siblings = dialsOf(s, groupId, parentId);
  const order = index == null ? nextOrder(siblings) : placeOrder(siblings, index);
  const d = make({
    id: uid('d'), groupId, parentId, type, url, title, order,
    thumb: thumb || { mode: type === 'folder' ? 'folder' : (settingsOf(s).defaultThumbMode || 'auto'), image: null, bg: null, fit: 'cover', at: 0 },
    visits: 0, lastVisit: 0, createdAt: Date.now(), deleted: false,
  });
  s.dials[d.id] = d;
  return d;
}

export function dialsOf(s, groupId, parentId = null, sortMode = 'manual') {
  const list = Object.values(s.dials).filter(d => !d.deleted && d.groupId === groupId && (d.parentId || null) === (parentId || null));
  return sortDials(list, sortMode);
}

export function sortDials(list, mode = 'manual') {
  const byOrder = (a, b) => a.order - b.order || a.id.localeCompare(b.id);
  switch (mode) {
    case 'title': return list.sort((a, b) => (a.title || a.url).localeCompare(b.title || b.url, undefined, { sensitivity: 'base' }));
    case 'visits': return list.sort((a, b) => (b.visits || 0) - (a.visits || 0) || byOrder(a, b));
    case 'recent': return list.sort((a, b) => (b.lastVisit || 0) - (a.lastVisit || 0) || byOrder(a, b));
    default: return list.sort(byOrder);
  }
}

export function allLiveDials(s) {
  return Object.values(s.dials).filter(d => !d.deleted);
}

export function deleteDial(s, id, t = Date.now()) {
  const d = s.dials[id];
  if (!d) return;
  patch(d, { deleted: true }, t);
  if (d.type === 'folder') for (const c of Object.values(s.dials)) if (c.parentId === id && !c.deleted) deleteDial(s, c.id, t);
}

export function moveDial(s, id, { groupId, parentId = null, index } = {}, t = Date.now()) {
  const d = s.dials[id];
  if (!d) return;
  const gid = groupId ?? d.groupId;
  if (parentId === id) return;
  const siblings = dialsOf(s, gid, parentId).filter(x => x.id !== id);
  const order = index == null ? nextOrder(siblings) : placeOrder(siblings, index, s, t);
  patch(d, { groupId: gid, parentId, order }, t);
  // children of a folder follow it to the new group
  if (d.type === 'folder') for (const c of Object.values(s.dials)) if (c.parentId === id && !c.deleted && c.groupId !== gid) patch(c, { groupId: gid }, t);
}

export function nextOrder(sorted) {
  if (!sorted.length) return 1000;
  return Math.max(...sorted.map(x => x.order || 0)) + 1000;
}

// Order value to insert at `index` among `sorted` (which excludes the item being placed).
export function placeOrder(sorted, index, s, t) {
  const prev = sorted[index - 1], next = sorted[index];
  if (!prev && !next) return 1000;
  if (!prev) return next.order - 1000;
  if (!next) return prev.order + 1000;
  const mid = (prev.order + next.order) / 2;
  if (Math.abs(next.order - prev.order) > 1e-6) return mid;
  // gap exhausted: renumber siblings
  sorted.forEach((x, i) => patch(x, { order: (i + (i >= index ? 2 : 1)) * 1000 }, t));
  return (index + 1) * 1000;
}

// ---------- settings ----------
export function settingsOf(s) {
  const out = { ...DEFAULT_SETTINGS };
  for (const [k, v] of Object.entries(s.settings || {})) if (k !== '_ts') out[k] = v;
  return out;
}

export function setSettings(s, fields, t = Date.now()) {
  s.settings ||= { _ts: {} };
  patch(s.settings, fields, t);
}

// ---------- merge ----------
export function mergeEntity(a, b) {
  if (!a) return clone(b);
  if (!b) return clone(a);
  const out = { _ts: {} };
  if (a.id || b.id) out.id = a.id || b.id;
  const keys = new Set([...Object.keys(a), ...Object.keys(b), ...Object.keys(a._ts || {}), ...Object.keys(b._ts || {})]);
  keys.delete('_ts'); keys.delete('id');
  for (const k of keys) {
    const ta = a._ts?.[k] || 0, tb = b._ts?.[k] || 0;
    let src;
    if (ta > tb) src = a;
    else if (tb > ta) src = b;
    else {
      // tie: deterministic choice so every replica converges
      const sa = stableStringify(a[k]), sb = stableStringify(b[k]);
      src = (sa ?? '') >= (sb ?? '') ? a : b;
    }
    if (k in src) out[k] = clone(src[k]);
    out._ts[k] = Math.max(ta, tb);
  }
  return out;
}

function mergeMap(a = {}, b = {}) {
  const out = {};
  for (const id of new Set([...Object.keys(a), ...Object.keys(b)])) out[id] = mergeEntity(a[id], b[id]);
  return out;
}

export function merge(local, remote) {
  if (!remote) return clone(local);
  if (!local) return clone(remote);
  return {
    schema: SCHEMA,
    groups: mergeMap(local.groups, remote.groups),
    dials: mergeMap(local.dials, remote.dials),
    settings: mergeEntity(local.settings || { _ts: {} }, remote.settings || { _ts: {} }),
    createdAt: Math.min(local.createdAt || Infinity, remote.createdAt || Infinity),
  };
}

// The portion of state that is synced / compared.
export function syncView(s) {
  return { schema: SCHEMA, groups: s.groups || {}, dials: s.dials || {}, settings: s.settings || { _ts: {} }, createdAt: s.createdAt };
}

export function sameData(a, b) {
  return stableStringify(syncView(a)) === stableStringify(syncView(b));
}

// Drop tombstones older than maxAge (default 90 days).
export function purgeTombstones(s, maxAge = 90 * 864e5, t = Date.now()) {
  for (const map of [s.groups, s.dials]) {
    for (const [id, e] of Object.entries(map)) {
      if (e.deleted && t - (e._ts?.deleted || 0) > maxAge) delete map[id];
    }
  }
  return s;
}

export function referencedImages(s) {
  const set = new Set();
  for (const d of Object.values(s.dials)) if (!d.deleted && d.thumb?.image) set.add(d.thumb.image);
  for (const g of Object.values(s.groups)) if (!g.deleted && g.bg?.image) set.add(g.bg.image);
  const st = settingsOf(s);
  if (st.bgImage) set.add(st.bgImage);
  return set;
}

// Replace the whole dataset with `snap` in a way that wins against older replicas:
// every field is re-stamped, and anything not in the snapshot gets tombstoned.
export function restoreFrom(current, snap, t = Date.now()) {
  const out = emptyState();
  out.createdAt = current.createdAt || t;
  const restamp = e => { const c = clone(e); c._ts = {}; for (const k of Object.keys(c)) if (k !== 'id' && k !== '_ts') c._ts[k] = t; return c; };
  for (const kind of ['groups', 'dials']) {
    for (const [id, e] of Object.entries(snap[kind] || {})) out[kind][id] = restamp(e);
    for (const [id, e] of Object.entries(current[kind] || {})) {
      if (!out[kind][id]) { const c = clone(e); patch(c, { deleted: true }, t); out[kind][id] = c; }
    }
  }
  out.settings = restamp(snap.settings || {});
  return out;
}

export function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }
