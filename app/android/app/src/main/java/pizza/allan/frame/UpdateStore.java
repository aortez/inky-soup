package pizza.allan.frame;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;
import java.util.function.LongConsumer;
import okhttp3.Call;
import okhttp3.HttpUrl;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;

/** One verified release package at a time, kept in app-private storage until Android installs it. */
final class UpdateStore {
    static final String MISMATCH = "The downloaded update did not match the release. Try again.";
    static final String CANCELLED = "Download cancelled.";
    private static final int CHUNK = 64 * 1024, REPORT = 256 * 1024;
    private final File directory;

    UpdateStore(File directory) {
        this.directory = directory;
        directory.mkdirs();
        File[] leftovers = directory.listFiles();
        if (leftovers != null) for (File file : leftovers) if (file.getName().endsWith(".part")) file.delete();
    }

    /** The retained package, or null. The file is hashed again before installation. */
    synchronized File retained() {
        File[] files = directory.listFiles();
        if (files == null) return null;
        for (File file : files) {
            String name = file.getName();
            if (name.length() == 68 && name.endsWith(".apk") && file.length() > 0) return file;
        }
        return null;
    }

    /** The checksum encoded in the retained package name, or null. */
    String downloaded() {
        File file = retained();
        return file == null ? null : file.getName().substring(0, 64);
    }

    synchronized void clear() {
        File[] files = directory.listFiles();
        if (files != null) for (File file : files) file.delete();
    }

    File download(OkHttpClient client, HttpUrl url, long size, String sha256, Consumer<Call> started, LongConsumer progress) throws IOException {
        if (size <= 0 || size > UpdatePolicy.MAXIMUM_APK) throw new IOException("The update is too large to download.");
        clear();
        File partial = new File(directory, sha256 + ".part"), target = new File(directory, sha256 + ".apk");
        Call call = client.newCall(new Request.Builder().url(url).header("Accept", "application/vnd.android.package-archive, */*").build());
        call.timeout().timeout(10, TimeUnit.MINUTES);
        started.accept(call);
        try (Response response = call.execute()) {
            if (!response.isSuccessful()) throw new IOException("The update server answered with status " + response.code() + ". Try again later.");
            MessageDigest digest = sha256();
            long received = 0, reported = 0;
            try (InputStream in = response.body().byteStream(); OutputStream out = new FileOutputStream(partial)) {
                byte[] bytes = new byte[CHUNK];
                int count;
                while ((count = in.read(bytes)) != -1) {
                    received += count;
                    if (received > size) throw new IOException(MISMATCH);
                    digest.update(bytes, 0, count);
                    out.write(bytes, 0, count);
                    if (received - reported >= REPORT || received == size) { reported = received; progress.accept(received); }
                }
            }
            if (call.isCanceled()) throw new IOException(CANCELLED);
            if (received != size || !UpdatePolicy.hex(digest.digest()).equals(sha256)) throw new IOException(MISMATCH);
            if (!partial.renameTo(target)) throw new IOException("Could not keep the downloaded update. Free some storage and try again.");
            return target;
        } catch (IOException error) {
            partial.delete();
            throw call.isCanceled() ? new IOException(CANCELLED, error) : error;
        }
    }

    /** Hashes the retained package again so a truncated or altered file is never handed to the installer. */
    synchronized File verified(String sha256) throws IOException {
        File file = new File(directory, sha256 + ".apk");
        if (!file.isFile()) throw new IOException("Download the update again before installing it.");
        MessageDigest digest = sha256();
        try (InputStream in = new FileInputStream(file)) {
            byte[] bytes = new byte[CHUNK];
            int count;
            while ((count = in.read(bytes)) != -1) digest.update(bytes, 0, count);
        }
        if (!UpdatePolicy.hex(digest.digest()).equals(sha256)) {
            file.delete();
            throw new IOException("The saved update no longer matches the release. Download it again.");
        }
        return file;
    }

    private static MessageDigest sha256() throws IOException {
        try { return MessageDigest.getInstance("SHA-256"); }
        catch (NoSuchAlgorithmException error) { throw new IOException("SHA-256 is unavailable on this phone.", error); }
    }
}
