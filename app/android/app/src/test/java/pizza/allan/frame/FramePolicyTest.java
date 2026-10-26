package pizza.allan.frame;

import java.net.InetAddress;
import org.junit.Test;
import static org.junit.Assert.*;

public class FramePolicyTest {
    @Test public void restrictDestinationsAndResolvedAddresses() throws Exception {
        for (String ip : new String[]{"10.55.0.1", "192.168.1.149", "172.16.1.2", "172.31.255.1"}) {
            assertTrue(FramePolicy.privateAddress(InetAddress.getByName(ip)));
            assertEquals("http://" + ip + ":8000", FramePolicy.base("http://" + ip + ":8000"));
        }
        for (String ip : new String[]{"127.0.0.1", "169.254.1.1", "8.8.8.8", "172.32.0.1", "::1"}) {
            assertFalse(FramePolicy.privateAddress(InetAddress.getByName(ip)));
        }
        for (String base : new String[]{"http://example.com:8000", "file:///etc/passwd", "http://user@192.168.1.2:8000",
            "http://192.168.1.2:8000/path", "http://192.168.1.2:8000?x=1"}) {
            assertThrows(Exception.class, () -> FramePolicy.base(base));
        }
        assertEquals("http://inky-soup.local:8000", FramePolicy.base("http://inky-soup.local:8000"));
    }

    @Test public void allowOnlyDeviceOperationsWithoutTraversalOrRedirectDestinations() {
        FramePolicy.route("GET", "/api/device");
        assertThrows(IllegalArgumentException.class, () -> FramePolicy.route("POST", "/api/device"));
        FramePolicy.route("POST", "/api/settings/photo-rotation");
        FramePolicy.route("GET", "/images/Fr%C3%B8lich.jpg");
        FramePolicy.route("GET", "/api/flash/status/123");
        for (String path : new String[]{"/", "//example.com", "/images/../secret", "/images/%2e%2e",
            "/images/%2Fsecret", "/images/a?redirect=1", "/images/a#hash", "/api/admin"}) {
            assertThrows(IllegalArgumentException.class, () -> FramePolicy.route("GET", path));
        }
        assertThrows(IllegalArgumentException.class, () -> FramePolicy.route("DELETE", "/api/images"));
    }

    @Test public void allowRepeatedDotsInsideOriginalAndThumbnailNames() {
        for (String name : new String[]{"holiday..jpg", "holiday%2E%2Ejpg", "a...b.png", "Fr%C3%B8lich..jpg"}) {
            FramePolicy.route("GET", "/images/" + name);
            FramePolicy.route("GET", "/images/thumbs/" + name + ".png");
        }
    }

    @Test public void rejectTraversalSegmentsAndEncodedSeparators() {
        for (String name : new String[]{".", "..", "%2e", "%2E%2e", ".%2e", "%2e.",
            "../secret", "%2e%2e%2fsecret", "a%2Fb.jpg", "a%5cb.jpg", "a\\b.jpg", "%00.jpg", "%broken"}) {
            for (String prefix : new String[]{"/images/", "/images/thumbs/"}) {
                assertThrows(prefix + name, IllegalArgumentException.class,
                    () -> FramePolicy.route("GET", prefix + name));
            }
        }
    }
}
