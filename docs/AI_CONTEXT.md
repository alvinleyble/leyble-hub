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
(**Express on Render + Postgres on Supabase**) — there is no web client.

## Mental model

A back-office for the flow of goods:

```
Incoming Supplies → Inventory (Products) → Outgoing Orders → Customers
                          ▲  every stock change is logged (inventory_audit_logs)
        Personnel (drivers/helpers) attach to orders · Tickets track issues · Audit Log is read-only
```

Modules: Dashboard, Inventory, Customers, Personnel, Outgoing Orders, Incoming Supplies, Tickets,
Audit Log. Details in the [PRD](product/PRD.md).

## Repo map

```
server/src/
  index.js              Express app (API-only — routes under /api/v1, 404 JSON for anything else)
  db.js                 pg Pool
  middleware/auth.js    requireAuth — accepts cookie OR Bearer
  lib/inventory.js      applyStockDelta/applyDeltaMap — the ONLY place stock changes
  lib/activityLog.js    logActivity + diffFields
  routes/*.js           auth, products, customers, personnel, orders, incoming, tickets, audit, dashboard
server/db/
  migrations/NNN_*.sql  schema (tracked in _migrations); migrate.js runs them; seed.js makes admin
client/src/
  api/client.js         api.get/post/patch/del wrapper (Bearer on native, 401→/login)
  pages/<module>/       UI, one folder per module
  utils/productSearch.js  productMatches() for all product pickers
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
- **At most one Driver per order** (auto-demote in UI + validated server-side).
- **Quantities/stock are decimal** (`NUMERIC`) to allow 0.5 cases. `pg` returns NUMERIC as
  **strings** → coerce with `Number()`.
- **Customer types are `regular` / `wholesaler`** (not retail/wholesale/suki — those are
  historical). Only wholesalers get custom prices.
- **Never modify an applied migration** — add a new `NNN_name.sql`.
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
| Understand the stack / auth / layout | [architecture/ARCHITECTURE.md](architecture/ARCHITECTURE.md) |
| Know the current schema | [architecture/DATABASE.md](architecture/DATABASE.md) |
| Call/extend an endpoint | [architecture/API.md](architecture/API.md) |
| Touch order status/stock/deposit logic | [architecture/order-lifecycle.md](architecture/order-lifecycle.md) |
| Run it locally | [operations/local-development.md](operations/local-development.md) |
| Build the APK / deploy | [operations/android.md](operations/android.md) |
| Follow working rules & conventions | [CLAUDE.md](../CLAUDE.md) |
