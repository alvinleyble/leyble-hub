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
5. **One account per person ([ADR 0017](../adr/0017-receipt-numbers-keyed-to-user-accounts.md) §5/§6):**
   each of Alvin, Josie and Luis signs in with their own email
   (`alvin@leyblestore.com`, `josie@leyblestore.com`, `luis@leyblestore.com`) and the JWT is the
   whole identity — `req.user.id` is who signed in, so `activity_logs.performed_by` and
   `GET /auth/me` are that person with nothing in between. The three are long-standing `users`
   rows that `performed_by` already pointed at; `server/db/setup-accounts.js` re-activates the
   two that the old shared-login setup had deactivated. All three share the same password by
   captain decision — attribution is honour-system, exactly as the profile picker it replaces
   was. There is no password reset, no user-management screen and no authorization: every
   account can do everything (ADR 0017, Accepted Open Issues).
   *Superseded:* migration 030's shared `josie@leyblestore.com` login plus a Josie/Luis/Admin
   profile pick sent as an `X-Active-Profile` header. `users.profile_key` (dropped in migration
   041), the header swap, `GET /auth/profiles`, `ProfileContext.jsx` and `ProfilePickerModal.jsx`
   are all gone; `requireAuth` ignores a stray header from a pre-0017 APK rather than rejecting
   it, so old tablets keep working through the update window.

CORS (`index.js`) allows only `localhost:5173` (Vite dev), `https://localhost` +
`capacitor://localhost` (the native Capacitor WebView's origin).

## Environment

There is one environment: **production** — `main` branch → `leyble-hub-api` Render service
(API-only, serves no web client) → prod Supabase DB. Defined in
[`render.yaml`](../../render.yaml). Workflow: `dev` → `main` (prod). See
[operations/android.md](../operations/android.md).

See also: [Database Reference](DATABASE.md) · [API Reference](API.md) ·
[Order Lifecycle](order-lifecycle.md).
