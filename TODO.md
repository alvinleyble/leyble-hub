# Leyble Hub — To-Do

---

## Pending (your action needed)

- [ ] **WiFi printer preflight** — before WiFi printing code can be written:
  1. Join the VOZY G80 to the shop WiFi (connect phone to printer's hotspot → enter shop WiFi credentials in its config page)
  2. Print a self-test page (hold paper-feed while powering on) → note the IP address
  3. Confirm the tablet is on the same WiFi
  4. Open `http://<printer-IP>` in the tablet browser — if a config page loads, WiFi is viable; if it times out, router has client isolation and we stay on Bluetooth only
  5. Report back the result so the WiFi printing code can be written (or abandoned)

---

## Pending (code — waiting on above)

- [ ] **WiFi printing for Android APK**
  - Bluetooth printing already works and is stable on the tablet (v1.1 APK, commit `3b64b4b`)
  - `PrinterPlugin.java` already has `doPrintWifi` (TCP socket to `IP:9100`) — native layer is ready
  - What still needs to be written:
    - **Native:** `discoverWifiPrinters()` — parallel TCP sweep of /24 subnet on port 9100 (mDNS won't find cheap thermal printers); `printBytesTo()` — print to explicit target for test-print without saving
    - **UI:** rename `BluetoothPrinterPicker.jsx` → `PrinterPicker.jsx`, make it a two-tab sheet (Bluetooth: existing paired list | WiFi: Scan button + found IPs + manual IP/port/name + Test-print button)
    - **Hook:** update `usePrintReceipt.js` — unified `savePrinter({type,address,port,name})`, add `scanWifi()` and `testPrint()`, don't abort picker if BT list fails (so WiFi tab works with BT off)
    - Update imports in `OrderDetailPage.jsx` and `ReviewQueueModal.jsx`
  - After code: `cd client && npm run build`, bump `versionCode`/`versionName` in `build.gradle`, `npm run android:open`, signed APK, reinstall on parents' phones
  - Full plan: `~/.claude/plans/swirling-foraging-pizza.md`

---

## Pending (deploy)

- [ ] **Push 5 commits to prod** — `dev`/`staging` are 5 commits ahead of `main` (draft orders, delivery void, duplicate product warning, docs). Waiting for Alvin's go-ahead to test on staging then push to prod.

---

## Done

<!-- Move completed items here with [x] and a date -->
