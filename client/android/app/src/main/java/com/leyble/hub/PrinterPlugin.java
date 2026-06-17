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
import java.net.InetSocketAddress;
import java.net.Socket;
import java.util.Set;
import java.util.UUID;

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

    private void doPrintWifi(PluginCall call, SharedPreferences p) {
        String host = p.getString(KEY_ADDR, null);
        int    port = p.getInt(KEY_PORT, 9100);
        if (host == null) { call.reject("No printer selected."); return; }
        byte[] data = decode(call);
        if (data == null) return;

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
}
