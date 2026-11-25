// End-to-end: two Chromium profiles with the built extension syncing through the dev WebDAV server.
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const EXT = path.join(ROOT, 'dist/chrome');
const OUT = process.env.SHOTS || path.join(ROOT, 'test/shots');
fs.mkdirSync(OUT, { recursive: true });
const davDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-dav-'));
const log = (...a) => console.log('•', ...a);
const assert = (c, m) => { if (!c) throw new Error('ASSERT: ' + m); log('ok -', m); };

// --- local test websites ---
const icon = fs.readFileSync(path.join(ROOT, 'extension/icons/icon-128.png'));
const site = http.createServer((req, res) => {
  if (req.url.endsWith('.png')) { res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(icon); }
  const name = req.url.replace(/\W/g, '') || 'home';
  const hue = [...name].reduce((a, c) => a + c.charCodeAt(0), 0) % 360;
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(`<!doctype html><title>Site ${name}</title><link rel="apple-touch-icon" href="/touch.png"><body style="margin:0;font:40px sans-serif;background:hsl(${hue} 60% 45%);color:#fff;display:grid;place-items:center;height:100vh"><h1>${name}</h1></body>`);
}).listen(8800);

const dav = spawn(process.execPath, [path.join(ROOT, 'tools/dev-webdav.mjs'), '8766', davDir]);
await new Promise(r => dav.stdout.once('data', r));
const DAV_URL = 'http://localhost:8766/remote.php/dav/files/test/';

async function launch(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-prof-' + name));
  const ctx = await chromium.launchPersistentContext(dir, {
    headless: true, channel: 'chromium', viewport: { width: 1400, height: 900 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  sw.on('console', m => console.log('SW[' + name + ']', m.type(), m.text()));
  const id = sw.url().split('/')[2];
  // close the welcome tab opened on install
  await new Promise(r => setTimeout(r, 1500));
  return { ctx, sw, id, url: p => `chrome-extension://${id}/${p}` };
}

const state = page => page.evaluate(() => chrome.storage.local.get('state').then(r => r.state));
const live = s => ({ groups: Object.values(s.groups).filter(g => !g.deleted), dials: Object.values(s.dials).filter(d => !d.deleted) });
const update_layout = (page, gid, layout) => page.evaluate(([gid, layout]) => chrome.storage.local.get('state').then(({ state }) => { const g = state.groups[gid]; g.layout = layout; g._ts.layout = Date.now(); return chrome.storage.local.set({ state }); }), [gid, layout]);
const waitFor = async (fn, ms = 20000, what = 'condition') => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await new Promise(r => setTimeout(r, 300)); } throw new Error('timeout: ' + what); };

let A, B;
try {
  // ---------------- Browser A ----------------
  A = await launch('A');
  const pa = await A.ctx.newPage();
  pa.on('pageerror', e => console.log('PAGEERROR', e.message)); pa.on('console', m => m.type() === 'error' && console.log('CONSOLE', m.text()));
  await pa.goto(A.url('newtab.html'));
  await pa.waitForSelector('#grid .dial');
  let s = await state(pa);
  assert(live(s).groups.length === 2, 'seeded 2 groups on install');
  await pa.keyboard.press('Escape');

  // add a dial through the UI
  await pa.click('.dial.add');
  await pa.fill('.modal input.inp >> nth=0', 'localhost:8800/alpha'); // typed without scheme
  await pa.click('.modal footer .btn.primary');
  await waitFor(async () => live(await state(pa)).dials.some(d => d.url === 'http://localhost:8800/alpha' || d.url === 'https://localhost:8800/alpha'), 5000, 'dial added');
  s = await state(pa);
  const alpha = live(s).dials.find(d => d.url.includes('8800/alpha'));
  log('normalized url:', alpha.url);
  // https:// default would fail for this local site — edit to http
  await pa.click(`.dial[data-id="${alpha.id}"] .menu-btn`);
  await pa.click('#menu button:has-text("Edit")');
  await pa.fill('.modal input.inp >> nth=0', 'http://localhost:8800/alpha');
  await pa.fill('.modal input.inp >> nth=1', 'Alpha site');
  await pa.click('.modal footer .btn.primary');
  await waitFor(async () => (await state(pa)).dials[alpha.id].title === 'Alpha site', 5000, 'edit saved');

  // screenshot thumbnail captured via background window
  await waitFor(async () => !!(await state(pa)).dials[alpha.id].thumb?.image, 30000, 'screenshot thumbnail generated');
  assert(true, 'screenshot thumbnail generated in background');

  // add more dials via background message (like the context menu does) and a folder
  const home = live(s).groups.find(g => g.title === 'Home');
  for (const n of ['beta', 'gamma', 'delta']) await pa.evaluate(([u, g]) => chrome.runtime.sendMessage({ cmd: 'addDial', url: u, groupId: g, mode: 'logo' }), [`http://localhost:8800/${n}`, home.id]);
  await waitFor(async () => live(await state(pa)).dials.filter(d => d.url.includes('8800') && d.thumb?.image).length >= 4, 30000, 'logo thumbnails fetched');
  s = await state(pa);
  const beta = live(s).dials.find(d => d.url.endsWith('/beta'));
  assert(beta.title === 'Site beta', 'page title fetched automatically: ' + beta.title);
  assert(beta.thumb.fit === 'contain' && beta.thumb.bg, 'logo thumb has contain-fit and bg colour');

  // ---------------- synced site icons (favicons) ----------------
  await waitFor(async () => live(await state(pa)).dials.filter(d => d.url.includes('8800') && d.icon).length >= 4, 30000, 'site icons fetched');
  const iconInfo = await pa.evaluate(async hash => new Promise(res => {
    const r = indexedDB.open('dialdeck', 1);
    r.onsuccess = () => { const q = r.result.transaction('images').objectStore('images').get(hash); q.onsuccess = async () => { const b = new Blob([q.result.data], { type: q.result.type }); const bmp = await createImageBitmap(b); res({ type: b.type, w: bmp.width, h: bmp.height, size: b.size }); }; };
  }), live(await state(pa)).dials.find(d => d.url.endsWith('/beta')).icon);
  assert(iconInfo.type === 'image/png' && iconInfo.w === 64 && iconInfo.h === 64, `site icon stored as a 64×64 PNG (${JSON.stringify(iconInfo)}), not Chrome's generic globe`);
  const icons = new Set(live(await state(pa)).dials.filter(d => d.url.includes('8800')).map(d => d.icon));
  assert(icons.size === 1, 'dials on the same site share one icon (fetched once, stored once)');
  const siteIcon = [...icons][0];

  // drag & drop reorder: drag the last http dial onto the first tile
  await pa.waitForTimeout(500);
  const before = await pa.$$eval('#grid .dial[data-id]', els => els.map(e => e.dataset.id));
  const last = before[before.length - 1];
  await pa.dragAndDrop(`.dial[data-id="${last}"]`, `.dial[data-id="${before[0]}"]`, { targetPosition: { x: 10, y: 30 } });
  await pa.waitForTimeout(600);
  const after = await pa.$$eval('#grid .dial[data-id]', els => els.map(e => e.dataset.id));
  assert(after[0] === last, 'drag & drop moved dial to first position');
  const orderS = await state(pa);
  const sorted = Object.values(orderS.dials).filter(d => !d.deleted && d.groupId === home.id && !d.parentId).sort((a, b) => a.order - b.order).map(d => d.id);
  assert(sorted[0] === last, 'new order persisted');

  // create folder & move a dial into it via context menu
  await pa.click('.dial.add', { button: 'right' });
  await pa.click('#menu button:has-text("New folder")');
  await pa.waitForSelector('.folder-view');
  await pa.fill('.folder-view h2 input', 'Dev tools');
  await pa.press('.folder-view h2 input', 'Enter');
  await waitFor(async () => live(await state(pa)).dials.some(d => d.type === 'folder' && d.title === 'Dev tools'), 10000, 'folder renamed');
  await pa.click('.folder-view footer .btn.primary');
  await pa.waitForTimeout(300);
  await pa.click(`.dial[data-id="${beta.id}"]`, { button: 'right' });
  await pa.hover('#menu button:has-text("Move to folder")');
  await pa.click('#menu .sub .ctx button:has-text("Dev tools")');
  await waitFor(async () => !!(await state(pa)).dials[beta.id].parentId, 5000, 'moved into folder');
  assert(true, 'dial moved into folder');

  // group via UI + settings change
  await pa.click('#groupbar .gtab.add');
  await pa.fill('.modal input.inp >> nth=1', 'Media');
  await pa.click('.modal footer .btn.primary');
  await waitFor(async () => live(await state(pa)).groups.some(g => g.title === 'Media'), 5000, 'group created');
  await pa.click('#groupbar .gtab:has-text("Home")');
  await pa.screenshot({ path: path.join(OUT, '1-newtab.png') });

  // search filter
  await pa.fill('#q', 'alpha');
  await pa.waitForSelector('#search-results .dial');
  assert((await pa.$$('#search-results .dial')).length === 1, 'search filters dials');
  await pa.screenshot({ path: path.join(OUT, '2-search.png') });
  await pa.fill('#q', '');
  await pa.dispatchEvent('#q', 'input');

  // ---------------- enable sync on A via UI (with encryption) ----------------
  await pa.click('#btn-settings');
  await pa.click('#drawer .ptabs button:has-text("Sync")');
  await pa.waitForSelector('#drawer input[placeholder^="https://cloud"]');
  await pa.click('#drawer label.switch:has-text("Enable WebDAV sync")');
  await pa.fill('#drawer input[placeholder^="https://cloud"]', DAV_URL);
  await pa.fill('#drawer input[autocomplete=username]', 'test');
  await pa.fill('#drawer input[autocomplete=current-password]', 'test');
  assert(await pa.isChecked('#drawer label.switch:has-text("End-to-end encryption") input'), 'encryption is on by default');
  await pa.fill('#drawer input[autocomplete=new-password]', 'correct horse battery staple');
  await pa.click('#drawer button:has-text("Test connection")');
  await pa.waitForSelector('.toast:has-text("Connection OK")');
  assert(true, 'test connection OK');
  await pa.click('#drawer button:has-text("Save & sync now")');
  await pa.waitForSelector('.toast:has-text("Synced")', { timeout: 30000 });
  await pa.screenshot({ path: path.join(OUT, '3-sync-settings.png') });
  const files = fs.readdirSync(path.join(davDir, 'DialDeck')).sort();
  assert(JSON.stringify(files) === JSON.stringify(['dialdeck.bundle', 'keyinfo.json', 'packs', 'snapshots']), 'server holds one bundle + packs + snapshots, no per-dial files: ' + files.join(', '));
  const raw = fs.readFileSync(path.join(davDir, 'DialDeck/dialdeck.bundle'));
  assert(raw.subarray(0, 4).toString() === 'DDE1', 'bundle is encrypted');
  const packs = fs.readdirSync(path.join(davDir, 'DialDeck/packs'));
  assert(packs.length >= 1 && packs.length <= 2 && packs.every(n => /^[0-9a-f]{32}\.pack$/.test(n)), `images stored in ${packs.length} randomly-named pack(s): ${packs.join(', ')}`);
  // leak scan: no file name or file content on the server reveals a URL, a title or an image hash
  const refd = new Set(live(await state(pa)).dials.flatMap(d => [d.thumb?.image, d.icon]).filter(Boolean));
  const secrets = ['localhost:8800', 'Alpha site', 'Site beta', 'github.com', 'Wikipedia', ...refd];
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
  const leaks = [];
  for (const f of walk(path.join(davDir, 'DialDeck'))) {
    const body = fs.readFileSync(f).toString('latin1');
    for (const sec of secrets) if (f.includes(sec) || body.includes(sec)) leaks.push(`${path.relative(davDir, f)}: ${sec.slice(0, 20)}`);
  }
  assert(leaks.length === 0, `no URL, title or image hash visible anywhere on the server (checked ${walk(path.join(davDir, 'DialDeck')).length} files for ${secrets.length} secrets)` + (leaks.length ? ' LEAKS: ' + leaks.join('; ') : ''));
  assert(fs.readdirSync(path.join(davDir, 'DialDeck/snapshots')).filter(n => n.endsWith('.bundle')).length === 1, 'daily snapshot written (as an encrypted bundle)');

  // ---------------- Browser B ----------------
  B = await launch('B');
  const pb = await B.ctx.newPage();
  await pb.goto(B.url('newtab.html'));
  await pb.waitForSelector('#grid .dial');
  // wrong passphrase first
  await pb.evaluate(u => chrome.storage.local.set({ syncConfig: { enabled: true, url: u, username: 'test', password: 'test', folder: 'DialDeck', encrypt: true, passphrase: 'wrong', intervalMin: 10, syncImages: true, snapshotsKeep: 30 } }), DAV_URL);
  let r = await pb.evaluate(() => chrome.runtime.sendMessage({ cmd: 'syncConfigChanged' }));
  assert(!r.ok && /passphrase|Decryption/i.test(r.error), 'wrong passphrase rejected: ' + r.error);
  await pb.evaluate(() => chrome.storage.local.get('syncConfig').then(c => chrome.storage.local.set({ syncConfig: { ...c.syncConfig, passphrase: 'correct horse battery staple' } })));
  r = await pb.evaluate(() => chrome.runtime.sendMessage({ cmd: 'syncConfigChanged' }));
  assert(r.ok, 'B synced with correct passphrase');
  const sb = await state(pb);
  const sa = await state(pa);
  assert(live(sb).groups.length === live(sa).groups.length, `B has same number of groups as A (${live(sb).groups.length}) — no duplicated sample groups`);
  assert(live(sb).dials.length === live(sa).dials.length, `B has same dials (${live(sb).dials.length})`);
  const imgCount = await pb.evaluate(() => new Promise(res => { const r = indexedDB.open('dialdeck', 1); r.onsuccess = () => { const q = r.result.transaction('images').objectStore('images').count(); q.onsuccess = () => res(q.result); }; }));
  assert(imgCount >= refd.size, `B downloaded and decrypted images (${imgCount})`);
  assert(live(sb).dials.filter(d => d.url.includes('8800')).every(d => d.icon === siteIcon), 'site icons synced to B as part of the data');
  await pb.reload();
  await pb.waitForSelector('#grid .dial img[src^="blob:"]');
  await pb.waitForTimeout(800);
  await pb.screenshot({ path: path.join(OUT, '4-browser-B.png') });
  const alphaRowIcon = await pb.$eval(`.dial[data-id="${alpha.id}"] img`, i => i.src).catch(() => '');
  assert(alphaRowIcon.startsWith('blob:'), 'B shows the synced icon (no favicon request of its own): ' + alphaRowIcon.slice(0, 30));

  // ---------------- concurrent edits merge ----------------
  const target = alpha.id;
  await pa.evaluate(id => chrome.storage.local.get('state').then(({ state }) => { const d = state.dials[id]; d.title = 'Renamed on A'; d._ts.title = Date.now(); return chrome.storage.local.set({ state, dirtyAt: Date.now() }); }), target);
  await pb.evaluate(id => chrome.storage.local.get('state').then(({ state }) => { const d = state.dials[id]; d.url = 'http://localhost:8800/alpha2'; d._ts.url = Date.now(); return chrome.storage.local.set({ state, dirtyAt: Date.now() }); }), target);
  // B also deletes delta, A adds a new dial
  const delta = live(sa).dials.find(d => d.url.endsWith('/delta'));
  await pb.evaluate(id => chrome.storage.local.get('state').then(({ state }) => { state.dials[id].deleted = true; state.dials[id]._ts.deleted = Date.now(); return chrome.storage.local.set({ state, dirtyAt: Date.now() }); }), delta.id);
  await pa.evaluate(g => chrome.runtime.sendMessage({ cmd: 'addDial', url: 'http://localhost:8800/epsilon', groupId: g, mode: 'letter' }), home.id);
  for (const p of [pa, pb, pa]) { const x = await p.evaluate(() => chrome.runtime.sendMessage({ cmd: 'sync', force: true })); assert(x.ok, 'sync round ok ' + JSON.stringify(x.result || x.error)); }
  const fa = await state(pa), fb = await state(pb);
  assert(fa.dials[target].title === 'Renamed on A' && fa.dials[target].url.endsWith('alpha2'), 'A: both concurrent field edits survived');
  assert(fb.dials[target].title === 'Renamed on A' && fb.dials[target].url.endsWith('alpha2'), 'B: both concurrent field edits survived');
  assert(fa.dials[delta.id].deleted && fb.dials[delta.id].deleted, 'deletion propagated');
  assert(live(fb).dials.some(d => d.url.endsWith('/epsilon')), 'addition propagated');

  // ---------------- snapshot restore ----------------
  r = await pa.evaluate(() => chrome.runtime.sendMessage({ cmd: 'listSnapshots' }));
  assert(r.ok && r.result.length >= 1, 'snapshots listed: ' + r.result.map(x => x.name).join(','));

  // ---------------- delete via keyboard + undo ----------------
  await pa.goto('about:blank'); await pa.goto(A.url('newtab.html#g=' + home.id));
  await pa.waitForSelector('#grid .dial[data-id]');
  const victim = await pa.$eval('#grid .dial[data-id]', e => e.dataset.id);
  await pa.hover(`.dial[data-id="${victim}"]`);
  await pa.keyboard.press('Delete');
  await waitFor(async () => (await state(pa)).dials[victim].deleted, 5000, 'deleted via Del key');
  await pa.click('.toast button:has-text("Undo")');
  await waitFor(async () => !(await state(pa)).dials[victim].deleted, 5000, 'undo restored dial');
  assert(true, 'Del key deletes hovered dial and Undo restores it');

  // ---------------- layouts: list (default) <-> tiles, OLED ----------------
  await pa.goto('about:blank'); await pa.goto(A.url('newtab.html#g=' + home.id));
  await pa.waitForSelector('#grid .dial.row[data-id] .ico');
  await pa.waitForTimeout(600); // background fades in over .3s
  const oled = await pa.evaluate(() => [document.documentElement.dataset.theme, getComputedStyle(document.getElementById('bg')).backgroundColor]);
  assert(oled[0] === 'oled' && oled[1] === 'rgb(0, 0, 0)', 'OLED theme with pure black background by default: ' + oled);
  const rowW = await pa.$eval('#grid .dial.row[data-id]', e => e.getBoundingClientRect().width);
  const st0 = (await state(pa)).settings;
  const unit = (st0.dialWidth ?? 210), gap = (st0.gap ?? 22);
  assert(Math.abs(rowW - (unit * 2 + gap)) < 2, `list row is two tiles wide (${rowW}px)`);
  await pa.evaluate(() => chrome.storage.local.get('state').then(({ state }) => { state.settings.listColumns = 8; state.settings._ts.listColumns = Date.now(); return chrome.storage.local.set({ state }); }));
  await pa.waitForTimeout(500);
  const rowW8 = await pa.$eval('#grid .dial.row[data-id]', e => e.getBoundingClientRect().width);
  assert(Math.abs(rowW8 - rowW) < 2, `"Columns: 8" keeps rows two tiles wide (${rowW8}px) instead of squeezing them`);
  await pa.evaluate(() => chrome.storage.local.get('state').then(({ state }) => { state.settings.listColumns = 0; state.settings._ts.listColumns = Date.now(); return chrome.storage.local.set({ state }); }));
  const logoRow = live(await state(pa)).dials.find(d => d.thumb?.mode === 'logo' && d.thumb.image && !d.parentId && d.groupId === home.id);
  if (logoRow) assert(await pa.$eval(`.dial.row[data-id="${logoRow.id}"] .ico img`, i => i.src.startsWith('blob:')), 'list icon uses fetched site logo');
  await pa.screenshot({ path: path.join(OUT, '9-list-oled.png') });
  await pa.keyboard.press(',');
  await pa.click('#drawer .ptabs button:has-text("Layout")');
  await pa.click('#drawer .seg button:has-text("Show site address")').catch(() => {});
  await pa.click('#drawer label.switch:has-text("Show site address")');
  await pa.waitForSelector('#grid .dial.row .u');
  assert(true, 'list option (site address) applies live');
  await pa.click('#drawer .seg button:has-text("Tiles")');
  await pa.waitForFunction(() => document.querySelectorAll('#grid .dial.row').length === 0 && document.querySelector('#grid .dial[data-id] .thumb'), null, { timeout: 5000 });
  assert(true, 'switching to Tiles renders thumbnail tiles');
  await pa.click('#drawer .seg button:has-text("List")');
  await pa.waitForSelector('#grid .dial.row[data-id]');
  assert(true, 'switching back to List works');
  await pa.keyboard.press('Escape');
  await pa.waitForTimeout(400);

  // ---------------- per-tab layout ----------------
  const work = live(await state(pa)).groups.find(g => g.title === 'Work');
  await pa.click('#btn-layout'); // Home -> Tiles, only this tab
  await waitFor(async () => (await state(pa)).groups[home.id].layout?.mode === 'grid', 5000, 'Home switched to tiles');
  await pa.waitForFunction(() => !document.querySelector('#grid .dial.row') && document.querySelector('#grid .dial[data-id] .thumb'), null, { timeout: 5000 });
  await pa.click(`#groupbar .gtab[data-gid="${work.id}"]`);
  await pa.waitForSelector('#grid .dial.row[data-id]');
  assert(!(await state(pa)).groups[work.id].layout?.mode, 'toolbar toggle only changed the current tab: Home=Tiles, Work=List');
  // per-tab list size via right-click submenu + editor
  await pa.click(`#groupbar .gtab[data-gid="${work.id}"]`, { button: 'right' });
  await pa.hover('#menu button:has-text("Layout")');
  await pa.click('#menu .sub .ctx button:has-text("Tiles")');
  await waitFor(async () => (await state(pa)).groups[work.id].layout?.mode === 'grid', 5000, 'Work set to tiles via menu');
  await pa.click(`#groupbar .gtab[data-gid="${home.id}"]`);
  await pa.click('#btn-layout', { button: 'right' });
  await pa.click('#menu button:has-text("Use default")');
  await waitFor(async () => !(await state(pa)).groups[home.id].layout?.mode, 5000, 'Home back to default');
  assert(true, 'tab right-click Layout submenu and toolbar "Use default" work');
  await update_layout(pa, work.id, { mode: 'list', listSpan: 3 });
  await pa.click(`#groupbar .gtab[data-gid="${work.id}"]`);
  await pa.waitForSelector('#grid .dial.row[data-id]');
  const w3 = await pa.$eval('#grid .dial.row[data-id]', e => e.getBoundingClientRect().width);
  await pa.click(`#groupbar .gtab[data-gid="${home.id}"]`);
  await pa.waitForTimeout(300);
  const w2 = await pa.$eval('#grid .dial.row[data-id]', e => e.getBoundingClientRect().width);
  assert(w3 > w2 * 1.4, `per-tab list width: Work ${w3}px (3 tiles) vs Home ${w2}px (2 tiles)`);

  // ---------------- popup ----------------
  const pp = await A.ctx.newPage();
  await pp.goto(A.url('popup.html'));
  await pp.waitForSelector('.foot');
  await pp.setViewportSize({ width: 360, height: 520 });
  await pp.screenshot({ path: path.join(OUT, '5-popup.png') });

  // ---------------- light theme + folder overlay screenshot ----------------
  await pa.evaluate(() => chrome.storage.local.get('state').then(({ state }) => { state.settings.theme = 'light'; state.settings._ts.theme = Date.now(); state.settings.bgType = 'gradient'; state.settings.bgGradient = 'linear-gradient(135deg,#e0eafc,#cfdef3)'; state.settings._ts.bgType = state.settings._ts.bgGradient = Date.now(); state.settings.showClock = true; state.settings._ts.showClock = Date.now(); return chrome.storage.local.set({ state }); }));
  const folder = live(await state(pa)).dials.find(d => d.type === 'folder');
  await pa.goto('about:blank');
  await pa.goto(A.url('newtab.html#g=' + folder.groupId));
  await pa.waitForSelector('#grid .dial');
  await pa.waitForTimeout(800);
  await pa.screenshot({ path: path.join(OUT, '6-light.png') });
  await pa.click(`.dial[data-id="${folder.id}"]`);
  await pa.waitForSelector('.folder-view .dial');
  await pa.screenshot({ path: path.join(OUT, '7-folder.png') });
  await pa.keyboard.press('Escape');
  await pa.click(`.dial[data-id="${alpha.id}"]`, { button: 'right' });
  await pa.screenshot({ path: path.join(OUT, '8-context-menu.png') });

  const errors = [];
  console.log('\nALL E2E CHECKS PASSED');
} catch (e) {
  console.error('\nE2E FAILED:', e); for (const p of [...(A?.ctx.pages()||[]), ...(B?.ctx.pages()||[])]) await p.screenshot({ path: path.join(OUT, 'fail-' + Math.random().toString(36).slice(2,6) + '.png') }).catch(()=>{});
  process.exitCode = 1;
} finally {
  await A?.ctx.close(); await B?.ctx.close();
  dav.kill(); site.close();
}
