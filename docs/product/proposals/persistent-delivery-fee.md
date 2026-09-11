# Proposal: Persistent per-customer delivery fee

**Status:** grilled, decisions locked — not built yet.
**Origin:** captain grilling session, 2026-09-11.
**See also:** [ADR 0009 — custom pricing derived from saved prices](../../adr/0009-custom-pricing-derived-from-saved-prices.md)
(same "snapshot a standing value onto the order" shape as custom pricing).

## The idea

Today "delivery fee" isn't a real concept anywhere in Leyble Hub — it's whatever the operator
types into the generic `orders.adjustment` / `orders.adjustment_reason` fields (migration 019)
on that particular order. There's no ADR or proposal covering it, and nothing remembers a
customer's usual delivery charge from one order to the next. This proposal gives a customer a
standing, per-customer delivery fee that auto-fills on their delivery orders, the same way
`customer_product_prices` already auto-fills their product pricing — while leaving the existing
free-text `adjustment` field alone for whatever else it's used for.

There is one order-creation/edit surface in actual use — `OrdersPage.jsx` → `OrderCreateModal.jsx`
(also reused for editing) and `OrderDetailPage.jsx`. This proposal is scoped to that surface only;
it does not touch a "V2" anything.

## Current state (as of this writing)

- `orders.adjustment NUMERIC(10,2)` + `orders.adjustment_reason TEXT` (migration 019) is the only
  place a delivery charge could live today, and it's a manual, signed, free-text field with no
  concept of "this customer's usual fee."
- `customers` has no delivery-fee column at all.
- `customer_product_prices` is the existing precedent for a per-customer standing value that gets
  snapshotted onto an order, but it's append-only (a price history), scoped by `order_type`, and
  written only through the explicit "Save Custom Price?" prompt (see
  [save-custom-price-prompt.md](./save-custom-price-prompt.md)). A delivery fee doesn't need any
  of that machinery — it's one mutable number per customer, not a priced-item history.
- The order form/detail/receipt today show a single `Adjustment` row, computed client-side and
  added on top of the server's `total_amount` (`recomputeTotal` in
  [server/src/routes/orders.js](../../../server/src/routes/orders.js) — goods + deposit only, no
  adjustment). The grand total shown on screen is `itemsSubtotal + depositTotal + adjustment`.

## Decisions (from the 2026-09-11 grilling session)

1. **This is per-customer, not global.** A standing delivery fee lives on the customer record —
   there's no single distributor-wide default to fall back to. If a customer has never had one
   set, nothing auto-fills for them.

2. **Storage: a plain mutable column, not a history table.** `customers.delivery_fee
   NUMERIC(10,2)`, nullable. Unlike `customer_product_prices`, there's no append-only ledger of
   past fees — it's one scalar per customer, and `activity_logs` already covers "what changed and
   when" for anyone who needs that trail.

3. **`NULL` means "not configured," not "free delivery."** Every existing customer starts `NULL`
   on rollout — zero behavior change until an owner deliberately opens a customer and sets a
   value. Nothing auto-applies on its own.

4. **Unset means the line doesn't exist, not that it shows ₱0.00.** When a customer's
   `delivery_fee` is `NULL`, no "Delivery Fee" row appears anywhere — order form, order detail, or
   receipt. But an owner *can* deliberately set a customer's fee to exactly `₱0.00` (e.g. a VIP
   account with free delivery), and that case is different: it's configured, so it prints its own
   "Delivery Fee: ₱0.00" line. The rule that decides whether the row exists is "was this
   configured," never "is the amount non-zero."

5. **A new, separate order-level column — `orders.delivery_fee_charged`, not a repurposed
   `adjustment`.** The two are independent: an order can carry both a delivery fee and a manual
   adjustment for something unrelated (a discount, a damaged-case credit, whatever `adjustment`
   is already used for). Wherever both appear together — order form, order detail, receipt — the
   Delivery Fee row sits above the Adjustment row.

6. **Snapshotted at order creation, not looked up live.** The customer's current `delivery_fee` is
   copied onto `orders.delivery_fee_charged` the moment the order is created — the same pattern
   `order_items.unit_price` already uses for product pricing. If the owner later changes that
   customer's standing fee, past orders and their printed receipts are unaffected.

7. **Delivery orders only.** `delivery_fee_charged` is populated only when `order_type ===
   'delivery'`; it's always absent/`NULL` on a `pickup` order, since there's nothing to deliver.

8. **Overridable per order.** The auto-filled amount can be hand-edited or waived on one specific
   order — same spirit as `adjustment` today — without touching the customer's standing rate. A
   one-off waiver doesn't mean the customer's usual fee changed.

9. **Configured on the Customer edit form, not a separate screen.** The standing fee is a new
   field on `CustomerDetailPanel.jsx`, next to `customer_type` — there's no dedicated
   delivery-fee management page, matching how custom pricing already lives inside the customer
   record rather than its own module.

10. **Cached for offline use from day one.** `delivery_fee` joins the customer catalogue cache
    (`client/src/offline/catalogue.js`), so the order form can auto-fill it identically whether
    the tablet is online or offline — the rest of a customer's record already works this way, and
    a delivery fee shouldn't be the one field that only auto-fills when connected.

11. **Follows the order-type toggle, unless the operator already touched it.** `OrderCreateModal.jsx`
    already re-derives custom pricing when its delivery/pickup toggle flips; this field mirrors
    that. Switching to pickup clears `delivery_fee_charged` (nothing to charge). Switching back to
    delivery re-populates it from the customer's current standing fee — but only if the operator
    hasn't already hand-edited the amount on this order; a deliberate edit is never silently
    clobbered by a toggle flip.

12. **Totals follow the `adjustment` pattern exactly: client-side addition, not baked into
    `total_amount`.** The server's `recomputeTotal` stays goods + deposit only, unchanged. The
    displayed grand total goes from `itemsSubtotal + depositTotal + adjustment` to
    `itemsSubtotal + depositTotal + delivery_fee_charged + adjustment`, with the delivery fee
    term added before the adjustment term (decision 5).

13. **Receipt label is plain `Delivery Fee`.** No parenthetical reason alongside it, unlike
    `Adjustment` (which prints its free-text reason) — this field carries no reason text, so
    there's nothing to show beyond the amount.

14. **Charge-only, validated `>= 0`.** Unlike `adjustment`, which is deliberately signed (it can
    discount or surcharge), a delivery fee is never negative — there's no such thing as a delivery
    discount through this field. Both `customers.delivery_fee` and `orders.delivery_fee_charged`
    need this enforced; a future implementation should add a DB check constraint on both columns
    plus matching client-side form validation.

15. **Order-level only for this slice — no reporting rollup.** Whatever this ships as covers order
    creation, editing, and display only. A Dashboard or reporting view totaling delivery fees
    collected is a natural follow-up once the data exists, but it's explicitly out of scope here.

## Not yet decided / explicitly out of scope

- Exact migration numbering and other implementation details — left to whoever builds this.
- No backfill of existing customers' fees from historical `adjustment_reason` free text; every
  customer starts `NULL` regardless of what past orders' adjustment notes said.
- No reporting or aggregate visibility into fees collected in the first implementation (decision 15).
