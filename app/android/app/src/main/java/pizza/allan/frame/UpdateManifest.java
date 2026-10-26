package pizza.allan.frame;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.TimeUnit;
import okhttp3.Call;
import okhttp3.HttpUrl;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import org.json.JSONException;
import org.json.JSONObject;

/** The release description published beside each signed APK; every field is validated before use. */
final class UpdateManifest {
    static final String UNREADABLE = "The update information could not be read. Try again later.";
    final String applicationId, versionName, apkUrl, apkSha256, signingSha256, notes, releaseUrl;
    final long versionCode, apkSize;
    final int minSdk;

    private UpdateManifest(JSONObject json) throws JSONException {
        applicationId = json.getString("application_id");
        if (!applicationId.matches("(?i)[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)+")) throw new JSONException("application_id");
        versionName = json.getString("version_name");
        if (!versionName.matches("\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}")) throw new JSONException("version_name");
        versionCode = bounded(json, "version_code", 2100000000L);
        minSdk = (int)bounded(json, "min_sdk", 1000);
        apkUrl = UpdatePolicy.url(json.getString("apk_url")).toString();
        apkSha256 = UpdatePolicy.digest(json.getString("apk_sha256"));
        apkSize = bounded(json, "apk_size", UpdatePolicy.MAXIMUM_APK);
        signingSha256 = UpdatePolicy.digest(json.getString("signing_sha256"));
        // Android's org.json renders a JSON null as the text "null", so optional strings are read explicitly.
        String trimmed = optional(json, "notes").trim();
        notes = trimmed.length() > UpdatePolicy.MAXIMUM_NOTES ? trimmed.substring(0, UpdatePolicy.MAXIMUM_NOTES) : trimmed;
        String link = optional(json, "release_url");
        releaseUrl = link.isEmpty() ? "" : UpdatePolicy.url(link).toString();
    }

    private static String optional(JSONObject json, String key) throws JSONException {
        Object value = json.opt(key);
        if (value == null || JSONObject.NULL.equals(value)) return "";
        if (!(value instanceof String)) throw new JSONException(key);
        return (String)value;
    }

    private static long bounded(JSONObject json, String key, long maximum) throws JSONException {
        Object value = json.get(key);
        if (!(value instanceof Integer) && !(value instanceof Long)) throw new JSONException(key);
        long number = ((Number)value).longValue();
        if (number < 1 || number > maximum) throw new JSONException(key);
        return number;
    }

    static UpdateManifest parse(String text) throws IOException {
        try { return new UpdateManifest(new JSONObject(text)); }
        catch (JSONException | IllegalArgumentException error) { throw new IOException(UNREADABLE, error); }
    }

    static UpdateManifest fetch(OkHttpClient client, HttpUrl url) throws IOException {
        Call call = client.newCall(new Request.Builder().url(url).header("Accept", "application/json").build());
        call.timeout().timeout(20, TimeUnit.SECONDS);
        try (Response response = call.execute()) {
            if (!response.isSuccessful()) throw new IOException("The update server answered with status " + response.code() + ". Try again later.");
            return parse(new String(read(response.body().byteStream(), UpdatePolicy.MAXIMUM_MANIFEST), StandardCharsets.UTF_8));
        }
    }

    private static byte[] read(InputStream in, int limit) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] bytes = new byte[8 * 1024];
        int count;
        while ((count = in.read(bytes)) != -1) {
            if (out.size() + count > limit) throw new IOException(UNREADABLE);
            out.write(bytes, 0, count);
        }
        return out.toByteArray();
    }
}
