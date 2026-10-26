package pizza.allan.frame;

import java.io.IOException;
import java.util.concurrent.TimeUnit;
import okhttp3.*;
import okhttp3.mockwebserver.*;
import org.junit.Test;
import static org.junit.Assert.*;

public class FrameHttpTest {
    @Test public void neverRepeatsPostOnRetryAfterOrRedirect() throws Exception {
        try (MockWebServer server = new MockWebServer()) {
            OkHttpClient client = FrameHttp.create(Dns.SYSTEM);
            server.enqueue(new MockResponse().setResponseCode(503).setHeader("Retry-After", "0"));
            server.enqueue(new MockResponse().setBody("must not be requested"));
            Request request = new Request.Builder().url(server.url("/flash"))
                .post(RequestBody.create("image", MediaType.get("text/plain"))).build();
            assertThrows(IOException.class, () -> client.newCall(request).execute());
            assertEquals(1, server.getRequestCount());
        }
        try (MockWebServer server = new MockWebServer()) {
            server.enqueue(new MockResponse().setResponseCode(307).setHeader("Location", "/other"));
            try (Response response = FrameHttp.create(Dns.SYSTEM).newCall(new Request.Builder()
                .url(server.url("/flash")).post(RequestBody.create("x", null)).build()).execute()) {
                assertEquals(307, response.code());
            }
            assertEquals(1, server.getRequestCount());
        }
    }

    @Test public void totalDeadlineAndCancellationStopSlowResponses() throws Exception {
        try (MockWebServer server = new MockWebServer()) {
            server.enqueue(new MockResponse().setBody("slow").setBodyDelay(1, TimeUnit.SECONDS));
            Call call = FrameHttp.create(Dns.SYSTEM).newCall(new Request.Builder().url(server.url("/api/images")).build());
            call.timeout().timeout(100, TimeUnit.MILLISECONDS);
            assertThrows(IOException.class, () -> {try (Response response = call.execute()) {response.body().string();}});
            assertEquals(1, server.getRequestCount());
            Call cancelled = FrameHttp.create(Dns.SYSTEM).newCall(new Request.Builder().url(server.url("/api/images")).build());
            cancelled.cancel();
            assertThrows(IOException.class, cancelled::execute);
            assertEquals(1, server.getRequestCount());
        }
    }
}
