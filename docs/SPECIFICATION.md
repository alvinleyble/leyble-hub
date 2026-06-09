# Leyble Hub — System Specification

**Version:** 1.2.0-spec  
**Status:** Active — Phase 3 In Progress  
**Schema note:** This document predates migrations 012–026 (per-bottle deposit, `activity_logs`, customer-type rename, dropped `custom_deposit_fee`, decimal stock, and more). Where it conflicts with `CLAUDE.md`'s schema drift table, the migration files are authoritative — see that table for the current schema.  
**Currency:** Philippine Peso (₱)  
**Target Users:** Business owners (late 50s) — accessibility is a first-class requirement.

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [System Architecture](#2-system-architecture)
3. [Tech Stack](#3-tech-stack)
4. [UX/Accessibility Design Constraints](#4-uxaccessibility-design-constraints)
5. [Database Schema](#5-database-schema)
6. [Order Status State Machine](#6-order-status-state-machine)
7. [Core Business Logic Rules](#7-core-business-logic-rules)
8. [Module Inventory](#8-module-inventory)
9. [API Surface (High-Level)](#9-api-surface-high-level)
10. [Hosting & Deployment](#10-hosting--deployment)

---

## 1. Project Overview

**Leyble Hub** is a private, internal web application for a local beverage distributor operating in Antipolo. It replaces manual paper-based processes with a centralized system for:

- Tracking outgoing orders and their delivery lifecycle.
- Managing product inventory (stock counts, pricing, deposit fees).
- Maintaining customer profiles with per-customer pricing history (Suki/VIP).
- Logging driver/helper profiles and assigning them to orders.
- Recording incoming supplier restocks.
- Flagging and resolving delivery discrepancies via a ticket system.
- Maintaining an immutable audit trail for all manual inventory changes.

The system is **not** customer-facing. All users are internal staff or business owners.

---

## 2. System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Client (Browser)                          │
│   React 18 + Vite SPA — deployed as Render Static Site          │
│   Tailwind CSS — high-contrast, large-target UI                  │
│   CSS Print Media Queries — thermal receipt rendering            │
└────────────────────────┬────────────────────────────────────────┘
                         │ HTTPS (JSON REST API)
                         │ JWT stored in HTTP-only cookies
┌────────────────────────▼────────────────────────────────────────┐
│                   Backend (Node.js + Express)                    │
│   Deployed as Render Web Service                                 │
│   Handles: Auth, Business Logic, DB Queries, File (Base64)       │
└────────────────────────┬────────────────────────────────────────┘
                         │ pg (node-postgres)
┌────────────────────────▼────────────────────────────────────────┐
│               PostgreSQL 15+ (Render Managed DB)                 │
│   All monetary values: NUMERIC(10,2) in ₱                        │
│   Driver ID images stored as Base64 TEXT columns                 │
└─────────────────────────────────────────────────────────────────┘
```

### Key Architectural Decisions

| Decision | Rationale |
|---|---|
| SPA (React/Vite) on Render Static Site | Zero-config CDN delivery; separate deploy pipeline from API |
| JWT in HTTP-only cookies | Prevents XSS token theft; SameSite=Strict CSRF protection |
| Base64 images in PostgreSQL | Eliminates external storage dependency; volume is small (~8 personnel, static IDs) |
| No ORM (raw `pg`) | Avoids abstraction overhead on a schema this well-defined; simpler mental model |
| NUMERIC(10,2) for all money | Avoids floating-point rounding errors for currency |
| Append-only audit and price-history tables | Immutability enforced at schema level (no UPDATE/DELETE on these tables) |

---

## 3. Tech Stack

| Layer | Technology | Notes |
|---|---|---|
| Frontend Framework | React 18 | Functional components, hooks only |
| Build Tool | Vite | Fast HMR in dev; optimized static build |
| Styling | Tailwind CSS v3 | Utility-first; custom theme for high-contrast palette |
| Backend Runtime | Node.js (LTS) | |
| Backend Framework | Express | REST API; no GraphQL |
| Database Client | `pg` (node-postgres) | Parameterized queries; no ORM |
| Database | PostgreSQL 15+ | Managed by Render |
| Authentication | JWT | Issued server-side; stored in HTTP-only, SameSite=Strict cookie |
| File Storage | PostgreSQL `TEXT` column | Base64-encoded driver ID images only |
| Hosting | Render | Web Service (API) + Static Site (Frontend) + Postgres |

---

## 4. UX/Accessibility Design Constraints

These constraints are **non-negotiable** and must be satisfied at the component level before any UI is considered complete.

### 4.1 General Rules
- Minimum touch/click target size: **48×48px** (WCAG 2.5.5 AA).
- Base font size: **16px minimum**; heading levels use a clear visual step (e.g., 24px → 20px → 16px).
- All form labels must be **visible above** their input fields — no placeholder-as-label patterns.
- Color is never the **sole** indicator of state (always pair with text or icon+text).

### 4.2 Color Palette Guidance
- Use high-contrast Tailwind palette pairs: `slate-900` on `white`; `red-700` on `red-50`; `green-700` on `green-50`.
- Interactive elements (buttons, links) must have a `:focus-visible` ring of at least `2px`.
- Status badges must use both color AND a text label (e.g., a yellow badge that reads "Pending", not just a yellow dot).

### 4.3 Feedback & Confirmation
- All destructive actions (cancel order, delete item) require an explicit confirmation modal before execution.
- All form submissions show a visible success banner or inline error message — no silent failures.
- Loading states must show a spinner or skeleton — no blank-screen flickers.

### 4.4 Receipt / Thermal Printer Optimization
- Each order detail view must have a **"Print Receipt"** action.
- A dedicated CSS `@media print` stylesheet must:
  - Hide all navigation, buttons, and chrome.
  - Use a fixed 58mm or 80mm width layout (configurable via CSS variable).
  - Use `font-family: monospace` for receipt body text alignment.
  - Force `color: black; background: white` — no ink waste from dark backgrounds.
  - Ensure prices, quantities, and totals align in columns using `display: grid` or `white-space: pre`.

---

## 5. Database Schema

All timestamps are `TIMESTAMPTZ` (UTC). All monetary values are `NUMERIC(10,2)`.  
Append-only tables (`inventory_audit_logs`, `customer_product_prices`) must never have `UPDATE` or `DELETE` issued against them by application code.

---

### 5.1 `users`
Internal admin accounts. No self-registration — created by a seed or by an existing admin.

```sql
CREATE TABLE users (
  id              SERIAL PRIMARY KEY,
  email           VARCHAR(255)  NOT NULL UNIQUE,
  password_hash   VARCHAR(255)  NOT NULL,
  full_name       VARCHAR(255)  NOT NULL,
  role            VARCHAR(50)   NOT NULL DEFAULT 'admin'
                    CHECK (role IN ('admin', 'viewer')),
  is_active       BOOLEAN       NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
```

**Notes:**
- `admin` role: full read/write access to all modules.
- `viewer` role: read-only access (future-proofing; not required for MVP).
- Password hashing: `bcrypt` with cost factor 12.

---

### 5.2 `products`
The central inventory catalogue. Each row represents one SKU.

```sql
CREATE TABLE products (
  id                    SERIAL PRIMARY KEY,
  name                  VARCHAR(255)  NOT NULL,
  category              VARCHAR(100),             -- e.g., 'Softdrinks', 'Water', 'Beer'
  unit                  VARCHAR(50)   NOT NULL,   -- e.g., 'bottle', 'case', 'pack'
  sku                   VARCHAR(100)  UNIQUE,      -- optional internal code
  base_wholesale_price  NUMERIC(10,2) NOT NULL DEFAULT 0,  -- retail price removed (migration 012)
  units_per_case        INT           NOT NULL DEFAULT 1,  -- added in migration 012
  deposit_fee           NUMERIC(10,2) NOT NULL DEFAULT 0,  -- empty bottle/container return
  current_stock         INT           NOT NULL DEFAULT 0,
  is_active             BOOLEAN       NOT NULL DEFAULT TRUE,
  created_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
```

**Notes:**
- `deposit_fee`: the returnable charge added per unit (e.g., ₱5 per bottle). Tracked separately from unit price so receipts can itemize it.
- Soft-deletion via `is_active = FALSE` — products referenced by historical orders must never be hard-deleted.
- Stock adjustments trigger an entry in `inventory_audit_logs`.

---

### 5.3 `customers`

```sql
CREATE TABLE customers (
  id              SERIAL PRIMARY KEY,
  name            VARCHAR(255)  NOT NULL,
  customer_type   VARCHAR(50)   NOT NULL DEFAULT 'regular'
                    CHECK (customer_type IN ('regular', 'wholesaler')),  -- 'retail' removed (015); renamed wholesale→regular, suki→wholesaler (025)
  address         TEXT,
  phone           VARCHAR(50),
  notes           TEXT,
  is_active       BOOLEAN       NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
```

**Notes:**
- `wholesaler` type (formerly `suki`) signals that custom pricing may apply (see §5.4); `regular` (formerly `wholesale`) uses base pricing.
- All customers are wholesale-business; the 'retail' type was removed in migration 015 (wholesale-only business model). Types were renamed in migration 025.

---

### 5.4 `customer_product_prices`
**Append-only.** Tracks the full history of custom price overrides per customer per product.

```sql
CREATE TABLE customer_product_prices (
  id                  SERIAL PRIMARY KEY,
  customer_id         INT           NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  product_id          INT           NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  custom_unit_price   NUMERIC(10,2),              -- NULL = revert to base price
  custom_deposit_fee  NUMERIC(10,2),              -- NULL = revert to base deposit fee
  set_by_user_id      INT           REFERENCES users(id),
  notes               TEXT,
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW()
  -- No updated_at: immutable history record
);

CREATE INDEX idx_cpp_customer_product_time
  ON customer_product_prices (customer_id, product_id, created_at DESC);
```

**Resolution Logic (applied at order-item creation time):**
1. Query the most recent `customer_product_prices` row for `(customer_id, product_id)`.
2. If a row exists and `custom_unit_price IS NOT NULL`, use `custom_unit_price` as the line-item default.
3. Otherwise, fall back to `products.base_retail_price` or `products.base_wholesale_price` based on `customers.customer_type`.
4. If the user further overrides the price inline during order entry, the overridden value is what gets saved to `order_items.unit_price`, AND a new `customer_product_prices` row is written to record the new custom price for next time.

---

### 5.5 `personnel`
All field workers (drivers, helpers, or anyone who may fill either role). Stores personal ID documents as Base64.

```sql
CREATE TABLE personnel (
  id                  SERIAL PRIMARY KEY,
  full_name           VARCHAR(255)  NOT NULL,
  remarks             TEXT,                       -- optional free-text (renamed from role_label in migration 017)
  phone               VARCHAR(50),
  license_number      VARCHAR(100),               -- for those with a driver's license
  id_image_base64     TEXT,                       -- Base64-encoded image data
  id_image_mime_type  VARCHAR(50),                -- e.g., 'image/jpeg', 'image/png'
  is_active           BOOLEAN       NOT NULL DEFAULT TRUE,
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
```

**Notes:**
- `remarks` (formerly `role_label`) is optional free-text for notes like "available weekends only". It does not restrict which role a person fills on any given order — that is tracked per-order in `order_personnel.role`.
- `id_image_base64` is stored as a raw Base64 string. The frontend renders it via `<img src="data:{mime_type};base64,{data}">`.
- Upload size must be validated server-side (recommended max: 2MB per image before encoding).
- Soft-deletion only — historical order assignments must remain intact.

---

### 5.6 `orders`
The core transactional record for outgoing deliveries.

```sql
CREATE TABLE orders (
  id              SERIAL PRIMARY KEY,
  customer_id     INT           NOT NULL REFERENCES customers(id),
  -- driver_id and helper_id were REMOVED in migration 016; use order_personnel join table instead
  status          VARCHAR(50)   NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'in_transit', 'completed', 'cancelled', 'done')),
  notes           TEXT,
  total_amount    NUMERIC(10,2) NOT NULL DEFAULT 0,        -- stored/updated on save
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  dispatched_at   TIMESTAMPTZ,     -- set when status → in_transit
  delivered_at    TIMESTAMPTZ,     -- set when status → completed
  closed_at       TIMESTAMPTZ      -- set when status → done OR cancelled
);

-- Personnel assigned to an order (replaces driver_id/helper_id — migration 016)
CREATE TABLE order_personnel (
  id           SERIAL PRIMARY KEY,
  order_id     INT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  personnel_id INT NOT NULL REFERENCES personnel(id),
  role         VARCHAR(50) NOT NULL DEFAULT 'Driver'  -- 'Driver' or 'Helper'
);

CREATE INDEX idx_orders_status     ON orders (status);
CREATE INDEX idx_orders_customer   ON orders (customer_id);
CREATE INDEX idx_orders_created_at ON orders (created_at DESC);
```

**Notes:**
- `total_amount` is computed as `SUM(order_items.line_total)` and stored here for fast reads (denormalized intentionally).
- Personnel are assigned via the `order_personnel` join table — multiple people (driver + helper(s)) may be linked to one order, each with a `role` of 'Driver' or 'Helper'.
- Editing an order (products, prices, deposits) is permitted while status is **not** `done` or `cancelled`. Each edit must re-compute and update `total_amount` and log changes to `inventory_audit_logs`.

---

### 5.7 `order_items`
Line items belonging to an order.

```sql
CREATE TABLE order_items (
  id                    SERIAL PRIMARY KEY,
  order_id              INT           NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id            INT           NOT NULL REFERENCES products(id),
  quantity              NUMERIC(10,2) NOT NULL DEFAULT 1 CHECK (quantity > 0),  -- NUMERIC since migration 013
  unit_price            NUMERIC(10,2) NOT NULL,            -- actual applied price (may be custom)
  unit_deposit_fee      NUMERIC(10,2) NOT NULL DEFAULT 0,  -- actual deposit applied
  is_price_overridden   BOOLEAN       NOT NULL DEFAULT FALSE,
  line_total            NUMERIC(10,2) GENERATED ALWAYS AS
                          (quantity * (unit_price + unit_deposit_fee)) STORED,
  created_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_order_items_order ON order_items (order_id);
```

**Notes:**
- `unit_price` and `unit_deposit_fee` are **standard mutable `NUMERIC(10,2)` columns** — they carry no generated or immutable constraint. Both may be updated to any non-negative numeric value (including `0`) on any non-closed order, at any point in the lifecycle, to reflect real-world delivery adjustments.
  - Setting `unit_deposit_fee = 0` is a valid and expected operation (e.g., customer returned empties; deposit is waived for that line).
  - Setting `unit_price = 0` is valid for complimentary items.
- `line_total` is a PostgreSQL **generated** column — it recomputes automatically whenever `quantity`, `unit_price`, or `unit_deposit_fee` is updated on that row. Application code must never write to it directly.
- `unit_price` captures the exact price at save time — it is not retroactively affected by future changes to `products.base_retail_price`.
- `is_price_overridden`: set to `TRUE` when the user manually changes `unit_price` from the pre-filled value (enables future discount-frequency reporting).
- Price adjustment UI supports both `+/-` stepper buttons and direct numeric text entry for both `unit_price` and `unit_deposit_fee`.

---

### 5.8 `supplier_deliveries` & `supplier_delivery_items`
Incoming restocks from suppliers (Coke, San Miguel, etc.). No statuses — these are simple log entries.

```sql
CREATE TABLE supplier_deliveries (
  id              SERIAL PRIMARY KEY,
  supplier_name   VARCHAR(255)  NOT NULL,     -- e.g., 'Coca-Cola', 'San Miguel'
  notes           TEXT,
  received_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  created_by      INT           REFERENCES users(id),
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE TABLE supplier_delivery_items (
  id                  SERIAL PRIMARY KEY,
  delivery_id         INT           NOT NULL REFERENCES supplier_deliveries(id) ON DELETE CASCADE,
  product_id          INT           NOT NULL REFERENCES products(id),
  quantity_received   INT           NOT NULL CHECK (quantity_received > 0),
  unit_cost           NUMERIC(10,2),           -- optional; for cost tracking only
  notes               TEXT,
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_sdi_delivery ON supplier_delivery_items (delivery_id);
```

**Notes:**
- Saving a `supplier_delivery` automatically increments `products.current_stock` for each line item and writes an `inventory_audit_logs` entry with `action_type = 'restock'`.
- To introduce a **new product** via a supplier delivery: the frontend first creates the product in the `products` table (with stock = 0), then the delivery references it.

---

### 5.9 `tickets`
Non-complex ledger/remarks for discrepancies, driver errors, and financial carry-overs.

```sql
CREATE TABLE tickets (
  id                  SERIAL PRIMARY KEY,
  title               VARCHAR(255)  NOT NULL,
  description         TEXT          NOT NULL,
  related_order_id      INT           REFERENCES orders(id),
  related_personnel_id  INT           REFERENCES personnel(id),
  amount              NUMERIC(10,2),           -- financial carry-over amount, if applicable
  status              VARCHAR(50)   NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'resolved')),
  created_by          INT           REFERENCES users(id),
  resolved_by         INT           REFERENCES users(id),
  resolved_at         TIMESTAMPTZ,
  resolution_notes    TEXT,
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_tickets_status ON tickets (status);
```

**Notes:**
- `related_order_id` and `related_personnel_id` are both optional — a ticket may relate to neither, one, or both.
- `amount`: used when the ticket represents a financial carry-over (e.g., driver collected ₱500 short — amount = -500; driver held ₱200 in advance — amount = 200).
- Status transitions: `pending` → `resolved` only. No re-opening of resolved tickets.

---

### 5.10 `inventory_audit_logs`
**Append-only.** Immutable record of every change to product stock, prices, or deposit fees.

```sql
CREATE TABLE inventory_audit_logs (
  id              SERIAL PRIMARY KEY,
  product_id      INT           NOT NULL REFERENCES products(id),
  action_type     VARCHAR(100)  NOT NULL
                    CHECK (action_type IN (
                      'manual_adjustment',   -- direct stock count edit via Inventory UI
                      'restock',             -- incoming supplier delivery
                      'price_change',        -- base price or deposit fee edit
                      'order_fulfillment',   -- stock decremented when order → in_transit
                      'order_edit',          -- stock adjusted due to order item edit
                      'order_cancel'         -- stock restored when order cancelled
                    )),
  field_changed   VARCHAR(100),              -- e.g., 'current_stock', 'base_retail_price'
  previous_value  TEXT,                      -- stored as text for generality
  new_value       TEXT,
  delta           NUMERIC,                   -- net stock change (NUMERIC since migration 014; positive = gain, negative = loss)
  reason          TEXT,                      -- free-text justification (required for manual_adjustment)
  performed_by    INT           REFERENCES users(id),
  related_order_id    INT       REFERENCES orders(id),
  related_delivery_id INT       REFERENCES supplier_deliveries(id),
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
  -- NO updated_at. This table is append-only. No UPDATE or DELETE ever.
);

CREATE INDEX idx_audit_product    ON inventory_audit_logs (product_id, created_at DESC);
CREATE INDEX idx_audit_action     ON inventory_audit_logs (action_type);
```

---

## 6. Order Status State Machine

### 6.1 Status Definitions

| Status | Open/Closed | Description |
|---|---|---|
| `pending` | Open | Order created; not yet dispatched. Fully editable. |
| `in_transit` | Open | Dispatched with driver. Editable (adjustments allowed mid-delivery). |
| `completed` | Open | Delivery confirmed; awaiting final reconciliation. Editable. |
| `done` | **Closed** | Reconciled and finalized. No further edits permitted. |
| `cancelled` | **Closed** | Order voided. No further edits. Stock is restored. |

### 6.2 State Machine Diagram

```
                  ┌───────────────┐
         Create   │               │
        ─────────►│    PENDING    │
                  │               │
                  └───────┬───────┘
                          │
               ┌──────────┴──────────┐
               │ Dispatch            │ Cancel
               │ (assign driver)     │
               ▼                     ▼
     ┌──────────────────┐    ┌──────────────────┐
     │    IN TRANSIT    │    │    CANCELLED      │ ◄── CLOSED
     │                  │    │    (stock         │
     │  (stock debited) │    │     restored)     │
     └────────┬─────────┘    └──────────────────┘
              │
   ┌──────────┴──────────┐
   │ Delivered           │ Cancel
   │                     │ (stock restored)
   ▼                     ▼
┌──────────────────┐    ┌──────────────────┐
│    COMPLETED     │    │    CANCELLED      │ ◄── CLOSED
│                  │    └──────────────────┘
│  (not yet closed;│
│   still editable)│
└────────┬─────────┘
         │
┌────────┴──────────────────────────┐
│ Reconcile         │ Cancel        │
│ (close order)     │ (edge case)   │
▼                   ▼               │
┌──────┐    ┌──────────────────┐    │
│ DONE │    │    CANCELLED      │◄──┘
│      │    └──────────────────┘
│(CLOSED)
└──────┘
```

### 6.3 Allowed Transitions (Enforcement Table)

| From | To | Trigger | Side Effects |
|---|---|---|---|
| `pending` | `in_transit` | User dispatches order | Stock check enforced here: if any line item quantity exceeds `products.current_stock`, the transition is rejected with a 422 error listing the shortfall. On success: `dispatched_at = NOW()`; stock decremented per line item; audit log entries written. |
| `pending` | `cancelled` | User cancels order | `closed_at = NOW()`; no stock change (stock was never debited for a pending order) |
| `in_transit` | `completed` | User confirms delivery | `delivered_at = NOW()` |
| `in_transit` | `cancelled` | User cancels in-transit order | `closed_at = NOW()`; stock restored per line item; audit log entries written |
| `completed` | `done` | User reconciles/closes order | `closed_at = NOW()` |
| `completed` | `cancelled` | User cancels after delivery (edge case) | `closed_at = NOW()`; stock restored; audit log entries written |

**Forbidden transitions** (must be rejected by the API with a 422 error):
- Any attempt to change status backwards (e.g., `in_transit` → `pending`).
- Any attempt to change a `done` or `cancelled` order's status.
- Any edit to order items on a `done` or `cancelled` order.

### 6.4 Stock Debit/Restore Rules

- **No stock check or debit on order creation.** A `pending` order may be saved even if its line item quantities exceed `products.current_stock`. This is intentional: the business does not operate first-come-first-served — delivery priority is determined by proximity and route efficiency, not by who placed the order first. Over-booking in the `pending` state is a normal operational condition.
- **Debit and hard check occur together at `pending → in_transit`.** This is the only moment the system enforces stock availability. If any line item cannot be fulfilled, the transition is blocked and the user sees which products are short.
- **Restore** occurs when: any order transitions to `cancelled` *from* `in_transit` or `completed`.
- No stock movement occurs on `pending → cancelled` (items were never debited).
- Every stock movement writes a row to `inventory_audit_logs`.

---

## 7. Core Business Logic Rules

### 7.1 Suki/VIP Pricing Auto-Fill
Custom prices are managed proactively in the Customers module (Customers → select customer → Suki Pricing → Set Price). Orders read saved prices but do not write back to `customer_product_prices`.

When creating or editing an order for a customer:
1. For each product added, query `customer_product_prices` for the most recent row matching `(customer_id, product_id)` using `DISTINCT ON (product_id)`.
2. Pre-fill the line item's `unit_price` with `custom_unit_price` if found; otherwise use `products.base_wholesale_price`.
3. The user may override the pre-filled price inline. The override is stored in `order_items.unit_price` only — it does **not** write a new `customer_product_prices` row automatically.

### 7.2 Order Total Computation
`orders.total_amount = SUM(order_items.line_total)` = `SUM(quantity × (unit_price + unit_deposit_fee))`.
This must be recomputed and persisted every time an order item is added, edited, or removed.

### 7.3 Dashboard — Rolling 5-Day View
The dashboard queries orders where:
- `created_at >= NOW() - INTERVAL '5 days'`
- **OR** `status IN ('pending', 'in_transit', 'completed')` (all open orders, regardless of age)

This ensures old backlogged orders are always visible even past the 5-day window.

### 7.4 Manual Inventory Adjustment
When a user directly edits `products.current_stock` via the Inventory UI:
- A free-text `reason` field is **required**.
- An `inventory_audit_logs` row is written with `action_type = 'manual_adjustment'`.

### 7.5 Incoming Supplier Delivery — New Products
If a supplier delivery includes a product not yet in the catalogue:
1. User first creates the product via the Inventory module (stock = 0).
2. The delivery line item then references the new product, incrementing stock.

### 7.6 Order Editing Constraints
- Orders in `pending`, `in_transit`, or `completed` status may have their line items (products, quantities, prices, deposits) fully edited by the user.
- Line item edits on `in_transit` orders must adjust `products.current_stock` to reflect the difference and write audit log entries.
- Orders in `done` or `cancelled` are immutable — the API must reject any edit attempts.

### 7.7 Pending Order Overbooking Policy
Creating or editing a `pending` order imposes **no stock availability check** at the database or API layer. The business's delivery workflow is proximity- and route-based, not first-come-first-served. Multiple pending orders may collectively reference more stock than is physically available. The system surfaces this fact visually (e.g., a low-stock indicator on the Inventory page) but does not block order creation. The hard enforcement gate is exclusively at the `pending → in_transit` transition (§6.4).

---

## 8. Module Inventory

| Module | Path Prefix | Description |
|---|---|---|
| Dashboard | `/` | Rolling 5-day + all-open orders view |
| Inventory | `/inventory` | Product list, stock edits, price edits |
| Outgoing Orders | `/orders` | Create, list, edit, dispatch, close orders |
| Order Detail | `/orders/:id` | Full order view + receipt print action |
| Customers | `/customers` | List, create, edit profiles + order history |
| Personnel | `/personnel` | List, create, edit profiles + ID image upload |
| Incoming (Suppliers) | `/incoming` | Log supplier deliveries + restock |
| Tickets | `/tickets` | Log and resolve discrepancy tickets |
| Audit Log | `/audit` | Read-only log of inventory changes |
| Auth | `/login` | JWT login; no registration UI |

---

## 9. API Surface (High-Level)

All routes are prefixed `/api/v1`. All responses are JSON. Authentication is required on all routes except `POST /api/v1/auth/login`.

### Auth
| Method | Path | Description |
|---|---|---|
| POST | `/auth/login` | Issue JWT cookie |
| POST | `/auth/logout` | Clear JWT cookie |
| GET | `/auth/me` | Return current user |

### Products
| Method | Path | Description |
|---|---|---|
| GET | `/products` | List all active products |
| POST | `/products` | Create product |
| GET | `/products/:id` | Get single product + audit log |
| PATCH | `/products/:id` | Update price/deposit/stock/name |

### Customers
| Method | Path | Description |
|---|---|---|
| GET | `/customers` | List customers |
| POST | `/customers` | Create customer |
| GET | `/customers/:id` | Get customer + order history |
| PATCH | `/customers/:id` | Update customer |
| GET | `/customers/:id/prices` | Get custom price history |

### Personnel
| Method | Path | Description |
|---|---|---|
| GET | `/personnel` | List all personnel |
| POST | `/personnel` | Create personnel record (with Base64 image) |
| GET | `/personnel/:id` | Get personnel record + order history |
| PATCH | `/personnel/:id` | Update personnel record |

### Orders
| Method | Path | Description |
|---|---|---|
| GET | `/orders` | List orders (with filter/status params) |
| POST | `/orders` | Create order (status = pending) |
| GET | `/orders/:id` | Get full order with items |
| PATCH | `/orders/:id` | Update order items/notes/driver assignment |
| POST | `/orders/:id/status` | Transition order status |

### Incoming (Supplier Deliveries)
| Method | Path | Description |
|---|---|---|
| GET | `/incoming` | List deliveries |
| POST | `/incoming` | Log new delivery + restock products |
| GET | `/incoming/:id` | Get delivery detail |

### Tickets
| Method | Path | Description |
|---|---|---|
| GET | `/tickets` | List tickets |
| POST | `/tickets` | Create ticket |
| GET | `/tickets/:id` | Get ticket detail |
| PATCH | `/tickets/:id` | Update / resolve ticket |

### Audit Log
| Method | Path | Description |
|---|---|---|
| GET | `/audit` | List audit log (filterable by product, action type, date) |

### Dashboard
| Method | Path | Description |
|---|---|---|
| GET | `/dashboard` | Rolling 5-day + all-open orders summary |

---

## 10. Hosting & Deployment

| Service | Render Type | Notes |
|---|---|---|
| Frontend | Static Site | Build command: `vite build`; publish dir: `dist/` |
| Backend | Web Service | Start command: `node src/index.js` |
| Database | PostgreSQL | Managed Render Postgres; SSL required |

### Environment Variables (Backend)
| Variable | Description |
|---|---|
| `DATABASE_URL` | Render-provided PostgreSQL connection string |
| `JWT_SECRET` | Minimum 32-character random string |
| `JWT_EXPIRES_IN` | e.g., `8h` |
| `COOKIE_DOMAIN` | Domain for cookie binding (Render URL) |
| `NODE_ENV` | `production` on Render |
| `PORT` | Render-provided port (default: 10000) |

### CORS Policy
The Express server must accept requests only from the deployed Render Static Site URL (or `localhost:5173` in development). `credentials: true` is required for the HTTP-only cookie to be sent cross-origin.

---

*End of SPECIFICATION.md — v1.1.0 approved. BMAD Phase 2 (database migration scripts + Express API scaffolding) is active.*
