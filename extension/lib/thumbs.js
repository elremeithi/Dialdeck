// Thumbnail generation: page screenshots, site logos, resizing.
// Runs in the background context (service worker in Chrome, event page in Firefox).
import { api, sleep, IS_FIREFOX, hostOf, sha256Hex } from './util.js';
import { putImage } from './images.js';
import { update, getState } from './store.js';
import { patch, settingsOf } from './model.js';

// fetch with timeout so one slow site never blocks the queue
async function fetchT(url, opts = {}, ms = 12000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctl.signal }); } finally { clearTimeout(t); }
}
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(what + ' timed out')), ms))]);

// ---------- image processing ----------
async function toBitmap(blob) {
  return createImageBitmap(blob);
}

async function canvasToBlob(canvas, type = 'image/webp', quality = 0.85) {
  let b = await canvas.convertToBlob({ type, quality });
  if (type === 'image/webp' && b.type !== 'image/webp') b = await canvas.convertToBlob({ type: 'image/jpeg', quality });
  return b;
}

// Scale a screenshot down to `width`, keeping aspect ratio.
export async function resizeScreenshot(blob, width = 560) {
  const bmp = await toBitmap(blob);
  const scale = Math.min(1, width / bmp.width);
  const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close?.();
  return canvasToBlob(c);
}

// Normalise an arbitrary user image (custom thumbnail / background) to sane size.
export async function normaliseImage(blob, maxW = 1200, maxH = 1200, quality = 0.88) {
  if (blob.type === 'image/svg+xml' || blob.type === 'image/gif') return blob; // keep vector / animation
  const bmp = await toBitmap(blob);
  const scale = Math.min(1, maxW / bmp.width, maxH / bmp.height);
  if (scale === 1 && blob.size < 400 * 1024) { bmp.close?.(); return blob; }
  const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
  const c = new OffscreenCanvas(w, h);
  c.getContext('2d').drawImage(bmp, 0, 0, w, h);
  bmp.close?.();
  return canvasToBlob(c, 'image/webp', quality);
}

// Average colour of the image border => tile background for logos.
export async function edgeColor(blob) {
  try {
    const bmp = await toBitmap(blob);
    const S = 32;
    const c = new OffscreenCanvas(S, S);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0, S, S);
    bmp.close?.();
    const d = ctx.getImageData(0, 0, S, S).data;
    let r = 0, g = 0, b = 0, n = 0, transparent = 0;
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      if (x > 1 && x < S - 2 && y > 1 && y < S - 2) continue;
      const i = (y * S + x) * 4;
      if (d[i + 3] < 128) { transparent++; continue; }
      r += d[i]; g += d[i + 1]; b += d[i + 2]; n++;
    }
    if (!n || transparent > n) return '#ffffff';
    const hex = v => Math.round(v / n).toString(16).padStart(2, '0');
    return '#' + hex(r) + hex(g) + hex(b);
  } catch { return '#ffffff'; }
}

// ---------- screenshot capture ----------
function waitForLoad(tabId, timeout = 25000) {
  return new Promise(resolve => {
    let done = false;
    const finish = () => { if (done) return; done = true; api.tabs.onUpdated.removeListener(l); clearTimeout(t); resolve(); };
    const l = (id, info) => { if (id === tabId && info.status === 'complete') finish(); };
    const t = setTimeout(finish, timeout);
    api.tabs.onUpdated.addListener(l);
    api.tabs.get(tabId).then(tab => { if (tab.status === 'complete') finish(); }).catch(finish);
  });
}

export async function captureUrl(url, opts = {}) {
  const st = settingsOf(await getState());
  const delay = opts.delay ?? st.captureDelay;
  const width = st.captureWidth || 1280, height = st.captureHeight || 800;
  let dataUrl;
  if (IS_FIREFOX && api.tabs.captureTab) {
    // Firefox can screenshot a background tab directly — no window flashes.
    const tab = await api.tabs.create({ url, active: false });
    try {
      await waitForLoad(tab.id);
      await sleep(delay);
      dataUrl = await api.tabs.captureTab(tab.id, { format: 'png', rect: { x: 0, y: 0, width, height } }).catch(() => api.tabs.captureTab(tab.id, { format: 'png' }));
    } finally { api.tabs.remove(tab.id).catch(() => {}); }
  } else {
    // Chromium: open an unfocused popup window sized like a desktop viewport.
    // Chrome rejects bounds that are mostly off-screen, so fall back to smaller sizes on small displays.
    let win;
    for (const b of [{ width, height, left: 0, top: 0 }, { width: 1024, height: 640, left: 0, top: 0 }, {}]) {
      try { win = await api.windows.create({ url, focused: false, type: 'popup', ...b }); break; }
      catch (e) { if (!/bounds/i.test(e.message)) throw e; }
    }
    if (!win) throw new Error('could not open capture window');
    try {
      const tabId = win.tabs[0].id;
      await waitForLoad(tabId);
      await sleep(delay);
      dataUrl = await api.tabs.captureVisibleTab(win.id, { format: 'png' });
    } finally { api.windows.remove(win.id).catch(() => {}); }
  }
  const blob = await (await fetch(dataUrl)).blob();
  return resizeScreenshot(blob, st.thumbWidth || 560);
}

export async function captureVisible(windowId) {
  const st = settingsOf(await getState());
  const dataUrl = await api.tabs.captureVisibleTab(windowId, { format: 'png' });
  return resizeScreenshot(await (await fetch(dataUrl)).blob(), st.thumbWidth || 560);
}

// ---------- logos ----------
function absolutize(href, base) { try { return new URL(href, base).href; } catch { return null; } }

function attr(tag, name) {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return m ? (m[2] ?? m[3] ?? m[4]) : null;
}

export async function findLogoCandidates(pageUrl) {
  const out = [];
  let html = '', finalUrl = pageUrl;
  try {
    const r = await fetchT(pageUrl, { credentials: 'include', redirect: 'follow' });
    finalUrl = r.url || pageUrl;
    html = (await r.text()).slice(0, 300000);
  } catch { /* ignore */ }
  const baseTag = html.match(/<base\s[^>]*>/i);
  const base = (baseTag && absolutize(attr(baseTag[0], 'href'), finalUrl)) || finalUrl;
  const links = []; // declared icons, for favicon selection
  for (const tag of html.match(/<link\s[^>]*>/gi) || []) {
    const rel = (attr(tag, 'rel') || '').toLowerCase();
    const href = attr(tag, 'href');
    if (!href) continue;
    if (rel.includes('icon')) links.push({ url: absolutize(href, base), rel, sizes: size(tag), svg: /\.svg(\?|$)/i.test(href) || /svg/.test(attr(tag, 'type') || '') });
    if (rel.includes('apple-touch-icon')) out.push({ url: absolutize(href, base), score: 900 + size(tag) });
    else if (rel.includes('icon')) {
      const sz = size(tag);
      const svg = /\.svg(\?|$)/i.test(href) || /svg/.test(attr(tag, 'type') || '');
      out.push({ url: absolutize(href, base), score: svg ? 950 : 100 + sz * 2 });
    } else if (rel === 'manifest') {
      try {
        const murl = absolutize(href, base);
        const m = await (await fetchT(murl, { credentials: 'include' }, 8000)).json();
        for (const ic of m.icons || []) out.push({ url: absolutize(ic.src, murl), score: 800 + parseInt(ic.sizes || '0') });
      } catch { /* ignore */ }
    }
  }
  const og = html.match(/<meta\s[^>]*property\s*=\s*["']og:image["'][^>]*>/i);
  const ogUrl = og && absolutize(attr(og[0], 'content'), base);
  const origin = new URL(finalUrl).origin;
  out.push({ url: origin + '/apple-touch-icon.png', score: 400 });
  out.push({ url: origin + '/favicon.ico', score: 50 });
  const st = settingsOf(await getState());
  if (st.useFaviconService) out.push({ url: `https://icons.duckduckgo.com/ip3/${hostOf(finalUrl)}.ico`, score: 40 });
  const titleM = html.match(/<title[^>]*>([^<]{1,200})<\/title>/i);
  return { candidates: out.filter(c => c.url).sort((a, b) => b.score - a.score), links: links.filter(l => l.url), origin, og: ogUrl, title: titleM ? decodeEntities(titleM[1].trim()) : '' };
  function size(tag) { const s = attr(tag, 'sizes'); return s ? parseInt(s) || 0 : 0; }
}

function decodeEntities(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
}

export async function fetchLogo(pageUrl) {
  const { candidates } = await findLogoCandidates(pageUrl);
  const seen = new Set();
  for (const c of candidates) {
    if (seen.has(c.url)) continue;
    seen.add(c.url);
    try {
      const r = await fetchT(c.url, { credentials: 'include' }, 8000);
      if (!r.ok) continue;
      const blob = await r.blob();
      if (blob.size < 100) continue;
      const type = blob.type || '';
      if (type.includes('svg') || c.url.endsWith('.svg')) {
        const svg = new Blob([await blob.arrayBuffer()], { type: 'image/svg+xml' });
        return { blob: svg, bg: '#ffffff' };
      }
      const bmp = await createImageBitmap(blob).catch(() => null);
      if (!bmp) continue;
      const w = bmp.width; bmp.close?.();
      if (w < 32 && c.score > 60) continue; // too small unless last resort
      return { blob, bg: await edgeColor(blob) };
    } catch { /* next */ }
  }
  return null;
}

export async function fetchPageTitle(url) {
  try { return (await findLogoCandidates(url)).title; } catch { return ''; }
}

// ---------- queues ----------
// Two lanes: screenshots (one at a time — they open a window) and logos (network only, 3 in parallel).
// A third lane fetches site icons (favicons), which are small and synced like thumbnails.
const lanes = { shot: { q: [], busy: 0, max: 1 }, logo: { q: [], busy: 0, max: 3 }, icon: { q: [], busy: 0, max: 4 } };
const pending = new Set();

export async function enqueueThumb(dialId, kind = 'auto') {
  if (pending.has(dialId)) return;
  const d = (await getState()).dials[dialId];
  const mode = kind === 'auto' ? (d?.thumb?.mode || 'auto') : kind;
  pending.add(dialId);
  const lane = mode === 'logo' ? lanes.logo : lanes.shot;
  lane.q.push({ key: dialId, run: () => generate(dialId, mode), fail: () => markFailed(dialId) });
  pump(lane);
}

export function enqueueIcon(dialId) {
  const key = 'icon:' + dialId;
  if (pending.has(key)) return;
  pending.add(key);
  lanes.icon.q.push({ key, run: () => generateIcon(dialId) });
  pump(lanes.icon);
}

async function pump(lane) {
  while (lane.busy < lane.max && lane.q.length) {
    const job = lane.q.shift();
    lane.busy++;
    withTimeout(job.run(), 60000, job.key)
      .catch(e => { console.warn('thumbnail/icon job failed', job.key, e); return job.fail?.(); })
      .finally(() => { pending.delete(job.key); lane.busy--; pump(lane); });
  }
}

// ---------- favicons ----------
const ICON_MAX = 64;
let genericFaviconHash; // Chrome's default globe, meaning "no icon cached for this site"

// Chrome: the icon the browser already has for this page (no network request). null if unknown.
async function browserFavicon(pageUrl) {
  if (IS_FIREFOX || globalThis.DD_ANDROID || !api.runtime?.getURL) return null;
  try {
    const u = new URL(api.runtime.getURL('/_favicon/'));
    u.searchParams.set('size', '64');
    if (genericFaviconHash === undefined) {
      u.searchParams.set('pageUrl', 'https://no-such-site.dialdeck.invalid/');
      const r0 = await fetch(u);
      genericFaviconHash = r0.ok ? await sha256Hex(await r0.blob()) : null;
    }
    u.searchParams.set('pageUrl', pageUrl);
    const r = await fetch(u);
    if (!r.ok) return null;
    const b = await r.blob();
    if (!b.size || (genericFaviconHash && (await sha256Hex(b)) === genericFaviconHash)) return null;
    return b;
  } catch { return null; }
}

// The site's own icon: declared <link rel=icon> (SVG, then sizes nearest 64px), /favicon.ico,
// then apple-touch icons; DuckDuckGo's icon service last if enabled in settings.
async function networkFavicon(pageUrl) {
  const { links, origin } = await findLogoCandidates(pageUrl);
  const rank = l => l.svg ? 100 : l.sizes ? 90 - Math.abs(Math.min(l.sizes, 256) - 64) / 4 : 70;
  const declared = links.filter(l => !l.rel.includes('apple-touch-icon')).sort((a, b) => rank(b) - rank(a)).map(l => l.url);
  const touch = links.filter(l => l.rel.includes('apple-touch-icon')).map(l => l.url);
  const urls = [...declared, origin + '/favicon.ico', ...touch, origin + '/apple-touch-icon.png'];
  if (settingsOf(await getState()).useFaviconService) urls.push(`https://icons.duckduckgo.com/ip3/${hostOf(origin)}.ico`);
  for (const u of [...new Set(urls)]) {
    try {
      const r = await fetchT(u, { credentials: 'include' }, 8000);
      if (!r.ok || /^text\//.test(r.headers.get('content-type') || '')) continue;
      const b = await r.blob();
      if (b.size < 40) continue;
      return await normaliseIcon(b, u);
    } catch { /* try the next one */ }
  }
  return null;
}

// Small, uniform PNG (at most 64x64, aspect kept); SVG icons stay vector.
async function normaliseIcon(blob, url = '') {
  if ((blob.type || '').includes('svg') || /\.svg(\?|$)/i.test(url)) {
    const txt = await blob.text();
    if (!/<svg[\s>]/i.test(txt)) throw new Error('not an SVG');
    return new Blob([txt], { type: 'image/svg+xml' });
  }
  const bmp = await createImageBitmap(blob); // throws if it isn't a decodable image
  if (bmp.width < 8 || bmp.height < 8) { bmp.close?.(); throw new Error('icon too small'); }
  const S = Math.min(ICON_MAX, Math.max(bmp.width, bmp.height));
  const scale = S / Math.max(bmp.width, bmp.height);
  const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
  const c = new OffscreenCanvas(S, S);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, (S - w) / 2, (S - h) / 2, w, h);
  bmp.close?.();
  return c.convertToBlob({ type: 'image/png' });
}

export async function fetchFavicon(pageUrl) {
  const b = await browserFavicon(pageUrl);
  if (b) { try { return await normaliseIcon(b); } catch { /* fall through */ } }
  return networkFavicon(pageUrl);
}

// Fetch, store (content-addressed, so synced/deduplicated like thumbnails) and attach a dial's icon.
export async function generateIcon(dialId) {
  const s = await getState();
  const d = s.dials[dialId];
  if (!d || d.deleted || d.type !== 'link' || d.icon || !/^https?:/i.test(d.url)) return;
  if (settingsOf(s).syncFavicons === false) return;
  let origin;
  try { origin = new URL(d.url).origin; } catch { return; }
  // reuse an icon another dial on the same site already has: no request at all
  let hash = Object.values(s.dials).find(x => !x.deleted && x.icon && x.url && x.url.startsWith(origin + '/'))?.icon;
  if (!hash) {
    const blob = await fetchFavicon(d.url);
    if (!blob) return;
    hash = await putImage(blob);
  }
  await update(st => { const x = st.dials[dialId]; if (!x || x.icon || x.url !== d.url) return false; patch(x, { icon: hash }); });
}

// Stop the "generating" spinner; the tile falls back to a letter tile until the next refresh.
async function markFailed(dialId) {
  await update(st => {
    const x = st.dials[dialId];
    if (!x || x.thumb?.image) return false;
    patch(x, { thumb: { ...(x.thumb || {}), at: Date.now(), failed: true } });
  }).catch(() => {});
}

export async function generate(dialId, kind) {
  const s = await getState();
  const d = s.dials[dialId];
  if (!d || d.deleted || d.type !== 'link' || !d.url) return;
  const mode = kind === 'auto' ? (d.thumb?.mode || 'auto') : kind;
  if (!/^https?:|^file:|^ftp:/i.test(d.url)) return; // can't capture chrome://, about: etc.
  let image = null, bg = d.thumb?.bg || null, fit = 'cover';
  if (mode === 'logo') {
    const logo = await fetchLogo(d.url);
    if (!logo) return markFailed(dialId);
    image = await putImage(logo.blob);
    bg = logo.bg; fit = 'contain';
  } else if (mode === 'auto') {
    if (globalThis.DD_ANDROID) return markFailed(dialId); // a desktop browser captures it after the next sync
    const blob = await captureUrl(d.url);
    image = await putImage(blob);
  } else return;
  await update(st => {
    const x = st.dials[dialId];
    if (!x) return false;
    patch(x, { thumb: { ...(x.thumb || {}), mode, image, bg, fit, at: Date.now() } });
  });
}
