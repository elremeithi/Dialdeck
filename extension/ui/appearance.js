// Applies settings (and per-group overrides) to CSS variables / classes.
import { imageUrl } from '../lib/images.js';
import { app, $ } from './core.js';
import { effectiveLayout } from '../lib/model.js';

const mq = matchMedia('(prefers-color-scheme: dark)');
mq.addEventListener?.('change', () => applyAppearance());

export function applyAppearance() {
  const s = app.settings;
  if (!s) return;
  const g = app.state?.groups[app.groupId];
  const L = effectiveLayout(s, g);
  app.eff = L;
  const root = document.documentElement;
  const theme = s.theme === 'auto' ? (mq.matches ? 'dark' : 'light') : s.theme;
  app.layoutMode = L.mode;
  root.dataset.theme = theme;
  const v = (k, val) => root.style.setProperty(k, val);
  v('--accent', s.accent);
  v('--dial-w', L.dialWidth + 'px');
  v('--dial-ratio', L.dialRatio);
  v('--cols', L.columns > 0 ? String(L.columns) : 'auto-fill');
  v('--gap', L.gap + 'px');
  v('--radius', s.radius + 'px');
  v('--title-size', s.titleSize + 'px');
  if (s.titleColor) v('--title-color', s.titleColor); else root.style.removeProperty('--title-color');
  v('--dial-opacity', s.dialOpacity);
  v('--max-w', s.maxWidth + 'px');
  v('--bg-dim', s.bgDim);
  v('--list-span', L.listSpan);
  v('--list-h', L.listHeight + 'px');
  v('--list-icon', L.listIconSize + 'px');
  v('--list-gap', L.listRowGap + 'px');
  v('--list-title-size', L.listTitleSize + 'px');
  v('--list-cols', L.listColumns > 0 ? String(L.listColumns) : 'auto-fill');
  // Explicit column widths: exactly one tile / exactly N tiles per list row, shrinking only when the
  // window is too narrow. (Not minmax(0, …), which relies on the engine growing tracks to their max.)
  const gap = Number(L.gap) || 0, tileW = Number(L.dialWidth) || 210, span = Number(L.listSpan) || 2;
  const listW = Math.round(tileW * span + gap * (span - 1));
  const cols = (n, w) => n > 0 ? `repeat(${n}, min(${w}px, calc((100% - ${(n - 1) * gap}px) / ${n})))` : `repeat(auto-fill, min(100%, ${w}px))`;
  v('--grid-template', cols(Number(L.columns) || 0, tileW));
  // List rows always keep their width (N tiles); "Columns" is a maximum, never a squeeze.
  const lc = Number(L.listColumns) || 0;
  v('--list-template', cols(0, listW));
  if (lc > 0) v('--list-max-w', (lc * listW + (lc - 1) * gap) + 'px'); else root.style.removeProperty('--list-max-w');
  const body = document.body;
  body.classList.toggle('shadow', !!s.shadow);
  body.classList.toggle('layout-list', app.layoutMode === 'list');
  for (const st of ['card', 'flat', 'outline']) body.classList.toggle('list-' + st, L.listStyle === st);
  body.classList.toggle('list-lines-2', Number(L.listTitleLines) === 2);
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
