# Local Development

How to run Leyble Hub on your own machine. (Production/cloud deploy lives in
[android.md](android.md). The old Windows/PM2 on-prem setup is retired — there is no on-prem PC
anymore.)

## Prerequisites

- **Node.js** 20+
- **PostgreSQL** 15+
- **Git**

## Setup

```bash
# 1. Clone
git clone https://github.com/alvinleyble/leyble-hub.git
cd leyble-hub

# 2. Create the database
psql -U postgres -c "CREATE DATABASE leyble_hub;"

# 3. Environment file
cp server/.env.example server/.env
# then edit server/.env (see below)

# 4. Install deps, migrate, seed the admin user
cd server && npm install && node db/migrate.js && node db/seed.js && cd ..
cd client && npm install && cd ..
```

`server/.env`:
```
DATABASE_URL=postgresql://postgres:YOUR_PG_PASSWORD@localhost/leyble_hub
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
Run `node server/db/setup-accounts.js` once after seeding to activate the three (see
[ARCHITECTURE.md#authentication-flow](../architecture/ARCHITECTURE.md#authentication-flow)).
There is no profile picker — signing in lands straight on the Dashboard.

## Database Environments & Isolation

A dedicated **development database** (Supabase PostgreSQL, full replica of production) was provisioned on 2026-08-25. See [development-database.md](development-database.md) for full operational policy.

**"Staging" and "dev/test" name the same database** — the captain calls it "staging", these docs
call it "dev/test" or "development"; there is no separate staging environment. Project refs:
production `prauvokvlhptvkadvfqq` (Sydney), development/staging/dev-test `yzopwoquzfnyqdmuookw`
(Tokyo).

> **The Supabase project already wired into `server/.env` (ref `yzopwoquzfnyqdmuookw`) IS the
> standing dev/test database.** Captain-confirmed 2026-08-26 — "we've been using this." Do not
> swap it for another connection string and do not stand up a local Postgres for ordinary dev or
> a live pair-test; point at what the file already holds.
>
> `server/.env` is gitignored, so a **fresh worktree has no copy of it**. Copy it in from an
> existing checkout before starting the backend the first time. Without it `DATABASE_URL` is
> unset and `pg` falls back to a local socket — it connects to the *wrong* database silently
> instead of failing loudly, which is the failure mode this note exists to prevent.
>
> (Throwaway databases are still the right thing for the automated suites — see the Tests
> section of [CLAUDE.md](../../CLAUDE.md); never run those against the dev database.)

- **Isolation Rule:** Local development points at the development database; **local development must NEVER point at the production database.** (Connecting local dev to production was how test orders and exploratory customer tagging reached live data in the past.)
- **Configuration (`server/.env`):** `DATABASE_URL` is configured to the development database connection string. The production connection string is kept in `server/.env` under a disabled variable name (`PROD_DATABASE_URL_DISABLED`); switching environments requires deliberately swapping variable names.
- **Regional Latency:** The development database (ref `yzopwoquzfnyqdmuookw`) is hosted in Tokyo (`ap-northeast-1`), while production (ref `prauvokvlhptvkadvfqq`) is in Sydney (`ap-southeast-2`). Queries from the Philippines against the dev database will be measurably slower due to network latency; this is expected and affects only local dev.
- **Migration Rehearsal:** The development database is the rehearsal stage where all migrations (`031`, `032`, `033`) are tested and verified before deployment to production.

## Environment variables (backend)

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | Yes | PostgreSQL connection string (points to development database for local dev) |
| `PROD_DATABASE_URL_DISABLED` | No | Production connection string retained under a disabled name |
| `JWT_SECRET` | Yes | Secret for signing auth tokens |
| `JWT_EXPIRES_IN` | No | Token lifetime, default `8h` |
| `PORT` | No | Backend port, default `3000` |
| `DEV_CORS_EXTRA_ORIGINS` | No | Comma-separated list of extra origins allowed for CORS in local development (e.g. `http://localhost:5174,http://100.96.45.91:5173`) |
| `SEED_ADMIN_EMAIL` | No | Admin email for seed, default `admin@leyblevhub.local` |
| `SEED_ADMIN_PASSWORD` | Yes | Admin password created by `node db/seed.js` |
| `SEED_ADMIN_NAME` | No | Admin display name, default `Admin` |
| `ACCOUNT_PASSWORD` | No | Password written to the re-activated Alvin/Luis accounts by `node db/setup-accounts.js`, default `leyble123` |

## Migrations

```bash
cd server && node db/migrate.js   # run all pending migrations
```
Migrations live in `server/db/migrations/NNN_name.sql` and are tracked in a `_migrations` table.
**Never modify an applied migration — add a new numbered file.** Schema details:
[../architecture/DATABASE.md](../architecture/DATABASE.md).

