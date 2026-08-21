# Database Reference

PostgreSQL 15+. This is the **current** shape of the schema after all migrations `001–030` have
been applied — reconstructed from `server/db/migrations/` (not from the archived spec, which is
stale). When in doubt, the migration files are the source of truth.

## Conventions

- **Money** → `NUMERIC(10,2)`. **Timestamps** → `TIMESTAMPTZ` (UTC).
- **Quantities / stock** → `NUMERIC(10,2)` to support half-case (`0.5`) values.
- Migrations are numbered `NNN_name.sql` and tracked in a `_migrations` table by
  `server/db/migrate.js`. **Never edit an applied migration — always add a new one.**
- **Append-only tables** (never `UPDATE`/`DELETE`): `customer_product_prices`,
  `inventory_audit_logs`, `activity_logs`.
- Stock is mutated in exactly one place: `applyStockDelta` in
  [`server/src/lib/inventory.js`](../../server/src/lib/inventory.js), always inside a transaction,
  and every change writes an `inventory_audit_logs` row.

---

## Tables

### `users` (001, altered by 030)
App accounts. `role` ∈ `('admin','viewer')` default `admin`. `email` unique, `password_hash`
(bcrypt), `is_active`. Seeded by `server/db/seed.js` using `SEED_ADMIN_*` env vars.
`profile_key VARCHAR(20) UNIQUE` (030) tags the rows that back the Josie/Luis/Admin profile
picker — login is now a single shared active account (`josie@leyblestore.com`); the other
profile rows are `is_active = FALSE` and exist only so `requireAuth` can swap request identity
to them via the `X-Active-Profile` header. Assigned by the one-off `server/db/setup-profiles.js`
script (not run automatically by `migrate.js`/`seed.js`). See
[ARCHITECTURE.md#authentication-flow](ARCHITECTURE.md#authentication-flow).

### `products` (002, altered by 012, 022, 023)
| Column | Type | Notes |
|---|---|---|
| `id` | SERIAL PK | |
| `name`, `category`, `unit` | text | `unit` NOT NULL |
| `sku` | VARCHAR UNIQUE | nullable |
| `base_wholesale_price` | NUMERIC(10,2) | wholesale-only model; `base_retail_price` was **dropped** (012) |
| `deposit_fee` | NUMERIC(10,2) | per-bottle deposit amount |
| `units_per_case` | INT default 1 | added 012 |
| `requires_bottle_return` | BOOLEAN default false | added 023; gates whether a deposit applies |
| `current_stock` | NUMERIC(10,2) | was INT, now decimal (022) |
| `is_active` | BOOLEAN | soft-delete flag |

### `customers` (003, altered by 015, 025, 031)
`customer_type` ∈ **`('regular','wholesaler','discounted','unassigned')`** default `'regular'`. (History: started as
`retail/wholesale/suki` → `wholesale/suki` (015) → `regular/wholesaler` (025) → +`discounted`/`unassigned` (031).) Wholesaler,
discounted, and unassigned customers get custom per-product pricing. Fields: `name`, `address`, `phone`, `notes`,
`is_active`.

### `customer_product_prices` (004, altered by 020, 026) — **append-only**
Custom price history for wholesaler customers. The **most recent row** per
`(customer_id, product_id, order_type)` is the active price.
| Column | Notes |
|---|---|
| `customer_id`, `product_id` | FK, ON DELETE CASCADE |
| `custom_unit_price` | NUMERIC |
| `order_type` | `('delivery','pickup')` default `'delivery'` (020) — separate price per channel |
| `set_by_user_id`, `notes`, `created_at` | no `updated_at` (append-only) |

> `custom_deposit_fee` was **dropped** (026) — deposits are product-level now.

### `personnel` (005, altered by 017)
Field workers (drivers/helpers). `full_name`, `remarks` (TEXT — renamed from `role_label`, 017),
`phone`, `license_number`, `id_image_base64` + `id_image_mime_type` (ID photo stored inline as
Base64), `is_active`.

### `orders` (006, altered by 016, 018, 019, 027, 028)
| Column | Notes |
|---|---|
| `customer_id` | FK |
| `status` | ∈ `('draft','pending','in_transit','completed','cancelled','done')` (028 added `draft`) |
| `order_type` | `('delivery','pickup')` default `'delivery'` (018) |
| `total_amount` | NUMERIC — **goods-only while open**; deposit folded in only when `done` (see [order-lifecycle](order-lifecycle.md)) |
| `adjustment`, `adjustment_reason` | manual ± price adjustment (019) |
| `notes` | text |
| `dispatched_at`, `delivered_at`, `closed_at` | status timestamps |
| `pending_receipt_printed_at/by`, `delivered_receipt_printed_at/by` | receipt print tracking (027) |

> `driver_id` / `helper_id` FK columns were **dropped** (016) — personnel are now in the
> `order_personnel` join table.

### `order_personnel` (016) — join table
`order_id` (CASCADE), `personnel_id`, `role` default `'Driver'`. `UNIQUE(order_id, personnel_id)`.
**At most one row with `role='Driver'` per order** (enforced in app code, not the DB).

### `order_items` (007, altered by 013, 023)
| Column | Notes |
|---|---|
| `order_id` | FK CASCADE |
| `product_id` | FK |
| `quantity` | NUMERIC(10,2) (013) — supports 0.5 cases |
| `unit_price` | NUMERIC, mutable |
| `unit_deposit_fee` | NUMERIC default 0, per-bottle deposit on this line |
| `is_price_overridden` | BOOLEAN |
| `units_per_case` | INT default 1 (023) — cached from product at order time |
| `bottles_returned` | INT default 0 (023) — recorded at close |
| `line_total` | **GENERATED STORED** — never write directly | 

**`line_total` formula (since 023):**
```
quantity*unit_price + (quantity*units_per_case − bottles_returned)*unit_deposit_fee
```
i.e. deposit is charged on the bottles that were *not* returned. With defaults
(`units_per_case=1, bottles_returned=0`) this reduces to the old `quantity*(price+deposit)`.

### `supplier_deliveries` (008, altered by 029)
Incoming stock events. `supplier_name`, `notes`, `received_at`, `created_by`. Soft-void columns
`voided_at` / `voided_by` (029) — deliveries are **never hard-deleted** (their
`inventory_audit_logs` rows are append-only); voiding reverses the restock and hides the row.

### `supplier_delivery_items` (009, altered by 022)
`delivery_id` (CASCADE), `product_id`, `quantity_received` NUMERIC(10,2) (022), `unit_cost`,
`notes`.

### `tickets` (010)
`title`, `description`, `related_order_id`, `related_personnel_id`, `amount`,
`status` ∈ `('pending','resolved')`, `created_by`, `resolved_by`, `resolved_at`,
`resolution_notes`.

### `inventory_audit_logs` (011, altered by 014) — **append-only**
Every stock change. `product_id`, `action_type` ∈
`('manual_adjustment','restock','price_change','order_fulfillment','order_edit','order_cancel')`,
`field_changed`, `previous_value`, `new_value`, `delta` NUMERIC(10,2) (014), `reason`,
`performed_by`, `related_order_id`, `related_delivery_id`. Exposed via `GET /api/v1/audit`.

### `activity_logs` (024) — **append-only**
Generic cross-entity change log. `entity_type` ∈
`('order','customer','product','personnel','ticket')`, `entity_id`, `action`, `summary`,
`performed_by`, `created_at`. Written via
[`server/src/lib/activityLog.js`](../../server/src/lib/activityLog.js) (`logActivity`,
`diffFields`). Exposed via `GET /api/v1/audit/activity`.

---

## Two audit trails — don't confuse them

| | `inventory_audit_logs` | `activity_logs` |
|---|---|---|
| Scope | product stock deltas only | orders, customers, products, personnel, tickets |
| Written by | `lib/inventory.js` | `lib/activityLog.js` |
| API | `GET /api/v1/audit` | `GET /api/v1/audit/activity` |

See also: [Order Lifecycle](order-lifecycle.md) · [Architecture](ARCHITECTURE.md) · [API](API.md).
