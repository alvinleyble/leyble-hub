# AI Context Primer — read this first

This is the orientation layer: read it (and the docs it links) **before** diving into the code,
and you should understand the whole system without reading the whole codebase. For agent
*working rules* (git policy, reporting style, conventions to follow when editing), see
[CLAUDE.md](../CLAUDE.md) — this primer explains the *system*, CLAUDE.md governs *how you work in
it*.

## 30-second summary

Internal, **wholesale-only** admin app for a beverage distributor in Antipolo, Philippines
("Leyble General Merchandise"). Not customer-facing, no payments. Owners are in their late 50s →
accessibility matters (big targets, big fonts, text+color status). Currency is the Philippine
Peso (₱). Ships **only** as an **Android APK** (Capacitor) hitting a cloud, API-only backend
(**Express on Render/Northflank + Postgres on Supabase**) — there is no web client.

## Mental model

A back-office for the flow of goods:

```
Incoming Supplies → Inventory (Products) → Outgoing Orders → Customers
                          ▲  every stock change is logged (inventory_audit_logs)
        Personnel (drivers/helpers) attach to orders · Tickets track issues · Audit Log is read-only
```

Modules: Dashboard, Inventory, Customers, Personnel, Outgoing Orders, Incoming Supplies, Tickets,
Audit Log. Details in the [PRD](product/PRD.md).

## Topology & Environments

- **Tier 1 (Local Dev):** Local machine (`client/` Vite dev on `:5173`, `server/` Express on `:3000`) connected to the dev Supabase DB (`yzopwoquzfnyqdmuookw` in Tokyo).
- **Tier 2 (Staging):** Compute service on **Northflank**, auto-deploying from git `staging` branch to the dev Supabase DB (`yzopwoquzfnyqdmuookw` in Tokyo). Used for staging APK validation.
- **Tier 3 (Production):** Compute service on **Render** (`leyble-hub-api`), auto-deploying from git `main` branch to the production Supabase DB (`prauvokvlhptvkadvfqq` in Sydney).

## Repo map

```
server/src/
  index.js              Express app (API-only — routes under /api/v1, 404 JSON for anything else)
  db.js                 pg Pool
  middleware/auth.js    requireAuth — accepts cookie OR Bearer, validates session_id (`sid`)
  lib/inventory.js      applyStockDelta/applyDeltaMap — the ONLY place stock changes
  lib/activityLog.js    logActivity + diffFields
  lib/idempotency.js    request_key & receipt_number deduplication
  routes/*.js           auth, products, customers, personnel, orders, incoming, stations, tickets, audit, dashboard
server/db/
  migrations/NNN_*.sql  schema (001–045 tracked in _migrations); migrate.js runs them; seed.js makes admin
client/src/
  api/client.js         api.get/post/patch/del wrapper (Bearer on native, 401→/login)
  pages/<module>/       UI, one folder per module
  offline/              Local-first offline engine (outbox, storage, station identity)
  utils/productSearch.js productMatches() for all product pickers
docs/                   ← you are here
```

## Rules that will bite you if you don't know them up front

- **Append-only tables** — never `UPDATE`/`DELETE`: `inventory_audit_logs`, `activity_logs`,
  `customer_product_prices`. The latest row wins for custom prices.
- **`order_items.line_total` is a GENERATED column** — never write to it. Formula:
  `quantity*unit_price + (quantity*units_per_case − bottles_returned)*unit_deposit_fee`.
- **Order total is goods-only while open**; the refundable deposit is folded in only when the
  order is `done`. This is intentional, not a bug. See
  [order-lifecycle](architecture/order-lifecycle.md).
- **Stock changes go through `lib/inventory.js` only**, always inside a transaction, always
  logging an audit row. Don't `UPDATE products.current_stock` directly elsewhere.
- **Stock deducts at dispatch, not at save** ([ADR 0012](adr/0012-stock-deducts-at-dispatch-not-at-save.md)):
  `pending → in_transit` for delivery, `pending → completed` for pickup.
- **Customer types are `regular`, `wholesaler`, `discounted`, `markup`** (migration 034).
  These are purely descriptive labels for the owners ([ADR 0009](adr/0009-custom-pricing-derived-from-saved-prices.md));
  custom pricing is derived dynamically from saved prices in `customer_product_prices`, not from customer type tags.
- **Saved prices are the pricing source** ([ADR 0009](adr/0009-custom-pricing-derived-from-saved-prices.md)).
  Only the explicit prompt writes a saved price (`POST /customers/:id/prices`).
- **At most one Driver per order** (auto-demote in UI + validated server-side).
- **Quantities/stock are decimal** (`NUMERIC`) to allow 0.5 cases. `pg` returns NUMERIC as
  **strings** → coerce with `Number()`.
- **Receipt numbers are device-issued and keyed to user accounts** (`1A-00042`, [ADR 0017](adr/0017-receipt-numbers-keyed-to-user-accounts.md)).
  Three shapes coexist permanently (`#<id>`, `3-00061`, `3A-00001`); never sort or report by receipt number text.
- **Never modify an applied migration** — add a new `NNN_name.sql`. All migrations through `045` are applied.
- **Single-session per account** ([ADR 0017](adr/0017-receipt-numbers-keyed-to-user-accounts.md) #8, migration 044):
  `sid` claim inside JWT enforced by `requireAuth`.
- **Row Level Security (RLS) is enabled across all 16 tables** (migration 045, [ADR 0018](adr/0018-supabase-rls-lockdown.md)):
  Express connects as `postgres` (`BYPASSRLS=true`), while unauthenticated/anon PostgREST calls fail closed.
- **Auth is dual-mode**: web uses an HTTP-only SameSite=Strict cookie; the Android app uses a
  Bearer token from `@capacitor/preferences`. `requireAuth` accepts both.
- **Nothing is hard-deleted where it anchors history**: orders are cancelled, deliveries voided,
  products/customers/personnel soft-deactivated.
- **The archived spec is stale** ([docs/archive/SPECIFICATION.md](archive/SPECIFICATION.md)) —
  trust the migrations and these docs over it.

## Where to go next

| You need to… | Read |
|---|---|
| Understand what the app is / why | [product/PRD.md](product/PRD.md) |
| Look up a domain term | [product/glossary.md](product/glossary.md) |
| Understand the stack / auth / layout / 3 tiers | [architecture/ARCHITECTURE.md](architecture/ARCHITECTURE.md) |
| Know the current schema (001–045) | [architecture/DATABASE.md](architecture/DATABASE.md) |
| Call/extend an endpoint | [architecture/API.md](architecture/API.md) |
| Touch order status/stock/deposit logic | [architecture/order-lifecycle.md](architecture/order-lifecycle.md) |
| Review architectural decisions | [adr/](adr/) (ADR 0001–0018) |
| Run it locally | [operations/local-development.md](operations/local-development.md) |
| Understand DB environments & staging warnings | [operations/development-database.md](operations/development-database.md) |
| Build the APK / deploy | [operations/android.md](operations/android.md) |
| Follow working rules & conventions | [CLAUDE.md](../CLAUDE.md) |
