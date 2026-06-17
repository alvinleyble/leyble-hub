# CLAUDE.md — Leyble Hub

Private internal admin app for a local beverage distributor in Antipolo, Philippines.
Primary users: business owners (late 50s). Currency: Philippine Peso (₱). Not customer-facing.

---

## Reporting changes back to Alvin

Every time you summarize changes you made, end with a short **"Steps to replicate"** section —
numbered steps telling Alvin exactly where to click/navigate in the running app to see and test
the change himself (page/tab name, what to select, what action to take, what to expect). He
should never have to guess where to find what changed.

---

## Running the project

```bash
# Backend (port 3000)
cd server && node src/index.js

# Frontend (port 5173)
cd client && npm run dev
```

Vite dev proxy: `/api` → `http://localhost:3000`
DB: `DATABASE_URL=postgresql://localhost/leyble_hub`
**Never expose `server/.env` contents** — contains `JWT_SECRET` and `SEED_ADMIN_PASSWORD`.

---

## Tech stack

| Layer | Technology |
|---|---|
| Frontend | React 18, Vite, Tailwind CSS v3 |
| Backend | Node.js + Express, raw `pg` (no ORM) |
| Auth | JWT in HTTP-only SameSite=Strict cookies |
| Database | PostgreSQL 15+, `NUMERIC(10,2)` for money, `TIMESTAMPTZ` for timestamps |

---

## Key conventions

### Database
- Migrations live in `server/db/migrations/NNN_name.sql`. **Never modify an applied migration** — always add a new one.
- `inventory_audit_logs`, `customer_product_prices`, and `activity_logs` are **append-only** — never `UPDATE` or `DELETE` these tables.
- `order_items.line_total` is a PostgreSQL `GENERATED` column — never write to it directly. Since migration 023 the formula is `quantity*unit_price + (quantity*units_per_case − bottles_returned)*unit_deposit_fee` (deposit charged on un-returned bottles).
- Multiple personnel per order via `order_personnel` join table (not FK columns on `orders`).
- **At most one Driver per order** — auto-switch UX in the order modal (picking a new Driver
  demotes the previous one to Helper) + validated in `syncPersonnel` in
  [server/src/routes/orders.js](server/src/routes/orders.js) (400 on >1 Driver).

### Frontend patterns (follow these exactly — consistency matters)

**Searchable combobox** (product pickers everywhere):
- Text input + dropdown, filter on keystroke via `productMatches()` from
  `client/src/utils/productSearch.js` — punctuation-insensitive ("c8" matches SKU "C-8")
  and also matches name/category, so every product search bar must use it
- `onFocus`/`onBlur` + `setTimeout(150)` before closing so `onMouseDown` fires before blur
- Reference: `client/src/pages/orders/OrderCreateModal.jsx`

**Side panel** (detail views):
- `fixed inset-0 z-40` backdrop + `fixed right-0 top-0 h-full w-full max-w-lg` panel
- Reference: `client/src/pages/personnel/PersonnelDetailPanel.jsx`

**Modal** (create/edit forms):
- `fixed inset-0 z-50 flex items-start justify-center`
- Reference: `client/src/pages/personnel/PersonnelFormModal.jsx`

**PHP formatter** (defined locally in each file — do not centralize):
```js
const PHP = (n) =>
  `₱${Number(n).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
```

**API calls**: `api.get/post/patch/del` from `client/src/api/client.js`, always with `credentials: 'include'` (already set in the client).

**Toasts**: `const { addToast } = useToast()` → `addToast(msg, 'success' | 'error')`.

**Responsive layout**: the permanent sidebar only renders on the custom `desktop:` screen
(`min-width: 1024px` **and** `pointer: fine`, see `client/tailwind.config.js`); phones/tablets
get the hamburger drawer in both portrait and landscape. Width-based `sm:`/`md:`/`lg:` are
still used for everything else (table columns etc.).

### Accessibility (non-negotiable)
- Minimum 48×48px touch targets
- 16px+ fonts
- Visible labels above inputs — no placeholder-as-label
- `:focus-visible` ring on all interactive elements
- Status always conveyed with text + color, never color alone

---

## Module build status

| Module | Status | Notes |
|---|---|---|
| Inventory | ✅ Done | Category chips + stock filter |
| Customers | ✅ Done | Wholesaler custom pricing panel (separate delivery/pickup price tabs), order history |
| Personnel | ✅ Done | ID image upload, order history |
| Outgoing Orders | ✅ Done | Delivery + pickup types; editable at all statuses (inventory auto-reconciles, incl. Edit/Cancel inside the batch-review queues); price adjustment field; per-bottle deposit + bottle-return close flow (Review Deliveries queue); 80mm thermal receipt |
| Incoming Supplies | ✅ Done | Log deliveries, auto-restock; supports 0.5-case quantities |
| Tickets | ✅ Done | Create, view, resolve |
| Audit Log | ✅ Done | Read-only, filterable. Two append-only sources: `inventory_audit_logs` (stock deltas, `GET /api/v1/audit`) and `activity_logs` (cross-entity change log for orders/customers/products/personnel/tickets, `GET /api/v1/audit/activity`) |

> **Order totals:** an order's stored `total_amount` is **goods-only (qty × price) while it is open**; the bottle deposit on un-returned bottles is folded into the total only when the order is closed and returns are counted (`recomputeTotal` in [server/src/routes/orders.js](server/src/routes/orders.js)). This is intentional — pre-close totals deliberately exclude the refundable deposit.

---

## Schema — what diverges from the archived spec

The archived [docs/archive/SPECIFICATION.md](docs/archive/SPECIFICATION.md) predates migrations 012–026 (the divergences are listed below). Trust the actual migrations over the spec. For the current schema written up from the migrations, see [docs/architecture/DATABASE.md](docs/architecture/DATABASE.md).

| What the spec says | What the DB actually has |
|---|---|
| `products.base_retail_price` exists | **Dropped** (migration 012); wholesale-only model |
| `products` has no case-size field | `units_per_case INT NOT NULL DEFAULT 1` added (migration 012) |
| `order_items.quantity INT` | **`NUMERIC(10,2)`** (migration 013) — supports partial cases |
| `inventory_audit_logs.delta INT` | **`NUMERIC`** (migration 014) |
| `customers.customer_type IN ('retail','wholesale','suki')` | **`IN ('regular','wholesaler')`** only (migrations 015 + 025); default `'regular'` |
| `orders.driver_id`, `orders.helper_id` FK columns | **Dropped** (migration 016); replaced by `order_personnel` join table |
| `personnel.role_label VARCHAR(100)` | **Renamed to `remarks TEXT`** (migration 017) |
| `orders` has no `order_type` | `order_type VARCHAR(20) IN ('delivery','pickup') DEFAULT 'delivery'` (migration 018) |
| `orders` has no adjustment | `adjustment NUMERIC(10,2) DEFAULT 0`, `adjustment_reason TEXT` (migration 019) |
| `customer_product_prices` has no `order_type` | `order_type VARCHAR(20) IN ('delivery','pickup') DEFAULT 'delivery'` (migration 020) — append-only, existing rows default to 'delivery' |
| `products.current_stock INT` | **`NUMERIC(10,2)`** (migration 022) — supports 0.5-case stock levels |
| `supplier_delivery_items.quantity_received INT` | **`NUMERIC(10,2)`** (migration 022) — supports 0.5-case deliveries |
| `products` has no bottle-return flag | `requires_bottle_return BOOLEAN NOT NULL DEFAULT FALSE` added (migration 023). NB: per-bottle deposit amount lives in the pre-existing `products.deposit_fee` (migration 002) |
| `order_items` has no case-size / return fields | `units_per_case INT NOT NULL DEFAULT 1` and `bottles_returned INT NOT NULL DEFAULT 0` added (migration 023) |
| `order_items.line_total = quantity*(unit_price+unit_deposit_fee)` | **Reformulated** (migration 023) to `quantity*unit_price + (quantity*units_per_case − bottles_returned)*unit_deposit_fee`; still a `GENERATED ... STORED` column. Defaults (`units_per_case=1, bottles_returned=0`) reproduce the old result |
| no system-wide change log | `activity_logs` table added (migration 024) — append-only; `entity_type IN ('order','customer','product','personnel','ticket')`, `entity_id`, `action`, `summary`, `performed_by`, `created_at`. Written via [server/src/lib/activityLog.js](server/src/lib/activityLog.js) |
| `customer_product_prices.custom_deposit_fee` exists | **Dropped** (migration 026); deposit is now product-level (`products.deposit_fee`) with per-line override (`order_items.unit_deposit_fee`), not per-customer |

### `order_personnel` join table (migration 016)
```sql
CREATE TABLE order_personnel (
  id           SERIAL PRIMARY KEY,
  order_id     INT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  personnel_id INT NOT NULL REFERENCES personnel(id),
  role         VARCHAR(50) NOT NULL DEFAULT 'Driver'
);
```
Query pattern for personnel on an order:
```sql
SELECT STRING_AGG(per.full_name || ' (' || op.role || ')', ', ' ORDER BY op.id)
FROM order_personnel op JOIN personnel per ON per.id = op.personnel_id
WHERE op.order_id = $1
```

---

## Receipt printing

- Printer: **80mm thermal** (was 58mm until June 2026 — keep all sizing 80mm from now on)
- Implementation: receipt HTML built in [client/src/pages/orders/receiptTemplate.js](client/src/pages/orders/receiptTemplate.js),
  printed via `usePrintReceipt()` (used by OrderDetailPage and ReviewQueueModal)
- Uses `@page { size: 80mm auto; margin: 0 }`, body width 72mm — no external CSS needed
- Item layout: product name on line 1, `qty unit × price → amount` on line 2
- Shows **DELIVERY RECEIPT** or **PICKUP RECEIPT** depending on `order.order_type`
- Footer: terms text (left) + "Received the above merchandise…" + `By:` signature line (right)
- Business name on receipt: **LEYBLE GENERAL MERCHANDISE** (not "Leyble Hub")

---

## Deployment — cloud + Android app

There is no on-prem/Windows computer. The product ships as an **Android APK** (Capacitor wrap
of the existing React app) talking to a **cloud-hosted** backend + DB. The same backend also
serves the built frontend, so the app is also reachable as a normal website (e.g. for use on
iPad/desktop browsers — Add to Home Screen for an app-like icon):
- **Backend + Frontend:** Express services on **Render** (repo root, `node server/src/index.js`).
  Express serves the built `client/dist` and falls back to `index.html` for non-`/api` routes,
  so the browser/PWA login cookie (`SameSite=Strict`) works same-origin — see
  [server/src/index.js](server/src/index.js).
- **Database:** **Supabase** managed Postgres (pooled `DATABASE_URL`).
- `npm run dev` (separate Vite + Express servers) is dev-only.
- Login: `admin@leyblevhub.local` / (value of `SEED_ADMIN_PASSWORD`, set as a host env var).
- Full build/deploy/sideload steps: **[docs/operations/android.md](docs/operations/android.md)**.

### Production + Staging environments

A **staging** environment exists (separate Render service + separate Supabase project) where
family members can test and practice without touching production data. Both environments are
defined in [render.yaml](render.yaml) under a `projects:`/`environments:` structure:

- **Production** (`main` branch): `leyble-hub-api` service, prod Supabase DB
- **Staging** (`staging` branch): `leyble-hub-api-staging` service, staging Supabase DB (cloned
  from prod, then independent)

**Workflow:** changes flow `android-app` (dev) → `staging` (test live) → `main` (prod). Small
hotfixes can skip staging (merge `android-app` → `main` directly). See **[docs/operations/staging.md](docs/operations/staging.md)**
for the full setup, one-time Supabase clone, and deployment workflow.

> The old Windows/PM2 `.bat` scripts (`start/stop/restart/update.bat`) are **dev-only legacy**
> — they assumed an on-prem PC that no longer exists.

---

## Git rules

> **CRITICAL — read before every commit/push.**

- **Never commit without Alvin's explicit go-ahead.** Do not auto-commit even when changes are complete and ready.
- **Never push without Alvin's explicit go-ahead.** A completed implementation is not permission to push.
- Always present changes and ask "ready to commit and push?" — wait for a direct "yes" or "okay, commit and push."

## Security rules
- JWT in HTTP-only, SameSite=Strict cookies (web) — never localStorage, never log the token.
  **Native Android exception:** the Capacitor app can't use SameSite=strict cookies
  cross-origin, so it stores the JWT in `@capacitor/preferences` (native, app-sandboxed — *not*
  browser localStorage) and sends it as `Authorization: Bearer`. `requireAuth` accepts both
  cookie and Bearer; see [docs/operations/android.md](docs/operations/android.md).
- `server/.env` must never be committed or exposed — contains `JWT_SECRET` and `SEED_ADMIN_PASSWORD`
- All API routes require `requireAuth` middleware except `POST /api/v1/auth/login`
- Parameterized queries only — no string interpolation into SQL
