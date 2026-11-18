// Edge-case HTTP server for MiniHttpTest: chunked bodies, cross-host redirects, 1xx responses.
import http from 'node:http';
import net from 'node:net';
const port = +process.argv[2];
http.createServer((req, res) => {
  if (req.url === '/chunked') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.write('hello '); res.write('chunked '); return res.end('world'); }
  // "different host": 127.0.0.1 vs localhost
  if (req.url === '/redir') { res.writeHead(302, { Location: `http://127.0.0.1:${port}/final` }); return res.end(); }
  if (req.url === '/final') { res.writeHead(200, { 'Content-Length': req.headers.authorization ? 10 : 12 }); return res.end(req.headers.authorization ? 'final:auth' : 'final:noauth'); }
  res.writeHead(404); res.end();
}).on('connection', () => {}).listen(port);
// raw socket endpoint for an interim 100 response
net.createServer(s => s.once('data', () => s.end('HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 9\r\n\r\nafter-100'))).listen(port + 1);
