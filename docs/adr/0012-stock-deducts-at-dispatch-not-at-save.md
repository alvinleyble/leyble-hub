# Stock Deducts at Dispatch, Not at Save

**Status:** Settled [Provisional] (2026-08-25)  
**Origin:** Captain decision G4 (2026-08-25)  
**See also:** [ADR 0005: Offline Scope by Operation](0005-offline-scope-by-operation.md), [V3.0 Proposal](../product/proposals/v3-0-pos-order-creation-in-v1.md), [Order Lifecycle](../architecture/order-lifecycle.md)

## Context

In Leyble Hub V1, inventory stock was deducted only when an order reached the **dispatch** milestone in the state machine:
- **Delivery orders:** Stock deducted upon transition from `pending → in_transit` ([`server/src/routes/orders.js`](../../../server/src/routes/orders.js)).
- **Pickup orders:** Stock deducted upon transition from `pending → completed`.

In V2.0, stock deduction was moved to order **creation / finalization** (`draft → pending` or direct create). This change was introduced because V2 silenced the Review Deliveries batch queues and modeled all transactions as immediate, single-step retail counter sales.

However, moving stock deduction to order save introduced two critical issues:
1. It broke V1's multi-step order workflow (`pending → in_transit → completed → done`) and conflicted with the Review Deliveries queue.
2. It made stock levels an **offline-affected quantity**: If a tablet created an order offline at 2:00 PM during an internet outage and synced with the cloud database at 5:00 PM upon reconnection, stock was deducted at 5:00 PM. This caused a 3-hour lag in inventory audit logs, creating discrepancies between when goods left the store and when stock was adjusted.

## Decision

We are reverting the stock deduction timing back to V1's **deduct-on-dispatch** model (recorded as a provisional decision by the product owner, subject to future operational evaluation):

1. **Deduct-on-Dispatch Restored:**
   - In [`server/src/routes/orders.js`](../../../server/src/routes/orders.js), stock is deducted during the status transition handler: `in_transit` for deliveries, `completed` for pickups.
   - Deduction on `POST /orders` (direct pending create) and `POST /orders/:id/finalize` is removed.
2. **Offline Integrity Preserved:** Stock adjustment is an online-only operation executed exclusively when a user advances order status on a connected network. This ensures [V2.5's Explicit Non-Goal 1](../product/proposals/v2-5-offline-accessibility.md) ("No offline stock reservations") remains strictly true: the tablet never attempts to calculate, reserve, or deduct inventory offline.
3. **Hardening Fixes Retained:** Server-side validation hardening introduced in V2 is retained regardless:
   - Explicit rejection of negative prices and negative deposit fees on finalized order items.
   - Null-safety checks (`product_id != null`) in delta calculation routines.

## Considered Options

- **Option A: Revert to Deduct-on-Dispatch (Chosen)** — Aligns inventory decrements with physical warehouse dispatch and keeps stock movements strictly online. Restores compatibility with V1's Review Deliveries queues.
- **Option B: Retain V2 Deduct-on-Save (Rejected)** — Retaining deduction upon order creation. Rejected because it mutates stock during outbox sync hours after the sale occurred and breaks V1 batch-review lifecycles.
- **Option C: Deduct at Save for Pickups, Dispatch for Deliveries (Rejected)** — Bifurcating stock deduction timing based on order type. Rejected because bifurcated logic adds unnecessary complexity and ambiguity to status reconciliation and audit logging.

## Consequences

- Inventory movements accurately reflect physical goods leaving the premises.
- Offline order creation carries zero stock calculation overhead and zero risk of inventory desynchronization during network outages.
- Operational note: If an operator creates a pickup order but fails to mark it `completed`, stock will remain un-deducted until status advancement.
