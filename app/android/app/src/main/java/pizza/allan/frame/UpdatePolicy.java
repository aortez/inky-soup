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

    /** Bridge numbers arrive as Integer, Long, or Double depending on their magnitude and form. */
    static long size(Object value) {
        if (value instanceof Integer || value instanceof Long) {
            long size = ((Number)value).longValue();
            if (size >= 1 && size <= MAXIMUM_APK) return size;
        } else if (value instanceof Double) {
            double size = (Double)value;
            if (size >= 1 && size <= MAXIMUM_APK && size == Math.rint(size)) return (long)size;
        }
        throw new IllegalArgumentException("Invalid update size.");
    }

    /** Why a downloaded package must not reach the installer, or null when it is this app's own newer build. */
    static String archiveProblem(String installedPackage, long installedCode, String installedDigest,
                                 String archivePackage, long archiveCode, String archiveDigest) {
        if (archivePackage == null || archiveDigest == null) return "The downloaded file is not a readable app package. Download the update again.";
        if (!installedPackage.equals(archivePackage)) return "The downloaded package is not this app, so it was not installed.";
        if (!installedDigest.equals(archiveDigest)) return "The downloaded package was signed with a different key, so it was not installed.";
        if (archiveCode <= installedCode) return "The downloaded package is not newer than the installed app.";
        return null;
    }

    static String hex(byte[] bytes) {
        StringBuilder out = new StringBuilder(bytes.length * 2);
        for (byte value : bytes) out.append(String.format(Locale.ROOT, "%02x", value));
        return out.toString();
    }
}
