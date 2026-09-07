# Technical Architecture

Leyble Hub is a single-page React app, wrapped in Capacitor and shipped **only** as an Android
APK, talking to an **API-only** Express/PostgreSQL backend. The backend serves no web client.

## Stack

| Layer | Technology |
|---|---|
| Frontend | React 18, Vite, Tailwind CSS v3 |
| Backend | Node.js + Express, raw `pg` (no ORM) |
| Auth | JWT — `Authorization: Bearer` (native app) **or** HTTP-only `SameSite=Strict` cookie (local browser dev only). Single session per user account enforced via `sid` claim |
| Database | PostgreSQL 15+ (`NUMERIC(10,2)` money, `TIMESTAMPTZ` timestamps). RLS enabled across all tables |
| Mobile | Capacitor wrap of the same `client/` build |
| Hosting | Express on **Render** (prod) & **Northflank** (staging), Postgres on **Supabase** |

## Topology & Environments (3-Tier Model)

```
[ Tier 1: Local Dev ]
Local Workstation (Vite :5173 + Express :3000)
       │ DATABASE_URL
       ▼
Supabase Dev DB (Tokyo, `yzopwoquzfnyqdmuookw`)

[ Tier 2: Staging ]
Android Staging APK (Capacitor)
       │ HTTPS
       ▼
Northflank Compute Service (branch: `staging`, auto-deploy + auto-migrate via `prestart`)
       │ DATABASE_URL
       ▼
Supabase Dev DB (Tokyo, `yzopwoquzfnyqdmuookw`)

[ Tier 3: Production ]
Android Store APK (Capacitor)
       │ HTTPS
       ▼
Render API Service (branch: `main`, `leyble-hub-api`, auto-deploy + auto-migrate via `render.yaml`)
       │ DATABASE_URL
       ▼
Supabase Prod DB (Sydney, `prauvokvlhptvkadvfqq`)
```

### The Three Environments

1. **Development (`dev`):** Local development on developer workstations (`cd client && npm run dev` / `cd server && node src/index.js`). Connects via `server/.env` to the dedicated Supabase development database (`yzopwoquzfnyqdmuookw` in Tokyo).
2. **Staging (`staging`):** Compute service hosted on **Northflank**, auto-deploying from the `staging` git branch. Connects to the same Supabase development database (`yzopwoquzfnyqdmuookw`). Used exclusively for staging APK device verification and integration smoke-testing. Runs migrations automatically on deployment via `npm start`'s `prestart` script in [`server/package.json`](../../server/package.json).
3. **Production (`main`):** Web API service hosted on **Render** (`leyble-hub-api`), auto-deploying from the `main` git branch and defined in [`render.yaml`](../../render.yaml). Connects to the production Supabase database (`prauvokvlhptvkadvfqq` in Sydney). Serves live store tablets. Migrations run during build time via `node server/db/migrate.js`.

> **Environment Isolation:** Local development and staging share the Tokyo development database. Production (Sydney) is strictly isolated. The staging database must NEVER be dirtied or cluttered with ad-hoc test runs or automated test suites (see [development-database.md](../operations/development-database.md)).

---

## Backend Layout (`server/`)

```
server/src/
├── index.js              # Express app: CORS, JSON (10mb for ID images), routes, 404 JSON catch-all
├── db.js                 # pg Pool (DATABASE_URL)
├── middleware/
│   ├── auth.js           # requireAuth — accepts cookie OR Bearer, validates session_id (`sid`)
│   └── errorHandler.js   # central error → JSON
├── lib/
│   ├── inventory.js      # applyStockDelta / applyDeltaMap — the ONLY place stock changes
│   ├── activityLog.js    # logActivity + diffFields (writes activity_logs)
│   ├── idempotency.js    # request_key & receipt_number deduplication
│   ├── personNumbers.js  # assertIssuableStation / receipt person range guards
│   └── deviceLetters.js  # nextDeviceLetter allocation helper
└── routes/               # one file per resource (auth, products, customers, personnel,
                          # orders, incoming, stations, tickets, audit, dashboard)
server/db/
├── migrations/NNN_*.sql  # schema (tracked in _migrations table)
├── migrate.js            # runs pending migrations transactionally
├── seed.js               # creates the first admin user
└── setup-accounts.js     # sets up the permanent Alvin, Josie, Luis accounts
```

Every route file mounts `router.use(requireAuth)` except `auth.js` (where only `/me` is guarded),
so **all `/api/v1/*` endpoints require auth except `POST /api/v1/auth/login` and `POST /api/v1/auth/logout`**.

---

## Frontend Layout (`client/src/`)

```
client/src/
├── api/client.js         # api.get/post/patch/del wrapper — credentials:'include',
│                         #   injects Bearer token on native, redirects to /login on 401
├── context/AuthContext.jsx # logged-in user state & account switching
├── offline/              # local-first offline engine (outbox, storage, station identity)
├── components/{layout,ui}# shared layout + UI primitives
├── pages/<module>/       # one folder per module (orders, customers, inventory, incoming,
│                         #   personnel, tickets, audit, + DashboardPage, LoginPage)
└── utils/productSearch.js# productMatches() — punctuation-insensitive product search
```

**Conventions to follow** (also in [CLAUDE.md](../../CLAUDE.md)): searchable combobox for every
product picker (`productMatches`), side-panel for detail views, modal for create/edit forms,
a locally-defined `PHP()` formatter per file, toasts via `useToast()`. The permanent sidebar
renders only on the custom `desktop:` breakpoint (`min-width:1024px` **and** `pointer:fine`);
phones/tablets get a hamburger drawer.

---

## Authentication Flow & Single-Session Enforcement

1. `POST /api/v1/auth/login` verifies email and bcrypt password.
2. **Single-Session Per Account ([ADR 0017](../adr/0017-receipt-numbers-keyed-to-user-accounts.md) #8, migration 044):**
   - Logging in generates a fresh UUID `session_id`.
   - The server updates `users.session_id`, `users.session_device` (from optional `device_key`), and `users.session_started_at = NOW()`.
   - The `session_id` is signed into the JWT as the `sid` claim.
   - Any previous session for this user on any other device is immediately superseded.
3. **Native Android (Capacitor):**
   - The client stores the JWT in `@capacitor/preferences` (app-sandboxed native storage) and sends it as `Authorization: Bearer <token>`.
   - Under ADR 0017 #7, the client keeps remembered account tokens locally for fast two-tap offline account switching.
4. **Local Browser Dev:**
   - `npm run dev` sets the JWT in an HTTP-only `SameSite=Strict` cookie. Production serves no web client, so this path exists only for local dev.
5. **Session Verification ([`requireAuth`](../../server/src/middleware/auth.js)):**
   - `requireAuth` reads the token (Bearer header wins over cookie).
   - Verifies JWT signature against `JWT_SECRET`.
   - Checks `claims.sid === users.session_id`. If they do not match, returns `401` with `{ error: 'This account was signed in on another device. Sign in again to keep using it here.', code: 'session_superseded' }`.
   - On a 401, client clears the active session and prompts to re-login.
   - *Offline Safety:* Takeover is a server-side act. An offline tablet continues issuing receipts locally using its stored identity; outbox records waiting to sync are device state and survive being signed out (ADR 0015 §3, ADR 0017 #8).
6. **One Account Per Person ([ADR 0017](../adr/0017-receipt-numbers-keyed-to-user-accounts.md) §5/§6):**
   - Each person (Alvin, Josie, Luis) signs in with their own email.
   - `req.user.id` is who signed in, directly populating `activity_logs.performed_by` and `orders.created_by` (`sold_by_name`).
   - The legacy `profile_key` / `X-Active-Profile` header mechanism was completely removed in migration 041.

---

## Database Security & Row Level Security (RLS)

Per migration `045_enable_rls.sql` and [ADR 0018](../adr/0018-supabase-rls-lockdown.md), Row Level Security (RLS) is enabled across all 16 tables:
- **Express Backend:** Connects via `DATABASE_URL` as user `postgres`. In PostgreSQL/Supabase, `postgres` has `BYPASSRLS = true`. All application queries, transactions, and migration runs bypass RLS automatically with zero performance penalty.
- **Supabase PostgREST & GraphQL:** Direct HTTP access via Supabase's public endpoints (which run as `anon` or `authenticated` roles) fails closed with zero rows returned or 401/403 errors, because zero public policies are granted.
- This provides airtight defense-in-depth in preparation for repository public visibility.

---

## CORS & Network Security

CORS (`server/src/index.js`) allows only:
- `http://localhost:5173` (Vite dev server)
- `https://localhost` and `capacitor://localhost` (Capacitor Android WebView origins)
- Optional developer origins defined in `DEV_CORS_EXTRA_ORIGINS` (e.g. for Android emulator loopback `10.0.2.2`).

See also: [Database Reference](DATABASE.md) · [API Reference](API.md) · [Order Lifecycle](order-lifecycle.md) · [ADR 0018](../adr/0018-supabase-rls-lockdown.md).
