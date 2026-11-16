// Shared helpers usable from extension pages and the background context.
export const api = globalThis.browser ?? globalThis.chrome;
export const IS_FIREFOX = typeof globalThis.browser !== 'undefined' && !!globalThis.browser.runtime?.getBrowserInfo;

export const now = () => Date.now();

export function uid(prefix = '') {
  const a = new Uint8Array(9);
  crypto.getRandomValues(a);
  return prefix + btoa(String.fromCharCode(...a)).replace(/[+/=]/g, c => ({ '+': '-', '/': '_', '=': '' }[c]));
}

export function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function normalizeUrl(input) {
  let s = String(input || '').trim();
  if (!s) return '';
  if (/^(javascript|data|vbscript):/i.test(s)) return '';
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ||
    /^(mailto|about|chrome|edge|brave|vivaldi|opera|view-source|tel|magnet|news|irc|ircs|sms):/i.test(s);
  if (!hasScheme) {
    // LAN / homelab addresses (unraid.local:8080, 192.168.1.5, nas, localhost:3000) default to http
    const host = s.split(/[/?#]/)[0].replace(/:\d+$/, '').toLowerCase();
    const local = host === 'localhost' || !host.includes('.') || /^(\d{1,3}\.){3}\d{1,3}$/.test(host) || /^\[.*\]$/.test(host) ||
      /\.(local|lan|home|internal|localdomain|home\.arpa|test)$/.test(host);
    s = (local ? 'http://' : 'https://') + s;
  }
  try { return new URL(s).href; } catch { return ''; }
}

export function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

export function titleFromUrl(url) {
  const h = hostOf(url);
  if (!h) return url || '';
  const base = h.split('.').slice(-2, -1)[0] || h;
  return base.charAt(0).toUpperCase() + base.slice(1);
}

export function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export function colorFor(s) {
  const h = hashString(s || '?') % 360;
  return `hsl(${h} 55% 42%)`;
}

export async function sha256Hex(data) {
  const buf = data instanceof Blob ? await data.arrayBuffer() : (typeof data === 'string' ? new TextEncoder().encode(data) : data);
  const d = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// Deterministic JSON (sorted keys) for change detection.
export function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  return '{' + Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}

export function blobToDataUrl(blob) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(blob); });
}

export async function dataUrlToBlob(dataUrl) {
  return (await fetch(dataUrl)).blob();
}

export function b64encode(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export function b64decode(str) {
  const s = atob(str);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function fmtTime(ts) {
  if (!ts) return 'never';
  const d = new Date(ts);
  const diff = (Date.now() - ts) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return Math.floor(diff / 60) + ' min ago';
  if (diff < 86400) return Math.floor(diff / 3600) + ' h ago';
  return d.toLocaleString();
}
