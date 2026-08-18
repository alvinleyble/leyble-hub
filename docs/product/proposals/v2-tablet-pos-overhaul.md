# Proposal: Leyble Hub V2 — Tablet POS & Store Operations Overhaul

**Status:** Reviewed, prototype tested, decisions locked. Ready for slice-by-slice implementation.  
**Origin:** Alvin & Firstmate (2026-08-18).  
**Target Hardware:** **Honor Pad X8B** (11.0" Android Tablet, ~1200×1920 native, landscape orientation).  
**Target Users:** Store owners in Antipolo, Rizal, PH.  
**See also:** [PRD.md](../PRD.md), [ARCHITECTURE.md](../../architecture/ARCHITECTURE.md), [DATABASE.md](../../architecture/DATABASE.md), [order-lifecycle.md](../../architecture/order-lifecycle.md).

---

## 1. Executive Summary & Core Objectives

Leyble Hub V1 was built as a comprehensive desktop/web admin portal with 11 steps and 3 modals to complete an order. In high-volume daily store operations on the tablet, this creates unnecessary friction.

**Leyble Hub V2** overhauls the frontend into a high-speed, 2-click POS flow (**Create Order ➔ Print Receipt**), plus optimized screens for Inventory stock checks and Customer suki pricing. The remaining back-office modules — **Personnel, Incoming Supplies, Tickets, and Audit Log** — keep their existing V1 UI unchanged and stay reachable via a "Back Office" drawer entry; V2 does not rework them.

### Non-Negotiable Boundaries (100% Mechanical Parity)
1. **Zero Database / Schema Breakage:** All existing PostgreSQL tables, migrations, and schema constraints remain untouched.
2. **Zero Backend API Breakage:** All existing Express routes (`/orders`, `/products`, `/customers`, etc.) remain identical.
3. **Untouched Native Hardware Logic:** Thermal Bluetooth/USB printing (`PrinterPlugin.java` / Capacitor) and camera barcode scanning remain untouched.
4. **One backend logic change, three coordinated edits (documented deviation):** stock now moves at order-save rather than dispatch — **deduct on finalize** (`draft` → `pending`), **restore on cancel** of a `pending` order, and **reconcile on item edits** of a `pending` order. No schema migration and no API route change. See §2.1.

---

## 2. Locked Business Rules & UI Mechanics

```mermaid
graph TD
    subgraph V1 Workflow (11 Steps / 3 Modals)
        A1[Open App] --> A2[Open Hamburger Menu]
        A2 --> A3[Select Outgoing Orders]
        A3 --> A4[Click New Order Modal]
        A4 --> A5[Search Customer in Combobox]
        A5 --> A6[Search & Add Products 1-by-1]
        A6 --> A7[Adjust Quantities]
        A7 --> A8[Click Create Order]
        A8 --> A9[Redirect to Order Details Page]
        A9 --> A10[Click Print Receipt]
        A10 --> A11[Confirm 2-Copy & Tag Modals]
    end

    subgraph V2 POS Workflow (2-3 Taps Total)
        B1[Open App: Direct POS Screen] --> B2[Select Customer or Default Walk-in]
        B2 --> B3[Tap Product Tiles / Repeat Last Order]
        B3 --> B4[Tap Save Order → Print Receipt]
    end
```

### 1. Simplified Order Lifecycle in UI
* **Two Primary States:**
  * **`📝 Draft`**: In-progress order, auto-saved as a backend `draft` (created on customer pick, debounced auto-save — V1 behavior), hidden from history until finalized.
  * **`✅ Created`**: Finalized order (persisted as `pending` under the hood in PostgreSQL).
* **Order Cancellation:** Handled via History popup or Amber Edit Mode (calls `POST /orders/:id/status` `{ status: 'cancelled' }` to restore inventory).
* Complex intermediary statuses (`in_transit`, `completed`, `done`) are **silenced entirely** — never surfaced anywhere in V2. V2 exposes only `Draft`, `Created`, and `Cancelled`, catering solely to the features the owners actually use.
* **`pending` is V2's terminal state:** every saved order stays `pending` (shown as Created) — V2 never advances orders. The only other states V2 writes are `draft` and `cancelled`; the silenced states (`in_transit`, `completed`, `done`) receive no new orders, and the ~1,300 pre-existing `pending` orders remain untouched.
* **Driver/helper assignment silenced:** V2 does not capture which driver/helper is on an order — in practice this is not tracked, so `order_personnel` is simply not written by V2.
* **Stock deduction on save (documented deviation):** stock deducts **when an order is finalized** (`draft` → `pending`, shown as Created) rather than at dispatch — the intended lifecycle's deduction point. This requires three coordinated backend edits: **deduct on finalize** (`draft` → `pending`), **restore on cancel** of a `pending` order, and **reconcile on item edits** of a `pending` order. Recorded so a future pass can revert to the intended timing. The ~1,300 pre-existing `pending` orders are a known backlog and are **not** retroactively processed; the new deduction applies only to orders saved from V2 onward.

### 2. Catalog & Category Matrix
* **3-Row Category Pills:** Accommodates ~12 production categories without excessive horizontal scrolling.
* **"All Categories" Default:** Replaced "Top Sellers" with a clean "All Categories" pill.
* **Clean Cards:** Removed icons from product cards to match V1 catalog clarity and conserve screen space.

### 3. Steppers & Quantity Adjustments
* **0.5-Case Steppers:** `−` and `+` buttons supporting `0.5` case increments.
* **Press-and-Hold Acceleration:** Long-pressing stepper buttons accelerates addition/subtraction.

### 4. Ticket, Pricing & Bottle Deposits
* **In-line Price per Case:** Direct `price /cs` edit on order lines.
* **Preemptive Bottle Deposit Calculation:** `w/ dep` vs `w/o dep` calculations are folded directly into line totals, subtotal, and total due for zero visual clutter. Deposit is **display-only** — charged in full at sale and folded into the shown/receipt total, while the stored `total_amount` stays goods-only (deposit folds in only at `done`, which V2 never reaches); bottle returns are handled manually, not tracked in-app.
* **Adjustment & Reason:** Discount / Suki adjustment field matching V1 math, requiring an adjustment reason when discount is applied.
* **Customer Selection:** Default search bar with blank input for quick auto-complete.

### 5. Amber Edit Mode
* Modifying an existing order transforms the tablet screen into a high-visibility **Amber theme** with an animated header badge, `💾 UPDATE ORDER (#ID)` primary action, `🚫 Cancel Order`, and `✕ Exit Edit Mode`.
* **Edit scope:** can change items, prices, adjustment, and notes — but **not** the customer or order type (the backend only accepts those while an order is still a draft). Wrong customer → cancel and rebuild. Known V2 limitation.

### 6. Thermal Print Flow
* **Zero-Prompt Printing (two taps):** **Save Order** locks the order, then **Print Receipt** prints a pre-configured 2-copy thermal output — no copy-count or tag confirmation dialogs.
* **Print Tracking:** Orders missing confirmed print receipts display a prominent `⚠️ NOT PRINTED` badge in History and top bar alerts.
* **Receipt width stays 80mm** — the project standard since June; gemini's prototype renders 58mm, which is stale.

### 7. Future Revert — "Ideal Horizon"

V2 deliberately deviates from the intended lifecycle to match how the owners actually work today. To return to the intended design later, revert each deviation (all additive/removable — no schema change):

1. **Deduct on save → deduct on dispatch.** V2 deducts when an order is finalized (`draft` → `pending`); the intended design deducts at `pending → in_transit` (delivery) or `pending → completed` (pickup).
2. **Restore on cancel.** V2 restores stock when a `pending` order is cancelled; intended restores only for dispatched orders.
3. **Reconcile on edit.** V2 reconciles stock when a `pending` order's items are edited; intended reconciles only for dispatched orders.
4. **Statuses.** V2 silences `in_transit`/`completed`/`done`; intended exposes the full lifecycle via the Review Deliveries queue.
5. **Deposit.** V2 shows deposit as display-only (charged in full at sale, stored total goods-only); intended folds deposit in at `done` on un-returned bottles with returns tracked.
6. **Driver/helper.** V2 does not capture `order_personnel`; intended tracks at most one driver per order.
7. **Backlog.** The ~1,300 (and growing) `pending` orders would need a one-time bulk pass through the intended lifecycle on revert.

---

## 3. Implementation Slices & Architecture

| Slice # | Slice Name | Scope Summary |
| :--- | :--- | :--- |
| **Slice 0** | **V2 Shell & Navigation** | Dark slate design tokens (`#020617` / `#0f172a`), tablet shell layout, streamlined 3-screen POS-first nav (POS, Inventory, Customers) **plus a "Back Office" drawer entry** exposing Personnel, Incoming Supplies, Tickets, and Audit Log — all four kept in their existing V1 UI, no V2 rework — without breaking underlying routes. |
| **Slice 1** | **POS, History & Receipt** | 0.5 tap/hold steppers, in-line price edit, blank customer search, 3-row category matrix, preemptive deposit totaling, 2-stage Save ➔ Print buffer, History popup with Edit/Reprint/Cancel, Amber Edit Mode. Voice AI excluded — ships in Slice 4. |
| **Slice 2** | **Inventory & Stock** | In-line price edits, `w/ dep` flags, product detail & audit drawer, batch price edit modal with audit reason, physical stock count sheet generator. Per-row `−1`/`+1` stock steppers removed. **Priority: batch price edit** — the owners rarely touch stock and mainly open Inventory to change prices (this is why V1 added batch update price). |
| **Slice 3** | **Customers & Suki Pricing** | Directory filters, slide-over profile drawer with 100% V1 fields, delivery vs pickup custom pricing matrix with live discount math, live sync with POS. Custom prices fetched fresh at line-add and re-applied when the customer or order type changes. |
| **Slice 4** | **Voice AI (OpenAI API)** | OpenAI API Key integration, configurable model (`gpt-4o-mini`/`gpt-4o`), Taglish voice parsing for POS, Inventory, and Customer Suki pricing. |
| **Slice 5** | **Android Sync & Verification** | Capacitor Android sync, production Gradle build, `Pixel_Tablet` emulator headed verification. |

### Build Order (recommended)

Dependency + value order; each step lands as one fully-serial PR before the next starts.

0. **Backend stock trio (prerequisite)** — deduct-on-finalize · restore-on-cancel · reconcile-on-edit, with unit tests. Lands first: the POS "Save Order" depends on it to deduct stock correctly from day one.
1. **Slice 0 — Shell & Nav** — dark tokens, tablet shell, 3-screen nav + Back Office drawer.
2. **Slice 1 — POS** — 2-tap Save→Print, customer search, product grid + 3-row category matrix, 0.5-case steppers, deposit display, history popup, Amber Edit. Highest value.
3. **Slice 2 — Inventory (price-first)** — batch price edit + in-line price edits first, then the stock tools (detail drawer, Physical Count).
4. **Slice 3 — Customers & Suki** — suki pricing matrix + live sync to POS.
5. **Slice 5 — Android build & verification** — headed-emulator verification on every slice; final production APK at the end.
6. **Slice 4 — Voice AI** — deferred, after the core is live and stable.

---

## 4. Component Structure (Client)

```
client/src/
├── pages/
│   ├── POSPage.jsx                 # Direct POS landing replacing old dashboard
│   ├── InventoryV2Page.jsx         # Price & stock management (batch price edit is the priority)
│   └── CustomersV2Page.jsx         # Suki customer profiles & custom rates
├── components/pos/
│   ├── POSProductGrid.jsx          # 3-row category matrix + product cards
│   ├── POSTicket.jsx               # Sticky ticket, steppers, deposit math, grand total
│   ├── POSHistoryModal.jsx         # Fast order history, reprint & amber edit entry
│   └── AmberEditHeader.jsx         # Visual header banner during order modification
└── hooks/
    ├── usePrintReceipt.js          # Direct zero-prompt 2-copy ESC/POS thermal printing
    └── useVoiceOrder.js            # Taglish voice parsing & structured JSON order mapping
```

---

## 5. Execution Protocol
* Developed incrementally slice-by-slice via Firstmate crewmates.
* Tested against tablet viewport (1200×1920 landscape, ~1024–1280px).
* Verified against production PostgreSQL schemas and Capacitor Android build.
