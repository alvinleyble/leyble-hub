# Local Development

How to run Leyble Hub on your own machine. (Production and staging cloud deploys live in
[development-database.md](development-database.md) and [android.md](android.md). The old
Windows/PM2 on-prem setup is retired — there is no on-prem PC anymore.)

## Prerequisites

- **Node.js** 20+
- **PostgreSQL** 15+ (for local throwaway test databases)
- **Git**

## Setup

```bash
# 1. Clone
git clone https://github.com/alvinleyble/leyble-hub.git
cd leyble-hub

# 2. Environment file
cp server/.env.example server/.env
# then edit server/.env (see below)

# 3. Install deps
cd server && npm install && cd ..
cd client && npm install && cd ..
```

`server/.env`:
```
DATABASE_URL=postgresql://postgres:YOUR_PASSWORD@db.yzopwoquzfnyqdmuookw.supabase.co:5432/postgres
JWT_SECRET=<node -e "console.log(require('crypto').randomBytes(48).toString('hex'))">
SEED_ADMIN_PASSWORD=<choose a password>
```
> **Never commit or expose `server/.env`** — it holds `JWT_SECRET` and `SEED_ADMIN_PASSWORD`.

## Run (two terminals)

```bash
# Terminal 1 — backend (port 3000)
cd server && node src/index.js

# Terminal 2 — frontend (port 5173)
cd client && npm run dev
```

Open **http://localhost:5173** (Vite dev-proxies `/api` → `http://localhost:3000`).
Login: one account per person — `alvin@leyblestore.com`, `josie@leyblestore.com` or
`luis@leyblestore.com`, all on the same password *(`ACCOUNT_PASSWORD`, default `leyble123`)*.
Run `node server/db/setup-accounts.js` once if initializing accounts (see
[ARCHITECTURE.md#authentication-flow](../architecture/ARCHITECTURE.md#authentication-flow)).
There is no profile picker — signing in lands straight on the Dashboard.

## The 3-Tier Environment Model & Database Isolation

Leyble Hub operates under a strict 3-tier architecture:

1. **Tier 1 (Dev):** Local workstation running Vite dev (`:5173`) and Express (`:3000`), connected to the Supabase development database (`yzopwoquzfnyqdmuookw` in Tokyo).
2. **Tier 2 (Staging):** API service on **Render** (`leyble-hub-api`), auto-deploying from the `staging` branch to the same development database (`yzopwoquzfnyqdmuookw`). Used for staging APK testing.
3. **Tier 3 (Production):** Compute service on **Northflank**, auto-deploying from the `main` branch to the production Supabase database (`prauvokvlhptvkadvfqq` in Sydney).

> ### ⚠️ STRICT WARNING: NEVER POLLUTE THE DEV / STAGING DATABASE
>
> **NEVER run automated integration tests (`npm test` in `server/`) against the development/staging database (`yzopwoquzfnyqdmuookw`).**
>
> Automated suites insert synthetic test orders and reset sequences, which will corrupt the staging environment for device testing. Automated test suites MUST run against an isolated throwaway local database:
> ```bash
> createdb leyble_hub_v2audit && DATABASE_URL=postgresql://localhost/leyble_hub_v2audit node server/db/migrate.js
> cd server && DATABASE_URL=postgresql://localhost/leyble_hub_v2audit JWT_SECRET='test-jwt-secret-key-32-chars-minimum!!' npm test
> ```
> See [development-database.md](development-database.md) for full operational rules.

- **Isolation Rule:** Local dev points at the dev database; **local dev must NEVER point at production.**
- **Worktree Configuration:** `server/.env` is gitignored. Freshly created worktrees have no copy; copy `server/.env` from an existing checkout before starting the server. If `DATABASE_URL` is unset, `pg` silently falls back to a local socket and connects to the wrong database.
- **Regional Latency:** The dev database (ref `yzopwoquzfnyqdmuookw`) is in Tokyo (`ap-northeast-1`), while production is in Sydney (`ap-southeast-2`). Queries from the Philippines against the dev database have higher latency; this is expected and affects only local dev and staging builds.
- **Migration Rehearsal:** The development database is the rehearsal stage where all migrations (`001`–`045`) are verified before production rollout.

## Environment variables (backend)

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | Yes | PostgreSQL connection string (points to development database for local dev) |
| `PROD_DATABASE_URL_DISABLED` | No | Production connection string retained under a disabled name |
| `JWT_SECRET` | Yes | Secret for signing auth tokens |
| `JWT_EXPIRES_IN` | No | Optional token lifetime (e.g. `8h`) |
| `PORT` | No | Backend port, default `3000` |
| `DEV_CORS_EXTRA_ORIGINS` | No | Comma-separated list of extra origins allowed for CORS in local development (e.g. `http://localhost:5174,http://100.96.45.91:5173,http://localhost`) |
| `SEED_ADMIN_EMAIL` | No | Admin email for seed, default `admin@leyblevhub.local` |
| `SEED_ADMIN_PASSWORD` | Yes | Admin password created by `node db/seed.js` |
| `SEED_ADMIN_NAME` | No | Admin display name, default `Admin` |
| `ACCOUNT_PASSWORD` | No | Password written to Alvin/Josie/Luis accounts by `node db/setup-accounts.js`, default `leyble123` |

## Migrations

```bash
cd server && node db/migrate.js   # run all pending migrations
```
Migrations live in `server/db/migrations/NNN_name.sql` and are tracked in the `_migrations` table.
**Never modify an applied migration — add a new numbered file.** Schema details:
[../architecture/DATABASE.md](../architecture/DATABASE.md).

## Android Emulator Local Connectivity

When running the Android debug APK in an Android emulator against your local Express backend:
- **Emulator Host Loopback:** Android emulators access the host development machine via `http://10.0.2.2:3000` (port 3000 is the local Express server).
- **Vite Build Override:** Because `vite build` executes in production mode, `client/.env.production`'s `VITE_API_URL` outranks `client/.env.local`. Pass `VITE_API_URL` explicitly on the command line when building/syncing the web bundle:
  ```bash
  cd client && VITE_API_URL=http://10.0.2.2:3000 npm run android:sync
  ```
- **CORS Setup:** Ensure `DEV_CORS_EXTRA_ORIGINS` in `server/.env` includes `http://localhost` (the debug APK's WebView origin).
- For complete emulator workflow and on-device test instructions, see [e2e/appium/README.md](../../e2e/appium/README.md).
