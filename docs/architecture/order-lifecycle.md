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
- **cancelled** — voided; any deducted stock is restored.

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

- **Deduct** on finalize: when an order transitions `draft → pending` (or is created directly as
  `pending`), ordered quantities are deducted from `products.current_stock`.
- **Restore** on `→ cancelled`: when a `pending` (or previously deducted) order is cancelled,
  deducted stock is restored. Legacy pre-cutover `pending` orders that never had stock deducted
  safely skip stock restoration on cancel.
- **Reconcile** on item edits (`PATCH /:id`): for orders with deducted stock, the diff between old
  and new item quantities (`oldQty − newQty`) is applied as deltas. Legacy pre-cutover `pending`
  orders safely skip stock reconciliation on edit.
- **Drafts never touch stock.**

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
