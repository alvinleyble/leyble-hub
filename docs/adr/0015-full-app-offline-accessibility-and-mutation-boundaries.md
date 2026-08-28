# Full-App Offline Accessibility and Mutation Boundaries

**Status:** Settled (2026-08-28)  
**Origin:** Captain decisions following the full-app offline accessibility audit (2026-08-28)  
**Supersedes:** Partially supersedes [ADR 0005: Offline Scope Determined by Operation Type Rather Than Module](0005-offline-scope-by-operation.md) (manual stock adjustments, batch price edits, local order status transitions, and customer profile edits) and refines [ADR 0007: Native Storage for Device State](0007-native-storage-for-device-state.md) (session credentials in native preferences, order snapshots with no age limit)  
**See also:** [Full-App Offline Accessibility Audit Report](/Users/lovzay/alvin-workspace/data/leyble-hub-full-offline-accessibility-audit/report.md), [docs/product/proposals/v2-5-offline-accessibility.md](../product/proposals/v2-5-offline-accessibility.md), [docs/product/proposals/v3-0-pos-order-creation-in-v1.md](../product/proposals/v3-0-pos-order-creation-in-v1.md), [ADR 0003](0003-device-issued-receipt-numbers.md), [ADR 0004](0004-local-first-pos.md), [ADR 0005](0005-offline-scope-by-operation.md), [ADR 0006](0006-receipt-number-as-idempotency-key.md), [ADR 0007](0007-native-storage-for-device-state.md), [ADR 0010](0010-receipt-number-addresses-order-across-sync-boundary.md), [ADR 0012](0012-stock-deducts-at-dispatch-not-at-save.md), [ADR 0013](0013-unswitched-offline-core-no-flag-rollback.md)

---

## Context

During a counter testing session in Antipolo, simulated and real network disconnects exposed that Leyble Hub's offline capability was confined to an isolated outbox for POS orders rather than an end-to-end offline architecture for the client as a whole. Operators faced cascading disruptions across screens:
1. **Cold-Launch Lockout:** Relaunching the app offline threw an unhandled `Failed to fetch` error during `/api/v1/auth/me`, kicking operators out to a broken login screen because session data was stored in volatile browser `localStorage` (which Android evicts) instead of native storage.
2. **Orders List Amnesia:** The Outgoing Orders directory rendered completely empty on offline launch, with an error toast `"Failed to load orders"`, erasing all visibility into past sales.
3. **White-Screen Crashes:** Navigating to an order detail view or opening product, customer, personnel, or delivery detail panels offline resulted in immediate unhandled React runtime crashes (`TypeError: Cannot read properties of undefined/null`) because components lacked defensive guards and cached orders lacked complete line item arrays.
4. **Order Creation Blocked:** Tapping `+ New Order` while offline yielded `"Failed to load form data"`. Products, customers, and personnel dropdowns failed to populate because `loadCatalogue()` had zero call sites in the order modal.

An exhaustive audit of every route and component was conducted (documented in [`/Users/lovzay/alvin-workspace/data/leyble-hub-full-offline-accessibility-audit/report.md`](/Users/lovzay/alvin-workspace/data/leyble-hub-full-offline-accessibility-audit/report.md)). Following that audit, the captain conducted a structured grill session to establish definitive, app-wide offline requirements.

Previously, [ADR 0005](0005-offline-scope-by-operation.md) partitioned operations strictly by whether an operation was an "additive create" or an "overwrite/reversal of shared state", placing manual stock adjustments, batch price edits, and all customer mutations beyond quick-creates strictly into the online-only category to prevent multi-device race conditions. The captain's grill session deliberately revised and narrowed that boundary to satisfy the operational reality of running a distributor during multi-day power outages in Antipolo.

---

## Decision

We are establishing **Full-App Offline Accessibility** across all modules and routes, governed by nine settled decisions:

### 1. Overall Scope: Whole-App Offline Accessibility Mandate
**Every screen and action in the application must work offline.** This is a hard architectural requirement, not an optional enhancement. Operators standing at the counter during prolonged power and network outages must be able to navigate every section of the application without white-screen crashes, unhandled fetch rejections, or blank screens. Deviations from offline capability require the specific, narrow exceptions defined below and no others.

### 2. First-Ever Login: The Sole Standing Exception
A brand-new tablet that has never once connected to the internet requires **exactly one online connection, one time**, to verify credentials and claim its unique station/register number (`POST /api/v1/stations/register` per [ADR 0003](0003-device-issued-receipt-numbers.md)).
- The instant after this registration succeeds — even seconds later — the device must function with zero network connection indefinitely.
- This is the single place where an online connection is strictly required: it prevents two tablets from minting conflicting receipt sequence spaces or colliding on the same station number.
- This requirement is never generalized to any other flow or recurring session check.

### 3. Session and Authentication Resilience
The authenticated user session (`{ id, email, full_name, role }`) and active profile must be persisted in native app storage (`@capacitor/preferences` under `v25.session`), **never** in WebView storage (`localStorage`/`IndexedDB`) which Android evicts under memory pressure ([ADR 0007](0007-native-storage-for-device-state.md)).
- **Automatic Silent Session Recovery:** On application launch or foregrounding, if the verification request (`GET /api/v1/auth/me`) fails due to a network error, `AuthContext` must automatically restore the authenticated user state from native storage without presenting any login prompt or error toast.
- **Offline Login Screen State:** If the app is launched completely unauthenticated while offline (e.g. after explicit manual logout), the login screen must detect offline status and display an informative notice: *"Offline — Connect to the internet to sign in for the first time."* rather than a raw `"Failed to fetch"` error. If prior station registration and profile data exist, a *"Resume Offline Session"* action is provided.

### 4. Order History & Detail Local Storage: Full Snapshots with No Age Limit
Every order the tablet has ever seen — whether created locally on this device or fetched from the server while online — is stored in full in native storage (`@capacitor/preferences` under `v25.receipt.<receipt_number>`), with **no age limit**.
- **Complete Entity Caching:** Cached orders must include full line items with `unit_deposit_fee`, returned bottle counts, customer references, assigned personnel (`order_personnel`), adjustment amounts, notes, and printing history. Summary-only caching is prohibited because it triggers runtime crashes in `OrderDetailPage.jsx` when computing bottle deposit and items subtotals.
- **No Age Limit & No Truncation:** This explicitly replaces the rolling 30-day window from V2.5 D9 and rejects arbitrary caps (e.g. "last 50 orders"). Any order from any historical date that has been loaded on the tablet must open completely offline.
- **Storage Feasibility:** Because `@capacitor/preferences` uses a per-key layout (`v25.receipt.<receipt_number>`), storing thousands of orders requires only single-digit megabytes, well within Android `SharedPreferences` limits without introducing a SQLite native plugin dependency.
- **Dual Identifier Resolution:** `getReceipt(identifier)` must resolve both device-issued receipt numbers (`1-00042`) and PostgreSQL integer primary keys (`1240`) via an internal index mapping, ensuring links from historical logs and notifications never hit dead ends offline.

### 5. Order Status Transitions for Unsynced Local Orders
An order created on this tablet that has **not yet synced** to the server may be transitioned through the fulfillment lifecycle (`pending → in_transit → completed`) while offline:
- **Zero Multi-Device Conflict Risk:** Because the order was created locally on this tablet during an outage, no other device in the store knows about it. Mutating its status updates the queued outbox payload locally before it drains to the cloud.
- **Synced Orders Require Online Connectivity:** The moment an order has successfully synced to the central database, it becomes visible to other tablets and affects central inventory accounting. At that point, status changes (dispatching, marking delivered, cancelling, or reopening) require an active online connection to prevent concurrent conflicting transitions across tablets ([ADR 0005](0005-offline-scope-by-operation.md), [ADR 0012](0012-stock-deducts-at-dispatch-not-at-save.md)).
- **Settlement & Bottle Returns:** Order settlement (`POST /orders/:id/close` to status `done`), which calculates returned bottle counts and reconciles deposit balances, remains online-only for synced orders to maintain central deposit ledger integrity.

### 6. Product Catalogue & Stock Mutations: Full Offline CRUD with Human Reconciliation
**The application supports full offline CRUD for products and inventory, including manual stock count corrections (`POST /api/v1/products/:id/adjust`) and batch price edits (`PATCH /api/v1/products/batch-price`).**
- **Accepted Operational Risk:** The captain explicitly accepted the business reality that two store tablets could independently correct the same product's stock count or modify prices while both operating offline during an outage, resulting in conflicting values upon reconnection.
- **Mandatory Human Conflict Reconciliation (No Silent Last-Write-Wins):** Stock discrepancies across tablets must **never** be resolved by silent last-write-wins (which discards physical count truth). When an outbox drain detects that a stock count was adjusted on both tablets during a disconnected window, the discrepancy must be surfaced in a prominent reconciliation view/modal where an operator reviews both inputs and confirms the true physical inventory count.
- **Supersedes ADR 0005 §2:** This explicitly supersedes ADR 0005's prior stance that manual stock adjustments and batch price edits must be strictly online-only.

### 7. Customer Mutations: Offline Profile Edits, Online-Only Merges & Deletions
- **Offline Profile Edits:** Editing existing customer contact details, delivery addresses, notes, and descriptive customer type tags (`PATCH /api/v1/customers/:id`) works offline, enqueued in native outbox storage and replayed upon reconnection.
- **Merges and Deletions Remain Strictly Online-Only:** Merging duplicate customer accounts (`POST /api/v1/customers/merge`) and deleting customers (`DELETE /api/v1/customers/:id`) remain strictly online-only, executed one at a time with clear explanatory tooltips when offline.
  - *Rationale:* Customer merges destructively re-parent complete order histories, unpaid bottle balances, and audit records. A concurrent or poorly synchronized merge across disconnected devices can cause unrecoverable relational corruption.
- **Additive Customer Operations (Unchanged):** Customer quick-creates (`POST /customers`) and custom price captures (`POST /customers/:id/prices`) remain 100% offline-capable via the outbox dependency pipeline (`$ref` resolution per [ADR 0005](0005-offline-scope-by-operation.md) and [ADR 0009](0009-custom-pricing-derived-from-saved-prices.md)).

### 8. Incoming Supplier Deliveries: Additive Offline Outbox Logging
Logging incoming supplier restock deliveries (`POST /api/v1/incoming`) works fully offline:
- **Additive and Conflict-Free:** As established in ADR 0005 §1, logging a delivery truck is mathematically additive — it appends an independent delivery header and items, and increases inventory. Concurrent blind delivery entries merge additively upon sync without conflicts.
- **Delivery Receipt Numbering:** Deliveries logged offline are assigned device-issued identifiers (`<station>-DEL-<sequence>`) and queued in the outbox, adopting the same idempotency mechanism as order creation ([ADR 0006](0006-receipt-number-as-idempotency-key.md)).
- **Delivery Voids Online-Only:** Voiding a delivery (`POST /incoming/:id/void`) reverses stock movements and soft-deletes a shared record; it remains strictly online-only.

### 9. Back-Office Screens: Quiet Local Cache & Read-Only Degradation
Administrative back-office screens (**Dashboard, Personnel, Tickets, Audit Log**) are fully accessible and viewable offline in a graceful, read-only degraded mode:
- **Quiet Reference Caching:** When online, the client silently caches reference data in native storage (`v25.cache.dashboard`, `v25.cache.personnel`, `v25.cache.tickets`). Personnel data is also cached in `v25.catalogue.personnel` to ensure driver and helper comboboxes in `OrderCreateModal` function offline.
- **Calm Offline Indicator:** When disconnected, these views render from local cache with a calm amber banner: *"Viewing offline data · Changes sync when connected."*
- **Shared Mutations Gated Online:** Actions that mutate shared operational records — resolving or deleting a deposit ticket (`PATCH /tickets/:id/resolve`, `DELETE /tickets/:id`), deactivating personnel, or updating staff profiles — are cleanly disabled offline with explicit explanatory badges, matching the safety model of customer merges and delivery voids.

---

## Comparison: What Changed from Prior ADRs

| Operation / Area | ADR 0005 / Prior Baseline | Settled ADR 0015 Decision | Rationale |
| :--- | :--- | :--- | :--- |
| **App Scope** | POS-only outbox; back-office screens error/crash offline | **Whole app accessible offline** across all routes and screens | Store owners in Antipolo operate the entire business during multi-day outages. |
| **First Login** | Unspecified; cold launch crashed with "Failed to fetch" | **Single online connection required once** to claim station ID | Prevents station number collisions; device operates offline forever after. |
| **Auth Session** | Session in `localStorage`; evicted on native Android | **Persisted in native preferences (`v25.session`)** | Network failure during `/auth/me` silently restores session; zero prompt. |
| **Order History** | Rolling 30-day cache; summary-only rows caused crashes | **Complete line-item snapshots; no age limit** | Any past order opens offline; eliminates white-screen crashes on detail views. |
| **Order Status** | Online-only for all status transitions | **Unsynced local orders can transition offline** | Local unsynced orders have zero multi-device conflict risk before sync. |
| **Stock Adjustments** | Strictly online-only (ADR 0005 §2) | **Full offline CRUD with human reconciliation** | Physical stock count corrections must not be blocked during prolonged outages. |
| **Batch Price Edits** | Strictly online-only (ADR 0005 §2) | **Full offline CRUD with human reconciliation** | Price edits allowed offline; conflicts flagged for human review upon sync. |
| **Customer Edits** | Quick-creates offline; profile edits online-only | **Profile edits queue offline; merges/deletes online-only** | Editing contact info is safe; destructive merges require server validation. |
| **Back Office** | Uncached; threw unstyled "Failed to fetch" errors | **Read-only cached view with calm offline banner** | Owners can inspect metrics, tickets, staff, and audit trails without crashes. |

---

## Considered Options

### Stock Adjustments & Catalogue Mutations
- **Option A: Full Offline CRUD with Human Conflict Reconciliation (Chosen)** — Allows operators to record stock count corrections and price edits immediately while doing physical floor counts, even during multi-day blackouts. Instead of risky silent last-write-wins, discrepancies between tablets are flagged for explicit human confirmation upon reconnect.
- **Option B: Strictly Online-Only Stock Adjustments (ADR 0005 §2, Superseded)** — Blocked stock adjustments offline to protect central database accuracy. Rejected because it paralyzed store operations during multi-day blackouts where physical inventory had to be updated on counter tablets.
- **Option C: Silent Last-Write-Wins (Rejected)** — Overwriting conflicting stock adjustments based on arrival timestamp. Rejected outright because physical stock counts on one tablet could silently obliterate valid counts from another without operator awareness.

### Local Order Retention
- **Option A: Complete Entity Storage with No Age Limit (Chosen)** — Stores full order snapshots (header, line items, deposit fees, personnel) per key in native storage. Any historical order ever seen by the tablet opens offline without network requests or React runtime crashes.
- **Option B: Rolling 30-Day Window (V2.5 D9, Superseded)** — Pruned orders older than 30 days. Rejected because searching or opening orders from previous months during an outage caused empty screens and operator confusion.
- **Option C: Heavyweight Embedded Database / SQLite (Rejected)** — Introducing `@capacitor-community/sqlite`. Rejected as unnecessary overhead: per-key native key-value storage (`@capacitor/preferences`) comfortably handles thousands of order JSON objects without native plugin churn.

### Customer Mutation Boundaries
- **Option A: Offline Profile Edits + Online-Only Merges & Deletions (Chosen)** — Safely allows editing phone numbers, notes, and addresses offline via outbox queues, while locking destructive account merges and deletions to online connectivity.
- **Option B: Full Offline Customer CRUD including Merges (Rejected)** — Permitting offline merges with client-side relational graph reconciliation. Rejected as excessively complex and dangerous; a flawed offline merge destroys distinct order histories permanently.
- **Option C: Strictly Online-Only Customer Edits (ADR 0005 §2, Superseded)** — Blocked all customer edits offline except quick-creates. Rejected because operators frequently need to update delivery notes and phone numbers while offline.

---

## Downstream Delivery Slices

This ADR serves as the authoritative specification for the four queued delivery tasks:

1. **Slice 3.1: Core Auth Resilience & Defensive UI Hardening (`leyble-hub-offline-slice-3-1-auth-resilience`)**
   - Native session persistence (`v25.session`) in `AuthContext.jsx`.
   - Automatic zero-prompt session recovery on network errors during `/auth/me`.
   - Friendly offline notice and session resume on `LoginPage.jsx`.
   - Defensive null/undefined guards across `ProductDetailPanel`, `CustomerDetailPanel`, `PersonnelDetailPanel`, and `DeliveryDetailPanel` to eliminate white-screen crashes.

2. **Slice 3.2: Counter POS & Order Creation Full Offline Parity (`leyble-hub-offline-slice-3-2-counter-pos-orders`)**
   - Wire `loadCatalogue()` to `OrderCreateModal.jsx` (products, customers, prices).
   - Cache personnel in native storage (`v25.catalogue.personnel`) for driver/helper assignments.
   - Wire customer directory creation modal (`CustomerFormModal.jsx`) to offline outbox.
   - Verify 100% offline order creation, price capture, and thermal ESC/POS printing.

3. **Slice 3.3: Orders Directory & Order Detail Complete Caching (`leyble-hub-offline-slice-3-3-orders-directory`)**
   - Fall back `OrdersPage.jsx` to complete local receipt cache with no age limit.
   - Store full line-item snapshots in `putReceipt()` on save and on server fetch.
   - Dual-key lookup index (`order_id -> receipt_number`) in `getReceipt()`.
   - Support offline status progression (`pending → in_transit → completed`) for unsynced local orders.

4. **Slice 3.4: Back-Office Graceful Degradation, Stock Mutations & Release 2 Supplies (`leyble-hub-offline-slice-3-4-backoffice-and-stock`)**
   - Full offline CRUD for products, stock adjustments, and batch price edits.
   - Multi-device stock conflict flagging and human reconciliation view.
   - Customer profile editing offline via outbox; online gating for merges and deletions.
   - Graceful read-only fallback and calm offline banners for Dashboard, Personnel, Tickets, and Audit Log.
   - Release 2: Offline logging of incoming supplier deliveries (`POST /incoming`) via outbox.
