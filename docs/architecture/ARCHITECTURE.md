# Technical Architecture

Leyble Hub is a single-page React app, wrapped in Capacitor and shipped **only** as an Android
APK, talking to an **API-only** Express/PostgreSQL backend. The backend serves no web client.

## Stack

| Layer | Technology |
|---|---|
| Frontend | React 18, Vite, Tailwind CSS v3 |
| Backend | Node.js + Express, raw `pg` (no ORM) |
| Auth | JWT — `Authorization: Bearer` (native app) **or** HTTP-only `SameSite=Strict` cookie (local browser dev only) |
| Database | PostgreSQL 15+ (`NUMERIC(10,2)` money, `TIMESTAMPTZ` timestamps) |
| Mobile | Capacitor wrap of the same `client/` build |
| Hosting | Express on **Render**, Postgres on **Supabase** |

## Topology

```
Android APK (Capacitor WebView)  ──HTTPS──►  Express on Render  ──►  Postgres on Supabase
```

A single Render web service runs `node server/src/index.js`. It mounts the API under
`/api/v1/*` and returns a 404 JSON for everything else — it is **API-only** and serves no web
client (see [`server/src/index.js`](../../server/src/index.js)). The Android app authenticates
with a Bearer token; the cookie path remains only for local browser dev (`npm run dev`).

## Backend layout (`server/`)

```
server/src/
├── index.js              # Express app: CORS, JSON (10mb for ID images), routes, 404 JSON catch-all
├── db.js                 # pg Pool (DATABASE_URL)
├── middleware/
│   ├── auth.js           # requireAuth — accepts cookie OR Bearer token
│   └── errorHandler.js   # central error → JSON
├── lib/
│   ├── inventory.js      # applyStockDelta / applyDeltaMap — the ONLY place stock changes
│   └── activityLog.js    # logActivity + diffFields (writes activity_logs)
└── routes/               # one file per resource (auth, products, customers, personnel,
                          # orders, incoming, tickets, audit, dashboard)
server/db/
├── migrations/NNN_*.sql  # schema; tracked in _migrations table
├── migrate.js            # runs pending migrations
└── seed.js               # creates the first admin user
```

Every route file does `router.use(requireAuth)` except `auth.js` (only `/me` is guarded there),
so **all `/api/v1/*` endpoints require auth except `POST /api/v1/auth/login`**.

## Frontend layout (`client/src/`)

```
api/client.js            # api.get/post/patch/del wrapper — credentials:'include',
                         #   injects Bearer token on native, redirects to /login on 401
context/AuthContext.jsx  # logged-in user state
components/{layout,ui}   # shared layout + UI primitives
pages/<module>/          # one folder per module (orders, customers, inventory, incoming,
                         #   personnel, tickets, audit, + DashboardPage, LoginPage)
utils/productSearch.js   # productMatches() — punctuation-insensitive product search
```

**Conventions to follow** (also in [CLAUDE.md](../../CLAUDE.md)): searchable combobox for every
product picker (`productMatches`), side-panel for detail views, modal for create/edit forms,
a locally-defined `PHP()` formatter per file, toasts via `useToast()`. The permanent sidebar
renders only on the custom `desktop:` breakpoint (`min-width:1024px` **and** `pointer:fine`);
phones/tablets get a hamburger drawer.

## Authentication flow

1. `POST /api/v1/auth/login` verifies credentials and issues a JWT.
2. **Native Android (production):** the client stores the JWT in `@capacitor/preferences`
   (app-sandboxed native storage — *not* browser localStorage) and sends it as
   `Authorization: Bearer <token>`. This is how the live app authenticates.
3. **Local browser dev only:** `npm run dev` runs in a browser, where the JWT is set as an
   HTTP-only `SameSite=Strict` cookie. Production serves no web client, so this path exists only
   for local development.
4. [`requireAuth`](../../server/src/middleware/auth.js) accepts **either** the cookie or the
   Bearer header. On any `401` the client clears the token and redirects to `/login`.
5. **Profile picker (migration 030):** login is now a single shared account
   (`josie@leyblestore.com`); after logging in, the client must pick a profile (Josie / Luis /
   Admin, from `GET /auth/profiles`) via `ProfileContext`/`ProfilePickerModal`, and sends it as an
   `X-Active-Profile` header on every subsequent request. `requireAuth` swaps `req.user.id`/
   `full_name` to that profile's `users` row (looked up by `profile_key`), so `activity_logs.performed_by`
   and `GET /auth/me` reflect *who's driving the app*, not the shared login identity. See
   `server/db/setup-profiles.js` for how `profile_key` is assigned.

CORS (`index.js`) allows only `localhost:5173` (Vite dev), `https://localhost` +
`capacitor://localhost` (the native Capacitor WebView's origin).

## Environment

There is one environment: **production** — `main` branch → `leyble-hub-api` Render service
(API-only, serves no web client) → prod Supabase DB. Defined in
[`render.yaml`](../../render.yaml). Workflow: `dev` → `main` (prod). See
[operations/android.md](../operations/android.md).

See also: [Database Reference](DATABASE.md) · [API Reference](API.md) ·
[Order Lifecycle](order-lifecycle.md).
