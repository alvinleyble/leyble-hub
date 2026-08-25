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
Login: single shared account `josie@leyblestore.com` / *(`JOSIE_PASSWORD`, default `leyble123`)* —
run `node server/db/setup-profiles.js` once after seeding to set this password and wire up the
Josie/Luis/Admin profile picker (see [ARCHITECTURE.md#authentication-flow](../architecture/ARCHITECTURE.md#authentication-flow)).

## Database Environments & Isolation

A dedicated **development database** (Supabase PostgreSQL, full replica of production) was provisioned on 2026-08-25. See [development-database.md](development-database.md) for full operational policy.

- **Isolation Rule:** Local development points at the development database; **local development must NEVER point at the production database.** (Connecting local dev to production was how test orders and exploratory customer tagging reached live data in the past.)
- **Configuration (`server/.env`):** `DATABASE_URL` is configured to the development database connection string. The production connection string is kept in `server/.env` under a disabled variable name (`PROD_DATABASE_URL_DISABLED`); switching environments requires deliberately swapping variable names.
- **Regional Latency:** The development database is hosted in Tokyo (`ap-northeast-1`), while production is in Sydney (`ap-southeast-2`). Queries from the Philippines against the dev database will be measurably slower due to network latency; this is expected and affects only local dev.
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
| `JOSIE_PASSWORD` | No | Login password for the shared account, used by `node db/setup-profiles.js`, default `leyble123` |

## Migrations

```bash
cd server && node db/migrate.js   # run all pending migrations
```
Migrations live in `server/db/migrations/NNN_name.sql` and are tracked in a `_migrations` table.
**Never modify an applied migration — add a new numbered file.** Schema details:
[../architecture/DATABASE.md](../architecture/DATABASE.md).

