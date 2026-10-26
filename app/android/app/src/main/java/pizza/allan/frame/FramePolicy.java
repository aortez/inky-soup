package pizza.allan.frame;

import java.net.InetAddress;
import java.net.URI;
import java.net.URISyntaxException;
import java.util.Set;
import java.util.HashSet;
import java.util.Arrays;

/** Restrictions also apply to direct bridge calls, independently of UI validation. */
final class FramePolicy {
    private static final Set<String> GET = new HashSet<>(Arrays.asList("/api/device", "/api/display-config", "/api/images", "/api/flash/status"));
    private static final Set<String> POST = new HashSet<>(Arrays.asList("/upload", "/flash", "/api/upload-cache", "/api/upload-thumb",
        "/api/upload-dithered", "/api/lock-image", "/api/unlock-image", "/api/delete-image",
        "/api/settings/display-rotation", "/api/settings/photo-rotation", "/api/flash-test-card"));

    static boolean privateAddress(InetAddress address) {
        byte[] bytes = address.getAddress();
        if (bytes.length != 4) return false; // This milestone supports RFC1918 IPv4 and .local resolving to it.
        int first = bytes[0] & 255, second = bytes[1] & 255;
        return first == 10 || first == 172 && second >= 16 && second <= 31 || first == 192 && second == 168;
    }

    static String base(String value) throws Exception {
        URI uri = new URI(value);
        String host = uri.getHost();
        if (!("http".equals(uri.getScheme()) || "https".equals(uri.getScheme())) || host == null
            || uri.getUserInfo() != null || uri.getQuery() != null || uri.getFragment() != null
            || !(uri.getPath().isEmpty() || uri.getPath().equals("/")) || uri.getPort() == 0) {
            throw new IllegalArgumentException("Enter a local frame address with its port.");
        }
        if (!host.endsWith(".local") && !(host.matches("[0-9.]+") && privateAddress(InetAddress.getByName(host)))) {
            throw new IllegalArgumentException("Use a private WiFi IPv4 or .local frame address.");
        }
        return uri.getScheme() + "://" + host + (uri.getPort() < 0 ? "" : ":" + uri.getPort());
    }

    static void route(String method, String path) {
        boolean allowed = "POST".equals(method) && POST.contains(path)
            || "GET".equals(method) && (GET.contains(path) || path.matches("/api/flash/status/[0-9]+")
            || path.matches("/images/(thumbs/)?[^/?#]+"));
        String decoded;
        try {
            decoded = new URI(path).getPath();
        } catch (URISyntaxException error) {
            throw new IllegalArgumentException("Invalid frame API path.", error);
        }
        // Decode once, as the server does. Dots inside a filename are harmless;
        // complete dot segments and encoded separators can change its location.
        if (!allowed || decoded == null || decoded.indexOf('\\') >= 0 || decoded.indexOf('\0') >= 0
            || path.toLowerCase(java.util.Locale.ROOT).contains("%2f")) {
            throw new IllegalArgumentException("This operation is not a frame API route.");
        }
        for (String segment : decoded.split("/")) {
            if (segment.equals(".") || segment.equals("..")) {
                throw new IllegalArgumentException("This operation is not a frame API route.");
            }
        }
    }
}
