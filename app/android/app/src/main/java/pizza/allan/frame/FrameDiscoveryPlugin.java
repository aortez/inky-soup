package pizza.allan.frame;

import android.content.Context;
import android.net.nsd.NsdManager;
import android.net.nsd.NsdServiceInfo;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.net.InetAddress;
import java.util.ArrayDeque;
import java.util.HashSet;
import java.util.Set;

/** Short foreground scans. Advertisements are hints; JS verifies the identity API. */
@CapacitorPlugin(name = "FrameDiscovery")
public class FrameDiscoveryPlugin extends Plugin {
    private final Handler main = new Handler(Looper.getMainLooper());
    private NsdManager nsd;
    private Scan current;
    private final class Scan {
        PluginCall call;
        NsdManager.DiscoveryListener listener;
        final ArrayDeque<NsdServiceInfo> queue = new ArrayDeque<>();
        final Set<String> seen = new HashSet<>(), bases = new HashSet<>();
        final JSArray services = new JSArray();
        WifiManager.MulticastLock multicast;
        boolean resolving;
        NsdManager.ResolveListener resolver;
        Runnable timeout;
        Scan(PluginCall call) { this.call = call; }
    }

    @Override public void load() { nsd = (NsdManager)getContext().getSystemService(Context.NSD_SERVICE); }

    @PluginMethod public void discover(PluginCall call) {
        main.post(() -> {
            if (current != null) { call.reject("Discovery is already running."); return; }
            if (nsd == null) { call.reject("Local discovery is unavailable. Enter the frame address or use Bluetooth setup."); return; }
            Scan scan = new Scan(call); current = scan;
            scan.listener = new NsdManager.DiscoveryListener() {
                public void onDiscoveryStarted(String type) { }
                public void onDiscoveryStopped(String type) { }
                public void onStartDiscoveryFailed(String type, int code) { main.post(() -> finish(scan, "Local discovery could not start. Check WiFi and Android app permissions, then retry.")); }
                public void onStopDiscoveryFailed(String type, int code) { }
                public void onServiceLost(NsdServiceInfo service) { }
                public void onServiceFound(NsdServiceInfo service) {
                    main.post(() -> {
                        if (current != scan || scan.seen.size() >= 32 || !"_inky-soup._tcp.".equals(service.getServiceType()) && !"_inky-soup._tcp".equals(service.getServiceType())) return;
                        if (scan.seen.add(service.getServiceName())) { scan.queue.add(service); resolveNext(scan); }
                    });
                }
            };
            try {
                WifiManager wifi = (WifiManager)getContext().getApplicationContext().getSystemService(Context.WIFI_SERVICE);
                if (wifi != null) {
                    scan.multicast = wifi.createMulticastLock("frame-discovery");
                    scan.multicast.setReferenceCounted(false); scan.multicast.acquire();
                }
                nsd.discoverServices("_inky-soup._tcp.", NsdManager.PROTOCOL_DNS_SD, scan.listener);
                scan.timeout = () -> finish(scan, null);
                main.postDelayed(scan.timeout, 6500);
            } catch (SecurityException error) {
                finish(scan, "Allow local-network access in Android Settings, then retry discovery.");
            } catch (RuntimeException error) {
                finish(scan, "Local discovery is unavailable. Check WiFi or enter the frame address.");
            }
        });
    }

    @SuppressWarnings("deprecation") // API 24 compatibility; each foreground reconnect resolves afresh.
    private void resolveNext(Scan scan) {
        if (current != scan || scan.resolving || scan.queue.isEmpty()) return;
        scan.resolving = true;
        try {
            scan.resolver = new NsdManager.ResolveListener() {
                public void onResolveFailed(NsdServiceInfo service, int code) { main.post(() -> {scan.resolving = false; resolveNext(scan);}); }
                public void onServiceResolved(NsdServiceInfo service) {
                    main.post(() -> {
                        if (current != scan) return;
                        java.util.List<InetAddress> hosts = Build.VERSION.SDK_INT >= 34
                            ? service.getHostAddresses() : java.util.Collections.singletonList(service.getHost());
                        for (InetAddress host : hosts) {
                            if (host != null && FramePolicy.privateAddress(host) && service.getPort() > 0 && service.getPort() <= 65535) {
                                String base = "http://" + host.getHostAddress() + ":" + service.getPort();
                                if (scan.bases.add(base)) scan.services.put(new JSObject().put("base", base).put("name", service.getServiceName()));
                            }
                        }
                        scan.resolving = false; resolveNext(scan);
                    });
                }
            };
            nsd.resolveService(scan.queue.remove(), scan.resolver);
        } catch (SecurityException error) {
            finish(scan, "Allow local-network access in Android Settings, then retry discovery.");
        } catch (RuntimeException error) { scan.resolving = false; resolveNext(scan); }
    }

    private void finish(Scan scan, String error) {
        if (current != scan) return;
        current = null;
        if (scan.timeout != null) main.removeCallbacks(scan.timeout);
        if (Build.VERSION.SDK_INT >= 34 && scan.resolving && scan.resolver != null) {
            try { nsd.stopServiceResolution(scan.resolver); } catch (RuntimeException ignored) { }
        }
        try { nsd.stopServiceDiscovery(scan.listener); } catch (RuntimeException ignored) { }
        if (scan.multicast != null && scan.multicast.isHeld()) scan.multicast.release();
        if (error == null) scan.call.resolve(new JSObject().put("services", scan.services));
        else scan.call.reject(error);
    }

    @Override protected void handleOnPause() { main.post(() -> {if (current != null) finish(current, "Discovery paused. Return to the app to reconnect.");}); }
    @Override protected void handleOnDestroy() { main.post(() -> {if (current != null) finish(current, "Discovery cancelled.");}); }
}
