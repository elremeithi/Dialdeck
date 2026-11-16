// Minimal WebDAV client tuned for Nextcloud / ownCloud / Apache / nginx / rclone.
// Uses no cookies (credentials: 'omit') -- important for Nextcloud: if the browser has a
// logged-in Nextcloud session cookie, sending it triggers "CSRF check failed".

export class DavError extends Error {
  constructor(msg, status) { super(msg); this.status = status; }
}

export class WebDAV {
  constructor({ url, username, password }) {
    if (!url) throw new DavError('No WebDAV URL configured', 0);
    this.base = url.endsWith('/') ? url : url + '/';
    this.auth = username || password ? 'Basic ' + btoa(unescape(encodeURIComponent(`${username}:${password}`))) : null;
  }

  url(path = '') {
    const clean = String(path).split('/').filter(Boolean).map(encodeURIComponent).join('/');
    return new URL(clean, this.base).href + (path.endsWith('/') && clean ? '/' : '');
  }

  async req(method, path, { body, headers = {}, timeout = 30000 } = {}) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeout);
    const h = { ...headers };
    if (this.auth) h.Authorization = this.auth;
    try {
      return await fetch(this.url(path), { method, body, headers: h, credentials: 'omit', cache: 'no-store', redirect: 'follow', signal: ctl.signal });
    } catch (e) {
      if (e.name === 'AbortError') throw new DavError(`${method} ${path}: timed out`, 0);
      throw new DavError(`${method} ${path}: network error (${e.message}). Check the URL, HTTPS certificate and that the extension has site access.`, 0);
    } finally { clearTimeout(t); }
  }

  check(r, what, ok = [200, 201, 204, 207]) {
    if (ok.includes(r.status)) return r;
    const hint = r.status === 401 ? ' — wrong username/app password' : r.status === 403 ? ' — forbidden' : r.status === 404 ? ' — path not found (check the WebDAV URL)' : r.status === 405 ? ' — method not allowed (is this a WebDAV URL?)' : '';
    throw new DavError(`${what}: HTTP ${r.status}${hint}`, r.status);
  }

  async propfind(path, depth = 1) {
    const body = '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:getetag/><d:getcontentlength/><d:getlastmodified/><d:resourcetype/></d:prop></d:propfind>';
    const r = await this.req('PROPFIND', path, { body, headers: { Depth: String(depth), 'Content-Type': 'application/xml; charset=utf-8' } });
    if (r.status === 404) return null;
    this.check(r, 'PROPFIND ' + path, [207, 200]);
    return parseMultistatus(await r.text(), this.base);
  }

  async stat(path) {
    const list = await this.propfind(path, 0);
    return list?.[0] || null;
  }

  async list(path) {
    const list = await this.propfind(path.endsWith('/') ? path : path + '/', 1);
    if (!list) return null;
    const self = this.url(path.endsWith('/') ? path : path + '/');
    const selfPath = decodeURIComponent(new URL(self).pathname).replace(/\/$/, '');
    return list.filter(e => e.path.replace(/\/$/, '') !== selfPath);
  }

  async get(path, as = 'arrayBuffer') {
    const r = await this.req('GET', path);
    if (r.status === 404) return { status: 404 };
    this.check(r, 'GET ' + path, [200]);
    return { status: 200, etag: cleanEtag(r.headers.get('ETag') || r.headers.get('OC-ETag')), body: await r[as]() };
  }

  async put(path, body, { ifMatch, ifNoneMatch, contentType = 'application/octet-stream' } = {}) {
    const headers = { 'Content-Type': contentType };
    if (ifMatch) headers['If-Match'] = `"${ifMatch}"`;
    if (ifNoneMatch) headers['If-None-Match'] = ifNoneMatch;
    const r = await this.req('PUT', path, { body, headers, timeout: 60000 });
    if (r.status === 412) return { status: 412 };
    this.check(r, 'PUT ' + path, [200, 201, 204]);
    return { status: r.status, etag: cleanEtag(r.headers.get('ETag') || r.headers.get('OC-ETag')) };
  }

  async mkcol(path) {
    const r = await this.req('MKCOL', path.endsWith('/') ? path : path + '/');
    // 405 = already exists
    if ([201, 200, 405].includes(r.status)) return true;
    this.check(r, 'MKCOL ' + path, [201]);
  }

  async ensureDir(path) {
    const parts = path.split('/').filter(Boolean);
    let cur = '';
    for (const p of parts) {
      cur += p + '/';
      const st = await this.stat(cur).catch(() => null);
      if (!st) await this.mkcol(cur);
    }
  }

  async delete(path) {
    const r = await this.req('DELETE', path);
    if (r.status === 404) return false;
    this.check(r, 'DELETE ' + path, [200, 204]);
    return true;
  }
}

function cleanEtag(e) {
  return e ? e.replace(/^W\//, '').replace(/"/g, '') : null;
}

// Namespace-agnostic multistatus parser (works in service workers, which lack DOMParser).
export function parseMultistatus(xml, base) {
  const out = [];
  const tag = name => new RegExp(`<(?:[A-Za-z0-9_-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[A-Za-z0-9_-]+:)?${name}>`, 'i');
  const responses = xml.split(/<(?:[A-Za-z0-9_-]+:)?response(?:\s[^>]*)?>/i).slice(1);
  for (const chunk of responses) {
    const href = (chunk.match(tag('href')) || [])[1];
    if (!href) continue;
    // Only take props from a 200 propstat
    const propstats = chunk.split(/<(?:[A-Za-z0-9_-]+:)?propstat(?:\s[^>]*)?>/i).slice(1);
    let props = '';
    for (const ps of propstats) {
      const st = (ps.match(tag('status')) || [])[1] || '';
      if (/ 200 /.test(st) || !st) props += ps;
    }
    const decoded = decodeXml(href.trim());
    let pathname;
    try { pathname = decodeURIComponent(new URL(decoded, base).pathname); } catch { pathname = decoded; }
    const isDir = /<(?:[A-Za-z0-9_-]+:)?collection\s*\/?>/i.test(props);
    out.push({
      path: pathname,
      name: pathname.replace(/\/$/, '').split('/').pop(),
      isDir,
      etag: cleanEtag(decodeXml((props.match(tag('getetag')) || [])[1] || '')) || null,
      size: Number((props.match(tag('getcontentlength')) || [])[1] || 0),
      modified: Date.parse((props.match(tag('getlastmodified')) || [])[1] || '') || 0,
    });
  }
  return out;
}

function decodeXml(s) {
  return s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}
