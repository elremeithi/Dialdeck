// Import / export: native backups (with images), bookmarks, other speed-dial add-ons.
import { api, normalizeUrl, titleFromUrl, b64encode, b64decode, escapeHtml } from '../lib/util.js';
import { newGroup, newDial, groupsSorted, dialsOf, syncView, merge, restoreFrom, referencedImages, patch } from '../lib/model.js';
import { update, getState, getLocal, setLocal } from '../lib/store.js';
import { getImage, putImageWithHash, putImage } from '../lib/images.js';
import { sniffType } from '../lib/sync.js';

export async function exportBackup({ images = true } = {}) {
  const s = await getState();
  const out = { format: 'dialdeck-backup', version: 1, exportedAt: new Date().toISOString(), data: syncView(s), images: {} };
  if (images) for (const h of referencedImages(s)) {
    const b = await getImage(h);
    if (b) out.images[h] = b64encode(await b.arrayBuffer());
  }
  download(`dialdeck-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(out), 'application/json');
}

export function download(name, text, type) {
  if (globalThis.DD_ANDROID) { // WebView can't download blobs: let Android save the file
    const u8 = new TextEncoder().encode(text);
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    window.DDAndroid.saveFile(name, type, btoa(s));
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// Returns a short description of what was imported.
export async function importFile(file, { mode = 'merge' } = {}) {
  const text = await file.text();
  if (/^\uFEFF?\s*<!DOCTYPE NETSCAPE-Bookmark-file/i.test(text) || /<DL>/i.test(text)) return importBookmarksHtml(text);
  let json;
  try { json = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { throw new Error('Unrecognised file: expected JSON (DialDeck, Group Speed Dial, Speed Dial 2…) or bookmarks HTML. If this is a Group Speed Dial backup, please report its structure (with URLs removed) so the importer can support it.'); }
  if (json.format === 'dialdeck-backup') {
    for (const [h, b64] of Object.entries(json.images || {})) {
      const bytes = b64decode(b64);
      await putImageWithHash(h, new Blob([bytes], { type: sniffType(bytes.buffer) }));
    }
    await update(cur => {
      const next = mode === 'replace' ? restoreFrom(cur, json.data) : merge(cur, json.data);
      for (const k of Object.keys(cur)) delete cur[k];
      Object.assign(cur, next);
    });
    const g = Object.values(json.data.groups).filter(x => !x.deleted).length;
    const d = Object.values(json.data.dials).filter(x => !x.deleted).length;
    return `Imported ${g} groups and ${d} dials${mode === 'replace' ? ' (replaced existing data)' : ''}`;
  }
  if (isGroupSpeedDial(json)) return importGroupSpeedDial(json);
  return importForeign(json);
}

// ---------- Group Speed Dial (fastaddons) ----------
// backup_*.group_speed_dial is JSON: { dataVersion, version, options, metadata,
//   groups: [{ id, name, rows, cols, archived, dials: [{ type, name, url, created, ... }] }] }
// type 0 = website dial; other types are widgets (e.g. 4 = search box) or empty slots ({}).
export function isGroupSpeedDial(json) {
  return !!json && Array.isArray(json.groups) && json.groups.some(g => g && Array.isArray(g.dials)) &&
    ('dataVersion' in json || 'productivity_mode' in json || ('options' in json && 'metadata' in json));
}

export function parseGroupSpeedDial(json) {
  const toDial = x => {
    if (!x || typeof x !== 'object') return null;
    const kids = Array.isArray(x.dials) ? x.dials : Array.isArray(x.children) ? x.children : null;
    if (kids) { // folder (not present in all versions)
      const children = kids.map(toDial).filter(Boolean);
      return children.length ? { folder: true, title: String(x.name || x.title || 'Folder'), children } : null;
    }
    if (typeof x.url !== 'string' || !x.url.trim()) return null; // widgets, empty slots
    return { url: x.url.trim(), title: String(x.name ?? x.title ?? '').trim() };
  };
  return json.groups.filter(g => g && Array.isArray(g.dials)).map((g, i) => ({
    title: String(g.name || g.title || `Group ${i + 1}`) + (g.archived ? ' (archived)' : ''),
    layout: Number(g.cols) > 0 ? { columns: Math.min(14, Number(g.cols)) } : null,
    dials: g.dials.map(toDial).filter(Boolean).map((d, pos) => ({ ...d, pos })),
  }));
}

async function importGroupSpeedDial(json) {
  const groups = parseGroupSpeedDial(json);
  if (!groups.some(g => g.dials.length)) throw new Error('This Group Speed Dial backup contains no website dials');
  // Logos rather than screenshots: a few hundred screenshots would each open a capture window.
  // Switch any dial (or set the default) to screenshots later; capture-on-visit fills them in as you browse.
  const msg = await createGroups(groups, { thumbMode: 'logo' });
  return `Group Speed Dial: ${msg}. Fetching site logos in the background…`;
}

// Heuristic importer for other speed-dial extensions (Group Speed Dial, Speed Dial 2, FVD, Yandex…).
// Walks the JSON, finds "group-like" containers and "dial-like" objects (anything with a URL).
export async function importForeign(json) {
  const groups = new Map(); // key -> {title, dials:[]}
  const groupTitles = new Map();
  const urlKeys = ['url', 'link', 'href', 'uri', 'address'];
  const titleKeys = ['title', 'name', 'label', 'text', 'caption'];
  const groupKeys = ['groupId', 'group_id', 'group', 'idgroup', 'folderId', 'parentId', 'groupid', 'cat', 'category'];
  const imgKeys = ['thumbnail', 'thumb', 'image', 'img', 'screenshot', 'preview', 'logo', 'icon'];
  const pick = (o, keys) => { for (const k of keys) if (o[k] != null && o[k] !== '') return o[k]; return null; };

  // pass 1: collect group-ish objects with an id + title but no url
  const visit = (node, path) => {
    if (Array.isArray(node)) { node.forEach((n, i) => visit(n, path)); return; }
    if (!node || typeof node !== 'object') return;
    const url = pick(node, urlKeys);
    const title = pick(node, titleKeys);
    if (!url && title != null && (node.id != null || node._id != null) && typeof title === 'string') groupTitles.set(String(node.id ?? node._id), title);
    for (const [k, v] of Object.entries(node)) if (v && typeof v === 'object') visit(v, [...path, { key: k, title: !url ? title : null, id: node.id }]);
  };
  visit(json, []);

  const visit2 = (node, ctx) => {
    if (Array.isArray(node)) { node.forEach(n => visit2(n, ctx)); return; }
    if (!node || typeof node !== 'object') return;
    const url = pick(node, urlKeys);
    if (typeof url === 'string' && /^(https?|ftp|file):/i.test(url)) {
      let gk = pick(node, groupKeys);
      let gtitle = gk != null ? (groupTitles.get(String(gk)) || (typeof gk === 'string' && isNaN(gk) ? gk : null)) : null;
      if (!gtitle) gtitle = ctx.title || 'Imported';
      const key = gtitle;
      if (!groups.has(key)) groups.set(key, { title: gtitle, dials: [] });
      const img = pick(node, imgKeys);
      groups.get(key).dials.push({ url, title: String(pick(node, titleKeys) || ''), img: typeof img === 'string' ? img : null, pos: Number(node.position ?? node.order ?? node.pos ?? node.index ?? groups.get(key).dials.length) });
      return;
    }
    const title = pick(node, titleKeys);
    const childCtx = typeof title === 'string' ? { title } : ctx;
    for (const v of Object.values(node)) if (v && typeof v === 'object') visit2(v, childCtx);
  };
  visit2(json, { title: null });
  if (!groups.size) throw new Error('No dials found in that file');
  return createGroups([...groups.values()]);
}

async function createGroups(list, { thumbMode } = {}) {
  let total = 0;
  const pendingImgs = [];
  const seedIds = await getLocal('seedIds', null);
  await update(s => {
    // First import on a fresh install: replace the untouched sample groups instead of keeping them alongside.
    if (seedIds?.length) {
      const seed = new Set(seedIds);
      const live = [...Object.values(s.groups), ...Object.values(s.dials)].filter(e => !e.deleted);
      if (live.length === seed.size && live.every(e => seed.has(e.id))) live.forEach(e => patch(e, { deleted: true }));
    }
    const thumb = () => thumbMode ? { mode: thumbMode, image: null, bg: null, fit: thumbMode === 'logo' ? 'contain' : 'cover', at: 0 } : undefined;
    const add = (items, groupId, parentId) => {
      items.sort((a, b) => (a.pos ?? 0) - (b.pos ?? 0));
      for (const d of items) {
        if (d.folder) {
          const f = newDial(s, { groupId, parentId, type: 'folder', title: d.title, thumb: { mode: 'folder' } });
          add(d.children, groupId, f.id);
          continue;
        }
        const u = normalizeUrl(d.url);
        if (!u) continue;
        const dial = newDial(s, { groupId, parentId, url: u, title: d.title || titleFromUrl(u), thumb: thumb() });
        if (d.img) pendingImgs.push([dial.id, d.img]);
        total++;
      }
    };
    for (const g of list) {
      const grp = newGroup(s, g.title || 'Imported', g.layout ? { layout: g.layout } : {});
      add(g.dials, grp.id, null);
    }
  });
  if (seedIds) await setLocal('seedIds', null);
  // import data-URL thumbnails if the source file carried them
  for (const [id, img] of pendingImgs) {
    if (!img.startsWith('data:image/')) continue;
    try {
      const hash = await putImage(await (await fetch(img)).blob());
      await update(s => { const d = s.dials[id]; if (d) { d.thumb = { ...d.thumb, mode: 'custom', image: hash, fit: 'cover' }; d._ts.thumb = Date.now(); } });
    } catch { /* ignore */ }
  }
  api.runtime.sendMessage({ cmd: 'refreshMissing' }).catch(() => {});
  return `Imported ${total} dials into ${list.length} group${list.length === 1 ? '' : 's'}`;
}

export async function importBookmarksHtml(text) {
  const doc = new DOMParser().parseFromString(text, 'text/html');
  const loose = { title: 'Bookmarks', dials: [] };
  const groups = [loose];
  const walk = (dl, g) => {
    for (const dt of dl.querySelectorAll(':scope > dt, :scope > p > dt')) {
      const a = dt.querySelector(':scope > a');
      const h3 = dt.querySelector(':scope > h3');
      if (a) g.dials.push({ url: a.getAttribute('href'), title: a.textContent.trim(), pos: g.dials.length });
      else if (h3) {
        const sub = dt.querySelector(':scope > dl');
        if (!sub) continue;
        const ng = { title: h3.textContent.trim() || 'Folder', dials: [] };
        groups.push(ng);
        walk(sub, ng);
      }
    }
  };
  const top = doc.querySelector('dl');
  if (!top) throw new Error('No bookmarks found');
  walk(top, loose);
  return createGroups(groups.filter(g => g.dials.length));
}

export async function importBrowserFolder(folderId, { subfoldersAsGroups = true } = {}) {
  const [root] = await api.bookmarks.getSubTree(folderId);
  const list = [];
  const walk = (node, groupTitle, target) => {
    for (const c of node.children || []) {
      if (c.url) target.dials.push({ url: c.url, title: c.title, pos: target.dials.length });
      else if (subfoldersAsGroups) { const g = { title: c.title || 'Folder', dials: [] }; list.push(g); walk(c, c.title, g); }
      else walk(c, groupTitle, target);
    }
  };
  const main = { title: root.title || 'Bookmarks', dials: [] };
  list.push(main);
  walk(root, root.title, main);
  return createGroups(list.filter(g => g.dials.length));
}

export async function exportBookmarksHtml() {
  const s = await getState();
  const esc = escapeHtml;
  let out = '<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">\n<TITLE>Bookmarks</TITLE>\n<H1>DialDeck</H1>\n<DL><p>\n';
  const dump = (groupId, parentId, ind) => {
    for (const d of dialsOf(s, groupId, parentId)) {
      if (d.type === 'folder') { out += `${ind}<DT><H3>${esc(d.title)}</H3>\n${ind}<DL><p>\n`; dump(groupId, d.id, ind + '  '); out += `${ind}</DL><p>\n`; }
      else out += `${ind}<DT><A HREF="${esc(d.url)}">${esc(d.title)}</A>\n`;
    }
  };
  for (const g of groupsSorted(s)) { out += `  <DT><H3>${esc(g.title)}</H3>\n  <DL><p>\n`; dump(g.id, null, '    '); out += '  </DL><p>\n'; }
  out += '</DL><p>\n';
  download('dialdeck-bookmarks.html', out, 'text/html');
}

export async function bookmarkFolders() {
  const tree = await api.bookmarks.getTree();
  const out = [];
  const walk = (n, depth) => { for (const c of n.children || []) if (!c.url) { out.push({ id: c.id, title: c.title || '(untitled)', depth }); walk(c, depth + 1); } };
  walk(tree[0], 0);
  return out;
}
