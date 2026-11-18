package net.dialdeck.app;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SNIHostName;
import javax.net.ssl.SSLParameters;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;

/**
 * Small HTTP/1.1 client over plain sockets.
 *
 * Android's HttpURLConnection refuses WebDAV methods (PROPFIND, MKCOL, ...), so DialDeck's
 * sync traffic goes through this instead. It sends no cookies, follows redirects, handles
 * chunked and length-delimited bodies, and verifies TLS certificates and host names using the
 * platform trust store (which honours the app's network security config, so user-installed CAs
 * for a homelab server work too). Pure Java: no Android dependencies, unit-testable on a JVM.
 */
public final class MiniHttp {
    public static final class Response {
        public int status;
        public String statusText = "";
        public final Map<String, String> headers = new LinkedHashMap<>();
        public byte[] body = new byte[0];
        public String url;
    }

    private static final int MAX_BODY = 64 * 1024 * 1024;
    private static final int MAX_REDIRECTS = 6;
    public static int connectTimeoutMs = 15000;
    public static int readTimeoutMs = 60000;
    public static String userAgent = "DialDeck";
    private static final boolean ON_ANDROID = String.valueOf(System.getProperty("java.vendor")).contains("Android");

    private MiniHttp() {}

    public static Response request(String method, String url, Map<String, String> headers, byte[] body) throws IOException {
        String m = method.toUpperCase(Locale.ROOT);
        URI uri = URI.create(url);
        for (int hop = 0; ; hop++) {
            Response r = once(m, uri, headers, body);
            r.url = uri.toString();
            String loc = r.headers.get("location");
            boolean redirect = (r.status == 301 || r.status == 302 || r.status == 303 || r.status == 307 || r.status == 308) && loc != null;
            if (!redirect || hop >= MAX_REDIRECTS) return r;
            URI next = uri.resolve(loc);
            if (!next.getScheme().equalsIgnoreCase("http") && !next.getScheme().equalsIgnoreCase("https")) return r;
            if (r.status == 303 || ((r.status == 301 || r.status == 302) && !m.equals("GET") && !m.equals("HEAD") && !m.equals("PROPFIND"))) {
                m = "GET";
                body = null;
            }
            // never leak credentials to a different host on redirect
            if (!sameOrigin(uri, next) && headers != null && headers.containsKey("authorization")) {
                Map<String, String> h2 = new LinkedHashMap<>(headers);
                h2.remove("authorization");
                headers = h2;
            }
            uri = next;
        }
    }

    private static boolean sameOrigin(URI a, URI b) {
        return a.getScheme().equalsIgnoreCase(b.getScheme()) && a.getHost().equalsIgnoreCase(b.getHost()) && port(a) == port(b);
    }

    private static int port(URI u) {
        if (u.getPort() != -1) return u.getPort();
        return u.getScheme().equalsIgnoreCase("https") ? 443 : 80;
    }

    private static Response once(String method, URI uri, Map<String, String> headers, byte[] body) throws IOException {
        boolean tls = uri.getScheme().equalsIgnoreCase("https");
        if (!tls && !uri.getScheme().equalsIgnoreCase("http")) throw new IOException("Unsupported scheme: " + uri.getScheme());
        String host = uri.getHost();
        if (host == null) throw new IOException("Invalid URL: " + uri);
        int port = port(uri);
        Socket raw = new Socket();
        Socket s = raw;
        try {
            raw.connect(new InetSocketAddress(host, port), connectTimeoutMs);
            raw.setSoTimeout(readTimeoutMs);
            if (tls) {
                SSLSocket ssl = (SSLSocket) ((SSLSocketFactory) SSLSocketFactory.getDefault()).createSocket(raw, host, port, true);
                SSLParameters p = ssl.getSSLParameters();
                p.setEndpointIdentificationAlgorithm("HTTPS");
                if (!host.matches("^[0-9.]+$") && !host.contains(":")) p.setServerNames(Collections.singletonList(new SNIHostName(host)));
                ssl.setSSLParameters(p);
                ssl.startHandshake();
                // Belt and braces on Android (its default verifier is a real one; on a desktop JVM the
                // default verifier always says no, and endpoint identification above already checked).
                if (ON_ANDROID && !HttpsURLConnection.getDefaultHostnameVerifier().verify(host, ssl.getSession()))
                    throw new IOException("TLS certificate does not match host " + host);
                s = ssl;
            }
            String path = uri.getRawPath();
            if (path == null || path.isEmpty()) path = "/";
            if (uri.getRawQuery() != null) path += "?" + uri.getRawQuery();
            boolean defaultPort = uri.getPort() == -1 || (tls && port == 443) || (!tls && port == 80);
            String hostHeader = (host.contains(":") ? "[" + host + "]" : host) + (defaultPort ? "" : ":" + port);

            StringBuilder req = new StringBuilder();
            req.append(method).append(' ').append(path).append(" HTTP/1.1\r\n");
            req.append("Host: ").append(hostHeader).append("\r\n");
            req.append("Connection: close\r\n");
            boolean hasUa = false, hasAccept = false;
            if (headers != null) {
                for (Map.Entry<String, String> e : headers.entrySet()) {
                    String k = e.getKey().toLowerCase(Locale.ROOT);
                    if (k.equals("host") || k.equals("connection") || k.equals("content-length") || k.equals("accept-encoding") || k.equals("cookie")) continue;
                    if (k.indexOf('\r') >= 0 || k.indexOf('\n') >= 0 || e.getValue().indexOf('\r') >= 0 || e.getValue().indexOf('\n') >= 0) continue;
                    if (k.equals("user-agent")) hasUa = true;
                    if (k.equals("accept")) hasAccept = true;
                    req.append(e.getKey()).append(": ").append(e.getValue()).append("\r\n");
                }
            }
            if (!hasUa) req.append("User-Agent: ").append(userAgent).append("\r\n");
            if (!hasAccept) req.append("Accept: */*\r\n");
            if (body != null && (body.length > 0 || !method.equals("GET"))) req.append("Content-Length: ").append(body.length).append("\r\n");
            else if (method.equals("PUT") || method.equals("POST")) req.append("Content-Length: 0\r\n");
            req.append("\r\n");

            OutputStream out = s.getOutputStream();
            out.write(req.toString().getBytes(StandardCharsets.ISO_8859_1));
            if (body != null && body.length > 0) out.write(body);
            out.flush();

            InputStream in = new BufferedInputStream(s.getInputStream());
            Response r;
            do { // skip interim 1xx responses
                r = readHead(in);
            } while (r.status >= 100 && r.status < 200);
            boolean noBody = method.equals("HEAD") || r.status == 204 || r.status == 304;
            if (!noBody) r.body = readBody(in, r.headers);
            return r;
        } finally {
            try { s.close(); } catch (IOException ignored) { }
        }
    }

    private static Response readHead(InputStream in) throws IOException {
        Response r = new Response();
        String status = readLine(in);
        if (status == null) throw new IOException("Server closed the connection without a response");
        String[] parts = status.split(" ", 3);
        if (parts.length < 2 || !parts[0].startsWith("HTTP/")) throw new IOException("Malformed status line: " + status);
        r.status = Integer.parseInt(parts[1].trim());
        r.statusText = parts.length > 2 ? parts[2] : "";
        String line;
        List<String> setCookies = new ArrayList<>();
        while ((line = readLine(in)) != null && !line.isEmpty()) {
            int c = line.indexOf(':');
            if (c <= 0) continue;
            String k = line.substring(0, c).trim().toLowerCase(Locale.ROOT);
            String v = line.substring(c + 1).trim();
            if (k.equals("set-cookie")) { setCookies.add(v); continue; } // ignored on purpose
            String prev = r.headers.get(k);
            r.headers.put(k, prev == null ? v : prev + ", " + v);
        }
        return r;
    }

    private static byte[] readBody(InputStream in, Map<String, String> h) throws IOException {
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        String te = h.get("transfer-encoding");
        if (te != null && te.toLowerCase(Locale.ROOT).contains("chunked")) {
            while (true) {
                String sizeLine = readLine(in);
                if (sizeLine == null) break;
                int semi = sizeLine.indexOf(';');
                String hex = (semi >= 0 ? sizeLine.substring(0, semi) : sizeLine).trim();
                if (hex.isEmpty()) continue;
                int n = Integer.parseInt(hex, 16);
                if (n == 0) { // trailers
                    String t;
                    while ((t = readLine(in)) != null && !t.isEmpty()) { }
                    break;
                }
                copy(in, buf, n);
                readLine(in); // CRLF after chunk
            }
        } else if (h.containsKey("content-length")) {
            long n = Long.parseLong(h.get("content-length").split(",")[0].trim());
            if (n > MAX_BODY) throw new IOException("Response too large");
            copy(in, buf, (int) n);
        } else {
            byte[] b = new byte[16384];
            int k;
            while ((k = in.read(b)) != -1) {
                buf.write(b, 0, k);
                if (buf.size() > MAX_BODY) throw new IOException("Response too large");
            }
        }
        return buf.toByteArray();
    }

    private static void copy(InputStream in, ByteArrayOutputStream out, int n) throws IOException {
        if (out.size() + n > MAX_BODY) throw new IOException("Response too large");
        byte[] b = new byte[Math.min(Math.max(n, 1), 65536)];
        while (n > 0) {
            int k = in.read(b, 0, Math.min(b.length, n));
            if (k == -1) throw new IOException("Connection closed mid-body");
            out.write(b, 0, k);
            n -= k;
        }
    }

    private static String readLine(InputStream in) throws IOException {
        ByteArrayOutputStream b = new ByteArrayOutputStream(128);
        int c;
        boolean any = false;
        while ((c = in.read()) != -1) {
            any = true;
            if (c == '\n') break;
            if (c != '\r') b.write(c);
            if (b.size() > 65536) throw new IOException("Header line too long");
        }
        if (!any) return null;
        return b.toString(StandardCharsets.ISO_8859_1.name());
    }
}
