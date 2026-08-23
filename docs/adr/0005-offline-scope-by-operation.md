# Offline Scope Determined by Operation Type Rather Than Module

**Status:** Settled (2026-08-23)  
**Origin:** Captain decision D3 (2026-08-23)  
**See also:** [docs/product/proposals/v2-5-offline-accessibility.md](../product/proposals/v2-5-offline-accessibility.md), [docs/product/glossary.md](../product/glossary.md), [docs/architecture/DATABASE.md](../architecture/DATABASE.md)

## Context

When introducing offline capabilities for store operations during multi-day outages, we must establish a clear boundary defining which operations can safely be performed offline and which require an active online connection.

An intuitive approach might divide capabilities along UI module boundaries (e.g. "POS is offline-capable; Back-Office modules like Incoming Supplies and Inventory are strictly online"). However, module boundaries do not align with data integrity constraints. For example, logging a supplier delivery in Incoming Supplies only adds inventory and records an append-only log, making it safe to perform concurrently without connectivity, whereas cancelling a previously synced order in POS mutates shared inventory state and risks conflicts.

## Decision

Offline support is governed strictly by the **mathematical and transactional properties of the operation**, partitioned into two distinct categories:

### 1. Works Offline: Additive Creates of Self-Contained Records
Operations that append new independent rows and only increase inventory or record new sales:
- **POS Order Creation & Thermal Receipt Printing** (`POST /api/v1/orders`): Records sales and deducts stock locally; multiple devices creating orders append independently without primary key collisions due to device-issued receipt numbers.
- **POS Quick-Create Customer** (`POST /api/v1/customers`): Appends a new customer record locally, queued in the outbox ahead of referencing orders.
- **Capture Customer Custom Price** (`POST /api/v1/customers/:id/prices`): Appends customer product price overrides.
- **Record Incoming Supplier Delivery** (`POST /api/v1/incoming`): Verified in backend code — `POST /incoming` only ever adds inventory stock and appends a self-contained delivery record with items; concurrent blind delivery entries merge additively without conflicts.
- **Park an Order Draft**: Saved locally in client storage during an outage.
- **Reprint Receipts**: Reprints any receipt available in the device's local 30-day cache.

### 2. Requires Online Connection: Reversals, Deletions, and Overwrites of Shared State
Operations that mutate existing shared records, reverse previously confirmed stock, or modify global catalogue baselines:
- **Cancelling a Synced Order** (`POST /api/v1/orders/:id/status` with `status: 'cancelled'`): Restores inventory to the shared pool; requires online connectivity to verify current server state.
- **Voiding a Supplier Delivery** (`POST /api/v1/incoming/:id/void`): Soft-deletes a delivery and reverses restocked quantities; requires online connectivity.
- **Editing a Synced Order or Delivery**: Modifying line items on a record that has already been uploaded to the backend. *(Note: Unsynced local drafts or outbox orders that have not yet left the device may be freely edited or discarded locally).*
- **Inventory Stock Adjustments & Batch Price Edits** (`PATCH /api/v1/products/:id`, `PATCH /api/v1/products/batch-price`): Overwrites baseline pricing or forces manual stock levels across devices.

## Considered Options

- **Option 1: Operation-Based Boundary (Chosen)** — Partition based on additive creates versus state mutations and reversals. Additive operations commute cleanly when uploaded in batch, requiring zero distributed locking. Destructive reversals and edits remain online-only to protect inventory integrity.
- **Option 2: Module-Based Boundary (Rejected)** — Designating POS as offline and Incoming Supplies / Inventory as online. Rejected because logging incoming delivery trucks during a multi-day power outage is an essential store workflow, and its backend logic (`POST /incoming`) is entirely additive and mathematically identical to order creation in terms of conflict safety.
- **Option 3: Full Offline CRUD Across All Modules (Rejected)** — Permitting offline order cancellations, delivery voids, and stock adjustments with conflict resolution algorithms. Rejected because resolving concurrent stock adjustments and order cancellations across disconnected tablets introduces race conditions, phantom inventory drift, and distributed complexity that is unwarranted for a two-tablet retail beverage distributor.
