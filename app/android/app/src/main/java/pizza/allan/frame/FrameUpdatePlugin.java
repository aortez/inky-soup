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
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import javax.net.ssl.SSLException;
import okhttp3.Call;
import okhttp3.HttpUrl;
import okhttp3.OkHttpClient;
import org.json.JSONObject;

/** Signed release discovery and download; Android's installer performs the update after the user confirms. */
@CapacitorPlugin(name = "FrameUpdate")
public class FrameUpdatePlugin extends Plugin {
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private UpdateStore store;
    private OkHttpClient client;
    private volatile Call active;

    @Override public void load() {
        store = new UpdateStore(new File(getContext().getCacheDir(), "updates"));
        client = UpdateHttp.create();
    }

    @SuppressWarnings("deprecation") // API 24 through 27 only expose the legacy signature array.
    @PluginMethod public void installed(PluginCall call) {
        try {
            PackageManager manager = getContext().getPackageManager();
            String name = getContext().getPackageName();
            Signature[] signatures;
            long versionCode;
            String versionName;
            if (Build.VERSION.SDK_INT >= 28) {
                PackageInfo info = manager.getPackageInfo(name, PackageManager.GET_SIGNING_CERTIFICATES);
                signatures = info.signingInfo.hasMultipleSigners() ? info.signingInfo.getApkContentsSigners() : info.signingInfo.getSigningCertificateHistory();
                versionCode = info.getLongVersionCode();
                versionName = info.versionName;
            } else {
                PackageInfo info = manager.getPackageInfo(name, PackageManager.GET_SIGNATURES);
                signatures = info.signatures;
                versionCode = info.versionCode;
                versionName = info.versionName;
            }
            if (signatures == null || signatures.length == 0) throw new IOException("The app signature is unavailable.");
            // After key rotation the history ends with the current certificate, which apksigner prints for a release.
            byte[] certificate = signatures[signatures.length - 1].toByteArray();
            JSObject result = new JSObject().put("applicationId", name).put("versionName", versionName == null ? "" : versionName)
                .put("versionCode", versionCode).put("sdk", Build.VERSION.SDK_INT)
                .put("signingSha256", UpdatePolicy.hex(MessageDigest.getInstance("SHA-256").digest(certificate)))
                .put("canInstall", Build.VERSION.SDK_INT < 26 || manager.canRequestPackageInstalls());
            File retained = store.retained();
            if (retained != null) {
                // A package that is installed, older, or unreadable only wastes cache storage.
                PackageInfo archive = manager.getPackageArchiveInfo(retained.getAbsolutePath(), 0);
                long archived = archive == null ? 0 : Build.VERSION.SDK_INT >= 28 ? archive.getLongVersionCode() : archive.versionCode;
                if (archived <= versionCode) { store.clear(); retained = null; }
            }
            result.put("downloadedSha256", retained == null ? JSONObject.NULL : store.downloaded());
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
            long size = call.getLong("size", 0L);
            if (active != null) throw new IOException("An update is already downloading.");
            io.execute(() -> {
                try {
                    store.download(client, url, size, sha256, started -> active = started,
                        received -> notifyListeners("updateProgress", new JSObject().put("received", received).put("total", size)));
                    call.resolve(new JSObject().put("sha256", sha256));
                } catch (Exception error) { fail(call, error); }
                finally { active = null; }
            });
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
                getActivity().startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getContext().getPackageName())));
                call.resolve(new JSObject().put("status", "permission"));
                return;
            }
            io.execute(() -> {
                try {
                    File file = store.verified(sha256);
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
