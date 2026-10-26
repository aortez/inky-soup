package pizza.allan.frame;

import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
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

    @Test public void readBridgeSizesInEveryNumericFormTheMessageParserProduces() throws Exception {
        // A JavaScript number crosses the bridge as the smallest fitting Java type.
        PluginCall call = new PluginCall(null, "FrameUpdate", "callback", "download", new JSObject("{\"size\":8200000,\"url\":\"https://x\"}"));
        assertEquals(8200000L, UpdatePolicy.size(call.getData().opt("size")));
        assertEquals(8200000L, UpdatePolicy.size(8200000));
        assertEquals(8200000L, UpdatePolicy.size(8200000L));
        assertEquals(8200000L, UpdatePolicy.size(8200000.0));
        assertEquals(UpdatePolicy.MAXIMUM_APK, UpdatePolicy.size(UpdatePolicy.MAXIMUM_APK));
        for (Object value : new Object[]{null, 0, -1, UpdatePolicy.MAXIMUM_APK + 1, 8200000.5, "8200000", Boolean.TRUE}) {
            assertThrows(String.valueOf(value), IllegalArgumentException.class, () -> UpdatePolicy.size(value));
        }
    }

    @Test public void installOnlyThisAppsOwnNewerBuildSignedWithTheInstalledKey() {
        String key = "a".repeat(64);
        assertNull(UpdatePolicy.archiveProblem("pizza.allan.frame", 1000, key, "pizza.allan.frame", 2000, key));
        assertTrue(UpdatePolicy.archiveProblem("pizza.allan.frame", 1000, key, null, 0, null).contains("not a readable"));
        assertTrue(UpdatePolicy.archiveProblem("pizza.allan.frame", 1000, key, "com.example.other", 2000, key).contains("not this app"));
        assertTrue(UpdatePolicy.archiveProblem("pizza.allan.frame", 1000, key, "pizza.allan.frame", 2000, "b".repeat(64)).contains("different key"));
        assertTrue(UpdatePolicy.archiveProblem("pizza.allan.frame", 1000, key, "pizza.allan.frame", 1000, key).contains("not newer"));
        assertTrue(UpdatePolicy.archiveProblem("pizza.allan.frame", 2000, key, "pizza.allan.frame", 1000, key).contains("not newer"));
    }
}
