package pizza.allan.frame;

import java.util.concurrent.TimeUnit;
import okhttp3.OkHttpClient;

/** Release downloads follow HTTPS redirects only; a redirect that changes protocol is never followed. */
final class UpdateHttp {
    private UpdateHttp() { }

    static OkHttpClient create() {
        return new OkHttpClient.Builder().followRedirects(true).followSslRedirects(false)
            .connectTimeout(15, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS).writeTimeout(30, TimeUnit.SECONDS)
            .build();
    }
}
