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

### V2 tablet shell (in progress — see [docs/product/proposals/v2-tablet-pos-overhaul.md](docs/product/proposals/v2-tablet-pos-overhaul.md))

The V2 tablet POS overhaul lands slice by slice **alongside** V1, not in place of it:
- **Two shells, two route trees.** `/v2/*` renders `client/src/components/layout/V2Shell.jsx`
  (dark slate, POS/Inventory/Customers + Back Office drawer); every pre-existing route keeps its
  path and its V1 `AppLayout`. Never repoint or delete a V1 route — add V2 screens under `/v2`.
- **Dark tokens are V2-only.** `v2-*` colors and `min-h-tablet` (52px) in
  `client/tailwind.config.js` are for V2 shell/screens; V1 pages stay light. The V2 focus ring is
  re-tinted via the `.v2-root` rule in `client/src/index.css`.
- **Back Office** (Personnel, Incoming Supplies, Tickets, Audit Log) stays V1 UI permanently —
  V2 only relocates the entry point.
- All V2 slices merge to `dev` only; `main` is merged once at the end (batched APK cutover).
- **POS (Slice 1, done):** [client/src/pages/pos/POSPage.jsx](client/src/pages/pos/POSPage.jsx) plus
  `client/src/components/pos/`. Order math lives in `posMath.js` — every POS figure and the
  printed receipt are **goods-only**: V2 never charges or shows the bottle deposit, because it
  never reaches the closing step where returns are counted (captain correction 2026-08-20,
  reversing proposal §2.4 — lines still carry `unit_deposit_fee` for V1's close flow). POS copy
  says "order", never "ticket".
  The POS surfaces only Draft / Created (`pending`) / Cancelled and never writes
  `order_personnel`; Amber Edit Mode cannot change customer or order type (backend accepts those
  on drafts only). Its zero-prompt 2-copy print reuses `usePrintReceipt` via
  `options.copies` / `options.autoTag`, and the deposit on a pending receipt via
  `overrides.showDeposit` — V1's prompts and receipts are unchanged.

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

## Deployment — Android app + cloud API

There is no on-prem/Windows computer, and **no web client**. The product ships only as an
**Android APK** (Capacitor wrap of the React app) talking to a **cloud-hosted** API + DB. The
backend is **API-only** — it does not serve a website; opening the Render URL in a browser
returns a 404 JSON. The Android APK is the only way in.
- **API:** Express on **Render** (repo root, `node server/src/index.js`), API-only (no
  `client/dist` served) — see [server/src/index.js](server/src/index.js).
- **Database:** **Supabase** managed Postgres (pooled `DATABASE_URL`).
- `npm run dev` (separate Vite + Express servers) is **dev-only** — local development still runs
  in a browser, which is why the cookie auth path is kept (see Security rules).
- Login: single shared account `josie@leyblestore.com` / (value of `JOSIE_PASSWORD`, default
  `leyble123` — set via the one-off `node server/db/setup-profiles.js` script, see migration 030).
  After login, the app requires picking a profile (Josie / Luis / Admin); the client sends the
  chosen profile as an `X-Active-Profile` header on every request, and `requireAuth` swaps the
  request identity to that profile so `activity_logs.performed_by` reflects who's actually driving,
  not the shared login.
- Full build/deploy/sideload steps: **[docs/operations/android.md](docs/operations/android.md)**.

### Single production environment

There is **one** environment: production. It's defined in [render.yaml](render.yaml) as the
`leyble-hub-api` service (deploys from `main`) against the prod Supabase DB.

**Workflow:** changes flow `dev` → `main` (prod). Render production auto-deploys on push to
`main`. (There is no staging environment — it was removed in June 2026.)

> Because there is no web client, **every UI change requires rebuilding + reinstalling the APK**
> on each device — there is no web fallback to push fixes instantly.

---

## Git rules

> **CRITICAL — read before every commit/push.**

- **Never commit without Alvin's explicit go-ahead.** Do not auto-commit even when changes are complete and ready.
- **Never push without Alvin's explicit go-ahead.** A completed implementation is not permission to push.
- Always present changes and ask "ready to commit and push?" — wait for a direct "yes" or "okay, commit and push."

## Security rules
- **Native Android (production):** the Capacitor app stores the JWT in `@capacitor/preferences`
  (native, app-sandboxed — *not* browser localStorage) and sends it as `Authorization: Bearer`.
  This is how the live app authenticates; see [docs/operations/android.md](docs/operations/android.md).
- **Local browser dev only:** `npm run dev` runs in a browser, where the JWT is set as an
  HTTP-only, SameSite=Strict cookie (never localStorage, never log the token). This path exists
  solely so login works during local dev — production serves no web client.
- `requireAuth` accepts both cookie and Bearer.
- `server/.env` must never be committed or exposed — contains `JWT_SECRET` and `SEED_ADMIN_PASSWORD`
- All API routes require `requireAuth` middleware except `POST /api/v1/auth/login`
- Parameterized queries only — no string interpolation into SQL

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
