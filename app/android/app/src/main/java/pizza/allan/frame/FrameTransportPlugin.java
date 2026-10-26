package pizza.allan.frame;

import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.*;
import java.net.*;
import java.util.*;
import java.util.concurrent.*;
import okhttp3.*;

/** Bounded bridge messages; photo bodies are streamed from private temporary files. */
@CapacitorPlugin(name = "FrameTransport")
public class FrameTransportPlugin extends Plugin {
    private static final int CHUNK = 64 * 1024, LIMIT = 24 * 1024 * 1024;
    private final Map<String, File> files = new HashMap<>();
    private final Map<String, Call> calls = new ConcurrentHashMap<>();
    private final ExecutorService io = Executors.newFixedThreadPool(4);
    private File directory;
    private volatile String selected;
    private OkHttpClient client;

    @Override public void load() {
        directory = new File(getContext().getCacheDir(), "frame-transfers");
        directory.mkdirs();
        File[] abandoned = directory.listFiles();
        if (abandoned != null) for (File file : abandoned) file.delete();
        client = FrameHttp.create(host -> {
                List<InetAddress> local = new ArrayList<>();
                for (InetAddress address : InetAddress.getAllByName(host)) {
                    if (FramePolicy.privateAddress(address)) local.add(address);
                }
                if (local.isEmpty()) throw new UnknownHostException("Frame must resolve to a private WiFi IPv4 address.");
                return local; // OkHttp connects to these validated addresses, without a second DNS lookup.
            });
    }

    @PluginMethod public void select(PluginCall call) {
        try { selected = FramePolicy.base(call.getString("base")); call.resolve(); }
        catch (Exception error) { fail(call, error); }
    }

    private synchronized String createFile() throws IOException {
        long cutoff = System.currentTimeMillis() - TimeUnit.MINUTES.toMillis(10);
        Iterator<Map.Entry<String, File>> entries = files.entrySet().iterator();
        while (entries.hasNext()) {
            File stale = entries.next().getValue();
            if (stale.lastModified() < cutoff) { stale.delete(); entries.remove(); }
        }
        if (files.size() >= 12) throw new IOException("Too many photo transfers. Wait and try again.");
        String id = UUID.randomUUID().toString();
        File file = new File(directory, id);
        if (!file.createNewFile()) throw new IOException("Could not stage photo.");
        files.put(id, file);
        return id;
    }

    private synchronized File file(String id) throws IOException {
        File value = files.get(id);
        if (value == null) throw new IOException("Photo transfer expired. Please try again.");
        return value;
    }

    private synchronized void remove(String id) {
        File value = files.remove(id);
        if (value != null) value.delete();
    }

    @PluginMethod public void create(PluginCall call) {
        try { call.resolve(new JSObject().put("id", createFile())); }
        catch (Exception error) { fail(call, error); }
    }

    @PluginMethod public void append(PluginCall call) {
        try {
            String data = call.getString("data", "");
            if (data.length() > (CHUNK + 2) / 3 * 4) throw new IOException("Photo transfer chunk too large.");
            byte[] bytes = Base64.decode(data, Base64.NO_WRAP);
            File target = file(call.getString("id"));
            if (bytes.length > CHUNK || target.length() + bytes.length > LIMIT) throw new IOException("Choose a photo under 20 MB.");
            try (OutputStream out = new FileOutputStream(target, true)) { out.write(bytes); }
            call.resolve();
        } catch (Exception error) { fail(call, error); }
    }

    @PluginMethod public void read(PluginCall call) {
        try (RandomAccessFile source = new RandomAccessFile(file(call.getString("id")), "r")) {
            int offset = call.getInt("offset", 0);
            if (offset < 0 || offset > source.length()) throw new IOException("Invalid photo offset.");
            source.seek(offset);
            byte[] bytes = new byte[(int)Math.min(CHUNK, source.length() - offset)];
            source.readFully(bytes);
            call.resolve(new JSObject().put("data", Base64.encodeToString(bytes, Base64.NO_WRAP)));
        } catch (Exception error) { fail(call, error); }
    }

    @PluginMethod public void release(PluginCall call) { remove(call.getString("id")); call.resolve(); }

    @PluginMethod public void cancel(PluginCall call) {
        Call request = calls.get(call.getString("id"));
        if (request != null) request.cancel();
        call.resolve();
    }

    @PluginMethod public void request(PluginCall call) {
        String id = call.getString("id");
        try {
            String base = FramePolicy.base(call.getString("base"));
            if (!base.equals(selected)) throw new IOException("Select this frame before connecting.");
            String method = call.getString("method", "GET"), path = call.getString("path", "");
            FramePolicy.route(method, path);
            String type = call.getString("contentType", "application/octet-stream");
            RequestBody body = null;
            if (method.equals("POST")) {
                body = RequestBody.create(file(call.getString("bodyId")), MediaType.parse(type));
            }
            Request request = new Request.Builder().url(base + path).method(method, body)
                .header("Accept", call.getBoolean("binary", false) ? "image/*" : "application/json").build();
            Call transfer = client.newCall(request);
            transfer.timeout().timeout(Math.max(1, Math.min(60000, call.getInt("timeout", 60000))), TimeUnit.MILLISECONDS);
            if (id == null || calls.size() >= 8 || calls.putIfAbsent(id, transfer) != null) {
                throw new IOException("Too many active frame requests.");
            }
            io.execute(() -> {
                String responseId = null;
                try (Response response = transfer.execute()) {
                    responseId = createFile();
                    int limit = call.getBoolean("binary", false) && response.isSuccessful() ? LIMIT : 2 * 1024 * 1024;
                    int size = 0;
                    try (InputStream in = response.body().byteStream(); OutputStream out = new FileOutputStream(file(responseId))) {
                        byte[] bytes = new byte[CHUNK];
                        int count;
                        while ((count = in.read(bytes)) != -1) {
                            size += count;
                            if (size > limit) throw new IOException("The frame response is too large.");
                            out.write(bytes, 0, count);
                        }
                    }
                    if (transfer.isCanceled()) throw new IOException("Frame request cancelled.");
                    call.resolve(new JSObject().put("id", responseId).put("size", size)
                        .put("status", response.code()).put("contentType", response.header("Content-Type", "application/octet-stream")));
                    responseId = null; // JS owns this handle until release; no paths cross the bridge.
                } catch (Exception error) { fail(call, error); }
                finally { if (responseId != null) remove(responseId); calls.remove(id); }
            });
        } catch (Exception error) { fail(call, error); }
    }

    private void fail(PluginCall call, Exception error) {
        String message = error instanceof SecurityException || error instanceof SocketException && String.valueOf(error.getMessage()).contains("EPERM")
            ? "Allow local-network access in Android Settings, then reconnect."
            : error instanceof InterruptedIOException
            ? "Frame request timed out. Check WiFi and local-network access, then reconnect. A display request may already have started."
            : error instanceof ConnectException || error instanceof UnknownHostException
            ? "Cannot reach the frame. Check its address and use the same WiFi, then reconnect."
            : error.getMessage();
        call.reject(message == null ? "Frame transfer failed. Reconnect and try again." : message, error);
    }

    @Override protected void handleOnDestroy() {
        for (Call call : calls.values()) call.cancel();
        io.shutdownNow();
        synchronized (this) { for (File file : files.values()) file.delete(); files.clear(); }
    }
}
