# Leyble Hub — To-Do

---

## Pending (code — ready to start, preflight passed)

<!-- nothing pending -->

---

## Done

<!-- Move completed items here with [x] and a date -->

- [x] **WiFi printing for Android APK** _(2026-06-18)_ — added WiFi as a second transport alongside
  Bluetooth (APK **v1.2**, `versionCode 3`). Two-tab `PrinterPicker.jsx` (Bluetooth paired list |
  WiFi scan + manual IP/port/name + Test print); native `discoverWifiPrinters()` (parallel port-9100
  /24 sweep), `printBytesTo()` (explicit-target test print), unified `savePrinter()` in both print
  hooks. Verified on the tablet (BT regression + WiFi scan/manual/test).
  - **WiFi printer quirk fixed:** the VOZY G80's Hi-Flying **HF-LPT270** module printed
    `+EVENT=SOCKA_ON`/`SOCKA_OFF` on every WiFi receipt. Added a one-tap **"Disable notices & reboot
    printer"** action (WiFi tab) that sends `AT+EVENT=off` over the module's UDP config channel
    (port 48899) — `disableWifiEventNotice()` in PrinterPlugin.java. Confirmed working.
  - Docs: [docs/operations/android.md](docs/operations/android.md) "Native features status".
  - **Requires a new APK** (native plugin changed): rebuild + reinstall on the parents' devices.

- [x] **Deploy backlog to prod** _(2026-06-18)_ — merged `staging` → `main` (fast-forward,
  `3b64b4b..ee027e9`) and pushed. Shipped draft orders, quantity steppers, printable
  product/customer lists, delivery void, duplicate-product warning, and order/stock backend
  hardening, plus the docs/ restructure. Render prod auto-deploy applied migrations **028**
  (draft order status) + **029** (supplier delivery void) to prod Supabase. All branches
  (`main`/`staging`/`dev`) now in sync at `ee027e9`.
