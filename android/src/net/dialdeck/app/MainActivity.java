package net.dialdeck.app;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.util.Base64;
import android.util.Log;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.file.Files;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * DialDeck for Android: hosts the DialDeck web UI (the same code as the browser extension) in a
 * WebView served from a private https origin, and provides native services through the
 * "DDAndroid" JavaScript bridge:
 *   - HTTP for WebDAV sync and logo fetching (no CORS, WebDAV methods, no cookies)
 *   - opening dials and searches in Waterfox (or another chosen browser)
 *   - receiving "Share -> DialDeck" from any browser, saving export files, the back button.
 */
public class MainActivity extends Activity {
    static final String TAG = "DialDeck";
    static final String HOST = "appassets.androidplatform.net";
    static final String BASE = "https://" + HOST + "/";
    static final int REQ_PICK = 1, REQ_SAVE = 2;

    WebView web;
    SharedPreferences prefs;
    final ExecutorService pool = Executors.newFixedThreadPool(4);
    ValueCallback<Uri[]> fileCallback;
    byte[] pendingSave;
    String pendingShare; // JSON {url,title}
    boolean fromShare;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        prefs = getSharedPreferences("dialdeck", MODE_PRIVATE);
        getWindow().setStatusBarColor(Color.BLACK);
        getWindow().setNavigationBarColor(Color.BLACK);

        web = new WebView(this);
        web.setBackgroundColor(Color.BLACK);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setSupportMultipleWindows(false);
        s.setMediaPlaybackRequiresUserGesture(true);
        String ua = WebSettings.getDefaultUserAgent(this);
        MiniHttp.userAgent = ua; // sites serve normal pages/icons to a normal mobile UA
        s.setUserAgentString(ua + " DialDeckAndroid/" + version());
        WebView.setWebContentsDebuggingEnabled((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0);
        web.addJavascriptInterface(new Bridge(), "DDAndroid");
        web.setWebViewClient(new Client());
        web.setWebChromeClient(new Chrome());
        setContentView(web);

        handleIntent(getIntent());
        web.loadUrl(BASE + "newtab.html");
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleIntent(intent);
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) web.evaluateJavascript("window.ddOnResume && window.ddOnResume()", null);
    }

    @Override
    public void onBackPressed() {
        web.evaluateJavascript("window.ddBack ? window.ddBack() : false", v -> {
            if (!"true".equals(v)) leave();
        });
    }

    /** Go back to whatever app was open before (Waterfox after a share), keeping our state. */
    void leave() {
        fromShare = false;
        moveTaskToBack(true);
    }

    // ---------------- share target ----------------
    static final Pattern URL_RE = Pattern.compile("(https?://[^\\s<>\"']+)", Pattern.CASE_INSENSITIVE);

    void handleIntent(Intent i) {
        if (i == null || !Intent.ACTION_SEND.equals(i.getAction())) return;
        String text = i.getStringExtra(Intent.EXTRA_TEXT);
        String subject = i.getStringExtra(Intent.EXTRA_SUBJECT);
        if (text == null) return;
        Matcher m = URL_RE.matcher(text);
        if (!m.find()) {
            Toast.makeText(this, "No link found in the shared text", Toast.LENGTH_SHORT).show();
            return;
        }
        String url = m.group(1);
        String title = subject != null ? subject : text.replace(url, "").trim();
        try {
            JSONObject o = new JSONObject();
            o.put("url", url);
            o.put("title", title);
            pendingShare = o.toString();
        } catch (Exception e) { return; }
        fromShare = true;
        // If the page is already running, hand it over now; otherwise the page asks for it at start-up.
        if (web != null) web.evaluateJavascript("window.ddCheckShare && window.ddCheckShare()", null);
    }

    // ---------------- opening links in the chosen browser ----------------
    List<ResolveInfo> browsers() {
        Intent probe = new Intent(Intent.ACTION_VIEW, Uri.parse("https://example.com/"));
        probe.addCategory(Intent.CATEGORY_BROWSABLE);
        return getPackageManager().queryIntentActivities(probe, PackageManager.MATCH_ALL);
    }

    /** Package to open links with, or null for the system default. */
    String browserPackage() {
        String pref = prefs.getString("browser", "auto");
        Set<String> installed = new HashSet<>();
        for (ResolveInfo r : browsers()) installed.add(r.activityInfo.packageName);
        if ("system".equals(pref)) return null;
        if (!"auto".equals(pref) && installed.contains(pref)) return pref;
        // auto: prefer Waterfox (release first, then any Waterfox build)
        if (installed.contains("net.waterfox.android.release")) return "net.waterfox.android.release";
        for (String p : installed) if (p.startsWith("net.waterfox.android")) return p;
        return null;
    }

    void openExternal(String url) {
        Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
        i.addCategory(Intent.CATEGORY_BROWSABLE);
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        String pkg = browserPackage();
        if (pkg != null) i.setPackage(pkg);
        try {
            startActivity(i);
        } catch (ActivityNotFoundException e) {
            i.setPackage(null);
            try { startActivity(Intent.createChooser(i, "Open with")); }
            catch (Exception e2) { Toast.makeText(this, "No browser found", Toast.LENGTH_SHORT).show(); }
        }
    }

    // ---------------- web content: assets, favicons, navigation ----------------
    class Client extends WebViewClient {
        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
            Uri u = req.getUrl();
            if (!HOST.equals(u.getHost())) return null;
            String path = u.getPath() == null ? "/" : u.getPath();
            if (path.startsWith("/_favicon/")) return favicon(u.getQueryParameter("pageUrl"));
            if (path.equals("/") || path.isEmpty()) path = "/newtab.html";
            if (path.contains("..")) return notFound();
            try {
                InputStream in = getAssets().open("www" + path);
                WebResourceResponse r = new WebResourceResponse(mime(path), mime(path).startsWith("text/") || path.endsWith(".js") ? "utf-8" : null, in);
                Map<String, String> h = new HashMap<>();
                h.put("Cache-Control", "no-cache");
                r.setResponseHeaders(h);
                return r;
            } catch (IOException e) {
                return notFound();
            }
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
            Uri u = req.getUrl();
            if (HOST.equals(u.getHost())) return false;
            openExternal(u.toString()); // dials and web searches go to Waterfox
            return true;
        }
    }

    static String mime(String p) {
        String l = p.toLowerCase(Locale.ROOT);
        if (l.endsWith(".html")) return "text/html";
        if (l.endsWith(".js") || l.endsWith(".mjs")) return "text/javascript";
        if (l.endsWith(".css")) return "text/css";
        if (l.endsWith(".json")) return "application/json";
        if (l.endsWith(".png")) return "image/png";
        if (l.endsWith(".svg")) return "image/svg+xml";
        if (l.endsWith(".webp")) return "image/webp";
        if (l.endsWith(".ico")) return "image/x-icon";
        return "application/octet-stream";
    }

    static WebResourceResponse notFound() {
        return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", new HashMap<>(), new ByteArrayInputStream(new byte[0]));
    }

    /** Site favicon, fetched natively and cached on disk (replaces Chrome's _favicon API). */
    WebResourceResponse favicon(String pageUrl) {
        try {
            Uri page = Uri.parse(pageUrl);
            String origin = page.getScheme() + "://" + page.getAuthority();
            File dir = new File(getCacheDir(), "favicons");
            dir.mkdirs();
            File f = new File(dir, Integer.toHexString(origin.hashCode()));
            byte[] data = null;
            if (f.exists() && System.currentTimeMillis() - f.lastModified() < 14L * 86400000L) data = Files.readAllBytes(f.toPath());
            if (data == null) {
                for (String p : new String[]{"/favicon.ico", "/apple-touch-icon.png"}) {
                    try {
                        MiniHttp.Response r = MiniHttp.request("GET", origin + p, null, null);
                        String ct = r.headers.containsKey("content-type") ? r.headers.get("content-type") : "";
                        if (r.status == 200 && r.body.length > 50 && !ct.startsWith("text/")) { data = r.body; break; }
                    } catch (IOException ignored) { }
                }
                if (data == null) data = new byte[0];
                try (OutputStream o = new FileOutputStream(f)) { o.write(data); }
            }
            if (data.length == 0) return notFound(); // page falls back to letter badges
            return new WebResourceResponse("image/x-icon", null, new ByteArrayInputStream(data));
        } catch (Exception e) {
            return notFound();
        }
    }

    class Chrome extends WebChromeClient {
        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> cb, FileChooserParams params) {
            if (fileCallback != null) fileCallback.onReceiveValue(null);
            fileCallback = cb;
            Intent i = new Intent(Intent.ACTION_GET_CONTENT);
            i.addCategory(Intent.CATEGORY_OPENABLE);
            String[] types = params.getAcceptTypes();
            i.setType(types != null && types.length > 0 && types[0] != null && !types[0].isEmpty() && types[0].contains("/") ? types[0] : "*/*");
            try {
                startActivityForResult(i, REQ_PICK);
            } catch (ActivityNotFoundException e) {
                fileCallback = null;
                return false;
            }
            return true;
        }

        @Override
        public boolean onConsoleMessage(ConsoleMessage m) {
            Log.d(TAG, m.message() + " (" + m.sourceId() + ":" + m.lineNumber() + ")");
            return true;
        }
    }

    @Override
    protected void onActivityResult(int req, int result, Intent data) {
        super.onActivityResult(req, result, data);
        if (req == REQ_PICK && fileCallback != null) {
            fileCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result, data));
            fileCallback = null;
        } else if (req == REQ_SAVE) {
            byte[] bytes = pendingSave;
            pendingSave = null;
            if (result != RESULT_OK || data == null || data.getData() == null || bytes == null) return;
            try (OutputStream o = getContentResolver().openOutputStream(data.getData())) {
                o.write(bytes);
                Toast.makeText(this, "Saved", Toast.LENGTH_SHORT).show();
            } catch (Exception e) {
                Toast.makeText(this, "Could not save: " + e.getMessage(), Toast.LENGTH_LONG).show();
            }
        }
    }

    String version() {
        try { return getPackageManager().getPackageInfo(getPackageName(), 0).versionName; }
        catch (Exception e) { return "?"; }
    }

    // ---------------- JavaScript bridge ----------------
    class Bridge {
        /** Async HTTP: result is delivered to window.__ddHttpDone(id, result). */
        @JavascriptInterface
        public void http(final String id, final String method, final String url, final String headersJson, final String bodyB64) {
            pool.execute(() -> {
                JSONObject res = new JSONObject();
                try {
                    Map<String, String> headers = new LinkedHashMap<>();
                    JSONObject h = new JSONObject(headersJson == null || headersJson.isEmpty() ? "{}" : headersJson);
                    for (Iterator<String> it = h.keys(); it.hasNext(); ) { String k = it.next(); headers.put(k, h.getString(k)); }
                    byte[] body = bodyB64 == null || bodyB64.isEmpty() ? new byte[0] : Base64.decode(bodyB64, Base64.NO_WRAP);
                    MiniHttp.Response r = MiniHttp.request(method, url, headers, ("GET".equals(method) || "HEAD".equals(method)) && body.length == 0 ? null : body);
                    res.put("status", r.status);
                    res.put("statusText", r.statusText);
                    res.put("url", r.url);
                    JSONObject rh = new JSONObject();
                    for (Map.Entry<String, String> e : r.headers.entrySet()) rh.put(e.getKey(), e.getValue());
                    res.put("headers", rh);
                    res.put("body", Base64.encodeToString(r.body, Base64.NO_WRAP));
                } catch (Exception e) {
                    try { res.put("error", e.getClass().getSimpleName() + ": " + e.getMessage()); } catch (Exception ignored) { }
                }
                final String js = "window.__ddHttpDone(" + JSONObject.quote(id) + "," + res + ")";
                web.post(() -> web.evaluateJavascript(js, null));
            });
        }

        @JavascriptInterface
        public void openUrl(final String url) {
            runOnUiThread(() -> openExternal(url));
        }

        @JavascriptInterface
        public String listBrowsers() {
            JSONArray a = new JSONArray();
            Set<String> seen = new HashSet<>();
            PackageManager pm = getPackageManager();
            for (ResolveInfo r : browsers()) {
                String p = r.activityInfo.packageName;
                if (!seen.add(p) || p.equals(getPackageName())) continue;
                try { a.put(new JSONObject().put("pkg", p).put("label", String.valueOf(r.loadLabel(pm)))); } catch (Exception ignored) { }
            }
            return a.toString();
        }

        @JavascriptInterface
        public String getBrowser() {
            try {
                String active = browserPackage();
                return new JSONObject().put("pref", prefs.getString("browser", "auto")).put("active", active == null ? "" : active).toString();
            } catch (Exception e) { return "{}"; }
        }

        @JavascriptInterface
        public void setBrowser(String pkg) {
            prefs.edit().putString("browser", pkg == null || pkg.isEmpty() ? "auto" : pkg).apply();
        }

        @JavascriptInterface
        public String takeShare() {
            String s = pendingShare;
            pendingShare = null;
            return s;
        }

        /** After adding a shared link: return to the browser it came from. */
        @JavascriptInterface
        public void shareDone() {
            runOnUiThread(() -> { if (fromShare) leave(); });
        }

        @JavascriptInterface
        public void saveFile(String name, String mimeType, String b64) {
            pendingSave = Base64.decode(b64, Base64.NO_WRAP);
            runOnUiThread(() -> {
                Intent i = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType(mimeType == null || mimeType.isEmpty() ? "application/octet-stream" : mimeType);
                i.putExtra(Intent.EXTRA_TITLE, name);
                try { startActivityForResult(i, REQ_SAVE); }
                catch (ActivityNotFoundException e) { Toast.makeText(MainActivity.this, "No file manager available", Toast.LENGTH_LONG).show(); }
            });
        }

        @JavascriptInterface
        public String version() {
            return MainActivity.this.version();
        }

        @JavascriptInterface
        public void toast(String msg) {
            runOnUiThread(() -> Toast.makeText(MainActivity.this, msg, Toast.LENGTH_SHORT).show());
        }
    }
}
