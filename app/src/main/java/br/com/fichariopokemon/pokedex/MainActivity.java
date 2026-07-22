package br.com.fichariopokemon.pokedex;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

public final class MainActivity extends Activity {
    private static final int CREATE_BACKUP = 1001;
    private static final int OPEN_BACKUP = 1002;
    private static final long LIGA_POLL_INTERVAL_MS = 1200L;
    private static final long LIGA_TIMEOUT_MS = 35000L;

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final Map<String, WebView> ligaProbes = new HashMap<String, WebView>();
    private FrameLayout rootView;
    private WebView webView;
    private String pendingBackup;
    private double topInsetCss;
    private double bottomInsetCss;

    @SuppressLint({"SetJavaScriptEnabled", "JavascriptInterface"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(Color.rgb(7, 31, 65));
        getWindow().setNavigationBarColor(Color.rgb(255, 248, 220));
        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
        topInsetCss = systemBarHeightCss("status_bar_height");
        bottomInsetCss = systemBarHeightCss("navigation_bar_height");

        rootView = new FrameLayout(this);
        webView = new WebView(this);
        webView.setBackgroundColor(Color.rgb(255, 248, 220));
        configureWebView(webView, false);
        webView.setWebViewClient(new WebViewClient());
        webView.setWebChromeClient(new WebChromeClient());
        webView.addJavascriptInterface(new AppBridge(), "Android");
        rootView.addView(webView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(rootView);
        webView.loadUrl("file:///android_asset/www/index.html");
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void configureWebView(WebView target, boolean marketProbe) {
        WebSettings settings = target.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(true);
        settings.setAllowFileAccessFromFileURLs(true);
        settings.setAllowUniversalAccessFromFileURLs(true);
        settings.setDefaultTextEncodingName("utf-8");
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setCacheMode(marketProbe ? WebSettings.LOAD_NO_CACHE : WebSettings.LOAD_CACHE_ELSE_NETWORK);
        if (marketProbe) {
            settings.setUserAgentString("Mozilla/5.0 (Linux; Android 14; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36");
        }
    }

    private double systemBarHeightCss(String resourceName) {
        int resourceId = getResources().getIdentifier(resourceName, "dimen", "android");
        if (resourceId == 0) return 0;
        int pixels = getResources().getDimensionPixelSize(resourceId);
        float density = getResources().getDisplayMetrics().density;
        return density > 0 ? pixels / density : 0;
    }

    @Override
    public void onBackPressed() {
        if (webView != null) {
            webView.evaluateJavascript("window.handleAndroidBack && window.handleAndroidBack()", new ValueCallback<String>() {
                @Override
                public void onReceiveValue(String value) {
                    if (!"true".equals(value)) MainActivity.super.onBackPressed();
                }
            });
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onDestroy() {
        for (WebView probe : ligaProbes.values()) {
            try {
                probe.stopLoading();
                if (rootView != null) rootView.removeView(probe);
                probe.destroy();
            } catch (Exception ignored) {}
        }
        ligaProbes.clear();
        if (webView != null) {
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (resultCode != RESULT_OK || data == null || data.getData() == null) return;
        Uri uri = data.getData();
        try {
            if (requestCode == CREATE_BACKUP && pendingBackup != null) {
                OutputStream output = null;
                try {
                    output = getContentResolver().openOutputStream(uri);
                    if (output == null) throw new IllegalStateException("Arquivo indisponível");
                    output.write(pendingBackup.getBytes(StandardCharsets.UTF_8));
                } finally {
                    if (output != null) try { output.close(); } catch (Exception ignored) {}
                }
                pendingBackup = null;
                Toast.makeText(this, "Backup salvo", Toast.LENGTH_SHORT).show();
            } else if (requestCode == OPEN_BACKUP) {
                InputStream input = null;
                ByteArrayOutputStream output = null;
                String json;
                try {
                    input = getContentResolver().openInputStream(uri);
                    output = new ByteArrayOutputStream();
                    if (input == null) throw new IllegalStateException("Arquivo indisponível");
                    byte[] buffer = new byte[8192];
                    int count;
                    while ((count = input.read(buffer)) >= 0) output.write(buffer, 0, count);
                    json = output.toString(StandardCharsets.UTF_8.name());
                } finally {
                    if (input != null) try { input.close(); } catch (Exception ignored) {}
                    if (output != null) try { output.close(); } catch (Exception ignored) {}
                }
                webView.evaluateJavascript(
                        "window.receiveImportedBackup(" + JSONObject.quote(json) + ")", null);
            }
        } catch (Exception error) {
            Toast.makeText(this, "Não foi possível usar o arquivo", Toast.LENGTH_LONG).show();
        }
    }

    private boolean isAllowedLigaUrl(String value) {
        try {
            URL url = new URL(value);
            String host = url.getHost().toLowerCase(Locale.US);
            return "ligapokemon.com.br".equals(host) || "www.ligapokemon.com.br".equals(host);
        } catch (Exception ignored) {
            return false;
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void startLigaProbe(final String requestId, final String url) {
        if (requestId == null || requestId.length() == 0 || !isAllowedLigaUrl(url)) {
            deliverLigaResult(requestId, false, null, "Endereço da Liga Pokémon inválido.");
            return;
        }
        WebView previous = ligaProbes.remove(requestId);
        if (previous != null) destroyProbe(previous);

        final WebView probe = new WebView(this);
        configureWebView(probe, true);
        probe.setBackgroundColor(Color.TRANSPARENT);
        probe.setAlpha(0.01f);
        CookieManager cookieManager = CookieManager.getInstance();
        cookieManager.setAcceptCookie(true);
        cookieManager.setAcceptThirdPartyCookies(probe, true);
        probe.setWebChromeClient(new WebChromeClient());
        probe.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String loadedUrl) {
                super.onPageFinished(view, loadedUrl);
                scheduleLigaExtraction(requestId, probe, 22);
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                super.onReceivedError(view, request, error);
                if (request != null && request.isForMainFrame()) {
                    String description = error == null ? "erro de rede" : String.valueOf(error.getDescription());
                    deliverLigaResult(requestId, false, null, "Liga Pokémon: " + description);
                }
            }

            @Override
            public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse errorResponse) {
                super.onReceivedHttpError(view, request, errorResponse);
                if (request != null && request.isForMainFrame() && errorResponse != null && errorResponse.getStatusCode() >= 400) {
                    deliverLigaResult(requestId, false, null, "Liga Pokémon respondeu HTTP " + errorResponse.getStatusCode() + ".");
                }
            }
        });

        FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(2, 2);
        params.leftMargin = -20;
        params.topMargin = -20;
        rootView.addView(probe, params);
        ligaProbes.put(requestId, probe);
        probe.loadUrl(url);

        mainHandler.postDelayed(new Runnable() {
            @Override
            public void run() {
                if (ligaProbes.get(requestId) == probe) {
                    deliverLigaResult(requestId, false, null, "A página da Liga Pokémon demorou mais de 35 segundos.");
                }
            }
        }, LIGA_TIMEOUT_MS);
    }

    private void scheduleLigaExtraction(final String requestId, final WebView probe, final int attemptsLeft) {
        mainHandler.postDelayed(new Runnable() {
            @Override
            public void run() {
                if (ligaProbes.get(requestId) != probe) return;
                probe.evaluateJavascript(
                        "(function(){var b=document.body;var t=b?(b.innerText||b.textContent||''):'';var r=(t.indexOf('Preço Médio de Venda')>=0||t.indexOf('Preco Medio de Venda')>=0)&&t.indexOf('R$')>=0;return (r?'READY\n':'WAIT\n')+t;})()",
                        new ValueCallback<String>() {
                            @Override
                            public void onReceiveValue(String jsonText) {
                                if (ligaProbes.get(requestId) != probe) return;
                                String decoded = "";
                                try {
                                    if (jsonText != null && !"null".equals(jsonText)) {
                                        decoded = new JSONArray("[" + jsonText + "]").getString(0);
                                    }
                                } catch (Exception ignored) {}
                                boolean ready = decoded.startsWith("READY\n");
                                String text = decoded.length() > 5 ? decoded.substring(decoded.indexOf('\n') + 1) : "";
                                if (ready) {
                                    deliverLigaResult(requestId, true, JSONObject.quote(text), null);
                                } else if (attemptsLeft > 0) {
                                    scheduleLigaExtraction(requestId, probe, attemptsLeft - 1);
                                } else if (text.length() > 0) {
                                    deliverLigaResult(requestId, true, JSONObject.quote(text), null);
                                } else {
                                    deliverLigaResult(requestId, false, null, "A página da Liga abriu sem conteúdo de preços.");
                                }
                            }
                        });
            }
        }, LIGA_POLL_INTERVAL_MS);
    }

    private void deliverLigaResult(String requestId, boolean ok, String payloadJson, String error) {
        final WebView probe = ligaProbes.remove(requestId);
        if (probe != null) destroyProbe(probe);
        if (webView == null) return;
        String safeId = JSONObject.quote(requestId == null ? "" : requestId);
        String safePayload = payloadJson == null ? "null" : payloadJson;
        String safeError = error == null ? "null" : JSONObject.quote(error);
        String script = "window.receiveLigaPokemonText&&window.receiveLigaPokemonText(" + safeId + "," +
                (ok ? "true" : "false") + "," + safePayload + "," + safeError + ")";
        webView.evaluateJavascript(script, null);
    }

    private void destroyProbe(WebView probe) {
        try {
            probe.stopLoading();
            if (rootView != null) rootView.removeView(probe);
            probe.loadUrl("about:blank");
            probe.clearHistory();
            probe.removeAllViews();
            probe.destroy();
        } catch (Exception ignored) {}
    }

    public final class AppBridge {
        @JavascriptInterface
        public double getTopInsetCss() {
            return topInsetCss;
        }

        @JavascriptInterface
        public double getBottomInsetCss() {
            return bottomInsetCss;
        }

        @JavascriptInterface
        public void requestLigaPokemon(final String requestId, final String url) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    startLigaProbe(requestId, url);
                }
            });
        }

        @JavascriptInterface
        public void exportBackup(String json) {
            pendingBackup = json;
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                    intent.addCategory(Intent.CATEGORY_OPENABLE);
                    intent.setType("application/json");
                    intent.putExtra(Intent.EXTRA_TITLE, "fichario-pokemon-backup.json");
                    startActivityForResult(intent, CREATE_BACKUP);
                }
            });
        }

        @JavascriptInterface
        public void importBackup() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                    intent.addCategory(Intent.CATEGORY_OPENABLE);
                    intent.setType("application/json");
                    startActivityForResult(intent, OPEN_BACKUP);
                }
            });
        }

        @JavascriptInterface
        public void toast(final String message) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    Toast.makeText(MainActivity.this, message, Toast.LENGTH_SHORT).show();
                }
            });
        }
    }
}
