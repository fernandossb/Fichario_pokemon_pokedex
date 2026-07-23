package br.com.fichariopokemon.pokedex;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.DownloadManager;
import android.content.Intent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.IntentFilter;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.Settings;
import android.provider.MediaStore;
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

import androidx.core.content.FileProvider;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.File;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class MainActivity extends Activity {
    private static final int CREATE_BACKUP = 1001;
    private static final int OPEN_BACKUP = 1002;
    private static final int PICK_CARD_IMAGE = 1003;
    private static final long LIGA_POLL_INTERVAL_MS = 1200L;
    private static final long LIGA_TIMEOUT_MS = 35000L;
    private static final String UPDATE_API_URL = "https://api.github.com/repos/fernandossb/Fichario_pokemon_pokedex/releases/latest";
    private static final String APK_MIME = "application/vnd.android.package-archive";

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final Map<String, WebView> ligaProbes = new HashMap<String, WebView>();
    private final ExecutorService backgroundExecutor = Executors.newSingleThreadExecutor();
    private long updateDownloadId = -1L;
    private File pendingInstallFile;
    private FrameLayout rootView;
    private WebView webView;
    private String pendingBackup;
    private ValueCallback<Uri[]> pendingImageChooser;
    private Uri pendingCameraImageUri;
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
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> filePathCallback, FileChooserParams fileChooserParams) {
                if (pendingImageChooser != null) pendingImageChooser.onReceiveValue(null);
                pendingImageChooser = filePathCallback;
                try {
                    launchImageChooser(fileChooserParams != null && fileChooserParams.isCaptureEnabled());
                    return true;
                } catch (Exception error) {
                    pendingImageChooser = null;
                    Toast.makeText(MainActivity.this, "Não foi possível abrir câmera ou galeria", Toast.LENGTH_LONG).show();
                    return false;
                }
            }
        });
        webView.addJavascriptInterface(new AppBridge(), "Android");
        rootView.addView(webView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(rootView);
        registerUpdateReceiver();
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
    protected void onResume() {
        super.onResume();
        if (pendingInstallFile != null && canInstallUnknownApps()) {
            File file = pendingInstallFile;
            pendingInstallFile = null;
            installDownloadedApk(file);
        }
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
        try { unregisterReceiver(updateReceiver); } catch (Exception ignored) {}
        backgroundExecutor.shutdownNow();
        if (webView != null) {
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    private void launchImageChooser(boolean cameraOnly) throws Exception {
        Intent galleryIntent = new Intent(Intent.ACTION_GET_CONTENT);
        galleryIntent.addCategory(Intent.CATEGORY_OPENABLE);
        galleryIntent.setType("image/*");

        Intent cameraIntent = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
        File cameraFile = File.createTempFile("card-photo-", ".jpg", getExternalCacheDir() != null ? getExternalCacheDir() : getCacheDir());
        pendingCameraImageUri = FileProvider.getUriForFile(
                this,
                getPackageName() + ".fileprovider",
                cameraFile);
        cameraIntent.putExtra(MediaStore.EXTRA_OUTPUT, pendingCameraImageUri);
        cameraIntent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);

        Intent chooser;
        if (cameraOnly && cameraIntent.resolveActivity(getPackageManager()) != null) {
            chooser = cameraIntent;
        } else {
            chooser = Intent.createChooser(galleryIntent, "Escolher imagem da carta");
            if (cameraIntent.resolveActivity(getPackageManager()) != null) {
                chooser.putExtra(Intent.EXTRA_INITIAL_INTENTS, new Intent[]{cameraIntent});
            }
        }
        startActivityForResult(chooser, PICK_CARD_IMAGE);
    }

    private Uri[] imageChooserResult(int resultCode, Intent data) {
        if (resultCode != RESULT_OK) return null;
        if (data == null || (data.getData() == null && data.getClipData() == null)) {
            return pendingCameraImageUri == null ? null : new Uri[]{pendingCameraImageUri};
        }
        if (data.getClipData() != null) {
            int count = data.getClipData().getItemCount();
            Uri[] uris = new Uri[count];
            for (int index = 0; index < count; index++) uris[index] = data.getClipData().getItemAt(index).getUri();
            return uris;
        }
        return data.getData() == null ? null : new Uri[]{data.getData()};
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);

        if (requestCode == PICK_CARD_IMAGE) {
            if (pendingImageChooser != null) {
                pendingImageChooser.onReceiveValue(imageChooserResult(resultCode, data));
                pendingImageChooser = null;
            }
            pendingCameraImageUri = null;
            return;
        }

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

    private final BroadcastReceiver updateReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            if (!DownloadManager.ACTION_DOWNLOAD_COMPLETE.equals(intent.getAction())) return;
            long id = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1L);
            if (id != updateDownloadId) return;
            DownloadManager manager = (DownloadManager) getSystemService(DOWNLOAD_SERVICE);
            DownloadManager.Query query = new DownloadManager.Query().setFilterById(id);
            android.database.Cursor cursor = null;
            try {
                cursor = manager.query(query);
                if (cursor != null && cursor.moveToFirst()) {
                    int status = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
                    if (status == DownloadManager.STATUS_SUCCESSFUL && pendingInstallFile != null && pendingInstallFile.exists()) {
                        runJavascript("window.receiveUpdateDownload && window.receiveUpdateDownload(true,'Download concluído.');");
                        installDownloadedApk(pendingInstallFile);
                    } else {
                        runJavascript("window.receiveUpdateDownload && window.receiveUpdateDownload(false,'Não foi possível baixar a atualização.');");
                    }
                }
            } catch (Exception error) {
                runJavascript("window.receiveUpdateDownload && window.receiveUpdateDownload(false,'Falha ao verificar o download.');");
            } finally {
                if (cursor != null) cursor.close();
            }
        }
    };

    private void registerUpdateReceiver() {
        IntentFilter filter = new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE);
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(updateReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
        else registerReceiver(updateReceiver, filter);
    }

    private void runJavascript(final String script) {
        runOnUiThread(new Runnable() {
            @Override public void run() {
                if (webView != null) webView.evaluateJavascript(script, null);
            }
        });
    }

    private String readText(HttpURLConnection connection) throws Exception {
        InputStream stream = connection.getResponseCode() >= 400 ? connection.getErrorStream() : connection.getInputStream();
        if (stream == null) return "";
        BufferedReader reader = new BufferedReader(new InputStreamReader(stream, StandardCharsets.UTF_8));
        StringBuilder result = new StringBuilder();
        String line;
        while ((line = reader.readLine()) != null) result.append(line).append('\n');
        reader.close();
        return result.toString();
    }

    private int releaseBuildNumber(String tag) {
        if (tag == null) return 0;
        java.util.regex.Matcher matcher = java.util.regex.Pattern.compile("(\\d+)$").matcher(tag.trim());
        if (!matcher.find()) return 0;
        try { return Integer.parseInt(matcher.group(1)); } catch (Exception ignored) { return 0; }
    }

    private void checkForUpdateNative() {
        backgroundExecutor.execute(new Runnable() {
            @Override public void run() {
                HttpURLConnection connection = null;
                try {
                    connection = (HttpURLConnection) new URL(UPDATE_API_URL).openConnection();
                    connection.setConnectTimeout(15000);
                    connection.setReadTimeout(20000);
                    connection.setRequestProperty("Accept", "application/vnd.github+json");
                    connection.setRequestProperty("User-Agent", "Fichario-Pokemon-Android");
                    int code = connection.getResponseCode();
                    if (code < 200 || code >= 300) throw new IllegalStateException("GitHub respondeu HTTP " + code);
                    JSONObject release = new JSONObject(readText(connection));
                    String tag = release.optString("tag_name", "");
                    int latestBuild = releaseBuildNumber(tag);
                    int currentBuild = getPackageManager().getPackageInfo(getPackageName(), 0).versionCode;
                    String currentVersion = getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
                    String notes = release.optString("body", "Atualização disponível.");
                    String releaseName = release.optString("name", tag);
                    String publishedAt = release.optString("published_at", "");
                    String apkUrl = "";
                    String apkName = "Fichario-Pokemon.apk";
                    JSONArray assets = release.optJSONArray("assets");
                    if (assets != null) {
                        for (int i = 0; i < assets.length(); i++) {
                            JSONObject asset = assets.optJSONObject(i);
                            if (asset == null) continue;
                            String name = asset.optString("name", "");
                            if (name.toLowerCase(Locale.US).endsWith(".apk")) {
                                apkUrl = asset.optString("browser_download_url", "");
                                apkName = name;
                                break;
                            }
                        }
                    }
                    JSONObject result = new JSONObject();
                    result.put("ok", true);
                    result.put("currentBuild", currentBuild);
                    result.put("latestBuild", latestBuild);
                    result.put("currentVersion", currentVersion == null ? "" : currentVersion);
                    result.put("latestVersion", releaseName);
                    result.put("notes", notes);
                    result.put("publishedAt", publishedAt);
                    result.put("apkUrl", apkUrl);
                    result.put("apkName", apkName);
                    result.put("updateAvailable", latestBuild > currentBuild && apkUrl.length() > 0);
                    final String payload = result.toString();
                    runJavascript("window.receiveUpdateInfo && window.receiveUpdateInfo(" + JSONObject.quote(payload) + ");");
                } catch (Exception error) {
                    JSONObject result = new JSONObject();
                    try {
                        result.put("ok", false);
                        result.put("error", error.getMessage() == null ? "Falha ao consultar atualizações." : error.getMessage());
                    } catch (Exception ignored) {}
                    final String payload = result.toString();
                    runJavascript("window.receiveUpdateInfo && window.receiveUpdateInfo(" + JSONObject.quote(payload) + ");");
                } finally {
                    if (connection != null) connection.disconnect();
                }
            }
        });
    }

    private boolean canInstallUnknownApps() {
        return Build.VERSION.SDK_INT < 26 || getPackageManager().canRequestPackageInstalls();
    }

    private void requestInstallPermission() {
        if (Build.VERSION.SDK_INT < 26) return;
        Intent intent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                Uri.parse("package:" + getPackageName()));
        startActivity(intent);
    }

    private void downloadUpdateNative(String url, String fileName) {
        try {
            URL parsed = new URL(url);
            if (!"github.com".equalsIgnoreCase(parsed.getHost()) && !"objects.githubusercontent.com".equalsIgnoreCase(parsed.getHost())) {
                throw new IllegalArgumentException("Endereço de atualização não autorizado.");
            }
            String safeName = String.valueOf(fileName).replaceAll("[^a-zA-Z0-9._-]", "_");
            if (!safeName.toLowerCase(Locale.US).endsWith(".apk")) safeName += ".apk";
            pendingInstallFile = new File(getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), safeName);
            if (pendingInstallFile.exists()) pendingInstallFile.delete();
            DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));
            request.setTitle("Atualizando Fichário Pokémon");
            request.setDescription("Baixando a nova versão do aplicativo");
            request.setMimeType(APK_MIME);
            request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            request.setDestinationInExternalFilesDir(MainActivity.this, Environment.DIRECTORY_DOWNLOADS, safeName);
            DownloadManager manager = (DownloadManager) getSystemService(DOWNLOAD_SERVICE);
            updateDownloadId = manager.enqueue(request);
            runJavascript("window.receiveUpdateDownload && window.receiveUpdateDownload(null,'Download iniciado.');");
        } catch (Exception error) {
            String message = error.getMessage() == null ? "Não foi possível iniciar o download." : error.getMessage();
            runJavascript("window.receiveUpdateDownload && window.receiveUpdateDownload(false," + JSONObject.quote(message) + ");");
        }
    }

    private void installDownloadedApk(File apkFile) {
        if (apkFile == null || !apkFile.exists()) {
            Toast.makeText(this, "Arquivo da atualização não encontrado", Toast.LENGTH_LONG).show();
            return;
        }
        if (!canInstallUnknownApps()) {
            pendingInstallFile = apkFile;
            Toast.makeText(this, "Permita instalar apps desta fonte e volte ao Fichário.", Toast.LENGTH_LONG).show();
            requestInstallPermission();
            return;
        }
        try {
            Uri uri = FileProvider.getUriForFile(this, getPackageName() + ".fileprovider", apkFile);
            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(uri, APK_MIME);
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(intent);
        } catch (Exception error) {
            Toast.makeText(this, "Não foi possível abrir o instalador", Toast.LENGTH_LONG).show();
        }
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
        public void checkForUpdate() {
            checkForUpdateNative();
        }

        @JavascriptInterface
        public void downloadAndInstallUpdate(final String url, final String fileName) {
            runOnUiThread(new Runnable() {
                @Override public void run() { downloadUpdateNative(url, fileName); }
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
