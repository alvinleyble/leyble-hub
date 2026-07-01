# Android — Leyble Hub as an Android app

Leyble Hub ships to Android by **wrapping the existing React/Vite app with
[Capacitor](https://capacitorjs.com/)**. The same `client/` code becomes the APK — there is
no separate mobile codebase. The APK is the **only** way users access the app; the browser
version is for local development only.

> Plan of record: `we-need-to-plan-valiant-spark.md` (in `~/.claude/plans/`).

---

## How it fits together

```
Android APK (Capacitor WebView)  ──HTTPS──►  Express backend (Render, API-only)  ──►  Postgres (Supabase)
```

- The DB and backend are **cloud-hosted** (no on-prem computer). See "Cloud setup" below.
- The Render service is **API-only** — it serves `/api/v1/*` and returns a 404 JSON for anything
  else. It does **not** serve a web client, so there is no website to open in a browser; the APK
  is the only way in.
- Auth: the **Android app uses a Bearer token** stored in `@capacitor/preferences` (native,
  app-sandboxed storage — *not* browser localStorage). A `SameSite=Strict` cookie path also
  exists but is used only by the local browser dev server (`npm run dev`). Both are handled
  centrally in [client/src/api/client.js](../../client/src/api/client.js) and
  [server/src/middleware/auth.js](../../server/src/middleware/auth.js).

---

## Prerequisites (one-time, on the build machine)

1. **Android Studio** — install from https://developer.android.com/studio. It bundles the
   JDK + Android SDK that Gradle needs to build the APK. (Until this is installed,
   `cap sync`/builds fail with "Unable to locate a Java Runtime" — code scaffolding still works.)
2. Open Android Studio once and let it finish downloading the default SDK + build tools.

---

## Cloud setup (one-time)

### Database — Supabase (free)
1. Create a project at https://supabase.com → get the **pooled** connection string
   (Project Settings → Database → Connection string → "Transaction"/pooler).
2. Set it as `DATABASE_URL` for the backend (locally or on Render).
3. Run migrations + seed against it:
   ```bash
   cd server
   DATABASE_URL='<supabase-pooled-url>' node db/migrate.js
   # seed the admin user via the existing seed flow (uses SEED_ADMIN_PASSWORD)
   node db/seed.js
   # then run once to restrict login to a single shared account and wire up the
   # Josie/Luis/Admin profile picker (uses JOSIE_PASSWORD, default 'leyble123')
   node db/setup-profiles.js
   ```
   Note: free Supabase projects pause after ~7 days of no activity (un-pause in the dashboard).

### Backend — Render (API-only service)
1. Create a **Web Service** at https://render.com from this GitHub repo. **Root Directory:
   leave blank** (repo root).
   - Build command: `npm --prefix server install && node server/db/migrate.js`
     (the server serves no web client, so the client is **not** built here — the APK's web
     assets are built locally via `cap sync`).
   - Start command: `node server/src/index.js`
   - Health check path: `/health`
2. Set env vars (never commit these): `DATABASE_URL`, `JWT_SECRET`, `JWT_EXPIRES_IN`,
   `SEED_ADMIN_PASSWORD`, `JOSIE_PASSWORD`, `NODE_ENV=production`.
3. Note the public URL, e.g. `https://leyble-hub.onrender.com`. This is the **API** the APK
   talks to (set as `VITE_API_URL` in `client/.env.production`). It is API-only — opening it in
   a browser returns a 404 JSON, not the app.
   - Free tier sleeps after ~15 min idle (first request ~30–60s). Upgrade to Starter (~$7/mo)
     for always-on. **Do not use Render's free Postgres** — it is deleted ~30 days after
     creation; the DB lives on Supabase.

---

## Building the APK

1. Point the frontend at the backend:
   ```bash
   cd client
   cp .env.production.example .env.production
   # edit VITE_API_URL to the Render URL (no trailing slash, no /api/v1)
   ```
2. Build the web app and sync it into the native project:
   ```bash
   npm run android:open    # vite build + cap sync + opens Android Studio
   ```
3. In Android Studio: **Build → Generate Signed Bundle / APK → APK**.
   - First time: create a **keystore** and store it + its passwords somewhere safe
     (a password manager). The keystore and `key.properties`/`keystore.properties` are
     git-ignored — **never commit them**. Losing the keystore means you can't ship updates
     to an already-installed app under the same identity.
4. The signed APK lands under `client/android/app/build/outputs/apk/release/`.

---

## Installing on the owners' devices (sideload, no Play Store)

1. Transfer the `.apk` to the device (USB, email, or a download link).
2. On the device: allow "Install unknown apps" for the app you're installing from, then open
   the APK to install.
3. Launch **Leyble Hub**, log in. To prove it's cloud-backed, turn WiFi off (mobile data)
   and confirm it still works.

### Updating the app later
Rebuild with the same keystore (steps above), bump `versionCode`/`versionName` in
`client/android/app/build.gradle`, and re-install the new APK over the old one.

---

## Native features status

- **Camera** for personnel ID photos: works today via the existing `<input type=file>` (the
  WebView offers camera/gallery). `@capacitor/camera` is optional polish.
- **Thermal receipt printing (80mm) — Bluetooth + WiFi:** ✅ done. A custom Capacitor plugin
  ([PrinterPlugin.java](../../client/android/app/src/main/java/com/leyble/hub/PrinterPlugin.java))
  sends ESC/POS bytes straight to the **VOZY G80** — no Android print dialog. Transport is chosen
  in [PrinterPicker.jsx](../../client/src/pages/orders/PrinterPicker.jsx) (a two-tab sheet) and
  the choice is remembered:
  - **Bluetooth:** RFCOMM socket to a paired MAC (pair the printer in Android Settings → Bluetooth
    first). One tablet at a time.
  - **WiFi:** raw TCP to the printer's `IP:9100`. The WiFi tab can **Scan network** (a parallel
    port-9100 TCP sweep of the device's /24 — these cheap printers don't advertise over mDNS) or
    take a manual **IP / Port / Name**, with a **Test print** button. WiFi lets **multiple tablets
    share one printer**, which Bluetooth can't.
  - The saved printer (`type`/`address`/`port`/`name`) lives in the plugin's SharedPreferences;
    [usePrintReceipt.js](../../client/src/pages/orders/usePrintReceipt.js) (receipts) and
    [usePrintList.js](../../client/src/pages/shared/usePrintList.js) (product/customer lists) both
    route every print through it. Web (Render) stays on `window.print()` — browsers can't open raw
    sockets.
  - **WiFi preflight:** printer on the **same 2.4GHz SSID** as the tablet, raw port **9100** open,
    and router **AP/client isolation disabled** (otherwise device-to-device traffic is blocked and
    both scan + print fail). Set a **DHCP reservation** so the printer's IP doesn't drift.

### WiFi printer quirk — `+EVENT=SOCKA_ON` / `SOCKA_OFF` printed on receipts
The VOZY G80's WiFi card is a **Hi-Flying HF-LPT270** module. Out of the box it prints
connection-status notices — `+EVENT=SOCKA_ON` when a TCP client connects, `+EVENT=SOCKA_OFF` when
it disconnects — so they show up **above the header and below the footer on every WiFi print**
(Bluetooth is unaffected; it's not in our ESC/POS payload). The fix is the module command
**`AT+EVENT=off`** (default is `on`; the setting persists across reboots). The printer's web config
page (`http://<printer-ip>`, e.g. `192.168.1.39`) has no field to send AT commands, so the app
does it: **Wi-Fi tab → "Disable notices & reboot printer."** That runs the Hi-Flying handshake over
the module's UDP config channel (**port 48899**): `HF-A11ASSISTHREAD` discovery → `+ok` (enter
command mode) → `AT+EVENT=off` → `AT+Z` (reboot). One-time. Implemented as
`disableWifiEventNotice()` in PrinterPlugin.java; the button only needs the printer's IP filled in.
- **Push / offline:** out of scope for v1.
