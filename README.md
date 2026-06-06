# Leyble Hub

Internal admin app for **Leyble General Merchandise** — a beverage distributor based in Antipolo, Philippines. Manages outgoing orders, incoming supplies, inventory, customers, and personnel. Not customer-facing.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 18, Vite, Tailwind CSS v3 |
| Backend | Node.js + Express, raw `pg` (no ORM) |
| Auth | JWT in HTTP-only SameSite=Strict cookies |
| Database | PostgreSQL 15+ |

---

## Prerequisites

- **Node.js** 20+
- **PostgreSQL** 15+
- **Git**
- **PM2** (production only) — `npm install -g pm2`

---

## Local Development Setup

### 1. Clone the repo

```bash
git clone https://github.com/alvinleyble/leyble-hub.git
cd leyble-hub
```

### 2. Create the database

```bash
psql -U postgres -c "CREATE DATABASE leyble_hub;"
```

Or via the SQL Shell (psql): `CREATE DATABASE leyble_hub;`

### 3. Set up environment variables

```bash
cp server/.env.example server/.env
```

Edit `server/.env`:

```
DATABASE_URL=postgresql://postgres:YOUR_PG_PASSWORD@localhost/leyble_hub
JWT_SECRET=<generate: node -e "console.log(require('crypto').randomBytes(48).toString('hex'))">
SEED_ADMIN_PASSWORD=<choose a password>
```

See [Environment Variables](#environment-variables) for all options.

### 4. Install dependencies and run migrations

```bash
cd server && npm install && node db/migrate.js && node db/seed.js && cd ..
cd client && npm install && cd ..
```

### 5. Start the dev servers

```bash
# Terminal 1 — backend (port 3000)
cd server && node src/index.js

# Terminal 2 — frontend (port 5173)
cd client && npm run dev
```

Open **http://localhost:5173**

Login: `admin@leyblevhub.local` / *(your `SEED_ADMIN_PASSWORD`)*

---

## Windows Production Install (Parents' Computer)

For the first-time setup on the Windows machine where the business owners use the app.

### Prerequisites (install in this order)

1. [Node.js LTS](https://nodejs.org) — choose "Recommended for most users"
2. [Git for Windows](https://git-scm.com/download/win) — all defaults are fine
3. [PostgreSQL](https://www.postgresql.org/download/windows) — note the password you set for the `postgres` user

### Steps

**1. Open Command Prompt as Administrator** (search "cmd" → right-click → Run as administrator)

**2. Install PM2**
```
npm install -g pm2
npm install -g pm2-windows-startup
pm2-startup install
```

**3. Clone the repo**
```
cd C:\
git clone https://github.com/alvinleyble/leyble-hub.git
cd leyble-hub
```

**4. Create the database**

Open Start menu → search "SQL Shell (psql)" → press Enter for all prompts except password:
```sql
CREATE DATABASE leyble_hub;
\q
```

**5. Create the environment file**
```
cd C:\leyble-hub\server
copy .env.example .env
notepad .env
```

Fill in:
```
DATABASE_URL=postgresql://postgres:YOUR_PG_PASSWORD@localhost/leyble_hub
JWT_SECRET=<generate a random string — see step 3 of local dev setup>
SEED_ADMIN_PASSWORD=<the password your parents will use to log in>
```

**6. Install dependencies, migrate, and seed**
```
cd C:\leyble-hub\server
npm install
node db/migrate.js
node db/seed.js
cd ..\client
npm install
```

**7. Start with PM2**
```
cd C:\leyble-hub
pm2 start server/src/index.js --name leyble-server
pm2 start npm --name leyble-client --cwd C:\leyble-hub\client -- run dev
pm2 save
```

**8. Open and bookmark the app**

Go to **http://localhost:5173** in the browser and bookmark it.

Login: `admin@leyblevhub.local` / *(your chosen password)*

---

## Updating the App

After pushing changes to GitHub:

**Windows:** double-click `update.bat` in `C:\leyble-hub\`

**Mac/Linux:** run `./update.sh` in the repo root

Both scripts: pull latest code → install any new packages → run new migrations → restart PM2.

---

## Environment Variables

Stored in `server/.env` (never committed).

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `JWT_SECRET` | Yes | Secret for signing auth tokens. Generate: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| `JWT_EXPIRES_IN` | No | Token lifetime, default `8h` |
| `PORT` | No | Backend port, default `3000` |
| `CLIENT_ORIGIN` | No | Allowed CORS origin, default `http://localhost:5173` |
| `SEED_ADMIN_EMAIL` | No | Admin email for seed, default `admin@leyblevhub.local` |
| `SEED_ADMIN_PASSWORD` | Yes | Admin password created by `node db/seed.js` |
| `SEED_ADMIN_NAME` | No | Admin display name, default `Admin` |

---

## Database Migrations

Migrations live in `server/db/migrations/NNN_name.sql` and are tracked in a `_migrations` table.

```bash
# Run all pending migrations
cd server && node db/migrate.js
```

**Never modify an applied migration** — always add a new numbered file.

---

## Project Structure

```
leyble-hub/
├── client/                  # React + Vite frontend
│   └── src/
│       ├── api/client.js    # API wrapper (get/post/patch/del)
│       ├── components/      # Shared UI components
│       └── pages/           # One folder per module
├── server/                  # Express backend
│   ├── db/
│   │   ├── migrations/      # SQL migration files
│   │   ├── migrate.js       # Migration runner
│   │   └── seed.js          # Creates first admin user
│   └── src/
│       ├── routes/          # One file per resource
│       └── middleware/      # auth, errorHandler
├── update.bat               # Windows update script
├── update.sh                # Mac/Linux update script
└── CLAUDE.md                # Claude Code instructions
```
