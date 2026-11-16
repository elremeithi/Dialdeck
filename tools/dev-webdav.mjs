#!/usr/bin/env node
// Tiny WebDAV server for local testing (behaves like Nextcloud for what DialDeck needs:
// Basic auth, PROPFIND, GET/PUT with strong ETags + If-Match/If-None-Match, MKCOL, DELETE).
//   node tools/dev-webdav.mjs [port] [dataDir]     user/pass: test/test
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const port = +(process.argv[2] || 8765);
const root = path.resolve(process.argv[3] || './.dav-data');
const USER = process.env.DAV_USER || 'test', PASS = process.env.DAV_PASS || 'test';
const PREFIX = '/remote.php/dav/files/' + USER; // mimic Nextcloud URL layout
fs.mkdirSync(root, { recursive: true });

const etagOf = buf => crypto.createHash('md5').update(buf).digest('hex');
const xmlEsc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

function entry(href, p) {
  const st = fs.statSync(p);
  const dir = st.isDirectory();
  const etag = dir ? etagOf(String(st.mtimeMs)) : etagOf(fs.readFileSync(p));
  return `<d:response><d:href>${xmlEsc(href)}</d:href><d:propstat><d:prop>` +
    `<d:getlastmodified>${st.mtime.toUTCString()}</d:getlastmodified>` +
    (dir ? '<d:resourcetype><d:collection/></d:resourcetype>' : `<d:resourcetype/><d:getcontentlength>${st.size}</d:getcontentlength>`) +
    `<d:getetag>&quot;${etag}&quot;</d:getetag></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const auth = req.headers.authorization || '';
    if (auth !== 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64')) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="dav"' }); return res.end();
    }
    if (req.headers.cookie) { res.writeHead(401); return res.end('CSRF check failed'); } // like Nextcloud
    let url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (!url.startsWith(PREFIX)) { res.writeHead(404); return res.end(); }
    const rel = url.slice(PREFIX.length) || '/';
    const p = path.join(root, rel);
    if (!p.startsWith(root)) { res.writeHead(403); return res.end(); }
    const exists = fs.existsSync(p);
    const log = code => console.log(req.method, rel, code, req.headers['if-match'] || req.headers['if-none-match'] || '');
    switch (req.method) {
      case 'PROPFIND': {
        if (!exists) { log(404); res.writeHead(404); return res.end(); }
        const depth = req.headers.depth ?? '1';
        let out = entry(PREFIX + rel, p);
        if (fs.statSync(p).isDirectory() && depth !== '0') {
          for (const n of fs.readdirSync(p)) out += entry(path.posix.join(PREFIX + rel, n) + (fs.statSync(path.join(p, n)).isDirectory() ? '/' : ''), path.join(p, n));
        }
        log(207);
        res.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8' });
        return res.end(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${out}</d:multistatus>`);
      }
      case 'GET': case 'HEAD': {
        if (!exists || fs.statSync(p).isDirectory()) { log(404); res.writeHead(404); return res.end(); }
        const buf = fs.readFileSync(p);
        log(200);
        res.writeHead(200, { ETag: `"${etagOf(buf)}"`, 'Content-Length': buf.length });
        return res.end(req.method === 'GET' ? buf : undefined);
      }
      case 'PUT': {
        const im = req.headers['if-match'], inm = req.headers['if-none-match'];
        if (inm === '*' && exists) { log(412); res.writeHead(412); return res.end(); }
        if (im && (!exists || `"${etagOf(fs.readFileSync(p))}"` !== im)) { log(412); res.writeHead(412); return res.end(); }
        if (!fs.existsSync(path.dirname(p))) { log(409); res.writeHead(409); return res.end(); }
        fs.writeFileSync(p, body);
        log(exists ? 204 : 201);
        res.writeHead(exists ? 204 : 201, { ETag: `"${etagOf(body)}"` });
        return res.end();
      }
      case 'MKCOL': {
        if (exists) { log(405); res.writeHead(405); return res.end(); }
        if (!fs.existsSync(path.dirname(p.replace(/\/$/, '')))) { log(409); res.writeHead(409); return res.end(); }
        fs.mkdirSync(p); log(201); res.writeHead(201); return res.end();
      }
      case 'DELETE': {
        if (!exists) { log(404); res.writeHead(404); return res.end(); }
        fs.rmSync(p, { recursive: true }); log(204); res.writeHead(204); return res.end();
      }
      case 'OPTIONS': res.writeHead(200, { DAV: '1, 2', Allow: 'OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, MKCOL' }); return res.end();
      default: res.writeHead(405); return res.end();
    }
  });
});
server.listen(port, () => console.log(`WebDAV test server: http://localhost:${port}${PREFIX}/  (user ${USER} / pass ${PASS}, data in ${root})`));
