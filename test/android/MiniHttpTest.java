import net.dialdeck.app.MiniHttp;
import java.nio.charset.StandardCharsets;
import java.util.*;

// JVM test for the APK's HTTP client: run by test/android/run-http-test.sh against tools/dev-webdav.mjs.
public class MiniHttpTest {
    static int fails = 0;
    static void check(boolean ok, String what) { System.out.println((ok ? "ok - " : "FAIL - ") + what); if (!ok) fails++; }
    static Map<String, String> auth(String extra) {
        Map<String, String> h = new LinkedHashMap<>();
        h.put("authorization", "Basic " + Base64.getEncoder().encodeToString("test:test".getBytes()));
        if (extra != null) { String[] kv = extra.split(": ", 2); h.put(kv[0], kv[1]); }
        return h;
    }
    public static void main(String[] a) throws Exception {
        String base = a[0], misc = a[1];
        MiniHttp.Response r = MiniHttp.request("PROPFIND", base, auth("depth: 0"), "<?xml version=\"1.0\"?><d:propfind xmlns:d=\"DAV:\"><d:prop><d:getetag/></d:prop></d:propfind>".getBytes());
        check(r.status == 207 && new String(r.body).contains("multistatus"), "PROPFIND (WebDAV method Android's HttpURLConnection rejects) -> " + r.status);
        r = MiniHttp.request("MKCOL", base + "jtest/", auth(null), new byte[0]);
        check(r.status == 201, "MKCOL -> " + r.status);
        r = MiniHttp.request("PUT", base + "jtest/a.json", auth("if-none-match: *"), "{\"v\":1}".getBytes());
        String etag = r.headers.get("etag");
        check(r.status == 201 && etag != null, "PUT If-None-Match -> " + r.status + " etag " + etag);
        r = MiniHttp.request("PUT", base + "jtest/a.json", auth("if-match: \"stale\""), "{\"v\":2}".getBytes());
        check(r.status == 412, "PUT stale If-Match -> 412 (" + r.status + ")");
        r = MiniHttp.request("GET", base + "jtest/a.json", auth(null), null);
        check(r.status == 200 && new String(r.body).equals("{\"v\":1}"), "GET body round-trips");
        byte[] big = new byte[3_000_000]; new Random(1).nextBytes(big);
        r = MiniHttp.request("PUT", base + "jtest/big.bin", auth(null), big);
        MiniHttp.Response g = MiniHttp.request("GET", base + "jtest/big.bin", auth(null), null);
        check(Arrays.equals(g.body, big), "3 MB binary upload/download is byte-identical");
        r = MiniHttp.request("DELETE", base + "jtest/", auth(null), new byte[0]);
        check(r.status == 204, "DELETE -> " + r.status);
        r = MiniHttp.request("GET", base, new HashMap<>(), null);
        check(r.status == 401, "no credentials -> 401");
        r = MiniHttp.request("GET", misc + "/chunked", null, null);
        check(r.status == 200 && new String(r.body, StandardCharsets.UTF_8).equals("hello chunked world"), "chunked transfer-encoding decoded");
        r = MiniHttp.request("GET", misc + "/redir", auth(null), null);
        check(r.status == 200 && r.url.endsWith("/final") && new String(r.body).equals("final:noauth"), "redirect followed; Authorization dropped on cross-host redirect: " + new String(r.body));
        r = MiniHttp.request("GET", misc.replace("8782", "8783") + "/continue", null, null);
        check(r.status == 200 && new String(r.body).equals("after-100"), "1xx interim response skipped");
        if (fails > 0) { System.out.println(fails + " FAILED"); System.exit(1); }
        System.out.println("ALL MINIHTTP CHECKS PASSED");
    }
}
