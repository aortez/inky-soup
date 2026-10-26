package pizza.allan.frame;

import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import okhttp3.Call;
import okhttp3.OkHttpClient;
import okhttp3.mockwebserver.MockResponse;
import okhttp3.mockwebserver.MockWebServer;
import okio.Buffer;
import org.junit.Test;
import static org.junit.Assert.*;

public class UpdateStoreTest {
    private static final byte[] PACKAGE = new byte[700 * 1024];
    static { for (int i = 0; i < PACKAGE.length; i++) PACKAGE[i] = (byte)(i * 31); }

    private static String digest(byte[] bytes) throws Exception {
        return UpdatePolicy.hex(MessageDigest.getInstance("SHA-256").digest(bytes));
    }

    private static File temporary() throws IOException {
        return Files.createTempDirectory("frame-updates").toFile();
    }

    private static MockResponse body(byte[] bytes) {
        return new MockResponse().setBody(new Buffer().write(bytes)).setHeader("Content-Type", "application/vnd.android.package-archive");
    }

    @Test public void downloadVerifiesLengthAndDigestAndReportsProgress() throws Exception {
        File directory = temporary();
        UpdateStore store = new UpdateStore(directory);
        OkHttpClient client = UpdateHttp.create();
        List<Long> progress = new ArrayList<>();
        try (MockWebServer server = new MockWebServer()) {
            server.enqueue(new MockResponse().setResponseCode(302).setHeader("Location", "/objects/frame.apk"));
            server.enqueue(body(PACKAGE));
            String sha256 = digest(PACKAGE);
            File file = store.download(client, server.url("/frame.apk"), PACKAGE.length, sha256, call -> {}, progress::add);
            assertEquals(sha256 + ".apk", file.getName());
            assertArrayEquals(PACKAGE, Files.readAllBytes(file.toPath()));
            assertEquals(Long.valueOf(PACKAGE.length), progress.get(progress.size() - 1));
            assertTrue(progress.size() >= 2);
            assertEquals(sha256, store.downloaded());
            assertEquals(file, store.verified(sha256));
            assertEquals(1, directory.list().length);
            // A second download replaces the retained package.
            byte[] other = new byte[1000];
            server.enqueue(body(other));
            store.download(client, server.url("/frame.apk"), other.length, digest(other), call -> {}, progress::add);
            assertEquals(digest(other), store.downloaded());
            assertEquals(1, directory.list().length);
        }
    }

    @Test public void mismatchedBodiesStatusesAndSizesLeaveNoPackageBehind() throws Exception {
        File directory = temporary();
        UpdateStore store = new UpdateStore(directory);
        OkHttpClient client = UpdateHttp.create();
        try (MockWebServer server = new MockWebServer()) {
            String sha256 = digest(PACKAGE);
            server.enqueue(body(PACKAGE));
            assertEquals(UpdateStore.MISMATCH, assertThrows(IOException.class, () -> store.download(client, server.url("/frame.apk"), PACKAGE.length - 1, sha256, call -> {}, received -> {})).getMessage());
            server.enqueue(body(PACKAGE));
            assertEquals(UpdateStore.MISMATCH, assertThrows(IOException.class, () -> store.download(client, server.url("/frame.apk"), PACKAGE.length + 1, sha256, call -> {}, received -> {})).getMessage());
            server.enqueue(body(PACKAGE));
            assertEquals(UpdateStore.MISMATCH, assertThrows(IOException.class, () -> store.download(client, server.url("/frame.apk"), PACKAGE.length, "c".repeat(64), call -> {}, received -> {})).getMessage());
            server.enqueue(new MockResponse().setResponseCode(503));
            assertTrue(assertThrows(IOException.class, () -> store.download(client, server.url("/frame.apk"), PACKAGE.length, sha256, call -> {}, received -> {})).getMessage().contains("503"));
            // An oversized release is refused before any request is made.
            assertThrows(IOException.class, () -> store.download(client, server.url("/frame.apk"), UpdatePolicy.MAXIMUM_APK + 1, sha256, call -> {}, received -> {}));
            assertEquals(4, server.getRequestCount());
            assertNull(store.downloaded());
            assertEquals(0, directory.list().length);
            assertThrows(IOException.class, () -> store.verified(sha256));
        }
    }

    @Test public void cancellationStopsTheStreamAndIsReportedAsCancelled() throws Exception {
        UpdateStore store = new UpdateStore(temporary());
        OkHttpClient client = UpdateHttp.create();
        AtomicReference<Call> started = new AtomicReference<>();
        try (MockWebServer server = new MockWebServer()) {
            server.enqueue(body(PACKAGE).throttleBody(64 * 1024, 200, TimeUnit.MILLISECONDS));
            Thread canceller = new Thread(() -> {
                try { Thread.sleep(300); } catch (InterruptedException ignored) { }
                Call call = started.get();
                if (call != null) call.cancel();
            });
            canceller.start();
            IOException error = assertThrows(IOException.class, () -> store.download(client, server.url("/frame.apk"), PACKAGE.length, digest(PACKAGE), started::set, received -> {}));
            canceller.join();
            assertEquals(UpdateStore.CANCELLED, error.getMessage());
            assertNull(store.downloaded());
        }
    }

    @Test public void retainedPackagesAreRehashedBeforeInstallationAndPartsAreDiscardedAtStartup() throws Exception {
        File directory = temporary();
        String sha256 = digest(PACKAGE);
        Files.write(new File(directory, sha256 + ".apk").toPath(), PACKAGE);
        Files.write(new File(directory, "abandoned.part").toPath(), new byte[10]);
        UpdateStore store = new UpdateStore(directory);
        assertEquals(sha256, store.downloaded());
        assertEquals(new File(directory, sha256 + ".apk"), store.retained());
        assertFalse(new File(directory, "abandoned.part").exists());
        assertEquals(PACKAGE.length, store.verified(sha256).length());
        byte[] altered = PACKAGE.clone();
        altered[5] ^= 1;
        Files.write(new File(directory, sha256 + ".apk").toPath(), altered);
        assertTrue(assertThrows(IOException.class, () -> store.verified(sha256)).getMessage().contains("Download it again"));
        assertNull(store.downloaded());
        store.clear();
        assertEquals(0, directory.list().length);
    }
}
