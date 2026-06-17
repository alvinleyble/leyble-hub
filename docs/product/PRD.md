# Product Requirements — Leyble Hub

## Overview

**Leyble Hub** is a private, internal admin app for **Leyble General Merchandise**, a local
beverage distributor in Antipolo, Philippines. It is the operational back-office: tracking
inventory, customers, outgoing orders, incoming supplies, field personnel, and issues. It is
**not customer-facing** and handles no online payments — it is a record-keeping and
order-management tool for the business.

- **Primary users:** the business owners (a couple in their late 50s) and trusted family/staff.
- **Currency:** Philippine Peso (₱), `NUMERIC(10,2)` throughout.
- **Business model:** wholesale-only. There is no retail price; products carry a single
  wholesale base price, with optional custom prices for `wholesaler`-type customers.
- **Delivery surface:** Android APK (Capacitor) for the owners' phones, and the same app as a
  website/PWA on tablets/desktops. Cloud-hosted (Render + Supabase) — there is no on-prem PC.

## Goals

1. Replace paper/spreadsheet tracking of orders, stock, and deliveries with one reliable app.
2. Be usable by non-technical owners: large touch targets, large fonts, plain-language status,
   visible labels, no jargon. (See [Accessibility](#accessibility--ux-constraints).)
3. Keep an auditable history of every stock change and every important edit.
4. Handle the real-world quirks of the business: half-case quantities, returnable-bottle
   deposits, delivery vs pickup pricing, and multiple workers per delivery.

## Non-goals

- Not customer-facing; no public storefront, no customer logins.
- No payment processing / accounting integration.
- No multi-tenant support — it serves one business.

## Users & roles

- **admin** — full access (create/edit everything). The owners and staff.
- **viewer** — read access (role exists in schema; primary use is admin).

Authentication is a single shared-style login per account (JWT); see
[Architecture](../architecture/ARCHITECTURE.md#authentication-flow).

## Modules

| Module | What it does |
|---|---|
| **Dashboard** | At-a-glance summary (recent activity / rolling view). |
| **Inventory (Products)** | Product catalog with category chips + stock filter; case size (`units_per_case`), per-bottle deposit, returnable-bottle flag, current stock (supports 0.5). |
| **Customers** | Regular vs wholesaler; wholesaler custom pricing with **separate delivery/pickup price tabs**; per-customer order history. |
| **Personnel** | Drivers/helpers with ID photo upload and per-person order history. |
| **Outgoing Orders** | Create/edit delivery & pickup orders; draft orders; price adjustment; per-bottle deposit + bottle-return close flow; batch review queues; 80mm thermal receipt. |
| **Incoming Supplies** | Log supplier deliveries → auto-restock; supports 0.5-case quantities; soft-void reverses a delivery. |
| **Tickets** | Lightweight issue log (create, view, resolve), optionally linked to an order/person. |
| **Audit Log** | Read-only, filterable. Two append-only sources: inventory stock deltas and a cross-entity activity log. |

## Core business rules (plain language)

- **Wholesale-only pricing.** Every product has one base wholesale price. **Wholesaler**
  customers can have custom per-product prices, set **separately for delivery and pickup**. The
  newest custom price wins (price history is append-only). Regular customers use the base price.
- **Order types.** An order is either **delivery** or **pickup**; this affects the status flow
  and which custom price applies.
- **Order lifecycle.** draft → pending → (in_transit, delivery only) → completed → done, or
  cancelled. Stock is deducted when goods leave and restored on cancel. Full rules:
  [Order Lifecycle](../architecture/order-lifecycle.md).
- **Drafts.** A draft is a parked, possibly-incomplete order. It reserves no stock and is hidden
  everywhere except the Drafts tab until finalized.
- **Deposits & bottle returns.** Products that require bottle return carry a per-bottle deposit.
  The deposit is charged only on bottles **not** returned. The order total is **goods-only while
  the order is open**, and the deposit is folded in only when the order is closed and returns are
  counted.
- **Adjustments.** An order can carry a manual ± adjustment with a reason (discount/overcharge).
- **One Driver per order.** Multiple personnel may be attached, but at most one has the Driver
  role; assigning a new Driver demotes the previous one to Helper.
- **Half-cases.** Quantities and stock are decimal (`0.5`) to support half-case transactions.
- **Nothing is hard-deleted where it would orphan an audit trail.** Orders are cancelled,
  deliveries are voided, products/customers/personnel are soft-deactivated.

## Accessibility & UX constraints (non-negotiable)

- Minimum **48×48px** touch targets; **16px+** fonts.
- Visible labels above inputs (no placeholder-as-label).
- `:focus-visible` ring on all interactive elements.
- Status always conveyed with **text + color**, never color alone.
- Peso amounts formatted as `₱1,234.56`.
- Responsive: permanent sidebar only on large fine-pointer screens (`desktop:` breakpoint);
  phones/tablets get a hamburger drawer.

See also: [Glossary](glossary.md) · [Architecture](../architecture/ARCHITECTURE.md) ·
[Order Lifecycle](../architecture/order-lifecycle.md).
