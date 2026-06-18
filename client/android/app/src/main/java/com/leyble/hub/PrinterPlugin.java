package com.leyble.hub;

import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothSocket;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;
import android.util.Base64;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.IOException;
import java.io.OutputStream;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.NetworkInterface;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Enumeration;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

@CapacitorPlugin(
    name = "Printer",
    permissions = {
        @Permission(strings = {"android.permission.BLUETOOTH_CONNECT"}, alias = "bluetoothConnect")
    }
)
public class PrinterPlugin extends Plugin {

    // Serial Port Profile UUID — standard for Bluetooth serial/thermal printers
    private static final UUID SPP_UUID =
        UUID.fromString("00001101-0000-1000-8000-00805F9B34FB");

    private static final String PREFS    = "PrinterPrefs";
    private static final String KEY_TYPE = "printerType";   // "bluetooth" | "wifi"
    private static final String KEY_ADDR = "printerAddress"; // BT MAC or WiFi IP
    private static final String KEY_PORT = "printerPort";    // WiFi only (default 9100)
    private static final String KEY_NAME = "printerName";

    // ── Permission helpers ────────────────────────────────────────────────────

    private boolean hasBtPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return true;
        return getActivity().checkSelfPermission("android.permission.BLUETOOTH_CONNECT")
            == PackageManager.PERMISSION_GRANTED;
    }

    private byte[] decode(PluginCall call) {
        String encoded = call.getString("data");
        if (encoded == null || encoded.isEmpty()) { call.reject("data required."); return null; }
        try {
            return Base64.decode(encoded, Base64.DEFAULT);
        } catch (Exception e) {
            call.reject("Invalid base64 data.");
            return null;
        }
    }

    // ── listPairedDevices (Bluetooth) ──────────────────────────────────────────

    @PluginMethod
    public void listPairedDevices(PluginCall call) {
        if (!hasBtPermission()) {
            requestPermissionForAlias("bluetoothConnect", call, "afterPermListDevices");
            return;
        }
        doListPairedDevices(call);
    }

    @PermissionCallback
    private void afterPermListDevices(PluginCall call) {
        if (hasBtPermission()) doListPairedDevices(call);
        else call.reject("Bluetooth permission denied.");
    }

    private void doListPairedDevices(PluginCall call) {
        BluetoothAdapter adapter = BluetoothAdapter.getDefaultAdapter();
        if (adapter == null) { call.reject("Bluetooth not available."); return; }

        Set<BluetoothDevice> bonded = adapter.getBondedDevices();
        JSArray arr = new JSArray();
        for (BluetoothDevice d : bonded) {
            JSObject obj = new JSObject();
            obj.put("name",    d.getName() != null ? d.getName() : "Unknown");
            obj.put("address", d.getAddress());
            arr.put(obj);
        }
        JSObject result = new JSObject();
        result.put("devices", arr);
        call.resolve(result);
    }

    // ── saveSelectedPrinter ───────────────────────────────────────────────────

    @PluginMethod
    public void saveSelectedPrinter(PluginCall call) {
        String type    = call.getString("type", "bluetooth");
        String address = call.getString("address");
        String name    = call.getString("name", "Printer");
        int    port    = call.getInt("port", 9100);
        if (address == null || address.isEmpty()) { call.reject("address required."); return; }
        getActivity().getSharedPreferences(PREFS, 0).edit()
            .putString(KEY_TYPE, type)
            .putString(KEY_ADDR, address)
            .putInt(KEY_PORT, port)
            .putString(KEY_NAME, name)
            .apply();
        call.resolve();
    }

    // ── getSelectedPrinter ────────────────────────────────────────────────────

    @PluginMethod
    public void getSelectedPrinter(PluginCall call) {
        SharedPreferences p = getActivity().getSharedPreferences(PREFS, 0);
        String address = p.getString(KEY_ADDR, null);
        JSObject result = new JSObject();
        if (address != null) {
            result.put("type",    p.getString(KEY_TYPE, "bluetooth"));
            result.put("address", address);
            result.put("port",    p.getInt(KEY_PORT, 9100));
            result.put("name",    p.getString(KEY_NAME, "Printer"));
        }
        call.resolve(result);
    }

    // ── clearSelectedPrinter ──────────────────────────────────────────────────

    @PluginMethod
    public void clearSelectedPrinter(PluginCall call) {
        getActivity().getSharedPreferences(PREFS, 0).edit()
            .remove(KEY_TYPE).remove(KEY_ADDR).remove(KEY_PORT).remove(KEY_NAME).apply();
        call.resolve();
    }

    // ── printBytes — routes by stored connection type ──────────────────────────

    @PluginMethod
    public void printBytes(PluginCall call) {
        SharedPreferences p = getActivity().getSharedPreferences(PREFS, 0);
        String type = p.getString(KEY_TYPE, "bluetooth");

        if ("wifi".equals(type)) {
            doPrintWifi(call, p);
            return;
        }
        // Bluetooth path requires the runtime permission
        if (!hasBtPermission()) {
            requestPermissionForAlias("bluetoothConnect", call, "afterPermPrintBytes");
            return;
        }
        doPrintBluetooth(call, p);
    }

    @PermissionCallback
    private void afterPermPrintBytes(PluginCall call) {
        if (hasBtPermission()) {
            doPrintBluetooth(call, getActivity().getSharedPreferences(PREFS, 0));
        } else {
            call.reject("Bluetooth permission denied.");
        }
    }

    private void doPrintBluetooth(PluginCall call, SharedPreferences p) {
        String address = p.getString(KEY_ADDR, null);
        if (address == null) { call.reject("No printer selected."); return; }
        byte[] data = decode(call);
        if (data == null) return;
        sendBluetooth(call, address, data);
    }

    private void doPrintWifi(PluginCall call, SharedPreferences p) {
        String host = p.getString(KEY_ADDR, null);
        int    port = p.getInt(KEY_PORT, 9100);
        if (host == null) { call.reject("No printer selected."); return; }
        byte[] data = decode(call);
        if (data == null) return;
        sendWifi(call, host, port, data);
    }

    // Shared raw-TCP send used by both saved-printer and explicit-target Wi-Fi prints.
    private void sendWifi(PluginCall call, String host, int port, byte[] data) {
        final byte[] payload = data;
        final String h = host;
        final int    pt = port;
        new Thread(() -> {
            Socket socket = new Socket();
            try {
                socket.connect(new InetSocketAddress(h, pt), 8000); // 8s connect timeout
                OutputStream out = socket.getOutputStream();
                out.write(payload);
                out.flush();
                call.resolve();
            } catch (IOException e) {
                call.reject("Wi-Fi print failed: " + e.getMessage());
            } finally {
                try { socket.close(); } catch (IOException ignored) {}
            }
        }).start();
    }

    // ── printBytesTo — print to an EXPLICIT target (no saved prefs touched) ─────
    // Used by the picker's "Test print" so an IP can be verified before committing.

    @PluginMethod
    public void printBytesTo(PluginCall call) {
        String type    = call.getString("type", "wifi");
        String address = call.getString("address");
        int    port    = call.getInt("port", 9100);
        if (address == null || address.isEmpty()) { call.reject("address required."); return; }
        byte[] data = decode(call);
        if (data == null) return;

        if ("bluetooth".equals(type)) {
            if (!hasBtPermission()) { call.reject("Bluetooth permission denied."); return; }
            sendBluetooth(call, address, data);
        } else {
            sendWifi(call, address, port, data);
        }
    }

    // Shared RFCOMM send used by both saved-printer and explicit-target BT prints.
    private void sendBluetooth(PluginCall call, String address, byte[] data) {
        BluetoothAdapter adapter = BluetoothAdapter.getDefaultAdapter();
        if (adapter == null) { call.reject("Bluetooth not available."); return; }
        final byte[] payload = data;
        final String addr = address;
        new Thread(() -> {
            BluetoothSocket socket = null;
            try {
                BluetoothDevice device = adapter.getRemoteDevice(addr);
                socket = device.createRfcommSocketToServiceRecord(SPP_UUID);
                socket.connect();
                OutputStream out = socket.getOutputStream();
                out.write(payload);
                out.flush();
                call.resolve();
            } catch (IOException e) {
                call.reject("Bluetooth print failed: " + e.getMessage());
            } finally {
                if (socket != null) {
                    try { socket.close(); } catch (IOException ignored) {}
                }
            }
        }).start();
    }

    // ── discoverWifiPrinters — parallel TCP sweep of the local /24 on port 9100 ──
    // Cheap thermal printers don't advertise over mDNS, so we probe every host on
    // the device's own Wi-Fi subnet and keep the ones that accept a connection.

    @PluginMethod
    public void discoverWifiPrinters(PluginCall call) {
        final int port = call.getInt("port", 9100);
        new Thread(() -> {
            String localIp = getLocalWifiIpv4();
            if (localIp == null) {
                call.reject("Not connected to Wi-Fi.");
                return;
            }
            String prefix = localIp.substring(0, localIp.lastIndexOf('.') + 1); // "192.168.1."
            final List<String> found = new CopyOnWriteArrayList<>();
            ExecutorService pool = Executors.newFixedThreadPool(50);
            for (int i = 1; i <= 254; i++) {
                final String host = prefix + i;
                pool.execute(() -> {
                    Socket s = new Socket();
                    try {
                        s.connect(new InetSocketAddress(host, port), 300);
                        found.add(host);
                    } catch (IOException ignored) {
                    } finally {
                        try { s.close(); } catch (IOException ignored) {}
                    }
                });
            }
            pool.shutdown();
            try {
                pool.awaitTermination(15, TimeUnit.SECONDS);
            } catch (InterruptedException ignored) {}

            List<String> sorted = new ArrayList<>(found);
            Collections.sort(sorted, (a, b) -> {
                int ai = Integer.parseInt(a.substring(a.lastIndexOf('.') + 1));
                int bi = Integer.parseInt(b.substring(b.lastIndexOf('.') + 1));
                return Integer.compare(ai, bi);
            });
            JSArray arr = new JSArray();
            for (String host : sorted) {
                JSObject obj = new JSObject();
                obj.put("address", host);
                arr.put(obj);
            }
            JSObject result = new JSObject();
            result.put("devices", arr);
            call.resolve(result);
        }).start();
    }

    // Device's own IPv4 on the active (Wi-Fi) interface, or null if none.
    private String getLocalWifiIpv4() {
        try {
            Enumeration<NetworkInterface> ifaces = NetworkInterface.getNetworkInterfaces();
            while (ifaces.hasMoreElements()) {
                NetworkInterface iface = ifaces.nextElement();
                if (!iface.isUp() || iface.isLoopback()) continue;
                Enumeration<InetAddress> addrs = iface.getInetAddresses();
                while (addrs.hasMoreElements()) {
                    InetAddress addr = addrs.nextElement();
                    if (addr.isLoopbackAddress()) continue;
                    String ip = addr.getHostAddress();
                    if (ip != null && ip.indexOf(':') < 0) { // IPv4 only
                        return ip;
                    }
                }
            }
        } catch (Exception ignored) {}
        return null;
    }

    // ── disableWifiEventNotice — one-time printer-module fix ────────────────────
    // The Hi-Flying HF-LPT270 WiFi module prints "+EVENT=SOCKA_ON"/"SOCKA_OFF" on
    // every socket connect/disconnect. We disable that over its UDP config channel
    // (port 48899): discovery probe → "+ok" (enter command mode) → AT+EVENT=off →
    // AT+Z (reboot to apply). Returns rich diagnostics so a failure is legible.

    private static final int CONFIG_PORT = 48899;
    private static final String DISCOVERY_PROBE = "HF-A11ASSISTHREAD";

    @PluginMethod
    public void disableWifiEventNotice(PluginCall call) {
        String address = call.getString("address");
        if (address == null || address.isEmpty()) { call.reject("address required."); return; }
        final String host = address;
        new Thread(() -> {
            DatagramSocket sock = null;
            try {
                sock = new DatagramSocket(null);
                sock.setReuseAddress(true);
                try { sock.bind(new InetSocketAddress(CONFIG_PORT)); }
                catch (Exception e) { sock.bind(new InetSocketAddress(0)); } // ephemeral fallback
                sock.setSoTimeout(3000);
                InetAddress target = InetAddress.getByName(host);

                // 1. Discovery probe — proves the config channel is open.
                String discovered = udpSendRecv(sock, target, DISCOVERY_PROBE);
                if (discovered == null) {
                    JSObject r = new JSObject();
                    r.put("ok", false);
                    r.put("message", "Printer did not respond on its config channel (UDP 48899). "
                        + "Nothing was changed.");
                    call.resolve(r);
                    return;
                }

                // 2. Acknowledge → enter command mode.
                udpSend(sock, target, "+ok");

                // 3. Disable the connection-event notifications.
                String evReply = udpSendRecv(sock, target, "AT+EVENT=off\r");

                // 4. Reboot to apply (no reply expected — module restarts).
                udpSend(sock, target, "AT+Z\r");

                boolean ok = evReply != null && evReply.toLowerCase().contains("+ok");
                JSObject r = new JSObject();
                r.put("ok", ok);
                r.put("discovered", discovered.trim());
                r.put("eventReply", evReply != null ? evReply.trim() : "");
                r.put("message", ok
                    ? "Disabled connection notices and rebooted the printer. Give it ~15s, then reprint."
                    : "Reached the printer but it didn't confirm the change. Reply: "
                        + (evReply != null ? evReply.trim() : "(none)"));
                call.resolve(r);
            } catch (Exception e) {
                call.reject("Config failed: " + e.getMessage());
            } finally {
                if (sock != null) sock.close();
            }
        }).start();
    }

    private void udpSend(DatagramSocket sock, InetAddress addr, String msg) throws IOException {
        byte[] b = msg.getBytes();
        sock.send(new DatagramPacket(b, b.length, addr, CONFIG_PORT));
    }

    private String udpSendRecv(DatagramSocket sock, InetAddress addr, String msg) throws IOException {
        udpSend(sock, addr, msg);
        try {
            byte[] buf = new byte[512];
            DatagramPacket resp = new DatagramPacket(buf, buf.length);
            sock.receive(resp);
            return new String(resp.getData(), 0, resp.getLength());
        } catch (SocketTimeoutException e) {
            return null;
        }
    }
}
