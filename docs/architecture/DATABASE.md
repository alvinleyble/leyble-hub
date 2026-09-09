# Database Reference

PostgreSQL 15+. This is the **current** shape of the schema after all migrations `001–047` have
been applied — reconstructed from `server/db/migrations/` (not from the archived spec, which is
stale). When in doubt, the migration files are the source of truth.

## Conventions

- **Money** → `NUMERIC(10,2)`. **Timestamps** → `TIMESTAMPTZ` (UTC).
- **Quantities / stock** → `NUMERIC(10,2)` to support half-case (`0.5`) values.
- Migrations are numbered `NNN_name.sql` and tracked in the `_migrations` table by
  `server/db/migrate.js`. **Never edit an applied migration — always add a new one.**
- **Append-only tables** (never `UPDATE`/`DELETE`): `customer_product_prices`,
  `inventory_audit_logs`, `activity_logs`.
- Stock is mutated in exactly one place: `applyStockDelta` / `applyDeltaMap` in
  [`server/src/lib/inventory.js`](../../server/src/lib/inventory.js), always inside a transaction,
  and every change writes an `inventory_audit_logs` row.
- **Row Level Security (RLS)** is enabled across all 17 tables (migration 045 and 047, [ADR 0018](../adr/0018-supabase-rls-lockdown.md)). The Express backend connects as user `postgres` (`BYPASSRLS = true`), so all application queries and migrations bypass RLS, while direct external PostgREST / GraphQL queries fail closed.

---

## Tables

### 1. `users` (001, altered by 030, 041, 043, 044)
App accounts. `role` ∈ `('admin','viewer')` default `admin` — signed into the JWT and read by
no route guard and no client gate, so it authorizes nothing ([ADR 0017](../adr/0017-receipt-numbers-keyed-to-user-accounts.md)).
`email` unique, `password_hash` (bcrypt), `is_active`. Seeded by `server/db/seed.js` using
`SEED_ADMIN_*` env vars.

| Column | Type | Notes |
|---|---|---|
| `id` | SERIAL PK | |
| `email` | VARCHAR UNIQUE | Case-insensitive in auth queries |
| `password_hash` | VARCHAR | bcrypt |
| `full_name` | VARCHAR | Display name; printed on receipts as `Sold by: <name>` (ADR 0017 #10) |
| `role` | VARCHAR | default `'admin'` |
| `is_active` | BOOLEAN | Soft-deactivation flag; accounts are deactivated, never deleted (ADR 0017 #1) |
| `receipt_person` | INT | (043) The permanent person number (1–999) leading receipt numbers (`1A-00042`). Partial `UNIQUE` index `users_receipt_person_uniq` |
| `session_id` | UUID | (044) The active session ID. Signed as `sid` into the JWT; enforced by `requireAuth` for single-session per account (ADR 0017 #8) |
| `session_device` | VARCHAR(64) | (044) Device key of the tablet/browser currently holding the active session |
| `session_started_at` | TIMESTAMPTZ | (044) Timestamp when the active session logged in |

One row per person, and each signs in with their own email ([ADR 0017](../adr/0017-receipt-numbers-keyed-to-user-accounts.md) §5/§6):
Alvin/admin, Josie and Luis. An account is deactivated (`is_active = FALSE`), never deleted, so
its historical `activity_logs.performed_by` references always still resolve. The one-off
`server/db/setup-accounts.js` script activates the three and deactivates everything else.
`profile_key VARCHAR(20) UNIQUE`, added by 030 to back the Josie/Luis/Admin picker, was
**dropped by 041** along with the `X-Active-Profile` identity swap. See
[ARCHITECTURE.md#authentication-flow](ARCHITECTURE.md#authentication-flow).

### 2. `products` (002, altered by 012, 022, 023, 035)
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
| `updated_at` | TIMESTAMPTZ | Watermark index `idx_products_updated_at` (035) for keyset delta sync |

### 3. `customers` (003, altered by 015, 025, 031, 032, 034, 035)
`customer_type` ∈ **`('regular','wholesaler','discounted','markup')`** default `'regular'`.
History: started as `retail/wholesale/suki` → `wholesale/suki` (015) → `regular/wholesaler` (025) → +`discounted`/`unassigned` (031) → +`markup` (032) → `unassigned` collapsed into `regular` (034).
In V3.0 ([ADR 0009](../adr/0009-custom-pricing-derived-from-saved-prices.md)), `customer_type` is a purely descriptive tag carrying zero pricing logic; custom pricing is derived dynamically from `customer_product_prices`.
Fields: `name`, `address`, `phone`, `notes`, `is_active`, `updated_at` (watermark index `idx_customers_updated_at`, 035).

### 4. `customer_product_prices` (004, altered by 020, 026) — **append-only**
Custom price history. Every save inserts a new row. The **most recent row** per
`(customer_id, product_id, order_type)` is the active price (queried via `SELECT DISTINCT ON (cpp.product_id) ... ORDER BY cpp.product_id, cpp.created_at DESC`).
| Column | Notes |
|---|---|
| `customer_id`, `product_id` | FK, ON DELETE CASCADE |
| `custom_unit_price` | NUMERIC |
| `order_type` | `('delivery','pickup')` default `'delivery'` (020) — separate price per channel |
| `set_by_user_id`, `notes`, `created_at` | no `updated_at` (append-only) |

> `custom_deposit_fee` was **dropped** (026) — deposits are product-level now.

### 5. `personnel` (005, altered by 017, 035)
Field workers (drivers/helpers). `full_name`, `remarks` (TEXT — renamed from `role_label`, 017),
`phone`, `license_number`, `id_image_base64` + `id_image_mime_type` (ID photo stored inline as
Base64), `is_active`, `updated_at` (watermark index `idx_personnel_updated_at`, 035).

### 6. `orders` (006, altered by 016, 018, 019, 027, 028, 033, 035, 039, 040, 042)
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
| `receipt_station`, `receipt_device`, `receipt_sequence` | the device-issued receipt number, decomposed (033; the letter added by 040). `receipt_station` is the **person** and `receipt_device` their device letter ([ADR 0017](../adr/0017-receipt-numbers-keyed-to-user-accounts.md)). All three are nullable — orders predating V2.5 have none, orders from the pre-letter scheme have no letter, and neither is ever backfilled. `CHECK`s keep the station/sequence pair whole and the letter shaped `[A-Z]{1,2}` and never orphaned. Since 039 this is no longer the retry key — see `request_key` |
| `orders_receipt_number_uniq` | a **partial** `UNIQUE` over rows that carry a receipt number, keeping the number itself unique ([ADR 0010](../adr/0010-receipt-number-addresses-order-across-sync-boundary.md)). Since 040 the letter goes through `COALESCE(receipt_device, '')` **inside the index expression** — without that, NULL-is-distinct would silently stop the index protecting every pre-letter row. Match it the same way in any query that looks a receipt number up |
| `request_key` | the anti-duplicate key for a **resent outbox record** (039, [ADR 0017](../adr/0017-receipt-numbers-keyed-to-user-accounts.md) #9 revising [ADR 0006](../adr/0006-receipt-number-as-idempotency-key.md)). Minted on the device once per outbox record and resent unchanged on every retry of it; partial unique index `orders_request_key_uniq` over rows that carry one. Nullable: absent for anything a connected client posted, and for a record queued by a pre-039 build |
| `receipt_number` | `GENERATED ALWAYS AS ... STORED` (040) — `'1A-00042'`, or `'1-00042'` with no letter. Derived from the three columns above; never written to. **Never `ORDER BY` it** — `#1240`, `3-00061` and `3A-00001` coexist permanently and do not sort as text ([ADR 0017](../adr/0017-receipt-numbers-keyed-to-user-accounts.md) #12) |
| `created_by` | INT REFERENCES `users(id)` (042) — who made the sale ([ADR 0017](../adr/0017-receipt-numbers-keyed-to-user-accounts.md) #10). Joined as `sold_by_name` on-screen and printed on the receipt as `Sold by: <name>`. Nullable, no backfill |
| `created_at` | the **sale time**. Supplied by the device on a local-first save (same pattern as `supplier_deliveries.received_at`); defaults to `NOW()` otherwise |
| `updated_at` | Watermark index `idx_orders_updated_at_id` on `(updated_at, id)` (035) for keyset delta sync |
| `idx_orders_receipt_sequence` | Partial index on `(receipt_sequence) WHERE receipt_sequence IS NOT NULL` (042) for bare-digit order sequence lookups (ADR 0017 #11) |

> `driver_id` / `helper_id` FK columns were **dropped** (016) — personnel are now in the
> `order_personnel` join table.

### 7. `order_personnel` (016) — join table
`order_id` (CASCADE), `personnel_id`, `role` default `'Driver'`. `UNIQUE(order_id, personnel_id)`.
**At most one row with `role='Driver'` per order** (enforced in app code, not the DB).

### 8. `order_items` (007, altered by 013, 023)
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

### 9. `stations` (033, altered by 037)
One row per device that has registered ([ADR 0003](../adr/0003-device-issued-receipt-numbers.md)).
Since [ADR 0017](../adr/0017-receipt-numbers-keyed-to-user-accounts.md) this is a plain device
registry and nothing here is any part of a receipt number — the person is `users.receipt_person`
and the letter is `user_devices.device_letter` (043).
| Column | Notes |
|---|---|
| `device_key` | UNIQUE. Generated on the device; the idempotency key for registration, so a retried register call returns the same station instead of claiming a second one |
| `slot_number`, `slot_assigned_at`, `slot_assigned_by` | (037) **dead columns.** ADR 0016's three fixed slots — which device held each of 1/2/3, when it moved there and who moved it. ADR 0017 removed the slot concept along with the Devices screen and the assignment endpoint; nothing reads or writes these any longer. Kept rather than dropped so historical rows and any device still mid-switchover stay describable |
| `station_number` | UNIQUE, defaulted from `station_number_seq`. The registry's internal id for a device — it is **not** a receipt number component and never leaves the server |
| `label` | optional, e.g. `'Honor Pad X8B'` |
| `registered_at`, `last_seen_at` | |

### 10. `user_devices` (043)
Mapping of user accounts to allocated device letters for receipt numbering (`1A`, `2B`, etc.) under [ADR 0017](../adr/0017-receipt-numbers-keyed-to-user-accounts.md) #2/#3.
Allocated on the first successful online sign-in of that person on that device. Deliberately not globally unique: the same tablet can be `1A` for Alvin and `2B` for Josie.
| Column | Notes |
|---|---|
| `id` | SERIAL PK |
| `user_id` | INT NOT NULL REFERENCES `users(id)` |
| `device_key` | VARCHAR(64) NOT NULL. Minted by `client/src/offline/station.js`. Not an FK to `stations` |
| `device_letter` | VARCHAR(2) NOT NULL. CHECK `device_letter ~ '^[A-Z]{1,2}$'`. Allocated forward (`A`..`Z`, `AA`..`ZZ`), never gap-filled |
| `label` | VARCHAR(100) optional |
| `first_seen_at` | TIMESTAMPTZ NOT NULL DEFAULT NOW() |
| `last_seen_at` | TIMESTAMPTZ |
| Indexes | `UNIQUE (user_id, device_key)` (pair uniqueness), `UNIQUE (user_id, device_letter)` (letter uniqueness per person), `INDEX (device_key)` |

> Rows are **never deleted**. When a tablet is retired, its letter stays held so the person's next device is guaranteed a fresh letter that has never been used (ADR 0017 #3).

### 11. `supplier_deliveries` (008, altered by 029, 036, 039, 040)
Incoming stock events. `supplier_name`, `notes`, `received_at`, `created_by`. Soft-void columns
`voided_at` / `voided_by` (029) — deliveries are **never hard-deleted** (their
`inventory_audit_logs` rows are append-only); voiding reverses the restock and hides the row.
Carries the same device-identity columns as `orders`, with the same meanings and the same
partial unique indexes: the `receipt_station` / `receipt_device` / `receipt_sequence` triple
with its `COALESCE`-ed unique index `supplier_deliveries_receipt_number_uniq`, the `GENERATED delivery_ref`
(`'1A-DEL-00007'`, 036 with the letter added by 040), and `request_key` (039 with unique index `supplier_deliveries_request_key_uniq`). Deliberately identical column names — that
is what lets `server/src/lib/idempotency.js` cover both tables from one allowlist. `DEL` in
the middle keeps a delivery reference from ever being read as a customer's receipt number
([ADR 0015](../adr/0015-full-app-offline-accessibility-and-mutation-boundaries.md) §8,
[ADR 0017](../adr/0017-receipt-numbers-keyed-to-user-accounts.md) #14).

### 12. `supplier_delivery_items` (009, altered by 022)
`delivery_id` (CASCADE), `product_id`, `quantity_received` NUMERIC(10,2) (022), `unit_cost`,
`notes`.

### 13. `tickets` (010)
`title`, `description`, `related_order_id`, `related_personnel_id`, `amount`,
`status` ∈ `('pending','resolved')`, `created_by`, `resolved_by`, `resolved_at`,
`resolution_notes`.

### 14. `inventory_audit_logs` (011, altered by 014, 038) — **append-only**
Every stock change. `product_id`, `action_type` ∈
`('manual_adjustment','restock','price_change','order_fulfillment','order_edit','order_cancel','delivery_edit')` (038 added `delivery_edit` so delivery reversals are not conflated with manual recounts),
`field_changed`, `previous_value`, `new_value`, `delta` NUMERIC(10,2) (014), `reason`,
`performed_by`, `related_order_id`, `related_delivery_id`. Indexes: `idx_inventory_audit_product`, `idx_inventory_audit_created`. Exposed via `GET /api/v1/audit`.

### 15. `activity_logs` (024, altered by 037) — **append-only**
Generic cross-entity change log. `entity_type` ∈
`('order','customer','product','personnel','ticket','station')` (037 widened to include `station`), `entity_id`, `action`, `summary`,
`performed_by`, `created_at`. Written via
[`server/src/lib/activityLog.js`](../../server/src/lib/activityLog.js) (`logActivity`,
`diffFields`). Indexes: `idx_activity_logs_entity`, `idx_activity_logs_created`. Exposed via `GET /api/v1/audit/activity`.

### 16. `_migrations` — system table
Tracks schema migrations applied by `server/db/migrate.js`.
| Column | Type | Notes |
|---|---|---|
| `id` | SERIAL PK | |
| `name` | VARCHAR(255) UNIQUE | Migration filename, e.g. `'045_enable_rls.sql'` |
| `applied_at` | TIMESTAMPTZ | Timestamp of successful application |

### 17. `app_settings` (047)
System configuration key-value store. Primary use: minimum Android app version enforcement.
| Column | Type | Notes |
|---|---|---|
| `key` | TEXT PRIMARY KEY | Setting identifier, e.g. `'min_version'` |
| `value` | TEXT | Setting value (nullable). Null/empty leaves enforcement dormant |
| `updated_at` | TIMESTAMPTZ | Timestamp of last modification |

Seeded dormant with `('min_version', NULL)`. The captain can raise or adjust the required version directly in the Supabase SQL Editor (`UPDATE app_settings SET value = '1.3.0' WHERE key = 'min_version';` or `UPDATE app_settings SET value = '14' WHERE key = 'min_version';`) without publishing another build. RLS is enabled with zero public policies.

---

## Row Level Security (RLS) Posture

Per migrations `045_enable_rls.sql` and `047_app_settings_min_version.sql` and [ADR 0018](../adr/0018-supabase-rls-lockdown.md), Row Level Security (RLS) is enabled across all 17 tables in the schema with **zero public policies**.

- **Express backend:** Connects via `DATABASE_URL` as user `postgres`. In PostgreSQL and Supabase, `postgres` has `BYPASSRLS = true`. All backend application queries, sync jobs, and migrations bypass RLS unconditionally and execute with native performance.
- **External / direct PostgREST / GraphQL:** Supabase's HTTP endpoints operate as non-superusers (`anon`, `authenticated`). With RLS enabled and no policies granted, any direct external attempt to read, enumerate, or mutate data fails closed (returns empty sets or 401/403).

---

## Idempotency & Request Retry Keys (039)

Until migration 039, the receipt number served as the anti-duplicate key for resent outbox records. Under [ADR 0017](../adr/0017-receipt-numbers-keyed-to-user-accounts.md) #9, the retry key was decoupled from the business receipt number:
- `request_key VARCHAR(64)` is generated on the client device once per outbox record and resent unchanged on every retry of that record. It labels the **attempt to send** a record.
- `receipt_number` / `delivery_ref` labels the **sale or delivery itself**.
- Both `orders` and `supplier_deliveries` carry `request_key` with partial unique indexes (`orders_request_key_uniq`, `supplier_deliveries_request_key_uniq`).
- `server/src/lib/idempotency.js` checks `request_key` first; a repeat of a known request key returns the stored record with `200` without creating a duplicate.

---

## Two audit trails — don't confuse them

| | `inventory_audit_logs` | `activity_logs` |
|---|---|---|
| Scope | product stock deltas only | orders, customers, products, personnel, tickets, stations |
| Written by | `lib/inventory.js` | `lib/activityLog.js` |
| API | `GET /api/v1/audit` | `GET /api/v1/audit/activity` |

See also: [Order Lifecycle](order-lifecycle.md) · [Architecture](ARCHITECTURE.md) · [API](API.md) · [ADR 0018](../adr/0018-supabase-rls-lockdown.md).
