# API Reference

REST API under **`/api/v1`**. JSON in, JSON out. Source: `server/src/routes/`.

- **Auth:** every endpoint requires a valid session (cookie or `Bearer` token — see
  [Architecture](ARCHITECTURE.md#authentication-flow)) **except `POST /auth/login`**.
- **Errors:** `{ "error": "message" }` with an appropriate status (`400` validation,
  `401` unauth, `404` not found). Central handler: `server/src/middleware/errorHandler.js`.
- Money is `NUMERIC` and serialized by `pg` as **strings** — coerce with `Number()` on the client.

---

## Auth — `auth.js`
| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/auth/login` | — | Body `{ email, password }`. Web: sets HTTP-only cookie. Native: returns `{ token, user }` to store as Bearer. |
| POST | `/auth/logout` | — | Clears the cookie; native client drops its stored token. |
| GET | `/auth/me` | ✔ | Current user (reflects the active profile if `X-Active-Profile` is set). |
| GET | `/auth/profiles` | ✔ | `[{ profile_key, full_name }]` — options for the Josie/Luis/Admin picker. |

## Products — `products.js`
| Method | Path | Notes |
|---|---|---|
| GET | `/products` | List. Query: `include_inactive`. |
| POST | `/products` | Create. |
| GET | `/products/:id` | One product. |
| PATCH | `/products/:id` | Update; field-level diffs logged via `diffFields`. Enforces deposit rules vs `requires_bottle_return`. |
| DELETE | `/products/:id` | Soft-delete (`is_active=false`). |

## Customers — `customers.js`
| Method | Path | Notes |
|---|---|---|
| GET | `/customers` | List. Query: `include_inactive`, `search`. |
| POST | `/customers` | Create. `customer_type` ∈ `regular`/`wholesaler` (default `regular`). |
| GET | `/customers/:id` | One customer (with order history). |
| PATCH | `/customers/:id` | Update. |
| DELETE | `/customers/:id` | Soft-delete. |
| GET | `/customers/:id/prices` | Custom prices. Query: `order_type` (`delivery`/`pickup`, default `delivery`). |
| POST | `/customers/:id/prices` | Append a custom price row (append-only history). Body includes `product_id`, `custom_unit_price`, `order_type`. |

## Personnel — `personnel.js`
| Method | Path | Notes |
|---|---|---|
| GET | `/personnel` | List. Query: `include_inactive`. |
| POST | `/personnel` | Create. Optional `id_image_base64` + `id_image_mime_type`. |
| GET | `/personnel/:id` | One (with order history). |
| PATCH | `/personnel/:id` | Update. |
| DELETE | `/personnel/:id` | Soft-delete. |

## Orders — `orders.js`
See [Order Lifecycle](order-lifecycle.md) for status rules and stock/deposit behaviour.
| Method | Path | Notes |
|---|---|---|
| GET | `/orders` | List. Query: `status`, `customer_id`, `from_date`, `to_date`. Drafts excluded unless `status=draft`. |
| POST | `/orders` | Create. Body: `customer_id`, `items[]`, `personnel[]`, `order_type`, optional `status:'draft'`. |
| GET | `/orders/:id` | One order with items + personnel. |
| PATCH | `/orders/:id` | Edit items/notes/personnel (drafts may also change customer/order_type). Reconciles stock + recomputes total. |
| POST | `/orders/:id/finalize` | Draft → `pending` (writes the "created" activity log). |
| DELETE | `/orders/:id` | Only allowed for drafts. |
| PATCH | `/orders/:id/adjustment` | Set `adjustment` + `adjustment_reason`. |
| POST | `/orders/:id/receipt-printed` | Record a confirmed receipt print (pending vs delivered phase). |
| POST | `/orders/:id/status` | Transition status; validated by `getAllowedTransitions`. Deducts/restores stock at the right edges. |
| POST | `/orders/:id/close` | Record `bottles_returned` per item and move to `done`; folds deposit into total. |

## Incoming (supplier deliveries) — `incoming.js`
| Method | Path | Notes |
|---|---|---|
| GET | `/incoming` | List deliveries. Query: `supplier_name`, `from_date`, `to_date`. Voided hidden. |
| POST | `/incoming` | Log a delivery + items → auto-restock (writes `inventory_audit_logs`). Supports 0.5-case quantities; can create new products. |
| GET | `/incoming/:id` | One delivery. |
| PATCH | `/incoming/:id` | Edit; stock reconciles. |
| DELETE | `/incoming/:id` | **Void** (soft) — reverses the restock, keeps the row (audit logs are append-only). |

## Tickets — `tickets.js`
| Method | Path | Notes |
|---|---|---|
| GET | `/tickets` | List. Query: `status`. |
| POST | `/tickets` | Create. |
| GET | `/tickets/:id` | One. |
| PATCH | `/tickets/:id` | Update / resolve (`status`, `resolution_notes`). |

## Audit — `audit.js`
| Method | Path | Notes |
|---|---|---|
| GET | `/audit` | Inventory stock changes (`inventory_audit_logs`). Query: `product_id`, `action_type`, `from_date`, `to_date`, `limit` (default 200). |
| GET | `/audit/activity` | Cross-entity activity (`activity_logs`). Query: `entity_type`, `from_date`, `to_date`, `limit` (default 200). |

## Dashboard — `dashboard.js`
| Method | Path | Notes |
|---|---|---|
| GET | `/dashboard` | Aggregated summary for the home page. |

## Health
`GET /health` → `{ "status": "ok" }` (unauthenticated; used by Render health checks).
