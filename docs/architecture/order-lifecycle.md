# Order Lifecycle (deep-dive)

The most intricate part of the system: order status transitions, when stock moves, and how
deposits / bottle returns affect the total. Source of truth:
[`server/src/routes/orders.js`](../../server/src/routes/orders.js) and
[`server/src/lib/inventory.js`](../../server/src/lib/inventory.js).

## Statuses

`draft → pending → in_transit → completed → done` (delivery), plus `cancelled` from any open
state. Pickup orders skip `in_transit`.

- **draft** — parked, possibly incomplete. Deducts no stock; excluded from all lists/totals/
  history except the Drafts tab. Finalizing (`POST /:id/finalize`) turns it into `pending`.
- **pending** — confirmed order, not yet dispatched.
- **in_transit** — out for delivery (delivery orders only).
- **completed** — delivered / picked up, deposit not yet reconciled.
- **done** — closed; bottle returns counted, deposit folded into the total.
- **cancelled** — voided; stock is restored only if it had actually been dispatched.

## Allowed transitions

From `getAllowedTransitions(status, orderType)`:

**Delivery**
| From | To |
|---|---|
| pending | in_transit, cancelled |
| in_transit | pending, completed, cancelled |
| completed | in_transit, done, cancelled |
| done | completed |

**Pickup**
| From | To |
|---|---|
| pending | completed, cancelled |
| completed | pending, done, cancelled |
| done | completed |

Any other transition → `400`. Backward steps (e.g. `in_transit → pending`) null out the relevant
timestamps; `done`/`cancelled` set `closed_at`.

## Stock movement

Stock changes only through `applyDeltaMap` (`lib/inventory.js`), inside a transaction, and always
write an `inventory_audit_logs` row.

**Stock moves at dispatch, not at save** ([ADR 0012](../adr/0012-stock-deducts-at-dispatch-not-at-save.md)).
V2 briefly deducted at creation; that made stock an offline-affected quantity (an order saved
blind at 2pm moved inventory when the outbox drained at 5pm) and it bypassed the batch-review
queues. Creating, finalizing and parking an order now move nothing.

- **Deduct** on the dispatch transition: `pending → in_transit` for a delivery,
  `pending → completed` for a pickup.
- **Restore** on `→ cancelled`, and on stepping back behind that boundary
  (`in_transit`/`completed` → `pending`).
- **Reconcile** on item edits (`PATCH /:id`) while the goods are out: the diff between old and new
  quantities (`oldQty − newQty`) is applied as deltas.
- **Drafts never touch stock.**

All three are gated on `isStockOut(orderId)` — the running sum of the order's own audit-log
deltas, i.e. *are the goods out right now* — rather than on the status name alone. That is what
keeps the two populations of pre-existing rows correct: orders from before the V2 window were
never deducted (cancelling one must restore nothing), and orders from inside it were deducted at
save (dispatching one must not deduct a second time). It also makes re-dispatching after a step
back deduct again, which "was it ever deducted" would have silently skipped.

## Totals, deposits & bottle returns

`order_items.line_total` is a **generated column** (never written directly):
```
quantity*unit_price + (quantity*units_per_case − bottles_returned)*unit_deposit_fee
```
So the deposit is charged only on bottles **not** returned.

`recomputeTotal(orderId)` sets `orders.total_amount` differently by status:
- **While open** (not `done`): `SUM(quantity * unit_price)` — **goods only, deposit excluded.**
  This is intentional: the refundable deposit is not part of the running total.
- **When `done`:** `SUM(line_total)` — deposit on un-returned bottles is now folded in.

The separate `orders.adjustment` (± manual correction, with `adjustment_reason`) is stored
alongside and surfaced in the UI/receipt; it is not part of `recomputeTotal`'s goods sum.

## Closing an order

`POST /:id/close` accepts an `items[]` array of `{ id, bottles_returned }`, writes
`bottles_returned` on each line, moves the order to `done`, and recomputes the total (now
deposit-inclusive). Only products with `requires_bottle_return = true` and a non-zero
`unit_deposit_fee` participate. This is driven from the **Review Deliveries** batch queue in the
UI.

## Personnel

Assigned via the `order_personnel` join table, not FK columns. **At most one Driver per order** —
the order modal auto-demotes a previous Driver to Helper when a new Driver is picked, and
`syncPersonnel` returns `400` on more than one Driver.

## Receipts

80mm thermal receipts (`client/src/pages/orders/receiptTemplate.js`, printed via
`usePrintReceipt()`). Confirmed prints are recorded with `POST /:id/receipt-printed`, tracked
separately for the pending phase and the delivered/done phase
(`pending_receipt_printed_at`, `delivered_receipt_printed_at`).

See also: [Database Reference](DATABASE.md) · [API Reference](API.md).
