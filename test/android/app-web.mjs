// Tests the Android app's web layer: the exact assets packed into the APK (android/build/assets/www),
// run in Chromium with a phone viewport and a mock of the native DDAndroid bridge (HTTP is done by
// Node, like MiniHttp does on the phone). Syncs with a desktop Chromium running the extension.
//   android/build.sh && node build.mjs && NODE_PATH=$(npm root -g) node test/android/app-web.mjs
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const { chromium, devices } = createRequire(import.meta.url)('playwright');

const ROOT = path.resolve(new URL('../..', import.meta.url).pathname);
const WWW = path.join(ROOT, 'android/build/assets/www');
const EXT = path.join(ROOT, 'dist/chrome');
const OUT = process.env.SHOTS || path.join(ROOT, 'test/shots');
fs.mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log('•', ...a);
const assert = (c, m) => { if (!c) throw new Error('ASSERT: ' + m); log('ok -', m); };
const waitFor = async (fn, ms = 20000, what = 'condition') => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return; await new Promise(r => setTimeout(r, 250)); } throw new Error('timeout: ' + what); };
if (!fs.existsSync(path.join(WWW, 'android-shim.js'))) throw new Error('run android/build.sh first');

// --- servers: app assets, test websites, WebDAV ---
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json' };
const app = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.startsWith('/_favicon/')) { res.writeHead(404); return res.end(); } // native favicon fetch not mocked: letter badges
  const f = path.join(WWW, p === '/' ? 'newtab.html' : p);
  if (!f.startsWith(WWW) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': mime[path.extname(f)] || 'application/octet-stream' });
  res.end(fs.readFileSync(f));
}).listen(8830);
const icon = fs.readFileSync(path.join(ROOT, 'extension/icons/icon-128.png'));
const site = http.createServer((req, res) => {
  if (req.url.endsWith('.png')) { res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(icon); }
  const name = req.url.replace(/\W/g, '') || 'home';
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(`<!doctype html><title>Site ${name}</title><link rel="apple-touch-icon" href="/t.png"><body style="background:#284;color:#fff;font:40px sans-serif"><h1>${name}</h1>`);
}).listen(8805);
const davDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-adav-'));
const dav = spawn(process.execPath, [path.join(ROOT, 'tools/dev-webdav.mjs'), '8768', davDir]);
await new Promise(r => dav.stdout.once('data', r));
const DAV_URL = 'http://localhost:8768/remote.php/dav/files/test/';
const SYNC = { enabled: true, url: DAV_URL, username: 'test', password: 'test', folder: 'DialDeck', encrypt: true, passphrase: 'phone and desktop', intervalMin: 10, syncImages: true, snapshotsKeep: 30 };

let desk, phoneBrowser;
const calls = { open: [], save: [], shareDone: 0, setBrowser: [] };
try {
  // ---------------- desktop browser with the extension ----------------
  desk = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'dd-desk-')), { headless: true, channel: 'chromium', args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] });
  let [sw] = desk.serviceWorkers(); if (!sw) sw = await desk.waitForEvent('serviceworker');
  const eid = sw.url().split('/')[2];
  const dp = await desk.newPage();
  await dp.goto(`chrome-extension://${eid}/newtab.html`);
  await dp.waitForSelector('#grid .dial');
  const dstate = () => dp.evaluate(() => chrome.storage.local.get('state').then(r => r.state));
  const home = Object.values((await dstate()).groups).find(g => g.title === 'Home');
  for (const n of ['alpha', 'beta']) await dp.evaluate(([u, g]) => chrome.runtime.sendMessage({ cmd: 'addDial', url: u, groupId: g, mode: 'logo' }), [`http://localhost:8805/${n}`, home.id]);
  await waitFor(async () => Object.values((await dstate()).dials).filter(d => d.url.includes('8805') && d.thumb?.image).length === 2, 20000, 'desktop logos');
  await dp.evaluate(c => chrome.storage.local.set({ syncConfig: c }), SYNC);
  let r = await dp.evaluate(() => chrome.runtime.sendMessage({ cmd: 'syncConfigChanged' }));
  assert(r.ok, 'desktop extension synced to WebDAV (encrypted)');
  const deskLive = s => Object.values(s.dials).filter(d => !d.deleted);

  // ---------------- the phone: app web layer + mock native bridge ----------------
  phoneBrowser = await chromium.launch({ headless: true });
  const phone = await phoneBrowser.newContext({ ...devices['Pixel 7'] });
  const pp = await phone.newPage();
  pp.on('pageerror', e => console.log('PAGEERROR', e.message));
  pp.on('console', m => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && console.log('CONSOLE', m.text()));
  let shareQueue = null;
  await pp.exposeFunction('__mockHttp', async (id, method, url, headersJson, b64) => {
    let res;
    try {
      const f = await fetch(url, { method, headers: JSON.parse(headersJson || '{}'), body: b64 ? Buffer.from(b64, 'base64') : undefined, redirect: 'follow' });
      const headers = {}; f.headers.forEach((v, k) => { headers[k] = v; });
      res = { status: f.status, statusText: f.statusText, url: f.url, headers, body: Buffer.from(await f.arrayBuffer()).toString('base64') };
    } catch (e) { res = { error: e.message }; }
    pp.evaluate(([i, x]) => window.__ddHttpDone(i, x), [id, res]).catch(() => {});
  });
  await pp.exposeFunction('__mockOpen', u => { calls.open.push(u); });
  await pp.exposeFunction('__mockSave', (n, t, b) => { calls.save.push({ name: n, type: t, text: Buffer.from(b, 'base64').toString() }); });
  await pp.exposeFunction('__mockShareDone', () => { calls.shareDone++; });
  await pp.exposeFunction('__mockSetBrowser', p => { calls.setBrowser.push(p); });
  await pp.exposeFunction('__mockTakeShare', () => { const s = shareQueue; shareQueue = null; return s; });
  await pp.addInitScript(() => {
    // Synchronous parts of the bridge (Java returns values synchronously) are pre-filled here.
    let pendingShare = null;
    window.__setShare = s => { pendingShare = s; };
    window.DDAndroid = {
      http: (...a) => window.__mockHttp(...a),
      openUrl: u => window.__mockOpen(u),
      saveFile: (n, t, b) => window.__mockSave(n, t, b),
      shareDone: () => window.__mockShareDone(),
      setBrowser: p => window.__mockSetBrowser(p),
      listBrowsers: () => JSON.stringify([{ pkg: 'net.waterfox.android.release', label: 'Waterfox' }, { pkg: 'com.android.chrome', label: 'Chrome' }]),
      getBrowser: () => JSON.stringify({ pref: 'auto', active: 'net.waterfox.android.release' }),
      takeShare: () => { const s = pendingShare; pendingShare = null; return s; },
      version: () => '1.4.0',
      toast: () => {},
    };
  });
  await pp.goto('http://localhost:8830/newtab.html');
  await pp.waitForSelector('#grid .dial');
  await pp.waitForSelector('.modal-wrap:has-text("Welcome to DialDeck")');
  assert(await pp.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal overflow at phone width');
  assert(await pp.isVisible('.modal-wrap li:has-text("Share → DialDeck")'), 'first launch: welcome screen with Android instructions');
  assert(await pp.evaluate(() => window.ddBack()) === true && !(await pp.$('.modal-wrap')), 'back button closes the welcome dialog');
  assert(await pp.evaluate(() => window.ddBack()) === false, 'back button with nothing open lets Android leave the app');
  const pstate = () => pp.evaluate(() => chrome.storage.local.get('state').then(r => r.state));
  assert(await pp.evaluate(() => document.documentElement.dataset.theme === 'oled' && document.body.classList.contains('layout-list')), 'OLED theme + list layout');
  assert(!(await pp.isVisible('#btn-sidebar')), 'sidebar button hidden (no closed tabs/bookmarks on Android)');

  // ---------------- sync setup through the UI ----------------
  await pp.click('#btn-settings');
  await pp.click('#drawer .ptabs button:has-text("Sync")');
  await pp.click('#drawer label.switch:has-text("Enable WebDAV sync")');
  await pp.fill('#drawer input[placeholder^="https://cloud"]', DAV_URL);
  await pp.fill('#drawer input[autocomplete=username]', 'test');
  await pp.fill('#drawer input[autocomplete=current-password]', 'test');
  await pp.click('#drawer label.switch:has-text("End-to-end encryption")');
  await pp.fill('#drawer input[autocomplete=new-password]', SYNC.passphrase);
  await pp.click('#drawer button:has-text("Test connection")');
  await pp.waitForSelector('.toast:has-text("Connection OK")', { timeout: 15000 });
  assert(true, 'test connection through the native HTTP bridge (PROPFIND/MKCOL/PUT/DELETE)');
  await pp.click('#drawer button:has-text("Save & sync now")');
  await pp.waitForSelector('.toast:has-text("Synced")', { timeout: 30000 });
  const ds = await dstate(), ps = await pstate();
  const live = s => ({ g: Object.values(s.groups).filter(g => !g.deleted).map(g => g.title).sort().join(','), d: Object.values(s.dials).filter(d => !d.deleted).length });
  assert(JSON.stringify(live(ps)) === JSON.stringify(live(ds)), `phone has the desktop's groups and dials, no duplicate samples (${live(ps).g}; ${live(ps).d} dials)`);
  await waitFor(async () => (await pp.$$('#grid .dial.row .ico img[src^="blob:"]')).length >= 2, 15000, 'logos on phone');
  assert(true, 'encrypted logos downloaded, decrypted and shown');
  await pp.evaluate(() => window.ddBack()); // close settings
  await pp.waitForTimeout(300);
  await pp.screenshot({ path: path.join(OUT, 'android-1-home.png') });

  // ---------------- browser choice ----------------
  await pp.click('#btn-settings');
  await pp.click('#drawer .ptabs button:has-text("Behaviour")');
  const opts = await pp.$$eval('#drawer select >> nth=0 >> option', o => o.map(x => x.textContent));
  assert(opts[0].includes('Waterfox') && opts.includes('Chrome'), 'Settings → "Open dials with" lists installed browsers, Waterfox automatic: ' + opts.join(' | '));
  await pp.selectOption('#drawer select >> nth=0', 'com.android.chrome');
  await waitFor(async () => calls.setBrowser.includes('com.android.chrome'), 3000, 'setBrowser');
  await pp.selectOption('#drawer select >> nth=0', 'auto');
  await pp.screenshot({ path: path.join(OUT, 'android-2-settings.png') });
  await pp.evaluate(() => window.ddBack());

  // ---------------- tapping a dial / searching hands off to the browser ----------------
  const alpha = Object.values(ps.dials).find(d => d.url.endsWith('/alpha'));
  await pp.tap(`.dial.row[data-id="${alpha.id}"] .t`);
  await waitFor(async () => calls.open.includes(alpha.url), 3000, 'dial opened');
  assert(pp.url().startsWith('http://localhost:8830/'), 'tapping a dial opens it in the browser (Waterfox), the app stays put: ' + calls.open.at(-1));
  await pp.fill('#q', 'unraid nextcloud');
  await pp.press('#q', 'Enter');
  await waitFor(async () => calls.open.some(u => u.includes('q=unraid%20nextcloud')), 3000, 'search');
  assert(true, 'web search also opens in the browser: ' + calls.open.at(-1));
  await pp.evaluate(() => window.ddBack());

  // ---------------- Share → DialDeck from Waterfox ----------------
  await pp.evaluate(() => window.__setShare(JSON.stringify({ url: 'http://localhost:8805/gamma', title: 'Gamma from Waterfox' })));
  await pp.evaluate(() => window.ddCheckShare());
  await pp.waitForSelector('.modal-wrap:has-text("Add dial")');
  assert(await pp.inputValue('.modal input.inp >> nth=0') === 'http://localhost:8805/gamma' && await pp.inputValue('.modal input.inp >> nth=1') === 'Gamma from Waterfox', 'shared page pre-fills the add-dial dialog');
  await pp.click('.modal .seg button:has-text("Logo")');
  await pp.click('.modal footer .btn.primary');
  await waitFor(async () => calls.shareDone === 1, 3000, 'shareDone');
  assert(true, 'after adding, the app returns to the browser (shareDone)');
  await waitFor(async () => Object.values((await pstate()).dials).some(d => d.url.endsWith('/gamma') && d.thumb?.image), 15000, 'logo on phone');
  assert(true, 'logo for the shared page fetched on the phone via the native bridge');
  // a shared page with the default (screenshot) thumbnail: the desktop makes it after sync
  await pp.evaluate(() => { window.__setShare(JSON.stringify({ url: 'http://localhost:8805/delta', title: 'Delta' })); window.ddCheckShare(); });
  await pp.waitForSelector('.modal-wrap:has-text("Add dial")');
  await pp.click('.modal .seg button:has-text("Screenshot")');
  await pp.click('.modal footer .btn.primary');
  await waitFor(async () => Object.values((await pstate()).dials).some(d => d.url.endsWith('/delta')), 5000, 'delta added');
  r = await pp.evaluate(() => chrome.runtime.sendMessage({ cmd: 'sync', force: true }));
  assert(r?.ok, 'phone pushed its new dials');
  r = await dp.evaluate(() => chrome.runtime.sendMessage({ cmd: 'sync', force: true }));
  await waitFor(async () => deskLive(await dstate()).some(d => d.url.endsWith('/delta') && d.thumb?.image), 40000, 'desktop screenshot of phone dial');
  assert(true, 'desktop received the phone\'s dials and took the screenshot the phone can\'t');
  await dp.evaluate(() => chrome.runtime.sendMessage({ cmd: 'sync', force: true }));
  await pp.evaluate(() => chrome.runtime.sendMessage({ cmd: 'sync', force: true }));
  await waitFor(async () => Object.values((await pstate()).dials).some(d => d.url.endsWith('/delta') && d.thumb?.image), 15000, 'screenshot back on phone');
  assert(true, '…and that screenshot synced back to the phone');

  // ---------------- long-press menu: reorder without drag & drop ----------------
  const order = async () => pp.$$eval('#grid .dial.row[data-id]', e => e.map(x => x.dataset.id));
  const before = await order();
  assert(await pp.getAttribute(`.dial.row[data-id="${before[0]}"]`, 'draggable') === 'false', 'drag disabled on touch so long-press opens the menu');
  await pp.dispatchEvent(`.dial.row[data-id="${before[0]}"]`, 'contextmenu', { clientX: 100, clientY: 300 });
  const menuBox = await pp.$eval('#menu', m => m.getBoundingClientRect().toJSON());
  const vp = pp.viewportSize();
  assert(menuBox.bottom <= vp.height && menuBox.left >= 0 && menuBox.right <= vp.width, `long-press menu fits the phone screen as a bottom sheet (${Math.round(menuBox.top)}–${Math.round(menuBox.bottom)} of ${vp.height}px)`);
  assert(!(await pp.$('#menu button:has-text("private window")')), 'desktop-only open options hidden on Android');
  await pp.tap('#menu button:has-text("Move to group")');
  assert(await pp.isVisible('#menu .sub.open .ctx button:has-text("Work")'), 'tapping a submenu expands it inline');
  await pp.tap('#menu button:has-text("Move later")');
  await waitFor(async () => (await order())[1] === before[0], 5000, 'moved later');
  assert(true, 'long-press menu → "Move later" reorders');

  // ---------------- per-tab layout toggle works on the phone too ----------------
  await pp.tap('#btn-layout');
  await pp.waitForSelector('#grid .dial[data-id] .thumb');
  await pp.screenshot({ path: path.join(OUT, 'android-3-tiles.png') });
  await pp.tap('#btn-layout');
  await pp.waitForSelector('#grid .dial.row[data-id]');
  assert(true, 'toolbar List/Tiles toggle works on the phone');

  // ---------------- export backup goes through Android's save dialog ----------------
  await pp.click('#btn-settings');
  await pp.click('#drawer .ptabs button:has-text("Backup")');
  await pp.click('#drawer button:has-text("Export without images")');
  await waitFor(async () => calls.save.length === 1, 3000, 'saveFile');
  const saved = JSON.parse(calls.save[0].text);
  assert(calls.save[0].name.startsWith('dialdeck-backup-') && saved.format === 'dialdeck-backup', 'export hands the backup file to Android\'s save dialog');

  console.log('\nALL ANDROID WEB-LAYER CHECKS PASSED');
} catch (e) {
  console.error('\nANDROID TEST FAILED:', e);
  process.exitCode = 1;
} finally {
  await desk?.close(); await phoneBrowser?.close();
  dav.kill(); app.close(); site.close();
}
