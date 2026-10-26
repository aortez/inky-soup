package pizza.allan.frame;

import java.io.IOException;
import okhttp3.Dns;
import okhttp3.OkHttpClient;
import okhttp3.mockwebserver.MockResponse;
import okhttp3.mockwebserver.MockWebServer;
import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;

public class UpdateManifestTest {
    static final String DIGEST = "b".repeat(64), KEY = "a".repeat(64);

    static JSONObject release() throws Exception {
        return new JSONObject().put("application_id", "pizza.allan.frame").put("version_name", "0.2.0").put("version_code", 2000)
            .put("min_sdk", 24).put("apk_url", "https://github.com/aortez/inky-soup/releases/download/app-v0.2.0/frame.apk")
            .put("apk_sha256", DIGEST).put("apk_size", 8200000).put("signing_sha256", KEY).put("notes", "  Faster gallery.  ")
            .put("release_url", "https://github.com/aortez/inky-soup/releases/tag/app-v0.2.0");
    }

    @Test public void parseValidatesAndNormalizesEveryField() throws Exception {
        UpdateManifest manifest = UpdateManifest.parse(release().toString());
        assertEquals("pizza.allan.frame", manifest.applicationId);
        assertEquals("0.2.0", manifest.versionName);
        assertEquals(2000, manifest.versionCode);
        assertEquals(24, manifest.minSdk);
        assertEquals(8200000, manifest.apkSize);
        assertEquals(DIGEST, manifest.apkSha256);
        assertEquals(KEY, manifest.signingSha256);
        assertEquals("Faster gallery.", manifest.notes);
        assertEquals("https://github.com/aortez/inky-soup/releases/tag/app-v0.2.0", manifest.releaseUrl);
        assertEquals("", UpdateManifest.parse(release().put("notes", JSONObject.NULL).toString()).notes);
        JSONObject without = release();
        without.remove("notes");
        without.remove("release_url");
        assertEquals("", UpdateManifest.parse(without.toString()).notes);
        assertEquals("", UpdateManifest.parse(without.toString()).releaseUrl);
        assertEquals("", UpdateManifest.parse(release().put("release_url", JSONObject.NULL).toString()).releaseUrl);
        assertEquals(UpdatePolicy.MAXIMUM_NOTES, UpdateManifest.parse(release().put("notes", "n".repeat(1200)).toString()).notes.length());
    }

    @Test public void rejectMalformedReleasesWithOneUserFacingMessage() throws Exception {
        Object[][] patches = {{"apk_url", "http://github.com/frame.apk"}, {"apk_sha256", DIGEST.toUpperCase()}, {"apk_size", 0},
            {"apk_size", 65L * 1024 * 1024}, {"version_name", "0.2"}, {"version_code", "2000"}, {"version_code", 2.5}, {"min_sdk", 0},
            {"application_id", "frame"}, {"signing_sha256", JSONObject.NULL}, {"release_url", "http://github.com"}, {"notes", 5}};
        for (Object[] patch : patches) {
            JSONObject json = release().put((String)patch[0], patch[1]);
            IOException error = assertThrows(IOException.class, () -> UpdateManifest.parse(json.toString()));
            assertEquals(json.toString(), UpdateManifest.UNREADABLE, error.getMessage());
        }
        for (String text : new String[]{"", "[]", "{", "null", "{\"version_name\":\"0.2.0\"}"}) {
            assertEquals(UpdateManifest.UNREADABLE, assertThrows(IOException.class, () -> UpdateManifest.parse(text)).getMessage());
        }
    }

    @Test public void fetchFollowsSameProtocolRedirectsAndBoundsTheBody() throws Exception {
        OkHttpClient client = UpdateHttp.create();
        try (MockWebServer server = new MockWebServer()) {
            server.enqueue(new MockResponse().setResponseCode(302).setHeader("Location", "/moved/frame-release.json"));
            server.enqueue(new MockResponse().setBody(release().toString()).setHeader("Content-Type", "application/json"));
            UpdateManifest manifest = UpdateManifest.fetch(client, server.url("/frame-release.json"));
            assertEquals(2000, manifest.versionCode);
            assertEquals(2, server.getRequestCount());
            server.enqueue(new MockResponse().setResponseCode(404));
            assertTrue(assertThrows(IOException.class, () -> UpdateManifest.fetch(client, server.url("/frame-release.json"))).getMessage().contains("404"));
            server.enqueue(new MockResponse().setBody("{\"notes\":\"" + "x".repeat(UpdatePolicy.MAXIMUM_MANIFEST) + "\"}"));
            assertEquals(UpdateManifest.UNREADABLE, assertThrows(IOException.class, () -> UpdateManifest.fetch(client, server.url("/frame-release.json"))).getMessage());
        }
    }

    @Test public void clientNeverFollowsAProtocolChangeAndUsesSystemDns() {
        OkHttpClient client = UpdateHttp.create();
        assertTrue(client.followRedirects());
        assertFalse(client.followSslRedirects());
        assertSame(Dns.SYSTEM, client.dns());
    }
}
