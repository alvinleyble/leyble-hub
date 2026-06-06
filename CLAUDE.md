# CLAUDE.md — Leyble Hub

Private internal admin app for a local beverage distributor in Antipolo, Philippines.
Primary users: business owners (late 50s). Currency: Philippine Peso (₱). Not customer-facing.

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
- `inventory_audit_logs` and `customer_product_prices` are **append-only** — never `UPDATE` or `DELETE` these tables.
- `order_items.line_total` is a PostgreSQL `GENERATED` column — never write to it directly.
- Multiple personnel per order via `order_personnel` join table (not FK columns on `orders`).

### Frontend patterns (follow these exactly — consistency matters)

**Searchable combobox** (product pickers everywhere):
- Text input + dropdown, filter by name/category on keystroke
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
| Customers | ✅ Done | Suki pricing panel (separate delivery/pickup price tabs), order history |
| Personnel | ✅ Done | ID image upload, order history |
| Outgoing Orders | ✅ Done | Delivery + pickup types; editable at all statuses (inventory auto-reconciles); price adjustment field; 58mm thermal receipt |
| Incoming Supplies | ✅ Done | Log deliveries, auto-restock; supports 0.5-case quantities |
| Tickets | ✅ Done | Create, view, resolve |
| Audit Log | ✅ Done | Read-only, filterable |

---

## Schema — what diverges from SPECIFICATION.md

`SPECIFICATION.md` predates migrations 012–022. Trust the actual migrations over the spec.

| What the spec says | What the DB actually has |
|---|---|
| `products.base_retail_price` exists | **Dropped** (migration 012); wholesale-only model |
| `products` has no case-size field | `units_per_case INT NOT NULL DEFAULT 1` added (migration 012) |
| `order_items.quantity INT` | **`NUMERIC(10,2)`** (migration 013) — supports partial cases |
| `inventory_audit_logs.delta INT` | **`NUMERIC`** (migration 014) |
| `customers.customer_type IN ('retail','wholesale','suki')` | **`IN ('wholesale','suki')`** only (migration 015); default `'wholesale'` |
| `orders.driver_id`, `orders.helper_id` FK columns | **Dropped** (migration 016); replaced by `order_personnel` join table |
| `personnel.role_label VARCHAR(100)` | **Renamed to `remarks TEXT`** (migration 017) |
| `orders` has no `order_type` | `order_type VARCHAR(20) IN ('delivery','pickup') DEFAULT 'delivery'` (migration 018) |
| `orders` has no adjustment | `adjustment NUMERIC(10,2) DEFAULT 0`, `adjustment_reason TEXT` (migration 019) |
| `customer_product_prices` has no `order_type` | `order_type VARCHAR(20) IN ('delivery','pickup') DEFAULT 'delivery'` (migration 020) — append-only, existing rows default to 'delivery' |
| `products.current_stock INT` | **`NUMERIC(10,2)`** (migration 022) — supports 0.5-case stock levels |
| `supplier_delivery_items.quantity_received INT` | **`NUMERIC(10,2)`** (migration 022) — supports 0.5-case deliveries |

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

- Printer: **58mm thermal**
- Implementation: `handlePrint()` in [client/src/pages/orders/OrderDetailPage.jsx](client/src/pages/orders/OrderDetailPage.jsx)
- Uses `@page { size: 58mm auto; margin: 0 }` — no external CSS needed
- Item layout: product name on line 1, `qty unit × price → amount` on line 2
- Shows **DELIVERY RECEIPT** or **PICKUP RECEIPT** depending on `order.order_type`
- Footer: terms text (left) + "Received the above merchandise…" + `By:` signature line (right)
- Business name on receipt: **LEYBLE GENERAL MERCHANDISE** (not "Leyble Hub")

---

## Deployment — parents' Windows computer

- Location: `C:\leyble-hub\`
- Process manager: PM2 (`pm2 start npm --name leyble-client --cwd C:\leyble-hub\client -- run dev`)
- Update procedure: double-click `update.bat` in the repo root
- App URL: `http://localhost:5173`
- Login: `admin@leyblevhub.local` / (value of `SEED_ADMIN_PASSWORD` in `server/.env`)

---

## Git rules

> **CRITICAL — read before every commit/push.**

- **Never commit without Alvin's explicit go-ahead.** Do not auto-commit even when changes are complete and ready.
- **Never push without Alvin's explicit go-ahead.** A completed implementation is not permission to push.
- Always present changes and ask "ready to commit and push?" — wait for a direct "yes" or "okay, commit and push."

## Security rules
- JWT in HTTP-only, SameSite=Strict cookies — never localStorage, never log the token
- `server/.env` must never be committed or exposed — contains `JWT_SECRET` and `SEED_ADMIN_PASSWORD`
- All API routes require `requireAuth` middleware except `POST /api/v1/auth/login`
- Parameterized queries only — no string interpolation into SQL
