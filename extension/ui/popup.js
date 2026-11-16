// Toolbar popup: add the current page to a group (with an instant screenshot), sync status.
import { api, normalizeUrl, fmtTime } from '../lib/util.js';
import { getState, getLocal, getSyncConfig } from '../lib/store.js';
import { groupsSorted, settingsOf, allLiveDials } from '../lib/model.js';
import { h, seg } from './core.js';
import { I } from './icons.js';

const root = document.getElementById('root');

(async () => {
  const s = await getState();
  const st = settingsOf(s);
  document.documentElement.dataset.theme = st.theme === 'auto' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : st.theme;
  document.documentElement.style.setProperty('--accent', st.accent);
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  const url = normalizeUrl(tab?.url || '');
  const groups = groupsSorted(s);
  const last = await getLocal('lastGroup', null);
  const existing = allLiveDials(s).filter(d => d.url === url);

  const shot = h('div', { class: 'shot' });
  if (/^https?:/.test(url)) api.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 60 }).then(u => { shot.style.backgroundImage = `url("${u}")`; }).catch(() => { shot.hidden = true; });
  else shot.hidden = true;

  const title = h('input', { class: 'inp', value: tab?.title || '' });
  const group = h('select', { class: 'inp' }, groups.map(g => h('option', { value: g.id, selected: g.id === (last || groups[0]?.id) }, (g.emoji ? g.emoji + ' ' : '') + g.title)));
  let mode = st.defaultThumbMode;
  const add = h('button', { class: 'btn primary', style: { width: '100%', justifyContent: 'center', marginTop: '4px' }, html: I.plus }, 'Add to DialDeck');
  add.addEventListener('click', async () => {
    add.disabled = true;
    const r = await api.runtime.sendMessage({ cmd: 'addCurrent', groupId: group.value, title: title.value.trim(), mode });
    if (r?.ok) {
      root.innerHTML = '';
      root.append(h('div', { class: 'done', html: I.cloudOk }, h('p', {}, 'Added to ' + group.selectedOptions[0].textContent)));
      setTimeout(() => window.close(), 900);
    } else { add.disabled = false; add.textContent = 'Failed: ' + (r?.error || ''); }
  });

  const cfg = await getSyncConfig();
  const ss = await getLocal('syncStatus', {});
  const sync = h('div', { class: 'sync', title: 'Sync now', html: cfg.enabled ? (ss.state === 'error' ? I.cloudErr : I.cloudOk) : I.cloudOff },
    cfg.enabled ? (ss.state === 'error' ? 'Sync error' : 'Synced ' + fmtTime(ss.at)) : 'Sync off');
  sync.addEventListener('click', async () => { sync.lastChild.textContent = 'Syncing…'; const r = await api.runtime.sendMessage({ cmd: 'sync', force: true }); sync.lastChild.textContent = r?.ok ? 'Synced just now' : 'Error: ' + r?.error; });

  root.append(
    h('div', { class: 'head' }, h('img', { src: 'icons/icon-32.png', alt: '' }), h('b', {}, 'DialDeck')),
    /^https?:|^file:/.test(url) ? h('div', {},
      shot,
      existing.length ? h('p', { class: 'hint' }, `Already in: ${existing.map(d => s.groups[d.groupId]?.title).filter(Boolean).join(', ')}`) : null,
      h('div', { class: 'field' }, h('label', {}, 'Title'), title),
      h('div', { class: 'field' }, h('label', {}, 'Group'), group),
      h('div', { class: 'field' }, h('label', {}, 'Thumbnail'), seg([['auto', 'Screenshot'], ['logo', 'Logo'], ['letter', 'Letter']], mode, v => { mode = v; })),
      add,
    ) : h('p', { class: 'hint' }, 'This page can\'t be added. Open a website and try again.'),
    h('div', { class: 'foot' }, sync, h('a', { href: '#', onclick: e => { e.preventDefault(); api.tabs.create({ url: api.runtime.getURL('newtab.html') }); window.close(); } }, 'Open DialDeck →')),
  );
  setTimeout(() => title.focus(), 50);
})();
