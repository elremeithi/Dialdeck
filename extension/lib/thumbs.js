// Thumbnail generation: page screenshots, site logos, resizing.
// Runs in the background context (service worker in Chrome, event page in Firefox).
import { api, sleep, IS_FIREFOX, hostOf } from './util.js';
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
  for (const tag of html.match(/<link\s[^>]*>/gi) || []) {
    const rel = (attr(tag, 'rel') || '').toLowerCase();
    const href = attr(tag, 'href');
    if (!href) continue;
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
  return { candidates: out.filter(c => c.url).sort((a, b) => b.score - a.score), og: ogUrl, title: titleM ? decodeEntities(titleM[1].trim()) : '' };
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
const lanes = { shot: { q: [], busy: 0, max: 1 }, logo: { q: [], busy: 0, max: 3 } };
const pending = new Set();

export async function enqueueThumb(dialId, kind = 'auto') {
  if (pending.has(dialId)) return;
  const d = (await getState()).dials[dialId];
  const mode = kind === 'auto' ? (d?.thumb?.mode || 'auto') : kind;
  pending.add(dialId);
  const lane = mode === 'logo' ? lanes.logo : lanes.shot;
  lane.q.push({ dialId, kind: mode });
  pump(lane);
}

async function pump(lane) {
  while (lane.busy < lane.max && lane.q.length) {
    const job = lane.q.shift();
    lane.busy++;
    withTimeout(generate(job.dialId, job.kind), 60000, 'thumbnail')
      .catch(e => { console.warn('thumb failed', job, e); return markFailed(job.dialId); })
      .finally(() => { pending.delete(job.dialId); lane.busy--; pump(lane); });
  }
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
