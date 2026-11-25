// Migration test: a server in the v1 layout (data.json + images/<sha256>, encrypted, as written by
// DialDeck <= 1.5) is synced by the current extension. Expect: data and images preserved, v1 files
// deleted, a stub data.json that makes old clients stop, and no leaks left on the server.
//   node build.mjs && NODE_PATH=$(npm root -g) node test/migration.mjs
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { emptyState, newGroup, newDial, syncView } from '../extension/lib/model.js';
import { newKeyInfo, encrypt } from '../extension/lib/crypto.js';
const { chromium } = createRequire(import.meta.url)('playwright');

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const EXT = path.join(ROOT, 'dist/chrome');
const log = (...a) => console.log('•', ...a);
const assert = (c, m) => { if (!c) throw new Error('ASSERT: ' + m); log('ok -', m); };
const PASS = 'old server passphrase';

// ---- build a v1 server folder exactly as DialDeck <= 1.5 wrote it ----
const davDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-mig-'));
const F = path.join(davDir, 'DialDeck');
fs.mkdirSync(path.join(F, 'images'), { recursive: true });
fs.mkdirSync(path.join(F, 'snapshots'));
const { info, key } = await newKeyInfo(PASS);
fs.writeFileSync(path.join(F, 'keyinfo.json'), JSON.stringify(info));
const png = fs.readFileSync(path.join(ROOT, 'extension/icons/icon-48.png'));
const hash = createHash('sha256').update(png).digest('hex');
fs.writeFileSync(path.join(F, 'images', hash), Buffer.from(await encrypt(key, png)));
const s = emptyState();
const g = newGroup(s, 'Migrated group');
for (let i = 0; i < 5; i++) newDial(s, { groupId: g.id, url: `https://private-site-${i}.example/`, title: `Private ${i}`, thumb: { mode: 'logo', image: hash, bg: '#fff', fit: 'contain', at: 1 } });
const v1 = Buffer.from(await encrypt(key, JSON.stringify(syncView(s))));
fs.writeFileSync(path.join(F, 'data.json'), v1);
fs.writeFileSync(path.join(F, 'snapshots', 'data-2026-11-01.json'), v1);

const dav = spawn(process.execPath, [path.join(ROOT, 'tools/dev-webdav.mjs'), '8769', davDir]);
await new Promise(r => dav.stdout.once('data', r));
let ctx;
try {
  ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'dd-migp-')), { headless: true, channel: 'chromium', args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] });
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const id = sw.url().split('/')[2];
  const p = await ctx.newPage();
  await p.goto(`chrome-extension://${id}/newtab.html`);
  await p.waitForSelector('#grid .dial');
  await p.evaluate(pass => chrome.storage.local.set({ syncConfig: { enabled: true, url: 'http://localhost:8769/remote.php/dav/files/test/', username: 'test', password: 'test', folder: 'DialDeck', encrypt: true, passphrase: pass, intervalMin: 10, syncImages: true, snapshotsKeep: 30 } }), PASS);
  const r = await p.evaluate(() => chrome.runtime.sendMessage({ cmd: 'syncConfigChanged' }));
  assert(r.ok && r.result.migrated, 'first sync migrated the v1 server: ' + JSON.stringify(r.result || r.error));
  const st = await p.evaluate(() => chrome.storage.local.get('state').then(x => x.state));
  const dials = Object.values(st.dials).filter(d => !d.deleted);
  assert(dials.length === 5 && dials.every(d => d.url.startsWith('https://private-site-')), 'all 5 dials came across (sample dials dropped)');
  const hasImg = await p.evaluate(h => new Promise(res => { const q = indexedDB.open('dialdeck', 1); q.onsuccess = () => { const t = q.result.transaction('images').objectStore('images').getKey(h); t.onsuccess = () => res(t.result !== undefined); }; }), hash);
  assert(hasImg, 'images were read from the old images/ folder and decrypted');

  const files = fs.readdirSync(F).sort();
  assert(!files.includes('images'), 'old hash-named images/ folder deleted: ' + files.join(', '));
  assert(files.includes('dialdeck.bundle') && files.includes('packs'), 'new bundle + packs written');
  const stub = JSON.parse(fs.readFileSync(path.join(F, 'data.json'), 'utf8'));
  assert(stub.format === 'dialdeck-moved' && !stub.groups, 'data.json replaced by a stub without data (old clients stop with an error instead of writing)');
  const snaps = fs.readdirSync(path.join(F, 'snapshots'));
  assert(!snaps.some(n => n.startsWith('data-')) && snaps.some(n => n.endsWith('.bundle')), 'old snapshots replaced by an encrypted bundle snapshot: ' + snaps.join(', '));

  const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
  const leaks = walk(F).filter(f => { const b = fs.readFileSync(f).toString('latin1'); return f.includes(hash) || b.includes(hash) || b.includes('private-site') || b.includes('Private 1'); });
  assert(leaks.length === 0, 'nothing on the server reveals URLs, titles or image hashes after migration' + (leaks.length ? ': ' + leaks.join(', ') : ''));

  const again = await p.evaluate(() => chrome.runtime.sendMessage({ cmd: 'sync', force: true }));
  assert(again.ok && again.result.pushed === false && again.result.up === 0, 'a second sync with no changes uploads nothing: ' + JSON.stringify(again.result));

  // "Re-pack server images" replaces packs and deletes the old ones
  const before = fs.readdirSync(path.join(F, 'packs'));
  const rp = await p.evaluate(() => chrome.runtime.sendMessage({ cmd: 'cleanupServer' }));
  const after = fs.readdirSync(path.join(F, 'packs'));
  assert(rp.ok && after.length === 1 && !after.some(n => before.includes(n)), `re-pack wrote a new pack and deleted ${rp.result.removed} old one(s)`);

  // ---- sync without encryption, then turn encryption on: plaintext must not survive on the server ----
  const P2 = path.join(davDir, 'Plain');
  const cfg2 = { enabled: true, url: 'http://localhost:8769/remote.php/dav/files/test/', username: 'test', password: 'test', folder: 'Plain', encrypt: false, passphrase: '', intervalMin: 10, syncImages: true, snapshotsKeep: 30 };
  await p.evaluate(c => chrome.storage.local.set({ syncConfig: c }), cfg2);
  assert((await p.evaluate(() => chrome.runtime.sendMessage({ cmd: 'sync', force: true }))).ok, 'unencrypted sync to a second folder');
  const plainPacks = fs.readdirSync(path.join(P2, 'packs'));
  assert(fs.readFileSync(path.join(P2, 'packs', plainPacks[0])).includes(png.subarray(1, 4)), 'without encryption the pack holds raw images (as expected)');
  fs.mkdirSync(path.join(P2, 'snapshots'), { recursive: true });
  fs.copyFileSync(path.join(P2, 'dialdeck.bundle'), path.join(P2, 'snapshots', '2026-11-01.bundle')); // an older unencrypted snapshot
  await p.evaluate(c => chrome.storage.local.set({ syncConfig: { ...c, encrypt: true, passphrase: 'now encrypted' } }), cfg2);
  const r2 = await p.evaluate(() => chrome.runtime.sendMessage({ cmd: 'syncConfigChanged' }));
  assert(r2.ok, 'sync after turning encryption on: ' + JSON.stringify(r2.result || r2.error));
  const encPacks = fs.readdirSync(path.join(P2, 'packs'));
  assert(!encPacks.some(n => plainPacks.includes(n)) && encPacks.every(n => fs.readFileSync(path.join(P2, 'packs', n)).subarray(0, 4).toString() === 'DDE1'), 'old plaintext packs deleted, images re-packed encrypted');
  assert(fs.readFileSync(path.join(P2, 'dialdeck.bundle')).subarray(0, 4).toString() === 'DDE1', 'bundle re-written encrypted');
  const plainLeft = walk(P2).filter(f => !f.endsWith('keyinfo.json') && fs.readFileSync(f).subarray(0, 4).toString() !== 'DDE1');
  assert(plainLeft.length === 0 && r2.result.snapshotsEncrypted === 1, `no unencrypted file left on the server, snapshots included (${r2.result.snapshotsEncrypted} older snapshot re-encrypted)` + (plainLeft.length ? ': ' + plainLeft.join(', ') : ''));

  console.log('\nALL MIGRATION CHECKS PASSED');
} catch (e) {
  console.error('\nMIGRATION TEST FAILED:', e);
  process.exitCode = 1;
} finally {
  await ctx?.close();
  dav.kill();
}
