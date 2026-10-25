package pizza.allan.frame;

import java.io.IOException;
import java.net.Proxy;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import okhttp3.*;

final class FrameHttp {
    static OkHttpClient create(Dns dns) {
        return new OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
            .retryOnConnectionFailure(false).proxy(Proxy.NO_PROXY).dns(dns)
            .connectTimeout(10, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS)
            .writeTimeout(30, TimeUnit.SECONDS).callTimeout(60, TimeUnit.SECONDS)
            .addInterceptor(chain -> chain.proceed(chain.request().newBuilder()
                .tag(AtomicBoolean.class, new AtomicBoolean()).build()))
            .addNetworkInterceptor(chain -> {
                // Also prevent HTTP follow-ups such as 503 + Retry-After: 0.
                // A display submission must have exactly one on-wire attempt.
                if (!chain.request().tag(AtomicBoolean.class).compareAndSet(false, true)) {
                    throw new IOException("The frame requested a retry. Check its status before submitting again.");
                }
                return chain.proceed(chain.request());
            }).build();
    }
}
