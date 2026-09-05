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
- **Default Landing & Routing:** In V3.0, the app launches and opens directly on **Outgoing Orders (`/orders`)**, where order creation takes place. The V1/V2 long-press bridge and remembered `preferred_ui` preference were removed (G17); V1 is the sole application.
- **Orientation:** Screen orientation is locked to **`sensorLandscape`** across the application to provide optimal layout for side-by-side product tiles and order lines.
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
   # then run once to activate the three per-person accounts — Alvin, Josie, Luis —
   # and deactivate everything else (ACCOUNT_PASSWORD, default 'leyble123'; Josie's
   # existing password is left untouched). See ADR 0017 §5/§6.
   node db/setup-accounts.js
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
   `SEED_ADMIN_PASSWORD`, `NODE_ENV=production`. (`ACCOUNT_PASSWORD` is only read by the
   one-off `db/setup-accounts.js` script, so Render does not need it.)
3. Note the public URL, e.g. `https://leyble-hub.onrender.com`. This is the **API** the APK
   talks to (set as `VITE_API_URL` in `client/.env.production`). It is API-only — opening it in
   a browser returns a 404 JSON, not the app.
   - Free tier sleeps after ~15 min idle (first request ~30–60s). Upgrade to Starter (~$7/mo)
     for always-on. **Do not use Render's free Postgres** — it is deleted ~30 days after
     creation; the DB lives on Supabase.
   - **Local Android Emulator Testing:** When testing on an Android emulator against a local backend instead of Render/cloud, point the build to `http://10.0.2.2:3000` via `VITE_API_URL=http://10.0.2.2:3000 npm run android:sync`. See [e2e/appium/README.md](../../e2e/appium/README.md).

---

## Building and Distributing (Google Play Internal Testing)

Leyble Hub distributes to the owners' devices automatically via **Google Play Store (Internal Testing track)**.

### Continuous Deployment (GitHub Actions)

Deployments are fully automated via GitHub Actions for both Production and Staging:

#### Production Pipeline ([.github/workflows/deploy-play.yml](../../.github/workflows/deploy-play.yml))
- **Trigger**: Any push to `main` modifying `client/**` or `.github/workflows/deploy-play.yml` (and on-demand via `workflow_dispatch`).
- **Target Backend**: Production Render API (`https://leyble-hub.onrender.com`).
- **Application ID**: `com.leyble.hub`
- **App Name**: `Leyble Hub`
- **Steps**:
  1. Sets up Node 22 (required for Capacitor 8 CLI) and Java 21 (Temurin).
  2. Runs `npm ci && npm run build` inside `client/`.
  3. Runs `npx cap sync android` to sync web assets.
  4. Decodes the base64 release keystore to `client/android/app/release.jks`.
  5. Executes `./gradlew bundleRelease` to produce `app-release.aab`.
  6. Uploads the signed AAB to Google Play Internal Testing track (`com.leyble.hub`) via `r0adkll/upload-google-play@v1`.

#### Staging Pipeline ([.github/workflows/deploy-play-staging.yml](../../.github/workflows/deploy-play-staging.yml))
- **Trigger**: Any push to `staging` modifying `client/**` or `.github/workflows/deploy-play-staging.yml` (and on-demand via `workflow_dispatch`).
- **Target Backend**: Northflank Staging API (`https://site--leyble-hub--tkm4pp6r2kky.code.run`).
- **Application ID**: `com.leyble.hub.staging` (can be installed alongside production on the same device).
- **App Name**: `Leyble Hub (Staging)`
- **Steps**:
  1. Sets up Node 22 and Java 21.
  2. Builds web client with `VITE_API_URL=https://site--leyble-hub--tkm4pp6r2kky.code.run`.
  3. Runs `npx cap sync android`.
  4. Decodes keystore (supports `PLAY_STAGING_KEYSTORE_BASE64` with fallback to `PLAY_KEYSTORE_BASE64`).
  5. Executes `./gradlew bundleRelease` with `ANDROID_APPLICATION_ID=com.leyble.hub.staging` and `ANDROID_APP_NAME="Leyble Hub (Staging)"`.
  6. Uploads the signed AAB to Google Play Internal Testing track (`com.leyble.hub.staging`) via `r0adkll/upload-google-play@v1`.

### Signing & Keystore Secrets

The release keystore is stored locally at `client/android/app/release.jks` (alias `upload`) and is gitignored (`*.jks`).
The CI pipelines support both dedicated staging secrets and shared repository secrets:
- `PLAY_SERVICE_ACCOUNT_JSON` / `PLAY_STAGING_SERVICE_ACCOUNT_JSON`: Google Cloud IAM service account key with Google Play Android Developer API access.
- `PLAY_KEYSTORE_BASE64` / `PLAY_STAGING_KEYSTORE_BASE64`: Base64 encoded `release.jks` (`base64 -i client/android/app/release.jks | pbcopy`).
- `PLAY_KEYSTORE_PASSWORD` / `PLAY_STAGING_KEYSTORE_PASSWORD`: Keystore password.
- `PLAY_KEY_ALIAS` / `PLAY_STAGING_KEY_ALIAS`: Keystore alias (`upload`).
- `PLAY_KEY_PASSWORD` / `PLAY_STAGING_KEY_PASSWORD`: Key password.

### Versioning Rules

Google Play requires every release to have a strictly higher `versionCode`:
- Update `versionCode` and `versionName` in `client/android/app/build.gradle` for every release.
- Google Play Developer API rejects duplicate `versionCode` with `"Version code X has already been used."`

### Installing & Updating on Devices

1. Invite the Google accounts of the tablet owners/testers under **Google Play Console → Testing → Internal testing → Testers**.
2. Have owners open the one-time opt-in link and install **Leyble Hub** (or **Leyble Hub (Staging)**) from Google Play Store.
3. Subsequent releases pushed to `main` (or `staging`) will automatically update on the tablets via Google Play background updates.

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
- **Offline access & local-first storage:** ✅ Done (V2.5/V3.0). Native device storage (`@capacitor/preferences` under `v25.*`) holds station registrations, a rolling 30-day receipt cache, and the waiting outbox queue with automatic background drain upon reconnection.
