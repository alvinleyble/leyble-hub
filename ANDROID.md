# ANDROID.md — Leyble Hub as an Android app

Leyble Hub ships to Android by **wrapping the existing React/Vite web app with
[Capacitor](https://capacitorjs.com/)**. The same `client/` code becomes the APK — there is
no separate mobile codebase. The browser version still works for local development.

> Plan of record: `we-need-to-plan-valiant-spark.md` (in `~/.claude/plans/`).

---

## How it fits together

```
Android APK (Capacitor WebView)  ──HTTPS──►  Express backend (Render)  ──►  Postgres (Supabase)
                                                     │
Browser / iPad Safari (PWA)      ──HTTPS──►  also serves client/dist (same origin)
```

- The DB and backend are **cloud-hosted** (no on-prem computer). See "Cloud setup" below.
- The Render service serves both the API (`/api/v1/*`) and the built `client/dist` (with an
  SPA fallback to `index.html`), so the same URL works as a website — open it in a browser,
  log in, and "Add to Home Screen" for an app-like icon. Browser/PWA login uses a same-origin
  `SameSite=Strict` cookie, which only works because frontend and API share one origin.
- Auth: web uses an HTTP-only cookie; the **Android app uses a Bearer token** stored in
  `@capacitor/preferences` (native, app-sandboxed storage — *not* browser localStorage).
  Both are handled centrally in [client/src/api/client.js](client/src/api/client.js) and
  [server/src/middleware/auth.js](server/src/middleware/auth.js).

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
   ```
   Note: free Supabase projects pause after ~7 days of no activity (un-pause in the dashboard).

### Backend + Frontend — Render (single service)
1. Create a **Web Service** at https://render.com from this GitHub repo. **Root Directory:
   leave blank** (repo root) — the build needs both `server/` and `client/`.
   - Build command: `npm --prefix server install && npm --prefix client install && npm --prefix client run build && node server/db/migrate.js`
   - Start command: `node server/src/index.js`
   - Health check path: `/health`
2. Set env vars (never commit these): `DATABASE_URL`, `JWT_SECRET`, `JWT_EXPIRES_IN`,
   `SEED_ADMIN_PASSWORD`, `NODE_ENV=production`, and optionally `CLIENT_ORIGIN`
   (comma-separated extra browser origins — not needed for the deployed site itself, since
   it's same-origin).
3. Note the public URL, e.g. `https://leyble-hub.onrender.com`. This URL serves **both** the
   API and the website (open it in a browser to use Leyble Hub directly).
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
- **Bluetooth thermal printing (58mm):** NOT done yet. `window.print()` (in
  [OrderDetailPage.jsx](client/src/pages/orders/OrderDetailPage.jsx)) can't drive a Bluetooth
  ESC/POS printer. This needs a Bluetooth plugin + an ESC/POS generator — planned as a
  separate phase, and the exact printer model must be confirmed first.
- **Push / offline:** out of scope for v1.
