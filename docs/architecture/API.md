# API Reference

REST API under **`/api/v1`**. JSON in, JSON out. Source: `server/src/routes/`.

- **Auth:** every endpoint requires a valid session (cookie or `Bearer` token — see
  [Architecture](ARCHITECTURE.md#authentication-flow)) **except `POST /auth/login` and `POST /auth/logout`**.
- **Errors:** `{ "error": "message" }` with an appropriate status (`400` validation,
  `401` unauth, `404` not found). Superseded sessions return `401` with `code: 'session_superseded'`. Central handler: `server/src/middleware/errorHandler.js`.
- Money is `NUMERIC` and serialized by `pg` as **strings** — coerce with `Number()` on the client.

---

## Auth — `auth.js`

Authentication enforces one session per user account ([ADR 0017](../adr/0017-receipt-numbers-keyed-to-user-accounts.md) #8, migration 044).

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/auth/login` | — | Body: `{ email, password, device_key? }`. Web: sets HTTP-only cookie. Native: returns `{ token, user, session_replaced }` to store as Bearer. Mints a fresh `session_id` (UUID), stores it in `users.session_id`, and signs it into the JWT as claim `sid`. Signing in here ends this account's session on any other device |
| POST | `/auth/logout` | — | Clears the auth cookie. If the caller presents the active session's token, clears `session_id` and `session_device` on the user row. Native client drops its stored token |
| GET | `/auth/me` | ✔ | Current user — whoever the JWT was issued to. Returns `{ id, email, full_name, role }` |

> **Single-Session Enforcement:** [`requireAuth`](../../server/src/middleware/auth.js) verifies that the JWT's `sid` claim matches `users.session_id`. If another sign-in has superseded the session, it returns `401` with `{ error: "This account was signed in on another device. Sign in again to keep using it here.", code: "session_superseded" }`. Offline tablets continue selling locally and only encounter this check on reconnect; outbox records waiting to sync survive session changes (ADR 0015 §3, ADR 0017 #8).

---

## Products — `products.js`

| Method | Path | Notes |
|---|---|---|
| GET | `/products` | List. Query: `include_inactive`, `updated_since` (watermark sync filter for keyset deltas, 035) |
| POST | `/products` | Create product. |
| GET | `/products/:id` | One product. |
| PATCH | `/products/:id` | Update; field-level diffs logged to `activity_logs`. Enforces deposit rules vs `requires_bottle_return`. |
| DELETE | `/products/:id` | Soft-delete (`is_active=false`). |

---

## Customers — `customers.js`

| Method | Path | Notes |
|---|---|---|
| GET | `/customers` | List. Query: `include_inactive`, `search`, `updated_since` (watermark sync filter, 035) |
| POST | `/customers` | Create. `customer_type` ∈ `('regular','wholesaler','discounted','markup')` default `'regular'` (034). Descriptive label only; pricing is derived from saved prices (ADR 0009) |
| GET | `/customers/:id` | One customer (with order history). |
| PATCH | `/customers/:id` | Update. Logs diffs to `activity_logs`. |
| DELETE | `/customers/:id` | Deactivate (`is_active=false`) if customer has orders; hard-delete (cascades custom prices) if 0 orders |
| POST | `/customers/:id/merge` | Merge source into target customer. Body: `{ target_customer_id }`. Reassigns orders and logs activity |
| GET | `/customers/:id/prices` | Active custom prices. Query: `order_type` (`delivery`/`pickup`, default `delivery`). Returns `DISTINCT ON (cpp.product_id)` most recent price per product |
| POST | `/customers/:id/prices` | Append a custom price row (append-only history). Body: `{ product_id, custom_unit_price, order_type, notes }` |

---

## Personnel — `personnel.js`

| Method | Path | Notes |
|---|---|---|
| GET | `/personnel` | List. Query: `include_inactive`, `updated_since` (watermark sync filter, 035) |
| POST | `/personnel` | Create. Optional `id_image_base64` + `id_image_mime_type`. |
| GET | `/personnel/:id` | One (with order history). |
| PATCH | `/personnel/:id` | Update. |
| DELETE | `/personnel/:id` | Soft-delete (`is_active=false`). |

---

## Orders — `orders.js`

See [Order Lifecycle](order-lifecycle.md) for status rules and stock/deposit behaviour.

| Method | Path | Notes |
|---|---|---|
| GET | `/orders` | List. Query: `status`, `customer_id`, `from_date`, `to_date`, `search` / `q`, `page`, `limit`. Drafts excluded unless `status=draft`. Supports bare-digit sequence search `42` matching `receipt_sequence` across all prefixes or legacy `id` (ADR 0017 #11). Returns `sold_by_name` (042) |
| GET | `/orders/sync` | Keyset-pagination sync endpoint for offline tablets (ADR 0015 §4, Slice 3.2). Query: `cursor` (`<updated_at>|<id>`), `direction` (`back` [newest→oldest] or `forward` [oldest→newest]), `limit` (1..200, default 100). Returns `{ records: [...], first_cursor, next_cursor, has_more }` with complete snapshots (line items, personnel, returned bottles, `sold_by_name`). Drafts included |
| POST | `/orders` | Create. Body: `customer_id`, `items[]`, `personnel[]`, `order_type`, optional `status:'draft'`. Optional `receipt_number` (`'1A-00042'`, device-issued), `request_key` (migration 039 retry key), `created_at` (device sale time). Idempotent on `request_key` and `receipt_number`: a duplicate returns the stored order with `200` ([ADR 0006](../adr/0006-receipt-number-as-idempotency-key.md), ADR 0017 #9) |
| GET | `/orders/:id` | One order with items + personnel + `sold_by_name`. Resolves by row id or receipt number (`resolveOrderId`) |
| PATCH | `/orders/:id` | Edit items/notes/personnel (drafts may also change customer/order_type). Reconciles stock + recomputes total |
| POST | `/orders/:id/finalize` | Draft → `pending` (writes the "created" activity log). |
| DELETE | `/orders/:id` | Discard draft (only allowed for drafts). |
| PATCH | `/orders/:id/adjustment` | Set `adjustment` + `adjustment_reason`. |
| POST | `/orders/:id/receipt-printed` | Record a confirmed receipt print (pending vs delivered phase). |
| POST | `/orders/:id/status` | Transition status; validated by `getAllowedTransitions`. Deducts/restores stock at dispatch boundary (`in_transit` delivery / `completed` pickup) |
| POST | `/orders/:id/close` | Record `bottles_returned` per item and move to `done`; folds deposit into total |

---

## Stations — `stations.js`

Device registration and receipt identity allocation under [ADR 0017](../adr/0017-receipt-numbers-keyed-to-user-accounts.md) (migrations 033, 040, 043).

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/stations/register` | ✔ | Body: `{ device_key, label? }`. Idempotently registers or updates `stations` row. Ensures user has a permanent `receipt_person` (`users.receipt_person`, 1–999) and allocates/re-reads the per-person device letter (`user_devices.device_letter`, `A`..`Z`, `AA`..`ZZ`). Returns `{ device_key, label, registered_at, created, user_id, person, seller_name, device_letter, receipt_prefix, device_letter_allocated_at, next_pair_sequence, next_pair_delivery_sequence }` |

> **Removed Endpoints:** `GET /stations` and slot assignment endpoints (`POST /stations/slots/:slot/assign`) were deleted under ADR 0017 slice 6 when the slot concept and Devices screen were retired.

---

## Incoming (supplier deliveries) — `incoming.js`

| Method | Path | Notes |
|---|---|---|
| GET | `/incoming` | List deliveries. Query: `supplier_name`, `from_date`, `to_date`. Voided hidden |
| POST | `/incoming` | Log a delivery + items → auto-restock (writes `inventory_audit_logs`). Body: `supplier_name`, `notes`, `received_at`, `items[]`, optional `delivery_ref` (`'1A-DEL-00007'`, device-issued), optional `request_key` (039 retry key). Idempotent on `request_key` and `delivery_ref` |
| GET | `/incoming/:id` | One delivery with items. |
| PATCH | `/incoming/:id` | Edit; stock reconciles and logs `delivery_edit` to `inventory_audit_logs` (038) |
| DELETE | `/incoming/:id` | **Void** (soft) — reverses the restock, keeps the row, logs `delivery_edit` to audit log (029, 038) |

---

## Tickets — `tickets.js`

| Method | Path | Notes |
|---|---|---|
| GET | `/tickets` | List. Query: `status`. |
| POST | `/tickets` | Create. |
| GET | `/tickets/:id` | One. |
| PATCH | `/tickets/:id` | Update / resolve (`status`, `resolution_notes`). |

---

## Audit — `audit.js`

| Method | Path | Notes |
|---|---|---|
| GET | `/audit` | Inventory stock changes (`inventory_audit_logs`). Query: `product_id`, `action_type`, `from_date`, `to_date`, `limit` (default 200) |
| GET | `/audit/activity` | Cross-entity activity (`activity_logs`). Query: `entity_type`, `from_date`, `to_date`, `limit` (default 200) |

---

## Dashboard — `dashboard.js`

| Method | Path | Notes |
|---|---|---|
| GET | `/dashboard` | Aggregated summary for the home page. Orders include `sold_by_name` |

---

## Health

`GET /health` → `{ "status": "ok" }` (unauthenticated; used by Render and Northflank health checks).
