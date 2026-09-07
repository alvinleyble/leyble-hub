# Supabase Row Level Security (RLS) Lockdown Across All Tables

**Status:** Settled (2026-09-07)  
**Origin:** Captain decision, 2026-09-07 (security lockdown for repository public visibility)  
**Migration:** [`server/db/migrations/045_enable_rls.sql`](../../server/db/migrations/045_enable_rls.sql)  
**See also:** [Database Reference](../architecture/DATABASE.md), [Technical Architecture](../architecture/ARCHITECTURE.md), [Development Database](../operations/development-database.md), [ADR 0014: V3.0 Release Sequencing](0014-v3-release-sequencing.md)

---

## Context

Leyble Hub is preparing for repository public visibility. The application architecture is strictly API-only: the Android APK (Capacitor) and local development environments communicate exclusively with the Node.js Express backend (`/api/v1/*`), which in turn connects to PostgreSQL on Supabase via `DATABASE_URL`.

Supabase projects automatically expose PostgREST (`/rest/v1/*`) and GraphQL HTTP endpoints to the public internet by default. These endpoints authenticate requests using Supabase API keys (`anon` and `service_role`). In PostgreSQL and Supabase:
- When Row Level Security (RLS) is **disabled** on a table, the table is open to direct queries and mutations via the public PostgREST endpoints using the `anon` key.
- If repository code, build configs, or client bundles are made publicly visible, any attacker or automated scanner discovering the Supabase project reference could potentially enumerate, extract, or tamper with business records directly via PostgREST, completely bypassing Express middleware, authentication (`requireAuth`), and audit logging (`inventory_audit_logs`, `activity_logs`).

To ensure total defense-in-depth, the database layer itself must fail closed against any direct access outside the Express application.

---

## Decision

1. **Enable Row Level Security (RLS) across all tables.**  
   Migration `045_enable_rls.sql` enables RLS across all 16 application and system tables in the schema:
   - `users`
   - `products`
   - `customers`
   - `customer_product_prices`
   - `personnel`
   - `orders`
   - `order_items`
   - `supplier_deliveries`
   - `supplier_delivery_items`
   - `tickets`
   - `inventory_audit_logs`
   - `order_personnel`
   - `activity_logs`
   - `stations`
   - `user_devices`
   - `_migrations`

2. **Define zero public access policies.**  
   No permissive policies (`CREATE POLICY`) are defined for any table. In PostgreSQL, enabling RLS on a table without defining any policies causes all queries from standard roles to fail closed:
   - `SELECT` queries return zero rows.
   - `INSERT`, `UPDATE`, and `DELETE` mutations fail with permission errors.
   - Metadata enumeration and direct PostgREST table access return empty arrays or 401/403 responses.

---

## Mechanism

The Express backend connects to PostgreSQL through a pooled connection string (`DATABASE_URL`) as the PostgreSQL database owner user (`postgres`).

In PostgreSQL:
- Superuser accounts and roles explicitly created with the `BYPASSRLS` attribute ignore all Row Level Security policies entirely.
- In Supabase, the default `postgres` role has `BYPASSRLS = true`.
- Therefore, all application queries, background sync tasks, and migrations executed by the Express backend connect as `postgres` and bypass RLS automatically.
- Application queries proceed at full native speed with zero query rewriting overhead.
- Direct external requests targeting Supabase's PostgREST or GraphQL HTTP endpoints execute as `anon` or `authenticated` roles, which do not have `BYPASSRLS` and are blocked by the default-deny RLS posture.

```
                      ┌───────────────────────────┐
                      │  Android APK / Local Dev  │
                      └─────────────┬─────────────┘
                                    │ HTTPS
                                    ▼
                      ┌───────────────────────────┐
                      │  Express API (Backend)    │
                      └─────────────┬─────────────┘
                                    │ DATABASE_URL (role: postgres, BYPASSRLS=true)
                                    ▼
                      ┌───────────────────────────┐
                      │  PostgreSQL (Supabase)    │
                      │  All 16 tables: RLS ON    │
                      └───────────────────────────┘
                                    ▲
                                    │ PostgREST / GraphQL HTTP API
                                    │ (role: anon / authenticated, NO BYPASSRLS)
                      ┌─────────────┴─────────────┐
                      │  Direct / External Call   │ ──► BLOCKED (Fail Closed)
                      └───────────────────────────┘
```

`ALTER TABLE ... ENABLE ROW LEVEL SECURITY` is idempotent in PostgreSQL, making migration `045_enable_rls.sql` safe to run across development, staging, and production databases.

---

## Consequences

- **Airtight Defense-in-Depth:** The database schema is completely protected against direct PostgREST or GraphQL access regardless of repository publicity or leaked `anon` keys.
- **Zero Application Impact:** The Express backend requires zero code changes. Connection pooling, SQL queries, transactional stock mutations, and migration runners continue operating identically.
- **Strict Single-Gate Architecture:** The Express backend remains the sole authorized gate for all business logic, validation, authentication, and audit trails.
