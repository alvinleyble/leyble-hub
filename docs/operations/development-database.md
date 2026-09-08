# Development Database & 3-Tier Architecture

**Status:** Active  
**Effective Date:** 2026-08-25  
**See also:** [Local Development](local-development.md), [Database Reference](../architecture/DATABASE.md), [Technical Architecture](../architecture/ARCHITECTURE.md), [ADR 0011](../adr/0011-tablets-as-stations-browser-as-dev-tier.md), [ADR 0014](../adr/0014-v3-release-sequencing.md), [ADR 0018](../adr/0018-supabase-rls-lockdown.md)

---

## Overview: The 3-Tier Environment Model

Leyble Hub operates across a strict 3-tier architecture separating local development, staging verification, and production operations:

| Tier | Git Branch | Compute Hosting | Database Target | Supabase Project Ref | Region | Purpose |
|---|---|---|---|---|---|---|
| **1. Dev** | `dev` / feature branches | Local workstation (Vite :5173 + Express :3000) | Development Supabase DB | `yzopwoquzfnyqdmuookw` | Tokyo (`ap-northeast-1`) | Daily feature development, component testing, interactive debugging |
| **2. Staging** | `staging` | **Render** API service (`leyble-hub-api`, auto-deploy) | Development Supabase DB | `yzopwoquzfnyqdmuookw` | Tokyo (`ap-northeast-1`) | Staging APK device testing, integration smoke tests, pre-release validation |
| **3. Prod** | `main` | **Northflank** compute service | Production Supabase DB | `prauvokvlhptvkadvfqq` | Sydney (`ap-southeast-2`) | Live store operations on store tablets |

---

## Critical Operational Warning: Database Cleanliness & Isolation

> ### ⚠️ STRICT WARNING: NEVER DIRTY OR CLUTTER THE STAGING / DEV DATABASE
>
> The Supabase project `yzopwoquzfnyqdmuookw` is shared between **local development** and the **Render staging compute environment**.
>
> 1. **Automated Test Suites MUST Use Throwaway Databases:**  
>    **NEVER run automated integration test suites (`npm test` in `server/`) against the development/staging Supabase database.** Automated tests insert synthetic orders, alter sequences, and generate test noise. Always create a throwaway local database as documented in [CLAUDE.md](../../CLAUDE.md):
>    ```bash
>    createdb leyble_hub_v2audit && DATABASE_URL=postgresql://localhost/leyble_hub_v2audit node server/db/migrate.js
>    cd server && DATABASE_URL=postgresql://localhost/leyble_hub_v2audit JWT_SECRET='test-jwt-secret-key-32-chars-minimum!!' npm test
>    ```
> 2. **No Ad-Hoc Junk or Scratch Experimentation:**  
>    The staging deployment on Render is used by the captain and developers to test staging APK builds on physical tablets and emulators. Cluttering the database with dummy customers, nonsensical products, or junk orders pollutes the UI, distorts stock counts, and obscures genuine bug verification.
> 3. **High-Fidelity Rehearsals:**  
>    Treat the development/staging database with the care of a pre-production rehearsal environment. Manual test data should follow realistic business scenarios.

---

## Operational Rules

### 1. Absolute Isolation of Production Data
- **Local development and staging compute must NEVER point to the production database.**
- *Historical Context:* Prior to 2026-08-25, local development pointed directly at the production database, leading to test orders and exploratory customer tagging polluting live store data. The dedicated development database completely eliminates cross-environment contamination.

### 2. Environment Configuration (`server/.env`)
- **The Supabase project configured in `server/.env` (ref `yzopwoquzfnyqdmuookw`) is the standing dev/test database.** Use it for local dev and live pair-tests; do not point at production.
- `server/.env` is gitignored, so a **freshly created worktree has no copy of it**. Copy the file from an existing checkout before running `node src/index.js`. If `DATABASE_URL` is unset, `pg` silently falls back to a local socket and connects to the wrong database.
- The production connection string may be retained in `server/.env` only under a disabled variable name (such as `PROD_DATABASE_URL_DISABLED`).
- Switching environments is a deliberate, manual act.
- **Security Rule:** Never commit connection strings, passwords, or credentials to git. All credentials remain strictly within local `.env` files.

### 3. Regional Latency Characteristics
- **Production Database:** ref `prauvokvlhptvkadvfqq`, located in **Sydney** (`ap-southeast-2`).
- **Development Database:** ref `yzopwoquzfnyqdmuookw`, located in **Tokyo** (`ap-northeast-1`).
- Because the development instance is hosted in Tokyo, database queries executed from the Philippines experience higher network latency compared to production. This latency is expected and affects only local developer workstations and staging builds; production tablet performance is unaffected.

### 4. Migration Rehearsal Environment
- The development database serves as the rehearsal stage for all database migrations (from `001` through `045`) before they are executed against the production database.
- Developers must execute and verify new migrations against the development database via `node server/db/migrate.js` prior to scheduling production rollout.

### 5. Staging Deployment (Render)
- Staging compute runs on **Render** (`leyble-hub-api`), auto-deploying from the `staging` git branch as specified in [`render.yaml`](../../render.yaml).
- Staging auto-migrates during Render's build step via `node server/db/migrate.js`.

### 6. Production Deployment (Northflank)
- Production compute runs on **Northflank**, auto-deploying the latest commit on every push to the `main` git branch.
- Production auto-migrates on deploy via a `prestart` script in [`server/package.json`](../../server/package.json) (`"prestart": "node db/migrate.js"`), which `npm start` runs automatically before starting the server.
- `server/db/migrate.js` is idempotent: it records applied migrations in `_migrations` and runs each pending migration transactionally. Re-running on Northflank container restarts is a safe no-op.
