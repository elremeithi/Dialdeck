// Shared UI runtime: app state, DOM helpers, modal / menu / toast primitives.
import { api, escapeHtml } from '../lib/util.js';
import { I } from './icons.js';
import { settingsOf, patch } from '../lib/model.js';
import { update } from '../lib/store.js';

export const app = {
  state: null,
  settings: null,
  groupId: null,
  unlocked: new Set(JSON.parse(sessionStorage.getItem('dd-unlocked') || '[]')),
  dragging: false,
  render: () => {},
};

export function setState(s) {
  app.state = s;
  app.settings = settingsOf(s);
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function h(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(e.dataset, v);
    else if (v === true) e.setAttribute(k, '');
    else e.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null && c !== false) e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return e;
}

export const send = msg => api.runtime.sendMessage(msg);

// ---------- toasts ----------
export function toast(text, { action, onAction, error, ms = 4500 } = {}) {
  const t = h('div', { class: 'toast' + (error ? ' error' : '') }, h('span', {}, text));
  if (action) t.append(h('button', { onclick: () => { onAction?.(); t.remove(); } }, action));
  $('#toasts').append(t);
  setTimeout(() => t.remove(), ms);
  return t;
}

// Record entity fields, perform op, offer undo that restores them.
export async function undoable(label, ids, op) {
  const before = {};
  const s = app.state;
  const collect = id => {
    const e = s.dials[id] || s.groups[id];
    if (!e) return;
    before[id] = JSON.parse(JSON.stringify(e));
    if (e.type === 'folder') for (const c of Object.values(s.dials)) if (c.parentId === id) collect(c.id);
    if (s.groups[id]) for (const c of Object.values(s.dials)) if (c.groupId === id) before[c.id] = JSON.parse(JSON.stringify(c));
  };
  ids.forEach(collect);
  await op();
  toast(label, {
    action: 'Undo', ms: 7000, onAction: () => update(st => {
      for (const [id, old] of Object.entries(before)) {
        const cur = st.dials[id] || st.groups[id];
        if (!cur) continue;
        const fields = {};
        for (const k of Object.keys(old)) if (k !== '_ts' && k !== 'id') fields[k] = old[k];
        patch(cur, fields);
      }
    }),
  });
}

// ---------- modal ----------
export function modal({ title, icon, body, footer, wide, cls, onClose }) {
  const wrap = h('div', { class: 'modal-wrap ' + (cls || '') });
  const box = h('div', { class: 'modal' + (wide ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true' });
  const close = () => { wrap.remove(); document.removeEventListener('keydown', esc, true); onClose?.(); };
  const esc = e => { if (e.key === 'Escape' && document.querySelector('.modal-wrap:last-of-type') === wrap && !$('#menu:not([hidden])')) { e.stopPropagation(); close(); } };
  document.addEventListener('keydown', esc, true);
  const head = h('header', {}, h('h2', { html: (icon ? icon : '') }, typeof title === 'string' ? escapeHtml(title) : ''), h('button', { class: 'x-btn', title: 'Close', html: I.close, onclick: close }));
  if (title instanceof Node) head.firstChild.append(title);
  else head.firstChild.innerHTML = (icon || '') + escapeHtml(title || '');
  box.append(head, h('div', { class: 'body' }, body));
  if (footer) box.append(h('footer', {}, footer));
  wrap.append(box);
  wrap.addEventListener('mousedown', e => { if (e.target === wrap) close(); });
  $('#overlay-root').append(wrap);
  setTimeout(() => box.querySelector('[autofocus], input:not([type=hidden]):not([type=file])')?.focus(), 30);
  return { wrap, box, close };
}

export function confirmBox(text, { ok = 'Delete', danger = true } = {}) {
  return new Promise(res => {
    let done = false;
    const m = modal({
      title: 'Are you sure?', body: h('p', {}, text),
      footer: [
        h('button', { class: 'btn', onclick: () => { done = true; m.close(); res(false); } }, 'Cancel'),
        h('button', { class: 'btn ' + (danger ? 'danger' : 'primary'), autofocus: true, onclick: () => { done = true; m.close(); res(true); } }, ok),
      ],
      onClose: () => { if (!done) res(false); },
    });
  });
}

export function promptBox(title, value = '', { placeholder = '', ok = 'Save', type = 'text' } = {}) {
  return new Promise(res => {
    let done = false;
    const inp = h('input', { class: 'inp', value, placeholder, type, autofocus: true });
    const submit = () => { done = true; m.close(); res(inp.value); };
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
    const m = modal({
      title, body: inp,
      footer: [h('button', { class: 'btn', onclick: () => { done = true; m.close(); res(null); } }, 'Cancel'), h('button', { class: 'btn primary', onclick: submit }, ok)],
      onClose: () => { if (!done) res(null); },
    });
  });
}

// ---------- context menu ----------
// items: [{label, icon, onClick, danger, kbd, sub:[items]}, '-' ]
export function openMenu(items, x, y) {
  const m = $('#menu');
  m.innerHTML = '';
  const build = (list, root) => {
    for (const it of list) {
      if (!it) continue;
      if (it === '-') { root.append(h('hr')); continue; }
      const b = h('button', { class: it.danger ? 'danger' : '', html: (it.icon || '') }, it.label);
      if (it.kbd && !globalThis.DD_ANDROID) b.append(h('span', { class: 'kbd' }, it.kbd));
      if (it.sub) {
        const wrap = h('div', { class: 'sub' }, b);
        const sm = h('div', { class: 'ctx' });
        build(it.sub, sm);
        wrap.append(sm);
        b.append(h('span', { class: 'kbd' }, '›'));
        // tap/click toggles the submenu (touch screens have no hover)
        b.addEventListener('click', e => { e.stopPropagation(); const open = !wrap.classList.contains('open'); m.querySelectorAll('.sub.open').forEach(x => x !== wrap && !x.contains(wrap) && x.classList.remove('open')); wrap.classList.toggle('open', open); });
        root.append(wrap);
      } else {
        b.addEventListener('click', e => { e.stopPropagation(); closeMenu(); it.onClick?.(e); });
        root.append(b);
      }
    }
  };
  build(items, m);
  m.hidden = false;
  const r = m.getBoundingClientRect();
  m.style.left = Math.min(x, innerWidth - r.width - 8) + 'px';
  m.style.top = Math.min(y, innerHeight - r.height - 8) + 'px';
  // submenus open leftwards near the right edge
  for (const sm of m.querySelectorAll('.sub > .ctx')) if (x + r.width * 2 > innerWidth) { sm.style.left = 'auto'; sm.style.right = '100%'; }
}
export function closeMenu() { const m = $('#menu'); if (!m) return; m.hidden = true; m.innerHTML = ''; }
document.addEventListener('mousedown', e => { if (!e.target.closest('#menu')) closeMenu(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeMenu(); });
addEventListener('blur', closeMenu);
addEventListener('resize', closeMenu);

// ---------- form helpers used by dialogs/settings ----------
export function seg(options, value, onChange) {
  const el = h('div', { class: 'seg' });
  for (const [v, label, icon] of options) {
    const b = h('button', { type: 'button', class: v === value ? 'on' : '', html: icon || '' }, label);
    b.addEventListener('click', () => { $$('button', el).forEach(x => x.classList.remove('on')); b.classList.add('on'); onChange(v); });
    el.append(b);
  }
  return el;
}

export function toggle(label, checked, onChange, hint) {
  const inp = h('input', { type: 'checkbox' });
  inp.checked = !!checked;
  inp.addEventListener('change', () => onChange(inp.checked));
  const l = h('label', { class: 'switch' }, h('span', {}, label, hint ? h('div', { class: 'hint' }, hint) : null), inp);
  return l;
}

export function range(label, value, min, max, step, onChange, fmt = v => v) {
  const inp = h('input', { type: 'range', min, max, step, value });
  const out = h('output', {}, fmt(value));
  inp.addEventListener('input', () => { out.textContent = fmt(+inp.value); onChange(+inp.value, false); });
  inp.addEventListener('change', () => onChange(+inp.value, true));
  return h('div', { class: 'field' }, h('label', {}, label), h('div', { class: 'range-row' }, inp, out));
}

export function field(label, control, hint) {
  return h('div', { class: 'field' }, h('label', {}, label), control, hint ? h('div', { class: 'hint', html: hint }) : null);
}

export function pickFile(accept = 'image/*') {
  return new Promise(res => {
    const inp = $('#file-pick');
    inp.accept = accept;
    inp.value = '';
    inp.onchange = () => res(inp.files[0] || null);
    inp.click();
  });
}

export function favicon(url) {
  // Chrome MV3 _favicon API (needs "favicon" permission); Firefox: fall back to site favicon
  try {
    if (api.runtime.getURL && !globalThis.browser?.runtime?.getBrowserInfo) {
      const u = new URL(api.runtime.getURL('/_favicon/'));
      u.searchParams.set('pageUrl', url);
      u.searchParams.set('size', '32');
      return u.toString();
    }
    return new URL(url).origin + '/favicon.ico';
  } catch { return ''; }
}
