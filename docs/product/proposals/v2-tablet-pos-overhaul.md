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
  * **`📝 Draft`**: In-progress order, auto-saved as a backend `draft` (created on customer pick, debounced auto-save — V1 behavior), hidden from history until finalized — reachable (and resumable) via the top bar's **Drafts** popup, added 2026-08-20.
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
* **No deposit anywhere in V2 — goods-only totals.** ⚠️ **CORRECTED 2026-08-20 (captain decision, mid-Slice-1) — this reverses the original "Preemptive Bottle Deposit Calculation" rule locked in this section.** Line totals, the `Items` subtotal, the total due and the printed receipt are all **goods-only** (`quantity × price /cs`, plus the adjustment). Nothing deposit-derived is calculated or displayed on the POS screens, and a deposit-bearing product looks identical to one without: no `w/ dep` / `w/o dep` tag, badge or breakdown.
  * **Why:** V1 treats every bottle as returned until an order is explicitly closed and the returns are counted, so deposit is effectively zero before that step. §2.1 makes `pending` V2's terminal state — V2 **never advances an order**, so it never reaches `completed`/`done` where a deposit would become real. Charging or showing a preemptive deposit would bill customers for bottles the system will never mark returned.
  * **Unchanged below the UI:** order lines still carry `unit_deposit_fee` to the backend, `order_items.line_total` keeps its generated-column formula, and `orders.total_amount` stays goods-only exactly as `recomputeTotal` writes it. Those matter at V1's closing step and are untouched.
  * ~~Original rule (superseded): `w/ dep` vs `w/o dep` folded into line totals, subtotal and total due; deposit display-only, charged in full at sale.~~
* **Adjustment & Reason:** Discount / Suki adjustment field matching V1 math, requiring an adjustment reason when discount is applied.
* **Customer Selection:** Default search bar with blank input for quick auto-complete.

### 5. Amber Edit Mode
* Modifying an existing order transforms the tablet screen into a high-visibility **Amber theme** with an animated header badge, `💾 UPDATE ORDER (#ID)` primary action, `🚫 Cancel Order`, and `✕ Exit Edit Mode`.
* **Edit scope:** can change items, prices, adjustment, and notes — but **not** the customer or order type (the backend only accepts those while an order is still a draft). Wrong customer → cancel and rebuild. Known V2 limitation.

### 6. Thermal Print Flow
* **Zero-Prompt Printing (two taps):** **Save Order** locks the order, then **Print Receipt** prints a pre-configured 2-copy thermal output — no copy-count or tag confirmation dialogs.
* **Print Tracking:** Orders missing confirmed print receipts display a prominent `NOT PRINTED` badge on their row in History, plus a "today, not printed only" filter there. **Corrected 2026-08-20 (captain decision, round 4):** the ~~top-bar summary alert~~ was redundant with those per-order badges and is **removed**; its spot in the top bar now holds a **Drafts** button opening a Drafts popup (see §2.1 — drafts are hidden from History, so this is where an unfinished order is found and resumed). The not-printed count is back as a **badge on the History button** (today-scoped, same set as that filter), and History can **mark the whole filtered batch as printed** in one action when the receipts were printed but never tagged (added 2026-08-20, round 5).
* **Receipt width stays 80mm** — the project standard since June; gemini's prototype renders 58mm, which is stale.

### 7. Future Revert — "Ideal Horizon"

V2 deliberately deviates from the intended lifecycle to match how the owners actually work today. To return to the intended design later, revert each deviation (all additive/removable — no schema change):

1. **Deduct on save → deduct on dispatch.** V2 deducts when an order is finalized (`draft` → `pending`); the intended design deducts at `pending → in_transit` (delivery) or `pending → completed` (pickup).
2. **Restore on cancel.** V2 restores stock when a `pending` order is cancelled; intended restores only for dispatched orders.
3. **Reconcile on edit.** V2 reconciles stock when a `pending` order's items are edited; intended reconciles only for dispatched orders.
4. **Statuses.** V2 silences `in_transit`/`completed`/`done`; intended exposes the full lifecycle via the Review Deliveries queue.
5. **Deposit.** V2 shows **no deposit at all** — every POS figure and the printed receipt are goods-only; intended folds deposit in at `done` on un-returned bottles with returns tracked.
   > **Correction, 2026-08-20 (explicit captain decision, mid-Slice-1).** This supersedes the original §2.4 "Preemptive Bottle Deposit Calculation" language — which had V2 charging the deposit in full at sale and folding it into the shown/receipt total — and is a **reversal of a locked decision**, not an implementation detail. The reversal is UI-only: `unit_deposit_fee`, `line_total` and `recomputeTotal` are untouched, so returning to the intended design still only takes re-enabling the closing step.
6. **Driver/helper.** V2 does not capture `order_personnel`; intended tracks at most one driver per order.
7. **Backlog.** The ~1,300 (and growing) `pending` orders would need a one-time bulk pass through the intended lifecycle on revert.

---

## 3. Implementation Slices & Architecture

| Slice # | Status | Slice Name | Scope Summary |
| :--- | :--- | :--- | :--- |
| **V2.0 Slice 0** | ✅ **Done** | **V2 Shell & Navigation** | Dark slate design tokens (`#020617` / `#0f172a`), tablet shell layout, streamlined 3-screen POS-first nav (POS, Inventory, Customers) **plus a "Back Office" drawer entry** exposing Personnel, Incoming Supplies, Tickets, and Audit Log — all four kept in their existing V1 UI, no V2 rework — without breaking underlying routes. |
| **V2.0 Slice 1** | ✅ **Done** | **POS, History & Receipt** | 0.5 tap/hold steppers, in-line price edit, blank customer search, 3-row category matrix, preemptive deposit totaling, 2-stage Save ➔ Print buffer, History popup with Edit/Reprint/Cancel, Amber Edit Mode. |
| **V2.0 Slice 2** | ✅ **Done** | **Inventory & Stock** | In-line price edits, `w/ dep` flags, product detail & audit drawer, batch price edit modal with audit reason, physical stock count sheet generator. Per-row `−1`/`+1` stock steppers removed. **Priority: batch price edit** — the owners rarely touch stock and mainly open Inventory to change prices (this is why V1 added batch update price). |
| **V2.0 Slice 3** | ✅ **Done** | **Customers & Suki Pricing** | Directory filters, slide-over profile drawer with 100% V1 fields, delivery vs pickup custom pricing matrix with live discount math, live sync with POS, and "Save custom price?" prompt. |
| **V2.0 Slice 6** | ✅ **Done** | **Coca-Cola Color Palette Overhaul** | Overhauled V2 theme tokens (`tailwind.config.js`) to the iconic Coca-Cola beverage distributor palette: Coca-Cola Red primary branding (`#F40009` / `#E41E2B`), deep carbonated charcoal surfaces (`#0F0F10`, `#1A1A1C`, `#262629`), crisp white text, high-contrast focus rings, and matching POS/Inventory/Customer CTAs. |
| **V2.0 Slice 7** | ✅ **Done** | **Pre-Print Order Review Modal & Edit ⇄ Review Loop** | Large high-contrast tablet order review modal (`POSReviewModal.jsx`) before thermal printing, itemized bill breakdown with case counts, suki custom pricing badges, goods total & adjustments, and a frictionless Edit ⇄ Review loop allowing operators to jump seamlessly between modifying items and reviewing order totals. |
| **V2.0 Slice 5** | ⬜ Not started | **Android Sync & Dual-App Verification** | Capacitor Android sync, `com.leyble.hub.pos` dual-app ID configuration, production Gradle build, `Pixel_Tablet` emulator headed verification. Concluding slice of V2.0. |
| **V2.5 Slice 1** | ⏳ **Queued (Grill)** | **Offline Accessibility** | Offline order creation, local IndexedDB/SQLite cache, background reconnect sync, and conflict resolution policies. |
| **V3.0 Slice 1** | ⏳ **Queued** | **Voice AI (OpenAI API)** | OpenAI Taglish voice parsing for POS, Inventory, and Customer Suki pricing (re-allocated from earlier V2 draft). |

### Slice 1 — what shipped

Landed on `dev` as a frontend-only change: no migrations, no route or payload-shape
changes. The screen is `client/src/pages/pos/POSPage.jsx` with its parts under
`client/src/components/pos/`.

| Locked rule | Where it lives |
| :--- | :--- |
| 3-row category matrix + "All Categories", icon-free cards (§2.2) | `POSProductGrid.jsx` — cards show name, category and price/cs only |
| Blank customer search bar, punctuation-insensitive (§2.4) | `POSCustomerSearch.jsx` + `client/src/utils/customerSearch.js` |
| 0.5-case steppers with press-and-hold (§2.3) | `CaseStepper.jsx` on the order lines and the product cards themselves (shared `useHoldRepeat`) — a card tap adds 0.5 case |
| In-line `price /cs`, adjustment + required reason (§2.4) | `POSOrderPanel.jsx` |
| ~~Preemptive deposit totalling~~ → **goods-only totals** (§2.4, corrected 2026-08-20) | `posMath.js` — no deposit is calculated or shown anywhere in the POS; the receipt prints goods-only too. `unit_deposit_fee` / `line_total` / `total_amount` untouched |
| 2-stage Save → Print, zero prompts, 2 copies (§2.6) | `POSPage.jsx` + `usePrintReceipt(…, { copies: 2, autoTag: true })` |
| `NOT PRINTED` badges (§2.6) + Drafts popup (§2.1) | `POSHistoryModal.jsx` (per-order badge + "today, not printed only" filter) and `POSDraftsModal.jsx` behind the top bar's **Drafts** button — the top-bar summary alert was removed as redundant (corrected 2026-08-20). Both popups share `POSListModal.jsx`. Each top-bar button carries a count badge (parked drafts / today's not-printed), and History has a bulk "mark all as printed" for the filtered batch |
| Draft / Created / Cancelled only (§2.1) | History fetches `status=pending` + `status=cancelled` and Drafts fetches `status=draft` — the silenced statuses are never requested. Resuming a draft keeps its id, so saving finalizes that same order |
| Amber Edit Mode (§2.5) | `AmberEditHeader.jsx` + edit mode in `POSPage.jsx` |

Two additive hooks into shared V1 code (V1 behaviour unchanged):

- `usePrintReceipt(order, returnCounts, onTagged, overrides, options)` — `options.copies`
  prints a fixed number of copies with no "print twice?" gate, `options.autoTag` records
  the print without the confirm prompt. V1 callers pass neither and keep both prompts.
- `generateReceiptHtml` / `generateEscPos` accept `overrides.showDeposit`, which forces the
  deposit onto a `pending` receipt. The POS passes it so the printed total matches the
  screen; V1 receipts still only show the deposit at `completed`/`done`.

Known limitation, accepted: the customer and order type cannot be changed in Amber Edit
Mode (the backend accepts those on a draft only) — wrong customer means cancel and rebuild.

Screen copy calls these **orders**, never "tickets" — the business does not use that word.

**Reversal on record:** the preemptive bottle-deposit rule locked in §2.4 was corrected to
goods-only totals on 2026-08-20 by captain decision, mid-Slice-1. See §2.4 and §7 item 5.

### Slice 2 — what shipped

Landed on `dev` as a frontend-only change plus zero new backend routes — every capability
below already existed on `server/src/routes/products.js` from V1 (batch-price, PATCH with
audit, GET with `audit_log`) and is reused as-is. The screen is
[client/src/pages/inventory/InventoryV2Page.jsx](client/src/pages/inventory/InventoryV2Page.jsx)
plus `client/src/components/inventory/`.

| Locked rule | Where it lives |
| :--- | :--- |
| Batch price edit, **required** audit reason (§3 priority item) | `InventoryBatchPriceModal.jsx` — same uniform/individual math as V1's `BatchPriceEditModal.jsx`, but Save is disabled until a reason is typed (V1's `PATCH /products/batch-price` already accepted a reason; V2 just makes it non-optional client-side, so the V1 screen's optional-reason behaviour is unchanged) |
| In-line price edit | `InlinePriceCell` in `InventoryV2Page.jsx` — editable cell right in the table row, commits via `PATCH /products/:id` on blur, reverts on failure |
| `w/ dep` flag, visible + toggleable per product | `DepositToggle` in `InventoryV2Page.jsx` — a row-level pill (`w/ dep ₱X.XX` / `w/o dep`) that flips `requires_bottle_return` directly; the deposit **amount** is still edited in the detail drawer (toggling on defaults to whatever `deposit_fee` was last, incl. 0) |
| Product detail & audit drawer | `ProductDetailDrawer.jsx` — slide-over (same `fixed right-0 h-full` shape as V1's `ProductDetailPanel.jsx`), an "Adjust Stock & Audit" control with a **required** reason, a "Recent Stock Movements" log (last 50 from `inventory_audit_logs`, unchanged query), and Danger Zone delete |
| Physical stock count sheet generator | `productCountSheetHtml` / `productCountSheetEscPos` (new exports in `client/src/pages/shared/listPrintTemplate.js` / `listEscPos.js`), wired through the existing `usePrintList` hook — blank `Counted: ________` line per item plus signature lines, distinct from the price-list `productListHtml`/`productListEscPos` V1 already had |
| No per-row `−1`/`+1` steppers | Not present anywhere in `InventoryV2Page.jsx` — stock only moves through the drawer's Adjust Stock & Audit control |

No backend changes were needed for this slice: `PATCH /products/:id` (single-field price/
deposit/stock edits, all audit-logged), `PATCH /products/batch-price` (bulk price + reason)
and `GET /products/:id` (audit_log) already covered every Slice 2 requirement.

### Slice 3 — what shipped

Landed on `dev` as a frontend-only change plus zero new backend routes — every endpoint
on `server/src/routes/customers.js` (list, create, edit with conversion note, prices GET/POST,
and delete) is reused as-is. The screen is
[client/src/pages/customers/CustomersV2Page.jsx](client/src/pages/customers/CustomersV2Page.jsx)
with components under `client/src/components/customers/` and `client/src/components/pos/`.

| Locked rule | Where it lives |
| :--- | :--- |
| Fast tablet directory with search & filter pills | `CustomersV2Page.jsx` — instant filter on name/phone/address, `All` / `Wholesalers` / `Regular` pills, and `Show inactive` checkbox |
| 80mm Customer List Print | `CustomersV2Page.jsx` + `usePrintList` reusing `customerListHtml` / `customerListEscPos` |
| Add Customer modal | `CustomerCreateModal.jsx` — dark-themed tablet modal for rapid customer entry |
| Slide-over profile & Suki pricing drawer | `CustomerDetailDrawer.jsx` — 100% of V1 fields, dark tokens, active toggle, Danger Zone delete with order-history safety check |
| Delivery vs Pickup custom pricing matrix | `CustomerDetailDrawer.jsx` — channel tabs (`🚚 Delivery` vs `🏪 Pickup`), quick add/edit custom price per case, and live delta comparison against standard base wholesale price (`-₱X.XX / -Y% discount`) |
| Live Suki pricing sync with POS | `POSPage.jsx` — automatic price recomputation on customer select, line item add, or order type toggle (`delivery` ↔ `pickup`) |
| "Save custom price?" prompt on order submit | `POSSavePriceModal.jsx` + `POSPage.jsx` — hand-edited lines detected at submit; 2-step prompt for regular customers (convert to wholesaler + save rates) and 1-step prompt for wholesalers, non-blocking on dismissal (matches `save-custom-price-prompt.md`) |

### Slice 6 — what shipped

Landed as a token-only change to [client/tailwind.config.js](../../../client/tailwind.config.js) — no
component markup was restructured. Every V2 screen and popup already composed its styling from the
semantic `v2-*` classes (`bg-v2-bg`, `text-v2-accent`, `bg-v2-accent-strong`, …), so retinting the
seven tokens repainted the shell, POS, Inventory, and Customers screens in one pass.

| Locked rule | Where it lives |
| :--- | :--- |
| Coca-Cola red / carbonated-charcoal tokens (`bg`, `surface`, `raised`, `border`, `text`, `muted`, `accent`, `accent-strong`) | `client/tailwind.config.js` `theme.extend.colors.v2` |
| Off-palette hardcoded colors folded into the token system | `placeholder:text-slate-500` → `placeholder:text-v2-muted` and CTA `hover:bg-sky-500` → `hover:bg-v2-accent` across every V2 modal/drawer/page that still had them (customers, inventory, POS components) |
| Prominent Coke-red primary CTAs | `POSOrderPanel.jsx` — **Save Order** was hardcoded `bg-emerald-600`; recolored to `bg-v2-accent-strong` / `hover:bg-v2-accent` to match **Print Receipt**, per the "prominent Coke Red Save Order / Print Receipt" requirement |
| Preserved functional indicators (untouched) | Amber Edit Mode (`AmberEditHeader.jsx`) keeps its animated `amber-*` classes; printed/active status badges keep `emerald-*`; stock-level and order-status pills (`Low Stock`, `Cancelled`, `Created`, etc.) keep their existing semantic colors — none of these consume `v2-*` tokens, so the retheme did not touch them |

No backend changes, no new routes. `client/src/index.css`'s `.v2-root *:focus-visible` rule already
referenced `ring-v2-accent` / `ring-offset-v2-bg`, so the focus ring re-tints automatically with the
new token values — it needed no edit.

### Slice 7 — what shipped

Landed on `dev` as a frontend-only addition (`POSReviewModal.jsx`) and POS lifecycle integration
in `POSPage.jsx` and `POSOrderPanel.jsx`. Provides a full-screen/wide, high-contrast review modal
before thermal receipt printing, eliminating scrolling friction on tablets and establishing a
seamless Edit ⇄ Review loop.

| Locked rule | Where it lives |
| :--- | :--- |
| Pre-Print Order Review Modal | `POSReviewModal.jsx` — tablet-optimized centered modal (~800–1000px wide, high contrast) opening automatically upon saving an order |
| Itemized Bill Breakdown | `POSReviewModal.jsx` — large-typography table displaying case quantities (`2.0 cs`, `0.5 cs`), product name & SKU/unit packaging, price per case with custom **Suki Price** badge when custom pricing is active, and line totals. Fits 8–12 items cleanly without scrolling |
| Totals & Suki Adjustment Footer | `POSReviewModal.jsx` — displays total case count, goods subtotal, discount/suki adjustment row with reason, and grand total in prominent `3xl/4xl font-black` typography |
| Seamless Edit ⇄ Review Loop | `POSPage.jsx` — tapping **Edit Items / Back** transitions directly into Amber Edit mode with all lines and customer state intact; tapping **Update Order** refreshes and re-opens the review modal with updated totals |
| 52px+ Tactile Action Buttons | `POSReviewModal.jsx` — **Print Receipt (2 Copies)** (primary CTA Coke Red), **Edit Items / Back** (secondary CTA), and **New Order / Skip Print** |
| Saved Mode Panel Review & Edit Triggers | `POSOrderPanel.jsx` — added `📝 Review Order` and `✏️ Edit Order` buttons in saved mode so operators can easily re-enter review or edit mode at any time |
| Save Custom Price Coordination | `POSSavePriceModal.jsx` (`z-[60]`) overlays cleanly on top of `POSReviewModal` (`z-50`) when dirty prices are detected at submit |

### Build Order & Release Roadmap

Dependency + value order; each step lands as one fully-serial PR before the next starts.

#### **V2.0 — Tablet POS Overhaul (Active)**
0. **Backend stock trio (prerequisite)** — ✅ Done (PR #1).
1. **Slice 0 — Shell & Nav** — ✅ Done (PR #2).
2. **Slice 1 — POS, History & Receipt** — ✅ Done (PR #3).
3. **Slice 2 — Inventory & Stock** — ✅ Done (PR #4).
4. **Slice 3 — Customers & Suki Pricing** — ✅ Done (PR #5).
5. **Slice 6 — Coca-Cola Color Palette Overhaul** — ✅ Done (PR #6).
6. **Slice 7 — Pre-Print Order Review Modal & Edit ⇄ Review Loop** — ✅ Done (PR #7). Large high-contrast review modal before printing, itemized breakdown with case counts & suki badges, goods totals, and seamless POS Edit ⇄ Review loop.
7. **Slice 5 — Android Build & Dual-App Verification** — ⬜ Next up (Concluding slice of V2.0: Capacitor sync, `com.leyble.hub.pos` profile, Gradle build, emulator pass, final V2.0 production APK).

---

#### **Future Releases on Roadmap**
* **V2.5 (Offline Operations):**
  * **Slice 1 — Offline Accessibility (Queued for Grilling):** Local storage / IndexedDB offline caching, offline order creation on POS, background synchronization upon network reconnection, and conflict resolution rules during store internet drops.
* **V3.0 (AI-Powered Operations):**
  * **Slice 1 — Voice AI (Taglish Parsing):** OpenAI API integration for Taglish voice order creation and catalog queries across POS, Inventory, and Customers.

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
│   ├── POSOrderPanel.jsx           # Sticky order panel, steppers, goods-only totals
│   ├── POSReviewModal.jsx          # High-contrast pre-print review modal & edit loop
│   ├── POSHistoryModal.jsx         # Fast order history, reprint & amber edit entry
│   ├── POSDraftsModal.jsx          # Parked drafts, resume back onto the POS
│   ├── POSListModal.jsx            # Shared popup shell + row styling for both lists
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

---

## 6. Deployment Strategy: Single Batched Cutover

* **`dev`-only PR landing:** All slices (the backend stock trio prerequisite plus Slices 0–3 and 5; Slice 4 Voice AI remains deferred) merge exclusively into `dev`. There is **no intermediate `dev` → `main` promotion** after individual slices.
* **Single `main` merge:** `main` (which auto-deploys to Render production) is merged exactly once, only after the entire V2 build is complete and verified in `dev`.
* **Back-to-back APK rollout:** The single merge to `main` happens back-to-back with rebuilding and sideloading the new Android APK on the owners' tablets/phones — zero time gap between the cloud backend going live and the matching UI reaching their devices.
* **Rationale:**
  * Production is a single cloud environment with no staging; the owners cannot realistically be asked to reinstall the APK multiple times across slice iterations.
  * The backend stock trio timing change (deduct on finalize) is a pure backend change not gated behind a V2 UI flag. Merging it to `main` early would immediately alter stock deduction behavior in the live V1 app before the V2 POS interface is deployed. All commits must remain on `dev` until the full batched V2 cutover.

---

## 7. Dual-App Coexistence & Android Package Identity (Locked 2026-08-20)

* **Coexistence Model:** V1 and V2 co-exist concurrently on user devices as two independent Android applications connecting to the exact same backend API and PostgreSQL database. See [ADR 0002](../../adr/0002-v1-v2-dual-app-coexistence.md).
* **Package Profiles:**
  * **V1 App ("Leyble Hub Classic"):** `appId: com.leyble.hub`, `appName: "Leyble Hub"`, landing on `/dashboard`. Retains all V1 back-office modules and desktop flows.
  * **V2 App ("Leyble Hub POS"):** `appId: com.leyble.hub.pos`, `appName: "Leyble Hub POS"`, landing on `/v2/pos`. Fast 2-tap POS, Price/Stock management, and Suki customer profiles.
* **Shared Real-Time State:**
  * All database records are unified. Orders saved in V2 POS immediately deduct inventory stock and appear in V1 order history and audit logs.
  * Suki custom pricing configured in either version applies across both apps.
* **Slice 5 Scope:** Slice 5 will configure the Capacitor build artifacts for `com.leyble.hub.pos` so installing the V2 APK installs cleanly alongside V1 on the Honor Pad X8B tablet without overwriting the existing installation.
