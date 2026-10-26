package pizza.allan.frame;

import java.util.Locale;
import okhttp3.HttpUrl;

/** Release metadata and packages come only from HTTPS addresses named by the published manifest. */
final class UpdatePolicy {
    static final long MAXIMUM_APK = 64L * 1024 * 1024;
    static final int MAXIMUM_MANIFEST = 64 * 1024;
    static final int MAXIMUM_NOTES = 1000;

    private UpdatePolicy() { }

    static HttpUrl url(String value) {
        if (value == null || value.length() > 2048) throw new IllegalArgumentException("Invalid update address.");
        HttpUrl url = HttpUrl.parse(value);
        if (url == null || !url.isHttps() || !url.username().isEmpty() || !url.password().isEmpty()) {
            throw new IllegalArgumentException("Updates must come from an HTTPS address.");
        }
        return url;
    }

    static String digest(String value) {
        if (value == null || !value.matches("[0-9a-f]{64}")) throw new IllegalArgumentException("Invalid update checksum.");
        return value;
    }

    static String hex(byte[] bytes) {
        StringBuilder out = new StringBuilder(bytes.length * 2);
        for (byte value : bytes) out.append(String.format(Locale.ROOT, "%02x", value));
        return out.toString();
    }
}
