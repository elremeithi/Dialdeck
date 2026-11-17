// Applies settings (and per-group overrides) to CSS variables / classes.
import { imageUrl } from '../lib/images.js';
import { app, $ } from './core.js';

const mq = matchMedia('(prefers-color-scheme: dark)');
mq.addEventListener?.('change', () => applyAppearance());

export function applyAppearance() {
  const s = app.settings;
  if (!s) return;
  const g = app.state?.groups[app.groupId];
  const L = { columns: s.columns, dialWidth: s.dialWidth, dialRatio: s.dialRatio, ...(g?.layout || {}) };
  const root = document.documentElement;
  const theme = s.theme === 'auto' ? (mq.matches ? 'dark' : 'light') : s.theme;
  app.layoutMode = (g?.layout?.mode === 'grid' || g?.layout?.mode === 'list') ? g.layout.mode : (s.dialLayout === 'grid' ? 'grid' : 'list');
  root.dataset.theme = theme;
  const v = (k, val) => root.style.setProperty(k, val);
  v('--accent', s.accent);
  v('--dial-w', L.dialWidth + 'px');
  v('--dial-ratio', L.dialRatio);
  v('--cols', L.columns > 0 ? String(L.columns) : 'auto-fill');
  v('--gap', s.gap + 'px');
  v('--radius', s.radius + 'px');
  v('--title-size', s.titleSize + 'px');
  if (s.titleColor) v('--title-color', s.titleColor); else root.style.removeProperty('--title-color');
  v('--dial-opacity', s.dialOpacity);
  v('--max-w', s.maxWidth + 'px');
  v('--bg-dim', s.bgDim);
  v('--list-span', s.listSpan);
  v('--list-h', s.listHeight + 'px');
  v('--list-icon', s.listIconSize + 'px');
  v('--list-gap', s.listRowGap + 'px');
  v('--list-title-size', s.listTitleSize + 'px');
  v('--list-cols', s.listColumns > 0 ? String(s.listColumns) : 'auto-fill');
  const body = document.body;
  body.classList.toggle('shadow', !!s.shadow);
  body.classList.toggle('layout-list', app.layoutMode === 'list');
  for (const st of ['card', 'flat', 'outline']) body.classList.toggle('list-' + st, s.listStyle === st);
  body.classList.toggle('list-lines-2', Number(s.listTitleLines) === 2);
  for (const e of ['lift', 'zoom', 'glow']) body.classList.toggle('hover-' + e, s.hoverEffect === e);
  body.classList.toggle('no-titles', !s.showTitles);
  body.classList.toggle('title-overlay', s.showTitles && s.titlePos === 'overlay');
  body.classList.toggle('title-hover', s.showTitles && s.titlePos === 'hover');
  $('#app').classList.toggle('bar-bottom', s.groupBarPos === 'bottom');
  $('#main').classList.toggle('vcenter', !!s.verticalCenter);
  if (s.font && s.font !== 'system') body.style.fontFamily = s.font; else body.style.fontFamily = '';
  $('#custom-css').textContent = s.customCss || '';
  applyBackground(g?.bg || null);
}

let bgToken = 0;
async function applyBackground(groupBg) {
  const s = app.settings;
  const bg = $('#bg');
  const tok = ++bgToken;
  bg.style.filter = s.bgBlur ? `blur(${s.bgBlur}px)` : '';
  bg.style.inset = s.bgBlur ? `-${s.bgBlur * 2}px` : '0';
  const set = (css) => { if (tok === bgToken) { bg.style.background = css; bg.style.backgroundSize = s.bgFit === 'tile' ? 'auto' : s.bgFit; bg.style.backgroundPosition = 'center'; bg.style.backgroundRepeat = s.bgFit === 'tile' ? 'repeat' : 'no-repeat'; } };
  if (groupBg?.type === 'color') return set(groupBg.value);
  if (groupBg?.type === 'image' && groupBg.image) { const u = await imageUrl(groupBg.image); if (u) return set(`url("${u}")`); }
  switch (s.bgType) {
    case 'black': return set('#000');
    case 'color': return set(s.bgColor);
    case 'gradient': return set(s.bgGradient);
    case 'image': {
      const u = s.bgImage && await imageUrl(s.bgImage);
      return set(u ? `url("${u}")` : s.bgColor);
    }
    default: return set('var(--surface-solid)');
  }
}
