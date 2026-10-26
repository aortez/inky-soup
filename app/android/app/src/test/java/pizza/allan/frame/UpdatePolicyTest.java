package pizza.allan.frame;

import org.junit.Test;
import static org.junit.Assert.*;

public class UpdatePolicyTest {
    @Test public void acceptOnlyPlainHttpsAddressesAndLowercaseDigests() {
        assertEquals("https://github.com/aortez/inky-soup/releases/download/frame-app/frame.apk",
            UpdatePolicy.url("https://github.com/aortez/inky-soup/releases/download/frame-app/frame.apk").toString());
        for (String value : new String[]{null, "http://github.com/frame.apk", "https://user:pw@github.com/frame.apk", "ftp://github.com/frame.apk",
            "github.com/frame.apk", "https://" + "a".repeat(2048)}) {
            assertThrows(IllegalArgumentException.class, () -> UpdatePolicy.url(value));
        }
        String digest = "0123456789abcdef".repeat(4);
        assertEquals(digest, UpdatePolicy.digest(digest));
        for (String value : new String[]{null, digest.toUpperCase(), digest.substring(1), digest + "0", "g".repeat(64)}) {
            assertThrows(IllegalArgumentException.class, () -> UpdatePolicy.digest(value));
        }
        assertEquals("00ff7f80", UpdatePolicy.hex(new byte[]{0, (byte)0xff, 0x7f, (byte)0x80}));
    }
}
