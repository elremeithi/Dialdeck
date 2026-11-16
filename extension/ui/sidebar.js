// Sidebar: recently closed, most visited, open tabs, bookmarks — each item can be added as a dial.
import { api, hostOf } from '../lib/util.js';
import { app, h, $, send, toast, favicon } from './core.js';
import { I } from './icons.js';

let tab = 'closed';

export function toggleSidebar(force) {
  const sb = $('#sidebar');
  const open = force ?? sb.hidden;
  if (!open) { sb.hidden = true; sb.innerHTML = ''; return; }
  sb.hidden = false;
  render();
}

async function render() {
  const sb = $('#sidebar');
  sb.innerHTML = '';
  const list = h('div', { class: 'list' });
  const tabs = h('div', { class: 'seg', style: { margin: '0 14px 10px' } },
    [['closed', 'Closed', I.history], ['top', 'Top sites', I.star], ['tabs', 'Open tabs', I.tabs], ['bm', 'Bookmarks', I.bookmark]].map(([k, l, ic]) =>
      h('button', { class: k === tab ? 'on' : '', html: ic, title: l, onclick: () => { tab = k; render(); } }, l)));
  sb.append(h('div', { class: 'phead' }, h('h2', {}, 'Quick add'), h('button', { class: 'x-btn', html: I.close, onclick: () => toggleSidebar(false) })), tabs, list);
  try {
    if (tab === 'closed') {
      const items = await api.sessions.getRecentlyClosed({ maxResults: 25 });
      for (const it of items) {
        if (it.tab) list.append(row(it.tab.url, it.tab.title, () => api.sessions.restore(it.tab.sessionId)));
        else if (it.window) {
          list.append(h('div', { class: 'bm-folder', html: I.ext }, `Window · ${it.window.tabs.length} tabs`));
          for (const t of it.window.tabs) list.append(row(t.url, t.title));
        }
      }
    } else if (tab === 'top') {
      for (const t of await api.topSites.get()) list.append(row(t.url, t.title));
    } else if (tab === 'tabs') {
      const all = await api.tabs.query({});
      list.append(h('button', { class: 'btn', style: { margin: '4px 8px 10px' }, html: I.plus, onclick: async () => {
        const { addOpenTabs } = await import('./grid.js'); addOpenTabs(app.groupId);
      } }, 'Add all tabs of this window'));
      for (const t of all) if (/^https?:/.test(t.url)) list.append(row(t.url, t.title, () => api.tabs.update(t.id, { active: true }).then(() => api.windows.update(t.windowId, { focused: true }))));
    } else if (tab === 'bm') {
      const tree = await api.bookmarks.getTree();
      const walk = (node, el, depth) => {
        for (const c of node.children || []) {
          if (c.url) el.append(row(c.url, c.title));
          else {
            const kids = h('div', { class: 'bm-children' });
            kids.hidden = depth > 0;
            el.append(h('div', { class: 'bm-folder', html: I.folder, onclick: () => { kids.hidden = !kids.hidden; } }, c.title || 'Bookmarks'), kids);
            walk(c, kids, depth + 1);
          }
        }
      };
      walk(tree[0], list, 0);
    }
  } catch (e) { list.append(h('p', { class: 'hint' }, 'Not available: ' + e.message)); }
  if (!list.children.length) list.append(h('p', { class: 'hint', style: { padding: '10px' } }, 'Nothing here yet.'));
}

function row(url, title, onOpen) {
  const a = h('a', { class: 'li', href: url, draggable: 'true' },
    h('img', { src: favicon(url), alt: '' }),
    h('span', { class: 't' }, title || url, h('small', {}, hostOf(url))),
    h('button', { class: 'add-b', title: 'Add to current group', html: I.plus, onclick: async e => {
      e.preventDefault(); e.stopPropagation();
      const r = await send({ cmd: 'addDial', url, title, groupId: app.groupId });
      if (r?.ok) toast(`Added “${title || hostOf(url)}”`);
    } }));
  if (onOpen) a.addEventListener('click', e => { if (e.target.closest('.add-b')) return; e.preventDefault(); onOpen(); });
  a.querySelector('img').onerror = function () { this.style.visibility = 'hidden'; };
  return a;
}
