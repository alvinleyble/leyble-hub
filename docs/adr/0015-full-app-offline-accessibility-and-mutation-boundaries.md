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

An exhaustive audit of every route and component was conducted (documented in [`/Users/lovzay/alvin-workspace/data/leyble-hub-full-offline-accessibility-audit/report.md`](/Users/lovzay/alvin-workspace/data/leyble-hub-full-offline-accessibility-audit/report.md)). Following that audit, the captain conducted a structured grill session to establish definitive, app-wide offline requirements. The concrete acceptance criteria this ADR is tested against — including 7 follow-up decisions settled 2026-08-28 after a second coverage audit — are captured separately in [docs/offline-accessibility-acceptance-criteria.md](../offline-accessibility-acceptance-criteria.md).

Previously, [ADR 0005](0005-offline-scope-by-operation.md) partitioned operations strictly by whether an operation was an "additive create" or an "overwrite/reversal of shared state", placing manual stock adjustments, batch price edits, and all customer mutations beyond quick-creates strictly into the online-only category to prevent multi-device race conditions. The captain's grill session deliberately revised and narrowed that boundary to satisfy the operational reality of running a distributor during multi-day power outages in Antipolo.

---

## Decision

We are establishing **Full-App Offline Accessibility** across all modules and routes, governed by nine settled decisions:

### 1. Overall Scope: Whole-App Offline Accessibility Mandate
**Every screen and action in the application must work offline.** This is a hard architectural requirement, not an optional enhancement. Operators standing at the counter during prolonged power and network outages must be able to navigate every section of the application without white-screen crashes, unhandled fetch rejections, or blank screens. Deviations from offline capability require the specific, narrow exceptions defined below and no others.

#### Alternatives Considered / Rejected
- **Option A: Full-App Offline Accessibility Across All Screens and Modules (Chosen)** — Every screen and action must work offline unless explicitly identified as an unrecoverable multi-tablet conflict hazard (destructive merges/deletions, first login). Back-office views degrade gracefully to cached data with calm banners.
- **Option B: POS-Only Local-First Core (ADR 0005 Original Scope, Rejected)** — Confining offline support exclusively to the counter POS (`/orders/new`) and quick-create customer mid-order, treating all other routes as online-only web views. *Why rejected:* In actual field conditions during Antipolo blackouts, store owners operate the entire business from tablets. Restricting offline support to POS alone caused white-screen crashes, blank tables, and operational lockouts when owners navigated to order history, inventory, or staff lists.
- **Option C: Selective Route Gates with "Offline Notice" Walls (Rejected)** — Intercepting non-POS routes with full-page modal gate cards explaining that the page requires internet. *Why rejected:* The owners need to read reference data (e.g. past orders, pricing lists, customer phone numbers, open deposit tickets) while disconnected. Locking them out of screens entirely paralyzes store operations.

### 2. First-Ever Login: The Sole Standing Exception
A brand-new tablet that has never once connected to the internet requires **exactly one online connection, one time**, to verify credentials and claim its unique station/register number (`POST /api/v1/stations/register` per [ADR 0003](0003-device-issued-receipt-numbers.md)).
- The instant after this registration succeeds — even seconds later — the device must function with zero network connection indefinitely.
- This is the single place where an online connection is strictly required: it prevents two tablets from minting conflicting receipt sequence spaces or colliding on the same station number.
- This requirement is never generalized to any other flow or recurring session check.

#### Alternatives Considered / Rejected
- **Option A: Single Online Connection Once to Verify & Claim Station ID (Chosen)** — A brand-new tablet connects once to authenticate credentials and claim a sequential station number (`POST /api/v1/stations/register`). From that second onward, the tablet functions completely offline forever.
- **Option B: Fully Offline First Launch via Pre-Configured Hardware Stations (Rejected)** — Allowing operators or installers to manually configure station numbers on new tablets without contacting the server. *Why rejected:* High operational risk of human error. If two tablets are independently assigned Station 1, they will issue duplicate receipt sequences (`1-00042`), destroying the idempotency and duplicate-prevention guarantees that protect order creation and inventory across the enterprise. A single server round-trip guarantees globally unique number spaces.
- **Option C: Periodic Online Re-Authentication / Lease Expiration (Rejected)** — Requiring tablets to connect to the cloud every N days (e.g. 7 or 30 days) to refresh device leases or cryptographic station tokens. *Why rejected:* Violates the captain's hard requirement that a provisioned store tablet must work with zero connection forever without artificial software timeouts. Power and telecom outages in Rizal province can last indefinitely after severe storms.

### 3. Session and Authentication Resilience
The authenticated user session (`{ id, email, full_name, role }`) and active profile must be persisted in native app storage (`@capacitor/preferences` under `v25.session`), **never** in WebView storage (`localStorage`/`IndexedDB`) which Android evicts under memory pressure ([ADR 0007](0007-native-storage-for-device-state.md)).
- **Automatic Silent Session Recovery:** On application launch or foregrounding, if the verification request (`GET /api/v1/auth/me`) fails due to a network error, `AuthContext` must automatically restore the authenticated user state from native storage without presenting any login prompt or error toast.
- **Offline Login Screen State:** If the app is launched completely unauthenticated while offline (e.g. after explicit manual logout), the login screen must detect offline status and display an informative notice: *"Offline — Connect to the internet to sign in for the first time."* rather than a raw `"Failed to fetch"` error. If prior station registration and profile data exist, a *"Resume Offline Session"* action is provided.
- **Identity Survives Logout (Settled 2026-08-28, not yet implemented):** `logout()` must stop unconditionally wiping the device's last-known-identity record. It keeps clearing the live JWT/`authToken` and `activeProfile` by name (never a prefix sweep, per the storage rule above), but a separate "last known identity" record must persist through logout so the *"Resume Offline Session"* action above has something to resume. Today `AuthContext.jsx`'s `logout()` calls `removeStoredSession()` unconditionally, deleting exactly the record this needs — this is the concrete blocker on building "Resume Offline Session" at all. This work has no owning slice yet; it belongs in Slice 3.4 or a dedicated follow-up, whichever lands first. See [docs/offline-accessibility-acceptance-criteria.md](../offline-accessibility-acceptance-criteria.md) items 1.0 and 12.0.

#### Alternatives Considered / Rejected
- **Option A: Native Session Storage & Automatic Silent Offline Restore (Chosen, Hold 5.6 Option A)** — Persist authenticated user credentials (`{ id, email, full_name, role }`) and active profile in `@capacitor/preferences` under `v25.session`. If `GET /api/v1/auth/me` fails due to network error on startup, restore the session automatically with zero user prompt.
- **Option B: Station-Based Offline Counter Access with Profile Bypass (Rejected, Hold 5.6 Option B)** — If launched offline with a valid station ID, bypass user authentication entirely and open straight to `/orders` with a Netflix-style operator profile picker. *Why rejected:* Removes role-based access control (Admin vs Staff) while offline and creates an unacceptable security loophole if a tablet is lost or accessed by unauthorized personnel outside business hours.
- **Option C: Online-Only Initial Launch & Session Verification (Rejected, Hold 5.6 Option C / Baseline)** — Require an active internet connection to verify JWT validity on cold app start or token verification. *Why rejected:* Android regularly terminates background processes under memory pressure. If the app restarts during a blackout, requiring a live response from `/auth/me` locks the store owners out of the system with an unhandled `"Failed to fetch"` error, stranding unsynced orders with no way to access the app until the internet returns.
- **Option D: Browser / WebView Storage (`localStorage`) (Rejected, ADR 0007)** — Storing session tokens in browser `localStorage`. *Why rejected:* Android WebView aggressively evicts `localStorage` under storage pressure, and routine "Clear data" / "Clear cache" taps in Android Settings wipe it completely, triggering catastrophic session lockouts during outages.

### 4. Order History & Detail Local Storage: Full Snapshots with No Age Limit
Every order the tablet has ever seen — whether created locally on this device or fetched from the server while online — is stored in full in native storage (`@capacitor/preferences` under `v25.receipt.<receipt_number>`), with **no age limit**.
- **Complete Entity Caching:** Cached orders must include full line items with `unit_deposit_fee`, returned bottle counts, customer references, assigned personnel (`order_personnel`), adjustment amounts, notes, and printing history. Summary-only caching is prohibited because it triggers runtime crashes in `OrderDetailPage.jsx` when computing bottle deposit and items subtotals.
- **No Age Limit & No Truncation:** This explicitly replaces the rolling 30-day window from V2.5 D9 and rejects arbitrary caps (e.g. "last 50 orders"). Any order from any historical date that has been loaded on the tablet must open completely offline.
- **Storage Feasibility:** Because `@capacitor/preferences` uses a per-key layout (`v25.receipt.<receipt_number>`), storing thousands of orders requires only single-digit megabytes, well within Android `SharedPreferences` limits without introducing a SQLite native plugin dependency.
- **Dual Identifier Resolution:** `getReceipt(identifier)` must resolve both device-issued receipt numbers (`1-00042`) and PostgreSQL integer primary keys (`1240`) via an internal index mapping, ensuring links from historical logs and notifications never hit dead ends offline.

#### Alternatives Considered / Rejected
- **Option A: Complete Order Snapshot Storage with No Age Limit (Chosen, Expanded Hold 5.4 Option A)** — Store full entity snapshots (complete line items with unit deposit fees, returned bottles, customer data, personnel assignments, notes) per key in native preferences (`v25.receipt.<receipt_number>`), indexed by both receipt number and numeric ID, with no age-based pruning.
- **Option B: Rolling 30-Day Snapshot Cache (V2.5 D9, Superseded)** — Cache complete snapshots but prune records older than 30 days. *Why rejected:* Store owners frequently need to search customer order history, verify past invoice rates, or resolve longstanding bottle deposit balances dating back several months. Capping local history at 30 days caused older orders to vanish and triggered "Order not found" errors when reviewing customer ledgers offline.
- **Option C: Outbox-Only + Last 50 Active Orders Cache (Rejected, Hold 5.4 Option B)** — Cache only unsynced outbox orders plus the last 50 server orders. *Why rejected:* On busy weekends the store processes 40+ orders in a single day. A 50-order limit would evict orders after 24–48 hours, causing immediate cache turnover and white-screen crashes in `OrderDetailPage.jsx` when clicking on slightly older orders.
- **Option D: Heavyweight Embedded Relational Database / SQLite (Rejected, Hold 5.4 Option C / ADR 0007 Option B)** — Integrate `@capacitor-community/sqlite` for local relational order querying. *Why rejected:* Introduces an extra native plugin dependency, Android build complexity, and SQLite schema migrations. The existing `@capacitor/preferences` per-key layout easily handles thousands of order JSON records (single-digit megabytes total) without native plugin friction.

### 5. Order Status Transitions and Content Edits for Unsynced Local Orders
An order created on this tablet that has **not yet synced** to the server may be transitioned through the fulfillment lifecycle (`pending → in_transit → completed`) while offline:
- **Zero Multi-Device Conflict Risk:** Because the order was created locally on this tablet during an outage, no other device in the store knows about it. Mutating its status updates the queued outbox payload locally before it drains to the cloud.
- **Synced Orders Require Online Connectivity:** The moment an order has successfully synced to the central database, it becomes visible to other tablets and affects central inventory accounting. At that point, status changes (dispatching, marking delivered, cancelling, or reopening) require an active online connection to prevent concurrent conflicting transitions across tablets ([ADR 0005](0005-offline-scope-by-operation.md), [ADR 0012](0012-stock-deducts-at-dispatch-not-at-save.md)).
- **Settlement & Bottle Returns:** Order settlement (`POST /orders/:id/close` to status `done`), which calculates returned bottle counts and reconciles deposit balances, remains online-only for synced orders to maintain central deposit ledger integrity.
- **Content Edits Follow the Same Boundary (Settled 2026-08-28):** Editing an order's *content* — price, quantity, customer, adjustment, or notes — while offline is gated exactly like status transitions above: only an order that has **not yet synced** to the server may have its content edited offline (via `updateLocalOrder`/the outbox). The instant an order has synced, content edits require an active online connection, for the same multi-device conflict reason ADR 0005 rejected for status. **Consequence:** a Closed (`done`) order can never be edited offline, because Close is itself online-only (previous bullet), so every Closed order reviewed offline is guaranteed already-synced. See [docs/offline-accessibility-acceptance-criteria.md](../offline-accessibility-acceptance-criteria.md) items 5.8–5.12.

#### Alternatives Considered / Rejected
- **Option A: Offline Transitions for Local Unsynced Orders Only; Synced Orders Gated Online (Chosen, Hold 5.5 Option B)** — Local orders created during an outage that have not yet synced can advance from `pending → in_transit → completed` offline by mutating the queued outbox payload locally before it drains. Once synced to the server, status changes require online connectivity.
- **Option B: Status Transitions Strictly Gated Online for All Orders (Rejected, Hold 5.5 Option A / ADR 0005 §2)** — All orders remain frozen in `pending` status while offline; dispatching and completion can only be recorded after reconnecting. *Why rejected:* During multi-day outages, orders are created, packed onto delivery trucks, dispatched with drivers, and completed on the same day. Forcing them to remain `pending` in the UI prevents drivers and counter staff from seeing real-time dispatch status on counter tablets.
- **Option C: Full Offline Order Lifecycle via Queued Status Events (Rejected, Hold 5.5 Option C)** — Allow queueing status transitions (`POST /orders/:id/status`) for any historical or synced order while offline. *Why rejected:* High multi-device race hazard: Tablet A could mark a synced order cancelled (restoring stock) while Tablet B marks it dispatched (deducting stock). Replaying conflicting, out-of-order status mutations across disconnected devices corrupts central warehouse inventory ledger consistency.

### 6. Product Catalogue & Stock Mutations: Full Offline CRUD with Human Reconciliation
**The application supports full offline CRUD for products and inventory, including manual stock count corrections (`POST /api/v1/products/:id/adjust`) and batch price edits (`PATCH /api/v1/products/batch-price`).**
- **Accepted Operational Risk:** The captain explicitly accepted the business reality that two store tablets could independently correct the same product's stock count or modify prices while both operating offline during an outage, resulting in conflicting values upon reconnection.
- **Mandatory Human Conflict Reconciliation (No Silent Last-Write-Wins):** Stock discrepancies across tablets must **never** be resolved by silent last-write-wins (which discards physical count truth). When an outbox drain detects that a stock count was adjusted on both tablets during a disconnected window, the discrepancy must be surfaced in a prominent reconciliation view/modal where an operator reviews both inputs and confirms the true physical inventory count.
- **Supersedes ADR 0005 §2:** This explicitly supersedes ADR 0005's prior stance that manual stock adjustments and batch price edits must be strictly online-only.
- **Product deletion is the one carve-out from "full CRUD" (captain decision, added during Slice 3.3 delivery, 2026-08-29):** `DELETE /api/v1/products/:id` remains strictly **online-only**, disabled offline with an explanatory tooltip, the same treatment customer merges (§7) and delivery voids (§8) receive. *Rationale:* every other operation in this section has a reconciliation path because two tablets can each hold a value that is honestly true — 50 cases and 40 cases are both real counts, and §6's modal exists to let a person pick between them. "Tablet A deleted this product; tablet B is mid-sale on it" has no second value to weigh and therefore nothing for reconciliation to resolve. The offline grant covers creation, editing, stock corrections and batch reprices; deletion is not part of it.

#### Alternatives Considered / Rejected
- **Option A: Full Offline CRUD with Post-Sync Human Conflict Reconciliation (Chosen, Overriding ADR 0005 §2, Hold 5.2 Option C Extended)** — Enable full offline product creation, manual stock adjustments (`POST /products/:id/adjust`), and batch price edits (`PATCH /products/batch-price`). Discrepancies between tablets are detected upon reconnect and surfaced in a dedicated reconciliation modal for operator confirmation.
- **Option B: Strictly Online-Only for Product & Stock Mutations (ADR 0005 §2, Superseded, Hold 5.2 Option A)** — Uphold ADR 0005 §2: tablets sell strictly from held catalogue copies; all stock corrections and price changes are disabled offline. *Why rejected:* Physical inventory stocktakes and count corrections frequently happen during store downtime or power outages. Paralyzing stock adjustments forced owners to write counts on loose paper, defeating the purpose of the tablet inventory system.
- **Option C: Queue Product Creation Only, Keep Stock Adjustments Online-Only (Rejected, Hold 5.2 Option B)** — Allow `+ Add Product` offline with client IDs, but block stock adjustments and batch price edits. *Why rejected:* Solves the least common operation (adding brand-new product lines) while leaving the most critical and frequent daily operation (correcting physical stock counts after truck unloading) completely blocked.
- **Option D: Silent Last-Write-Wins (Rejected outright in Grill)** — Allow offline stock updates and automatically overwrite conflicting values based on sync timestamp. *Why rejected:* If Tablet A counts 50 cases of Pale Pilsen at 2:00 PM and Tablet B counts 40 cases at 2:15 PM (or has clock skew), silently overwriting destroys physical audit truth without human oversight.

### 7. Customer Mutations: Offline Profile Edits, Online-Only Merges & Deletions
- **Offline Profile Edits:** Editing existing customer contact details, delivery addresses, notes, and descriptive customer type tags (`PATCH /api/v1/customers/:id`) works offline, enqueued in native outbox storage and replayed upon reconnection.
- **Merges and Deletions Remain Strictly Online-Only:** Merging duplicate customer accounts (`POST /api/v1/customers/merge`) and deleting customers (`DELETE /api/v1/customers/:id`) remain strictly online-only, executed one at a time with clear explanatory tooltips when offline.
  - *Rationale:* Customer merges destructively re-parent complete order histories, unpaid bottle balances, and audit records. A concurrent or poorly synchronized merge across disconnected devices can cause unrecoverable relational corruption.
- **Additive Customer Operations (Unchanged):** Customer quick-creates (`POST /customers`) and custom price captures (`POST /customers/:id/prices`) remain 100% offline-capable via the outbox dependency pipeline (`$ref` resolution per [ADR 0005](0005-offline-scope-by-operation.md) and [ADR 0009](0009-custom-pricing-derived-from-saved-prices.md)).

#### Alternatives Considered / Rejected
- **Option A: Queue Profile Edits Offline via Outbox; Keep Merges & Deletions Strictly Online-Only (Chosen, Hold 5.1 Option B)** — Editing existing customer details (phone, address, notes, tags via `PATCH /customers/:id`) works offline via outbox queues. Account merges (`POST /customers/merge`) and deletions (`DELETE /customers/:id`) remain strictly online-only with clear explanatory tooltips.
- **Option B: Strictly Online-Only for All Customer Mutations (ADR 0005 §2, Superseded, Hold 5.1 Option A)** — Allow only quick-creates mid-order; block all edits to existing customer profiles while offline. *Why rejected:* Counter staff frequently need to update delivery addresses or phone numbers when a known customer calls during an outage. Blocking edits caused staff to create duplicate customer accounts just to record a new address.
- **Option C: Full Offline Customer CRUD including Merges (Rejected, Hold 5.1 Option C)** — Allow offline account merging with client-side relational graph reconciliation. *Why rejected:* Customer merges are irreversible destructive operations that re-parent complete order histories, unpaid bottle ledgers, and audit logs. A concurrent or corrupted offline merge across devices causes permanent data loss that cannot be automatically untangled.

### 8. Incoming Supplier Deliveries: Additive Offline Outbox Logging
Logging incoming supplier restock deliveries (`POST /api/v1/incoming`) works fully offline:
- **Additive and Conflict-Free:** As established in ADR 0005 §1, logging a delivery truck is mathematically additive — it appends an independent delivery header and items, and increases inventory. Concurrent blind delivery entries merge additively upon sync without conflicts.
- **Delivery Receipt Numbering:** Deliveries logged offline are assigned device-issued identifiers (`<station>-DEL-<sequence>`) and queued in the outbox, adopting the same idempotency mechanism as order creation ([ADR 0006](0006-receipt-number-as-idempotency-key.md)).
- **Delivery Voids Online-Only:** Voiding a delivery (`POST /incoming/:id/void`) reverses stock movements and soft-deletes a shared record; it remains strictly online-only.

#### Alternatives Considered / Rejected
- **Option A: Build Release 2 Offline Incoming Outbox (Chosen, Hold 5.3 Option A)** — Wire `DeliveryFormModal` to cached products and queue `POST /incoming` in the outbox using device-generated delivery IDs (`<station>-DEL-<seq>`), matching the POS order outbox engine. Voids and line edits remain online-only.
- **Option B: Online-Only Incoming Supplies (Rejected, Hold 5.3 Option B)** — Keep Incoming Supplies strictly online with an offline notice, deferring offline restock delivery logging. *Why rejected:* Brewery delivery trucks (e.g. San Miguel Brewery delivery trucks) arrive and unload during power outages. If staff cannot log incoming stock into the tablet, warehouse stock counts immediately desynchronize from counter POS inventory, causing false out-of-stock blocks.
- **Option C: Full Offline Delivery CRUD including Voids & Deletions (Rejected)** — Allow voiding and deleting deliveries offline. *Why rejected:* Voiding a delivery reverses stock movements and inventory ledger entries. If allowed offline concurrently with sales, it introduces phantom negative stock states and reconciliations.

### 9. Back-Office Screens: Quiet Local Cache & Read-Only Degradation
Administrative back-office screens (**Dashboard, Personnel, Tickets, Audit Log**) are fully accessible and viewable offline in a graceful, read-only degraded mode:
- **Quiet Reference Caching:** When online, the client silently caches reference data in native storage (`v25.cache.dashboard`, `v25.cache.personnel`, `v25.cache.tickets`). Personnel data is also cached in `v25.catalogue.personnel` to ensure driver and helper comboboxes in `OrderCreateModal` function offline.
- **Calm Offline Indicator:** When disconnected, these views render from local cache with a calm amber banner: *"Viewing offline data · Changes sync when connected."*
- **Shared Mutations Gated Online:** Actions that mutate shared operational records — resolving or deleting a deposit ticket (`PATCH /tickets/:id/resolve`, `DELETE /tickets/:id`), deactivating personnel, or updating staff profiles — are cleanly disabled offline with explicit explanatory badges, matching the safety model of customer merges and delivery voids.

#### Alternatives Considered / Rejected
- **Option A: Graceful Read-Only Degradation with Local Reference Cache & Calm Offline Banner (Chosen, Hold 5.7 Option A)** — Quietly cache reference data (Dashboard summary, Personnel roster, Tickets, and Audit log) in native storage. When offline, render views read-only with a calm amber banner (`"Viewing offline data · Changes sync when connected"`). Shared destructive mutations are cleanly disabled with tooltips.
- **Option B: Explicit Offline Gate Screen / Route Lockout (Rejected, Hold 5.7 Option B)** — Replace Dashboard, Tickets, and Audit pages with a full-page gate card: *"This module requires an active server connection. Counter selling is fully available in Outgoing Orders."* *Why rejected:* Completely locks store owners out of inspecting historical metrics, checking personnel contact info, or reviewing open bottle deposit debt during outages.
- **Option C: Full Offline Back-Office CRUD (Unrestricted Mutations) (Rejected)** — Allow resolving tickets, deactivating personnel, and modifying staff records offline via outbox queues. *Why rejected:* Back-office administrative mutations are shared organizational state with high conflict risk. For example, deactivating a driver on Tablet A while Tablet B assigns him to a delivery order creates operational confusion. Gating mutations online is safe because back-office changes are rarely time-critical during a blackout.

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

## Considered Options Matrix

Each of the 9 decisions above records its specific alternatives and rationale under its respective `Alternatives Considered / Rejected` subsection. Below is a structured cross-reference indexing the options considered against the structured decision holds from the audit report ([`/Users/lovzay/alvin-workspace/data/leyble-hub-full-offline-accessibility-audit/report.md`](/Users/lovzay/alvin-workspace/data/leyble-hub-full-offline-accessibility-audit/report.md), Section 5):

| Decision Area | Audit Hold Ref | Option Selected | Primary Rejected Alternatives & Why |
| :--- | :--- | :--- | :--- |
| **1. Overall Scope** | General Audit Mandate | Option A: Full-app offline accessibility | Option B (POS-only): Caused crashes in other screens; Option C (Route gates): Blocked essential reading of records. |
| **2. First-Ever Login** | Station Registration | Option A: One-time online setup | Option B (Offline station config): High risk of duplicate station IDs; Option C (Periodic leases): Violates zero-connection promise. |
| **3. Auth Resilience** | Hold 5.6 `auth-session-resilience-model` | Option A: Native `@capacitor/preferences` storage | Option B (Profile bypass): Broke role permissions; Option C (Online check): Locked out users on app restart; Option D (`localStorage`): Evicted by Android WebView. |
| **4. Order History** | Hold 5.4 `orders-read-cache-architecture` | Option A: Full snapshots, no age limit | Option B (30-day cap): Broke historical lookups; Option C (50-order cap): Evicted orders within 48h; Option D (SQLite): Unneeded native build bloat. |
| **5. Order Status** | Hold 5.5 `order-status-transitions-offline` | Option A (5.5 Option B): Local unsynced transitions | Option B (All transitions gated online): Hindered dispatch tracking; Option C (All transitions offline): Dangerous multi-device race hazard. |
| **6. Stock Mutations** | Hold 5.2 `catalogue-stock-mutation-policy` | Option A (5.2 Option C Ext): Full CRUD + reconciliation | Option B (Online-only): Paralyzed physical stocktakes; Option C (Add-product only): Left daily stock adjustments blocked; Option D (Silent LWW): Destroyed count truth. |
| **7. Customer Mutations** | Hold 5.1 `customer-mutation-policy` | Option A (5.1 Option B): Profile edits offline, merges online | Option B (Online-only): Caused duplicate profiles for address changes; Option C (Offline merges): Unrecoverable relational graph corruption risk. |
| **8. Incoming Deliveries** | Hold 5.3 `incoming-supplies-offline-scope` | Option A: Release 2 offline outbox logging | Option B (Online-only supplies): Caused counter stock desync during truck arrivals; Option C (Offline voids): Phantom negative inventory risk. |
| **9. Back-Office Screens**| Hold 5.7 `back-office-degradation-policy` | Option A: Cached read-only + calm banner | Option B (Gate screens): Locked owners out of critical business info; Option C (Full offline CRUD): Unnecessary high-conflict administrative risk. |

---

## The Sync Model: Eager at Setup, Incremental After That

*(Added 2026-08-28 with Slice 3.2. This supersedes the "cache orders as you visit them" model the original Downstream Delivery Slices text below assumed for Slices 3.2 and 3.3, which were also merged into one delivery because they can only be tested together.)*

Field testing on Slice 3.1 exposed the flaw in caching on visit: an order that had been **viewed** online but never created on this tablet had no local copy at all, so going offline and reopening it — or the Outgoing Orders list — still failed. Caching on visit can only ever protect what the operator happened to open before the line went down, which is not how a counter behaves during a blackout. The tablet therefore pulls **ahead of time**, in two clearly different shapes (`client/src/offline/sync.js`):

1. **First-ever setup of a tablet** (no local cache exists yet): one full pull — the complete product catalogue, all customers, all personnel, and the complete order history. Unavoidably heavy, and it happens exactly once per tablet, ever.
2. **Every login or reconnect after that** (a normal daily login, an app update, or a forced re-login after a bug or logout): an **incremental delta only** — whatever changed in products, customers, personnel and orders since the last successful sync, *including orders created on other tablets*. Step 1's full pull never runs again.
3. **The reconnect trigger is throttled.** Coming back online triggers a sync, but a reconnect landing less than ~90 seconds after the previous sync completed is skipped rather than stacked, so a flapping connection cannot fire back-to-back syncs. A deliberate login is never throttled.
4. **First-setup UX is non-blocking.** Only the three small, fast reference pulls (products, customers, personnel) hold the app; order history streams in behind an already-unlocked screen, newest first, so nobody waits on years of invoices.
5. **A sync interrupted partway leaves everything it already fetched in place.** Every write merges onto what the device holds — catalogue deltas by id, order snapshots one key per order — and never clears then repopulates, so a cut-off sync can only ever leave the tablet with *more* than it started with. Resumable cursors mean the next attempt continues rather than restarting.

Mechanically: `GET /api/v1/orders/sync` serves complete order snapshots (line items and personnel included, drafts excluded) with keyset pagination on `(updated_at, id)` in both directions — `direction=back` backfills a new tablet resumably, `direction=forward` is the delta from the device's own watermark. `GET /products`, `/customers` and `/personnel` accept an additive `updated_since` for the same purpose. The device's watermarks come from the rows the server sent, so there is no clock-skew comparison anywhere in the loop.

---

## Downstream Delivery Slices

This ADR serves as the authoritative specification for the queued delivery tasks. **The Slice 3.2 and 3.3 entries below are superseded by the sync model above** and are kept only as a record of the original plan; Slices 3.1 and 3.4 stand as written.

1. **Slice 3.1: Core Auth Resilience & Defensive UI Hardening (`leyble-hub-offline-slice-3-1-auth-resilience`)** — *shipped*
   - Native session persistence (`v25.session`) in `AuthContext.jsx`.
   - Automatic zero-prompt session recovery on network errors during `/auth/me`.
   - Friendly offline notice and session resume on `LoginPage.jsx`.
   - Defensive null/undefined guards across `ProductDetailPanel`, `CustomerDetailPanel`, `PersonnelDetailPanel`, and `DeliveryDetailPanel` to eliminate white-screen crashes.

2. **Slices 3.2 + 3.3, delivered together as Slice 3.2: Counter POS & Orders Full Offline Sync (`leyble-hub-offline-slice-3-2-pos-orders-full-sync`)** — *superseded plan; see the sync model above for what was actually built*
   - ~~Cache orders as the operator visits them~~ → the tablet syncs the whole history ahead of time.
   - Wire `loadCatalogue()` to `OrderCreateModal.jsx` (products, customers, personnel, prices).
   - Cache personnel in native storage (`v25.catalogue.personnel`) for driver/helper assignments.
   - Wire the customer directory's creation modal (`CustomerFormModal.jsx`) to the offline outbox.
   - `OrdersPage.jsx` falls back to the complete local history (no age limit); `OrderDetailPage.jsx` opens **any** order from it.
   - Dual identifier resolution (receipt number **or** numeric row id) in `getReceipt()`.
   - Offline status progression (`pending → in_transit → completed`) for unsynced local orders only (§5).

3. **Slice 3.3: Back-Office Graceful Degradation, Stock Mutations & Release 2 Supplies (`leyble-hub-offline-slice-3-3-backoffice-and-stock`)** — *shipped* (numbered 3.4 when this ADR was written; renumbered down when the original 3.2 and 3.3 were delivered as one unit above — the scope below is unchanged)
   - Full offline CRUD for products, stock adjustments, and batch price edits.
   - Multi-device stock conflict flagging and human reconciliation view.
   - Customer profile editing offline via outbox; online gating for merges and deletions.
   - Graceful read-only fallback and calm offline banners for Dashboard, Personnel, Tickets, and Audit Log.
   - Release 2: Offline logging of incoming supplier deliveries (`POST /incoming`) via outbox.
