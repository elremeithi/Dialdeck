import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyState, newGroup, newDial, patch, merge, sameData, deleteDial, dialsOf, moveDial, restoreFrom, groupsSorted, setSettings, settingsOf } from '../extension/lib/model.js';
import { WebDAV, parseMultistatus } from '../extension/lib/webdav.js';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const clone = x => JSON.parse(JSON.stringify(x));

test('concurrent edits to different fields both survive', () => {
  const a = emptyState();
  const g = newGroup(a, 'Home');
  const d = newDial(a, { groupId: g.id, url: 'https://a.com', title: 'A' });
  const b = clone(a);
  patch(a.dials[d.id], { title: 'Renamed on laptop' }, Date.now() + 10);
  patch(b.dials[d.id], { order: 99999 }, Date.now() + 20);
  const m1 = merge(a, b), m2 = merge(b, a);
  assert.equal(m1.dials[d.id].title, 'Renamed on laptop');
  assert.equal(m1.dials[d.id].order, 99999);
  assert.ok(sameData(m1, m2), 'merge is commutative');
});

test('newest write wins on the same field; tombstones propagate', () => {
  const a = emptyState();
  const g = newGroup(a, 'Home');
  const d = newDial(a, { groupId: g.id, url: 'https://a.com' });
  const b = clone(a);
  patch(a.dials[d.id], { title: 'old' }, Date.now() + 5);
  patch(b.dials[d.id], { title: 'new' }, Date.now() + 50);
  assert.equal(merge(a, b).dials[d.id].title, 'new');
  deleteDial(b, d.id, Date.now() + 100);
  const m = merge(a, b);
  assert.equal(dialsOf(m, g.id).length, 0);
});

test('merge is idempotent and converges with 3 replicas', () => {
  const a = emptyState();
  const g = newGroup(a, 'G');
  for (let i = 0; i < 5; i++) newDial(a, { groupId: g.id, url: `https://s${i}.com` });
  const b = clone(a), c = clone(a);
  newDial(b, { groupId: g.id, url: 'https://b.com' });
  newDial(c, { groupId: g.id, url: 'https://c.com' });
  setSettings(c, { columns: 6 });
  const x = merge(merge(a, b), c), y = merge(c, merge(b, a));
  assert.ok(sameData(x, y));
  assert.ok(sameData(merge(x, x), x));
  assert.equal(dialsOf(x, g.id).length, 7);
  assert.equal(settingsOf(x).columns, 6);
});

test('ordering: insert at index and move between groups/folders', () => {
  const s = emptyState();
  const g1 = newGroup(s, 'One'), g2 = newGroup(s, 'Two');
  const ids = ['a', 'b', 'c', 'd'].map(n => newDial(s, { groupId: g1.id, url: `https://${n}.com`, title: n }).id);
  moveDial(s, ids[3], { groupId: g1.id, parentId: null, index: 0 });
  assert.deepEqual(dialsOf(s, g1.id).map(d => d.title), ['d', 'a', 'b', 'c']);
  moveDial(s, ids[0], { groupId: g1.id, parentId: null, index: 2 });
  assert.deepEqual(dialsOf(s, g1.id).map(d => d.title), ['d', 'b', 'a', 'c']);
  const f = newDial(s, { groupId: g1.id, type: 'folder', title: 'F' });
  moveDial(s, ids[1], { groupId: g1.id, parentId: f.id });
  assert.deepEqual(dialsOf(s, g1.id, f.id).map(d => d.title), ['b']);
  moveDial(s, f.id, { groupId: g2.id, parentId: null });
  assert.equal(s.dials[ids[1]].groupId, g2.id, 'folder children follow the folder');
  assert.deepEqual(groupsSorted(s).map(g => g.title), ['One', 'Two']);
  // many inserts at the same spot never collide
  for (let i = 0; i < 80; i++) moveDial(s, ids[2], { groupId: g1.id, parentId: null, index: 1 }), moveDial(s, ids[3], { groupId: g1.id, parentId: null, index: 1 });
  const orders = dialsOf(s, g1.id).map(d => d.order);
  assert.equal(new Set(orders).size, orders.length);
});

test('restoreFrom wins over a stale replica', () => {
  const a = emptyState();
  const g = newGroup(a, 'G');
  newDial(a, { groupId: g.id, url: 'https://keep.com' });
  const snap = clone(a);
  const extra = newDial(a, { groupId: g.id, url: 'https://later.com' });
  const stale = clone(a);
  const restored = restoreFrom(a, snap, Date.now() + 1000);
  const m = merge(stale, restored);
  assert.equal(dialsOf(m, g.id).length, 1);
  assert.ok(m.dials[extra.id].deleted);
});

test('multistatus parser handles Nextcloud-style XML', () => {
  const xml = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns"><d:response><d:href>/remote.php/dav/files/al%20ice/DialDeck/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype><d:getetag>&quot;65a&quot;</d:getetag></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat><d:propstat><d:prop><d:getcontentlength/></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat></d:response><d:response><d:href>/remote.php/dav/files/al%20ice/DialDeck/data.json</d:href><d:propstat><d:prop><d:resourcetype/><d:getcontentlength>42</d:getcontentlength><d:getetag>"abc"</d:getetag></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`;
  const r = parseMultistatus(xml, 'https://x/remote.php/dav/files/al%20ice/');
  assert.equal(r.length, 2);
  assert.equal(r[0].isDir, true);
  assert.equal(r[0].path, '/remote.php/dav/files/al ice/DialDeck/');
  assert.equal(r[1].name, 'data.json');
  assert.equal(r[1].etag, 'abc');
  assert.equal(r[1].size, 42);
});

test('WebDAV client against dev server: mkcol, put, If-Match conflict', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dav-'));
  const srv = spawn(process.execPath, [new URL('../tools/dev-webdav.mjs', import.meta.url).pathname, '8799', dir]);
  await new Promise(r => srv.stdout.once('data', r));
  try {
    const dav = new WebDAV({ url: 'http://localhost:8799/remote.php/dav/files/test/', username: 'test', password: 'test' });
    await dav.ensureDir('DialDeck/images');
    const w1 = await dav.put('DialDeck/data.json', '{"v":1}', { ifNoneMatch: '*' });
    assert.equal(w1.status, 201);
    assert.ok(w1.etag);
    assert.equal((await dav.put('DialDeck/data.json', 'x', { ifNoneMatch: '*' })).status, 412);
    const g = await dav.get('DialDeck/data.json', 'text');
    assert.equal(g.body, '{"v":1}');
    const w2 = await dav.put('DialDeck/data.json', '{"v":2}', { ifMatch: g.etag });
    assert.equal(w2.status, 204);
    assert.equal((await dav.put('DialDeck/data.json', '{"v":3}', { ifMatch: g.etag })).status, 412, 'stale ETag rejected');
    const list = await dav.list('DialDeck');
    assert.deepEqual(list.map(e => e.name).sort(), ['data.json', 'images']);
    assert.equal((await dav.stat('DialDeck/data.json')).etag, w2.etag);
    const bad = new WebDAV({ url: 'http://localhost:8799/remote.php/dav/files/test/', username: 'test', password: 'nope' });
    await assert.rejects(bad.stat(''), /401/);
  } finally { srv.kill(); }
});

test('normalizeUrl handles homelab and public addresses', async () => {
  const { normalizeUrl } = await import('../extension/lib/util.js');
  assert.equal(normalizeUrl('localhost:8800/alpha'), 'http://localhost:8800/alpha');
  assert.equal(normalizeUrl('unraid.local:8080'), 'http://unraid.local:8080/');
  assert.equal(normalizeUrl('192.168.1.10:8096/web'), 'http://192.168.1.10:8096/web');
  assert.equal(normalizeUrl('tower'), 'http://tower/');
  assert.equal(normalizeUrl('github.com/foo'), 'https://github.com/foo');
  assert.equal(normalizeUrl('cloud.example.com:8443'), 'https://cloud.example.com:8443/');
  assert.equal(normalizeUrl('http://x.org'), 'http://x.org/');
  assert.equal(normalizeUrl('chrome://settings'), 'chrome://settings');
  assert.equal(normalizeUrl('javascript:alert(1)'), '');
});

test('Group Speed Dial backup format is parsed exactly', async () => {
  const { parseGroupSpeedDial, isGroupSpeedDial } = await import('../extension/ui/io.js');
  const gsd = {
    dataVersion: 7, version: '10.0', options: {}, metadata: { tags: [], folders: [] }, ___thumbnails: [],
    groups: [
      { id: 2, name: 'Home', rows: 4, cols: 8, archived: false, options: {}, dials: [
        { created: 1, size: 0, type: 4, providers: [{ type: 'GOOGLE' }], thumbnail: {}, visual: {} }, // search widget
        { type: 0, name: 'Mail', url: 'https://mail.example.com', created: 2 },
        {},                                                                                         // empty slot
        { type: 0, name: '', url: 'nas.local:5000', created: 3 },
      ] },
      { id: 3, name: 'Home', cols: 6, archived: true, dials: [{ type: 0, name: 'Dup', url: 'https://dup.example.com' }] },
      { id: 4, name: 'Empty', cols: 5, dials: [{}] },
    ],
  };
  assert.ok(isGroupSpeedDial(gsd));
  assert.ok(!isGroupSpeedDial({ groups: [{ dials: [] }] }), 'needs GSD markers');
  const g = parseGroupSpeedDial(gsd);
  assert.equal(g.length, 3, 'same-named groups stay separate');
  assert.deepEqual(g[0].dials.map(d => d.title), ['Mail', '']);
  assert.deepEqual(g[0].dials.map(d => d.pos), [0, 1]);
  assert.equal(g[0].layout.columns, 8);
  assert.equal(g[1].title, 'Home (archived)');
  assert.equal(g[2].dials.length, 0);
});

test('per-tab layout overrides fall back to global settings', async () => {
  const { effectiveLayout, compactLayout } = await import('../extension/lib/model.js');
  const st = settingsOf(emptyState());
  assert.equal(effectiveLayout(st, null).mode, 'list');
  assert.equal(effectiveLayout(st, { layout: { mode: 'grid' } }).mode, 'grid');
  const e = effectiveLayout({ ...st, listSpan: 2, listHeight: 52 }, { layout: { mode: 'list', listSpan: 3 } });
  assert.equal(e.listSpan, 3);
  assert.equal(e.listHeight, 52, 'unset keys come from global settings');
  assert.equal(effectiveLayout({ ...st, dialLayout: 'grid' }, { layout: { columns: 8 } }).mode, 'grid', 'no mode = global default');
  assert.equal(compactLayout({ mode: undefined }), null);
  assert.deepEqual(compactLayout({ mode: 'list', columns: undefined, listSpan: 3 }), { mode: 'list', listSpan: 3 });
});

test('sync v2: bundle and image pack formats', async () => {
  const { encodeBundle, decodeBundle, buildPack, parsePack } = await import('../extension/lib/sync.js');
  const { newKeyInfo } = await import('../extension/lib/crypto.js');
  const s = emptyState();
  const g = newGroup(s, 'Home');
  newDial(s, { groupId: g.id, url: 'https://secret-site.example/path', title: 'Secret' });
  const bundle = { format: 'dialdeck-bundle', v: 2, data: s, index: { abc123: 'pack1' } };
  // plaintext mode: gzip'd (not readable as text), round-trips
  const plain = new Uint8Array(await encodeBundle(bundle, null));
  assert.equal(plain[0], 0x1f); assert.equal(plain[1], 0x8b);
  assert.deepEqual((await decodeBundle(plain.buffer, null)).index, { abc123: 'pack1' });
  // encrypted: no trace of URLs, titles or image hashes in the bytes on the server
  const { key } = await newKeyInfo('pass phrase');
  const sealed = new Uint8Array(await encodeBundle(bundle, key));
  const asText = Buffer.from(sealed).toString('latin1');
  for (const secret of ['secret-site', 'Secret', 'abc123', 'pack1', 'dialdeck-bundle']) assert.ok(!asText.includes(secret), 'leaks ' + secret);
  assert.equal((await decodeBundle(sealed.buffer, key)).data.dials[Object.keys(s.dials)[0]].url, 'https://secret-site.example/path');
  await assert.rejects(decodeBundle(new TextEncoder().encode('{"groups":{}}').buffer, null), /not DialDeck data/);
  // packs: many images in one file, byte-exact round trip
  const imgs = [1, 2, 3].map(i => ({ h: 'h' + i, type: 'image/png', bytes: new Uint8Array(1000 * i).fill(i) }));
  const back = parsePack(buildPack(imgs).buffer);
  assert.deepEqual(back.map(e => [e.h, e.type, e.bytes.length, e.bytes[0]]), [['h1', 'image/png', 1000, 1], ['h2', 'image/png', 2000, 2], ['h3', 'image/png', 3000, 3]]);
});
