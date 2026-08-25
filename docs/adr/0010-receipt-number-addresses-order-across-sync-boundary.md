# The Receipt Number Addresses an Order, Not the Database Row ID

**Status:** Settled (2026-08-25)  
**Origin:** Captain decisions G5 + G6 (2026-08-25)  
**See also:** [ADR 0003: Device-Issued Receipt Numbers](0003-device-issued-receipt-numbers.md), [ADR 0004: Local-First POS](0004-local-first-pos.md), [ADR 0006: Receipt Number as Idempotency Key](0006-receipt-number-as-idempotency-key.md), [V3.0 Proposal](../product/proposals/v3-0-pos-order-creation-in-v1.md)

## Context

In Leyble Hub V1, creating an order involved a synchronous server round-trip (`POST /orders` or `POST /orders/:id/finalize`), returning a database row ID (`orders.id`) which the frontend used to navigate to `/orders/<id>`.

Under the local-first architecture established in V2.5/V3.0 ([ADR 0004](0004-local-first-pos.md)), order creation writes immediately to native device storage and enqueues to the outbox. An order saved offline has **no PostgreSQL row ID** — the primary key `id` is allocated by the database hours or days later when the outbox drains. If the application attempted to navigate by database ID upon save, it would fail or navigate to an invalid route.

Furthermore, [ADR 0003](0003-device-issued-receipt-numbers.md) established device-issued receipt numbers (`<station>-<sequence>`, e.g., `1-00042`) as first-class domain identifiers printed on physical receipts given to customers at the counter.

## Decision

We are establishing the device-issued `receipt_number` as the primary address and routing key for orders across the application:

1. **Routing by Receipt Number:** Upon saving an order, the frontend navigates to `/orders/<receipt-number>` (e.g. `/orders/1-00042`).
2. **Stable Across Sync Boundary:** 
   - Before outbox drain: `OrderDetailPage.jsx` renders the order immediately by reading its payload from the local 30-day cache ([`nativeStore.js`](../../../client/src/offline/nativeStore.js)).
   - After outbox drain: The same URL `/orders/1-00042` fetches and renders the synced server record. The view transitions seamlessly without URL churn or broken links.
3. **Backend Identifier Resolution:** The backend Express router resolves incoming URL params via `resolveOrderId()` in [`server/src/routes/orders.js`](../../../server/src/routes/orders.js). The helper regex-matches `\d+-\d+` receipt numbers against `(receipt_station, receipt_sequence)` and falls back to numeric IDs for legacy orders. All order endpoints accept both formats interchangeably.
4. **Uniform Display Identity:** The UI and thermal receipts display `receipt_number` everywhere `#<id>` was previously shown. Orders predating receipt numbering (~1,300 legacy rows) fall back to displaying `#<id>`.

## Considered Options

- **Option A: Route and Address by Receipt Number Across the Sync Boundary (Chosen)** — The receipt number is the only identifier that exists at the moment of sale and remains immutable after synchronization. Enables immediate local navigation without network dependencies.
- **Option B: Navigate Only When Server ID Exists / Close with Toast (Rejected)** — Attempting to fetch a server ID when online and falling back to closing the modal with a toast when offline. Rejected because it violates D2's single code path principle and creates network-dependent behavioral bifurcation on the primary selling screen.
- **Option C: Client-Generated UUID Primary Key (Rejected)** — Using client-generated UUIDs as primary keys in URLs. Rejected because long UUID strings are unreadable, hard to communicate verbally, and unsuitable for thermal receipt printouts.

## Consequences

- Navigation immediately following order save is 100% instant and offline-capable.
- [`OrderDetailPage.jsx`](../../../client/src/pages/orders/OrderDetailPage.jsx) gains a local-first read capability to render queued orders from the local cache with a "waiting to sync" indicator before server drain.
- The receipt number is the single source of truth connecting physical customer receipts, on-screen UI routes, and database records.
