package pizza.allan.frame;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.IOException;
import java.io.InterruptedIOException;
import java.net.ConnectException;
import java.net.UnknownHostException;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import javax.net.ssl.SSLException;
import okhttp3.Call;
import okhttp3.HttpUrl;
import okhttp3.OkHttpClient;
import org.json.JSONObject;

/** Signed release discovery and download; Android's installer performs the update after the user confirms. */
@CapacitorPlugin(name = "FrameUpdate")
public class FrameUpdatePlugin extends Plugin {
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final AtomicBoolean downloading = new AtomicBoolean();
    private UpdateStore store;
    private OkHttpClient client;
    private volatile Call active;

    @Override public void load() {
        store = new UpdateStore(new File(getContext().getCacheDir(), "updates"));
        client = UpdateHttp.create();
    }

    @SuppressWarnings("deprecation") // API 24 through 27 only expose the legacy signature array.
    private static int signatureFlags() {
        return Build.VERSION.SDK_INT >= 28 ? PackageManager.GET_SIGNING_CERTIFICATES : PackageManager.GET_SIGNATURES;
    }

    @SuppressWarnings("deprecation")
    private static long versionCodeOf(PackageInfo info) {
        return Build.VERSION.SDK_INT >= 28 ? info.getLongVersionCode() : info.versionCode;
    }

    /** SHA-256 of the current signing certificate, which apksigner prints for each release, or null. */
    @SuppressWarnings("deprecation")
    private static String signerDigest(PackageInfo info) throws NoSuchAlgorithmException {
        Signature[] signatures;
        if (Build.VERSION.SDK_INT >= 28) {
            if (info.signingInfo == null) return null;
            signatures = info.signingInfo.hasMultipleSigners() ? info.signingInfo.getApkContentsSigners() : info.signingInfo.getSigningCertificateHistory();
        } else {
            signatures = info.signatures;
        }
        if (signatures == null || signatures.length == 0) return null;
        // After key rotation the history ends with the current certificate.
        return UpdatePolicy.hex(MessageDigest.getInstance("SHA-256").digest(signatures[signatures.length - 1].toByteArray()));
    }

    private PackageInfo installedPackage() throws PackageManager.NameNotFoundException {
        return getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), signatureFlags());
    }

    /** Parses the downloaded package and compares its identity with the installed app. */
    private String archiveProblem(PackageInfo installed, File file) throws IOException, NoSuchAlgorithmException {
        String digest = signerDigest(installed);
        if (digest == null) throw new IOException("The app signature is unavailable.");
        PackageInfo archive = getContext().getPackageManager().getPackageArchiveInfo(file.getAbsolutePath(), signatureFlags());
        return UpdatePolicy.archiveProblem(installed.packageName, versionCodeOf(installed), digest,
            archive == null ? null : archive.packageName, archive == null ? 0 : versionCodeOf(archive), archive == null ? null : signerDigest(archive));
    }

    @PluginMethod public void installed(PluginCall call) {
        try {
            PackageInfo info = installedPackage();
            String digest = signerDigest(info);
            if (digest == null) throw new IOException("The app signature is unavailable.");
            JSObject result = new JSObject().put("applicationId", info.packageName).put("versionName", info.versionName == null ? "" : info.versionName)
                .put("versionCode", versionCodeOf(info)).put("sdk", Build.VERSION.SDK_INT).put("signingSha256", digest)
                .put("canInstall", Build.VERSION.SDK_INT < 26 || getContext().getPackageManager().canRequestPackageInstalls());
            File retained = store.retained();
            // A package that is installed, older, foreign, or unreadable only wastes cache storage.
            if (retained != null && archiveProblem(info, retained) != null) { store.clear(); retained = null; }
            result.put("downloadedSha256", retained == null ? JSONObject.NULL : retained.getName().substring(0, 64));
            call.resolve(result);
        } catch (Exception error) { fail(call, error); }
    }

    @PluginMethod public void check(PluginCall call) {
        try {
            HttpUrl url = UpdatePolicy.url(call.getString("url"));
            io.execute(() -> {
                try {
                    UpdateManifest manifest = UpdateManifest.fetch(client, url);
                    call.resolve(new JSObject().put("application_id", manifest.applicationId).put("version_name", manifest.versionName)
                        .put("version_code", manifest.versionCode).put("min_sdk", manifest.minSdk).put("apk_url", manifest.apkUrl)
                        .put("apk_sha256", manifest.apkSha256).put("apk_size", manifest.apkSize).put("signing_sha256", manifest.signingSha256)
                        .put("notes", manifest.notes).put("release_url", manifest.releaseUrl));
                } catch (Exception error) { fail(call, error); }
            });
        } catch (Exception error) { fail(call, error); }
    }

    @PluginMethod public void download(PluginCall call) {
        try {
            HttpUrl url = UpdatePolicy.url(call.getString("url"));
            String sha256 = UpdatePolicy.digest(call.getString("sha256"));
            // PluginCall.getLong only accepts a Long, while bridge integers arrive as Integer.
            long size = UpdatePolicy.size(call.getData().opt("size"));
            if (!downloading.compareAndSet(false, true)) throw new IOException("An update is already downloading.");
            try {
                io.execute(() -> {
                    try {
                        store.download(client, url, size, sha256, started -> active = started,
                            received -> notifyListeners("updateProgress", new JSObject().put("received", received).put("total", size)));
                        call.resolve(new JSObject().put("sha256", sha256));
                    } catch (Exception error) { fail(call, error); }
                    finally { active = null; downloading.set(false); }
                });
            } catch (RuntimeException error) { downloading.set(false); throw error; }
        } catch (Exception error) { fail(call, error); }
    }

    @PluginMethod public void cancel(PluginCall call) {
        Call running = active;
        if (running != null) running.cancel();
        call.resolve();
    }

    @PluginMethod public void install(PluginCall call) {
        try {
            String sha256 = UpdatePolicy.digest(call.getString("sha256"));
            if (Build.VERSION.SDK_INT >= 26 && !getContext().getPackageManager().canRequestPackageInstalls()) {
                // Android grants installation per app in Settings; the user returns and taps Install again.
                Intent settings = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getContext().getPackageName()));
                getActivity().runOnUiThread(() -> {
                    try { getActivity().startActivity(settings); call.resolve(new JSObject().put("status", "permission")); }
                    catch (ActivityNotFoundException error) { call.reject("Allow Sparkle Duck to install unknown apps in Android Settings, then tap Install update again.", error); }
                    catch (Exception error) { fail(call, error); }
                });
                return;
            }
            io.execute(() -> {
                try {
                    File file = store.verified(sha256);
                    // The manifest is trusted only as far as it names this app's own newer build.
                    String problem = archiveProblem(installedPackage(), file);
                    if (problem != null) { store.clear(); throw new IOException(problem); }
                    Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", file);
                    Intent intent = new Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive")
                        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                    getActivity().runOnUiThread(() -> {
                        try { getActivity().startActivity(intent); call.resolve(new JSObject().put("status", "launched")); }
                        catch (ActivityNotFoundException error) { call.reject("This phone has no package installer for app updates.", error); }
                        catch (Exception error) { fail(call, error); }
                    });
                } catch (Exception error) { fail(call, error); }
            });
        } catch (Exception error) { fail(call, error); }
    }

    private void fail(PluginCall call, Exception error) {
        String message = error instanceof UnknownHostException || error instanceof ConnectException || error instanceof SSLException
            ? "Cannot reach the update server. Check your internet connection and try again."
            : error instanceof InterruptedIOException
            ? "The update server did not respond in time. Try again."
            : error.getMessage();
        call.reject(message == null ? "The update could not be completed. Try again." : message, error);
    }

    @Override protected void handleOnDestroy() {
        Call running = active;
        if (running != null) running.cancel();
        io.shutdownNow();
    }
}
