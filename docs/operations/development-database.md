# Development Database

**Status:** Active  
**Effective Date:** 2026-08-25  
**See also:** [Local Development](local-development.md), [Database Reference](../architecture/DATABASE.md), [ADR 0011](../adr/0011-tablets-as-stations-browser-as-dev-tier.md), [ADR 0014](../adr/0014-v3-release-sequencing.md)

## Overview

A dedicated **development** PostgreSQL database hosted on Supabase was provisioned on 2026-08-25. It contains a full, standalone replica of the production schema and data.

This database provides an isolated development tier for local testing, browser-based UI development, and migration rehearsal without risking live store operations.

## Operational Rules

### 1. Absolute Isolation of Production Data
- **Local development environments must point exclusively to the development database.**
- **Local development must NEVER point directly at the production database.**
- *Historical Context:* Prior to 2026-08-25, local development environments pointed directly at the production database. This allowed test orders, exploratory tagging, and development experiments to inadvertently pollute live store data. The dedicated development database completely eliminates this cross-environment contamination.

### 2. Environment Configuration (`server/.env`)
- **The Supabase project already configured in `server/.env` (ref `yzopwoquzfnyqdmuookw`) is the standing dev/test database** — captain-confirmed 2026-08-26 ("we've been using this"). Use it as-is for local dev and for live pair-tests; do not substitute another connection string and do not stand up a local Postgres instead.
- `server/.env` is gitignored, so a **freshly created worktree has no copy of it**. Copy the file in from an existing checkout before the first `node src/index.js`: with `DATABASE_URL` unset, `pg` silently falls back to a local socket and connects to the wrong database rather than failing loudly.
- Local development sets the active `DATABASE_URL` environment variable to the development Supabase database pooled connection string.
- The production connection string is retained in the local `server/.env` file under a disabled variable name (specifically `PROD_DATABASE_URL_DISABLED` or commented out).
- Switching environments is a deliberate, manual act of swapping or renaming the variable names in `server/.env`.
- **Security Rule:** Never commit connection strings, passwords, project references, or credentials to git. All credentials remain strictly within uncommitted local `.env` files.

### 3. Regional Latency Characteristics
- **Production Database:** Located in the **Sydney** region (`ap-southeast-2`).
- **Development Database:** Located in the **Tokyo** region (`ap-northeast-1`).
- Because the development instance is hosted in Tokyo, database queries executed from the Philippines experience measurably higher latency compared to production. This latency is expected and affects only local developer workstations; production tablet performance is unaffected.

### 4. Migration Rehearsal Environment
- The development database serves as the rehearsal stage for all database migrations (including migrations `031`, `032`, and `033`) before they are executed against the production database.
- Developers must execute and verify new migrations against the development database via `node server/db/migrate.js` prior to scheduling production rollout.
