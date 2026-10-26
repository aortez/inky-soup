package pizza.allan.frame;

import android.Manifest;
import android.annotation.SuppressLint;
import android.bluetooth.*;
import android.bluetooth.le.*;
import android.content.*;
import android.location.LocationManager;
import android.net.Uri;
import android.os.*;
import android.provider.Settings;
import android.util.Base64;
import com.getcapacitor.*;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.util.*;

/** One selected Improv peripheral, one outstanding ATT operation, all state on the main thread. */
@CapacitorPlugin(name = "FrameBle", permissions = {
    @Permission(alias = "nearby", strings = {Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT}),
    @Permission(alias = "location", strings = {Manifest.permission.ACCESS_FINE_LOCATION})
})
public class FrameBlePlugin extends Plugin {
    private static final UUID SERVICE = UUID.fromString("00467768-6228-2272-4663-277478268000");
    private static final UUID CCC = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb");
    private final Handler main = new Handler(Looper.getMainLooper());
    private Session current;
    private PluginCall permissionCall;
    private final BroadcastReceiver radio = new BroadcastReceiver() {
        @Override public void onReceive(Context context, Intent intent) {
            if (intent.getIntExtra(BluetoothAdapter.EXTRA_STATE, -1) == BluetoothAdapter.STATE_OFF && current != null)
                fail(current, "Bluetooth is off. Turn it on, then scan again.");
        }
    };

    private static UUID uuid(int suffix) { return UUID.fromString("00467768-6228-2272-4663-27747826800" + suffix); }
    private static class Session {
        final String id;
        final Map<String, BluetoothDevice> devices = new LinkedHashMap<>();
        final List<BluetoothGattCharacteristic> subscriptions = new ArrayList<>();
        BluetoothLeScanner scanner;
        ScanCallback scan;
        BluetoothGatt gatt;
        PluginCall pending;
        String operation, stage = "link";
        Runnable deadline, scanDeadline, windowDeadline;
        int mtu = 23, subscription;
        Session(String id) { this.id = id; }
    }

    @Override public void load() {
        getContext().registerReceiver(radio, new IntentFilter(BluetoothAdapter.ACTION_STATE_CHANGED));
    }

    private String permission() { return Build.VERSION.SDK_INT >= 31 ? "nearby" : "location"; }
    private boolean allowed() { return getPermissionState(permission()) == PermissionState.GRANTED; }

    @PluginMethod public void scan(PluginCall call) { main.post(() -> {
        if (permissionCall != null) { call.reject("Finish the Bluetooth permission prompt, then scan again."); return; }
        String id = call.getString("session");
        if (id == null || !id.matches("[a-zA-Z0-9-]{1,64}")) { call.reject("Invalid setup session."); return; }
        close(current, "Setup cancelled.");
        current = new Session(id);
        if (!allowed()) {
            permissionCall = call;
            requestPermissionForAlias(permission(), call, "scanPermission");
        } else beginScan(call);
    }); }

    @PermissionCallback private void scanPermission(PluginCall call) { main.post(() -> {
        permissionCall = null;
        if (!owns(call)) { call.reject("Setup cancelled."); return; }
        if (!allowed()) {
            call.reject("Allow Nearby devices in app permissions, then scan again. On Android 11 or earlier, allow Location for Bluetooth discovery.");
            close(current, "Bluetooth permission denied.");
            return;
        }
        beginScan(call);
    }); }

    private boolean owns(PluginCall call) { return current != null && current.id.equals(call.getString("session")); }
    private void beginScan(PluginCall call) {
        Session s = current;
        try {
            BluetoothManager manager = (BluetoothManager) getContext().getSystemService(Context.BLUETOOTH_SERVICE);
            BluetoothAdapter adapter = manager == null ? null : manager.getAdapter();
            if (adapter == null) throw new IllegalStateException("This phone does not support Bluetooth. Use a frame address instead.");
            if (!adapter.isEnabled()) throw new IllegalStateException("Bluetooth is off. Turn it on, then scan again.");
            if (Build.VERSION.SDK_INT < 31) {
                LocationManager location = (LocationManager) getContext().getSystemService(Context.LOCATION_SERVICE);
                if (!location.isProviderEnabled(LocationManager.GPS_PROVIDER) && !location.isProviderEnabled(LocationManager.NETWORK_PROVIDER))
                    throw new IllegalStateException("Turn on Location for Bluetooth discovery on this Android version, then scan again.");
            }
            s.scanner = adapter.getBluetoothLeScanner();
            s.scan = new ScanCallback() {
                @Override public void onScanResult(int type, ScanResult result) { main.post(() -> {
                    if (current != s || s.scan == null) return;
                    try {
                        BluetoothDevice device = result.getDevice();
                        String id = device.getAddress();
                        if (!s.devices.containsKey(id) && s.devices.size() >= 30) return;
                        s.devices.put(id, device);
                        String name = result.getScanRecord() == null ? null : result.getScanRecord().getDeviceName();
                        if (name == null || name.trim().isEmpty()) name = "Inky frame";
                        JSObject data = event(s, "device");
                        data.put("id", id); data.put("name", name.substring(0, Math.min(name.length(), 128)));
                        data.put("rssi", result.getRssi()); notifyListeners("ble", data);
                    } catch (SecurityException error) { fail(s, "Bluetooth permission changed. Allow Nearby devices, then scan again."); }
                }); }
                @Override public void onScanFailed(int code) { main.post(() -> {
                    if (current == s && s.scan != null) fail(s, "Bluetooth scan failed. Wait a few seconds, then scan again (" + code + ").");
                }); }
            };
            s.scanner.startScan(Collections.singletonList(new ScanFilter.Builder().setServiceUuid(new ParcelUuid(SERVICE)).build()),
                new ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build(), s.scan);
            s.scanDeadline = () -> {
                if (current != s) return;
                stopScan(s); notifyListeners("ble", event(s, "scanDone"));
            };
            main.postDelayed(s.scanDeadline, 15000);
            s.windowDeadline = () -> { if (current == s) fail(s, "Setup timed out. Open a new setup window on the frame, then scan again."); };
            main.postDelayed(s.windowDeadline, 300000);
            call.resolve();
        } catch (SecurityException error) { call.reject("Allow Nearby devices, then scan again."); close(s, "Bluetooth permission changed."); }
        catch (Exception error) { call.reject(error.getMessage()); close(s, "Scan failed."); }
    }

    @PluginMethod public void connect(PluginCall call) { main.post(() -> {
        if (!owns(call)) { call.reject("Scan again to select a frame."); return; }
        Session s = current;
        BluetoothDevice device = s.devices.get(call.getString("device"));
        if (device == null || s.gatt != null || s.pending != null) { call.reject("Select a frame from the current scan."); return; }
        stopScan(s);
        begin(s, call, "connect", 25000);
        try {
            s.gatt = device.connectGatt(getContext(), false, callback(s), BluetoothDevice.TRANSPORT_LE);
            if (s.gatt == null) fail(s, "Could not connect. Move closer to the frame and scan again.");
        } catch (SecurityException error) { fail(s, "Allow Nearby devices, then scan again."); }
        catch (Exception error) { fail(s, "Could not connect over Bluetooth. Check permissions and scan again."); }
    }); }

    // Capacitor gates discovery on runtime permissions. All callbacks run through run(),
    // which catches permission revocation before closing this session.
    @SuppressLint("MissingPermission")
    private BluetoothGattCallback callback(Session s) { return new BluetoothGattCallback() {
        private void run(BluetoothGatt gatt, Runnable task) { main.post(() -> {
            if (current != s || s.gatt != gatt) return;
            try { task.run(); }
            catch (SecurityException error) { fail(s, "Bluetooth permission changed. Allow Nearby devices, then scan again."); }
            catch (Exception error) { fail(s, "Bluetooth operation failed. Reconnect and try again."); }
        }); }
        @Override public void onConnectionStateChange(BluetoothGatt g, int status, int state) { run(g, () -> {
            if (status != BluetoothGatt.GATT_SUCCESS || state == BluetoothProfile.STATE_DISCONNECTED)
                fail(s, "Bluetooth disconnected. Move closer and scan again. The frame may need a new setup window.");
            else if (state == BluetoothProfile.STATE_CONNECTED && "link".equals(s.stage)) {
                s.stage = "services";
                if (!g.discoverServices()) fail(s, "Could not discover setup services. Scan again.");
            }
        }); }
        @Override public void onServicesDiscovered(BluetoothGatt g, int status) { run(g, () -> {
            if (!"services".equals(s.stage)) return;
            BluetoothGattService service = g.getService(SERVICE);
            if (status != BluetoothGatt.GATT_SUCCESS || service == null) { fail(s, "This device does not expose Improv setup. Scan again."); return; }
            for (int i = 1; i <= 4; i++) {
                BluetoothGattCharacteristic c = service.getCharacteristic(uuid(i));
                if (c == null) { fail(s, "The frame’s setup service is incomplete. Update its firmware."); return; }
                if (i != 3 && (c.getProperties() & BluetoothGattCharacteristic.PROPERTY_NOTIFY) != 0) s.subscriptions.add(c);
            }
            // A whole 32-byte SSID + 64-byte password fits one acknowledged ATT write.
            // Splitting it into unrelated writes would change the provisioner's protocol.
            s.stage = "mtu";
            if (!g.requestMtu(185)) fail(s, "Could not negotiate Bluetooth packet size. Scan again.");
        }); }
        @Override public void onMtuChanged(BluetoothGatt g, int mtu, int status) { run(g, () -> {
            if (!"mtu".equals(s.stage)) return;
            if (status != BluetoothGatt.GATT_SUCCESS || mtu < 104) { fail(s, "Bluetooth packet size is too small for WiFi setup. Reconnect or use another phone."); return; }
            s.mtu = mtu; s.stage = "subscribe"; subscribe(s);
        }); }
        @Override public void onDescriptorWrite(BluetoothGatt g, BluetoothGattDescriptor d, int status) { run(g, () -> {
            if (!"subscribe".equals(s.stage) || s.subscription >= s.subscriptions.size()
                || !d.getCharacteristic().getUuid().equals(s.subscriptions.get(s.subscription).getUuid())) return;
            if (status != BluetoothGatt.GATT_SUCCESS) { fail(s, "Could not subscribe to setup status. Scan again."); return; }
            s.subscription++; subscribe(s);
        }); }
        @Override public void onCharacteristicRead(BluetoothGatt g, BluetoothGattCharacteristic c, int status) {
            read(g, c, c.getValue(), status);
        }
        @Override public void onCharacteristicRead(BluetoothGatt g, BluetoothGattCharacteristic c, byte[] value, int status) { read(g, c, value, status); }
        private void read(BluetoothGatt g, BluetoothGattCharacteristic c, byte[] value, int status) {
            byte[] snapshot = value == null ? new byte[0] : value.clone();
            run(g, () -> {
                if (!("read:" + c.getUuid()).equals(s.operation)) return;
                if (status != BluetoothGatt.GATT_SUCCESS) { fail(s, "Could not read setup status. Reconnect and try again."); return; }
                JSObject result = new JSObject(); result.put("data", Base64.encodeToString(snapshot, Base64.NO_WRAP)); complete(s, result);
            });
        }
        @Override public void onCharacteristicWrite(BluetoothGatt g, BluetoothGattCharacteristic c, int status) { run(g, () -> {
            if (!"write".equals(s.operation)) return;
            if (status != BluetoothGatt.GATT_SUCCESS) fail(s, "Could not send WiFi settings. Reconnect and try again.");
            else complete(s, new JSObject());
        }); }
        @Override public void onCharacteristicChanged(BluetoothGatt g, BluetoothGattCharacteristic c) { changed(g, c, c.getValue()); }
        @Override public void onCharacteristicChanged(BluetoothGatt g, BluetoothGattCharacteristic c, byte[] value) { changed(g, c, value); }
        private void changed(BluetoothGatt g, BluetoothGattCharacteristic c, byte[] value) {
            byte[] snapshot = value == null ? new byte[0] : value.clone();
            run(g, () -> {
                String kind = c.getUuid().equals(uuid(1)) ? "state" : c.getUuid().equals(uuid(2)) ? "error" : c.getUuid().equals(uuid(4)) ? "result" : null;
                if (kind == null) return;
                JSObject data = event(s, "value"); data.put("kind", kind); data.put("data", Base64.encodeToString(snapshot, Base64.NO_WRAP));
                notifyListeners("ble", data);
            });
        }
    }; }

    // Only called inside the guarded GATT callback runner above.
    @SuppressLint("MissingPermission")
    private void subscribe(Session s) {
        if (s.subscription == s.subscriptions.size()) {
            s.stage = "ready";
            JSObject result = new JSObject(); result.put("mtu", s.mtu); complete(s, result); return;
        }
        BluetoothGattCharacteristic c = s.subscriptions.get(s.subscription);
        BluetoothGattDescriptor d = c.getDescriptor(CCC);
        if (d == null || !s.gatt.setCharacteristicNotification(c, true)) { fail(s, "Could not subscribe to setup status. Scan again."); return; }
        boolean started;
        if (Build.VERSION.SDK_INT >= 33) started = s.gatt.writeDescriptor(d, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE) == BluetoothStatusCodes.SUCCESS;
        else { d.setValue(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE); started = s.gatt.writeDescriptor(d); }
        if (!started) fail(s, "Could not subscribe to setup status. Scan again.");
    }

    @PluginMethod public void read(PluginCall call) { main.post(() -> {
        Session s = ready(call); if (s == null) return;
        String kind = call.getString("kind", "");
        int suffix = kind.equals("state") ? 1 : kind.equals("error") ? 2 : kind.equals("result") ? 4 : 0;
        if (suffix == 0) { call.reject("Invalid setup characteristic."); return; }
        begin(s, call, "read:" + uuid(suffix), 10000);
        try {
            if (!s.gatt.readCharacteristic(s.gatt.getService(SERVICE).getCharacteristic(uuid(suffix)))) fail(s, "Could not read setup status. Scan again.");
        } catch (SecurityException error) { fail(s, "Allow Nearby devices, then scan again."); }
        catch (Exception error) { fail(s, "Bluetooth read failed. Scan again."); }
    }); }

    @PluginMethod public void write(PluginCall call) { main.post(() -> {
        Session s = ready(call); if (s == null) return;
        byte[] packet;
        if (call.getString("data", "").length() > 136) { call.reject("Invalid WiFi setup request."); return; }
        try { packet = Base64.decode(call.getString("data", ""), Base64.NO_WRAP); ImprovPacket.validate(packet, s.mtu); }
        catch (Exception error) { call.reject("Invalid WiFi setup request."); return; }
        begin(s, call, "write", 10000);
        try {
            BluetoothGattCharacteristic c = s.gatt.getService(SERVICE).getCharacteristic(uuid(3));
            boolean started;
            if (Build.VERSION.SDK_INT >= 33) started = s.gatt.writeCharacteristic(c, packet, BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT) == BluetoothStatusCodes.SUCCESS;
            else { c.setWriteType(BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT); c.setValue(packet); started = s.gatt.writeCharacteristic(c); }
            if (!started) fail(s, "Could not send WiFi settings. Scan again.");
        } catch (SecurityException error) { fail(s, "Allow Nearby devices, then scan again."); }
        catch (Exception error) { fail(s, "Bluetooth write failed. Scan again."); }
        // The plugin never stores credentials outside this write, and never logs call arguments.
    }); }

    private Session ready(PluginCall call) {
        if (!owns(call) || current.gatt == null || !"ready".equals(current.stage)) { call.reject("Reconnect to a frame first."); return null; }
        if (current.pending != null) { call.reject("Wait for the current Bluetooth operation."); return null; }
        return current;
    }
    private void begin(Session s, PluginCall call, String operation, int timeout) {
        s.pending = call; s.operation = operation;
        s.deadline = () -> { if (current == s && s.pending == call) fail(s, "Bluetooth timed out. Move closer and scan again."); };
        main.postDelayed(s.deadline, timeout);
    }
    private void complete(Session s, JSObject result) {
        if (s.deadline != null) main.removeCallbacks(s.deadline);
        PluginCall call = s.pending; s.pending = null; s.operation = null;
        if (call != null) call.resolve(result);
    }
    private JSObject event(Session s, String type) {
        JSObject data = new JSObject(); data.put("session", s.id); data.put("type", type); return data;
    }
    private void fail(Session s, String message) {
        if (current != s) return;
        JSObject data = event(s, "error"); data.put("message", message);
        close(s, message); notifyListeners("ble", data);
    }
    private void stopScan(Session s) {
        if (s.scanDeadline != null) main.removeCallbacks(s.scanDeadline);
        if (s.scan != null) {
            try { s.scanner.stopScan(s.scan); } catch (SecurityException | IllegalStateException ignored) { /* Permission or radio may have changed. */ }
            s.scan = null;
        }
    }
    private void close(Session s, String message) {
        if (s == null) return;
        if (current == s) current = null; // Invalidate before disconnect callbacks can run.
        stopScan(s);
        if (s.deadline != null) main.removeCallbacks(s.deadline);
        if (s.windowDeadline != null) main.removeCallbacks(s.windowDeadline);
        if (s.pending != null) { s.pending.reject(message); s.pending = null; }
        if (s.gatt != null) {
            try { s.gatt.disconnect(); } catch (SecurityException | IllegalStateException ignored) { /* Always close even after permission revocation. */ }
            try { s.gatt.close(); } catch (SecurityException ignored) { /* Android owns cleanup after revocation. */ }
            s.gatt = null;
        }
        s.devices.clear();
    }
    @PluginMethod public void cancel(PluginCall call) { main.post(() -> {
        if (owns(call)) close(current, "Setup cancelled. Scan again when ready.");
        call.resolve();
    }); }
    @PluginMethod public void settings(PluginCall call) { main.post(() -> {
        String kind = call.getString("kind", "");
        Intent intent = kind.equals("bluetooth") ? new Intent(Settings.ACTION_BLUETOOTH_SETTINGS)
            : kind.equals("location") ? new Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS)
            : new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getContext().getPackageName()));
        try { getActivity().startActivity(intent); call.resolve(); }
        catch (Exception error) { call.reject("Open Android Settings, enable Bluetooth and allow Nearby devices, then return and scan again."); }
    }); }
    @Override protected void handleOnStop() { main.post(() -> { if (current != null) fail(current, "Setup paused. Return to the app and scan again."); }); }
    @Override protected void handleOnDestroy() { main.post(() -> {
        close(current, "Setup closed."); getContext().unregisterReceiver(radio);
    }); }
}
