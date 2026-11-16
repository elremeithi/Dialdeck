// Search box: web search engines + instant filtering across all dials.
import { api } from '../lib/util.js';
import { allLiveDials, setSettings } from '../lib/model.js';
import { update } from '../lib/store.js';
import { app, h, $, $$, openMenu } from './core.js';
import { tileEl, openDial } from './grid.js';

export const ENGINES = {
  google: { name: 'Google', url: 'https://www.google.com/search?q=%s', badge: 'G' },
  duckduckgo: { name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=%s', badge: 'D' },
  bing: { name: 'Bing', url: 'https://www.bing.com/search?q=%s', badge: 'B' },
  brave: { name: 'Brave Search', url: 'https://search.brave.com/search?q=%s', badge: 'Br' },
  startpage: { name: 'Startpage', url: 'https://www.startpage.com/do/search?q=%s', badge: 'S' },
  ecosia: { name: 'Ecosia', url: 'https://www.ecosia.org/search?q=%s', badge: 'E' },
  kagi: { name: 'Kagi', url: 'https://kagi.com/search?q=%s', badge: 'K' },
  qwant: { name: 'Qwant', url: 'https://www.qwant.com/?q=%s', badge: 'Q' },
  browser: { name: 'Browser default', url: null, badge: '⌕' },
  custom: { name: 'Custom (e.g. SearXNG)', url: null, badge: '★' },
};

let sel = -1;

export function initSearch() {
  const q = $('#q'), form = $('#search');
  const btn = $('#engine-btn');
  const paint = () => { const e = ENGINES[app.settings.searchEngine] || ENGINES.google; btn.textContent = e.badge; btn.title = 'Search with ' + e.name + ' (click to change)'; };
  app.paintEngine = paint;
  paint();
  btn.addEventListener('click', e => {
    const r = btn.getBoundingClientRect();
    openMenu(Object.entries(ENGINES).map(([k, en]) => ({ label: (k === app.settings.searchEngine ? '✓ ' : ' ') + en.name, onClick: () => update(s => setSettings(s, { searchEngine: k })) })), r.left, r.bottom + 6);
  });
  q.addEventListener('input', () => { sel = -1; filter(q.value); });
  q.addEventListener('keydown', e => {
    const tiles = $$('#search-results .dial');
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight' && q.selectionStart === q.value.length && tiles.length) { if (!tiles.length) return; e.preventDefault(); sel = Math.min(tiles.length - 1, sel + 1); mark(tiles); }
    else if (e.key === 'ArrowUp' || (e.key === 'ArrowLeft' && sel >= 0)) { if (!tiles.length) return; e.preventDefault(); sel = Math.max(-1, sel - 1); mark(tiles); }
    else if (e.key === 'Escape') { q.value = ''; filter(''); q.blur(); }
  });
  form.addEventListener('submit', e => {
    e.preventDefault();
    const tiles = $$('#search-results .dial');
    if (sel >= 0 && tiles[sel]) { const d = app.state.dials[tiles[sel].dataset.id]; if (d) openDial(d, app.settings.openIn); return; }
    const text = q.value.trim();
    if (!text) return;
    if (/^[a-z][a-z0-9+.-]*:\/\/\S+$/i.test(text) || /^[\w-]+(\.[\w-]+)+(:\d+)?(\/\S*)?$/.test(text)) { location.href = text.includes('://') ? text : 'https://' + text; return; }
    const key = app.settings.searchEngine;
    if (key === 'browser' && api.search?.query) return api.search.query({ text, disposition: 'CURRENT_TAB' }).catch(() => api.search.search?.({ query: text }));
    if (key === 'browser' && api.search?.search) return api.search.search({ query: text });
    const tpl = key === 'custom' ? app.settings.customSearchUrl : (ENGINES[key] || ENGINES.google).url || ENGINES.google.url;
    location.href = tpl.replace('%s', encodeURIComponent(text));
  });
}

function mark(tiles) { tiles.forEach((t, i) => t.classList.toggle('kbd', i === sel)); tiles[sel]?.scrollIntoView({ block: 'nearest' }); }

export function filter(text) {
  const box = $('#search-results');
  const grid = $('#grid');
  text = text.trim().toLowerCase();
  if (!text || !app.settings.searchFiltersDials) { box.hidden = true; grid.hidden = false; app.searching = false; app.renderMainOnly?.(); return; }
  app.searching = true;
  const words = text.split(/\s+/);
  const visibleGroup = d => { const g = app.state.groups[d.groupId]; return g && !g.deleted && (!g.lockHash || app.unlocked.has(g.id)); };
  const res = allLiveDials(app.state).filter(d => d.type === 'link' && visibleGroup(d)).map(d => {
    const hay = ((d.title || '') + ' ' + d.url).toLowerCase();
    if (!words.every(w => hay.includes(w))) return null;
    const score = (d.title || '').toLowerCase().startsWith(words[0]) ? 3 : hay.includes('//' + words[0]) || hay.includes('.' + words[0]) ? 2 : 1;
    return { d, score: score * 1000 + (d.visits || 0) };
  }).filter(Boolean).sort((a, b) => b.score - a.score).slice(0, 48);
  grid.hidden = true;
  $('#lock-screen').hidden = true;
  box.hidden = false;
  box.innerHTML = '';
  box.append(h('h3', {}, res.length ? `${res.length} matching dial${res.length === 1 ? '' : 's'} — Enter searches the web, ↓ to pick` : 'No matching dials — press Enter to search the web'));
  const g = h('div', { class: 'grid' });
  for (const { d } of res) g.append(tileEl(d, { showGroup: true }));
  g.addEventListener('click', e => { const a = e.target.closest('.dial'); if (!a) return; e.preventDefault(); const d = app.state.dials[a.dataset.id]; if (d) openDial(d, e.ctrlKey || e.metaKey ? 'background' : app.settings.openIn); });
  box.append(g);
}
