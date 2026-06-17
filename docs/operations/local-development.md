# Local Development

How to run Leyble Hub on your own machine. (Production/cloud deploy lives in
[android.md](android.md) and [staging.md](staging.md). The old Windows/PM2 on-prem setup is
retired — there is no on-prem PC anymore.)

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
Login: `admin@leyblevhub.local` / *(your `SEED_ADMIN_PASSWORD`)*.

## Environment variables (backend)

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `JWT_SECRET` | Yes | Secret for signing auth tokens |
| `JWT_EXPIRES_IN` | No | Token lifetime, default `8h` |
| `PORT` | No | Backend port, default `3000` |
| `CLIENT_ORIGIN` | No | Extra allowed CORS origins (comma-separated) |
| `SEED_ADMIN_EMAIL` | No | Admin email for seed, default `admin@leyblevhub.local` |
| `SEED_ADMIN_PASSWORD` | Yes | Admin password created by `node db/seed.js` |
| `SEED_ADMIN_NAME` | No | Admin display name, default `Admin` |

## Migrations

```bash
cd server && node db/migrate.js   # run all pending migrations
```
Migrations live in `server/db/migrations/NNN_name.sql` and are tracked in a `_migrations` table.
**Never modify an applied migration — add a new numbered file.** Schema details:
[../architecture/DATABASE.md](../architecture/DATABASE.md).
