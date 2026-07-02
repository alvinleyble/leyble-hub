# Proposal: "Save custom price?" prompt on New Order

**Status:** grilled, decisions locked — not built yet.
**Origin:** Alvin, verbal description, 2026-07-02. Grilled 2026-07-02 (see Decisions below).
**See also:** [ADR 0001 — Wholesaler status gates custom pricing](../../adr/0001-wholesaler-status-gates-custom-pricing.md).

## The idea

When creating a New Order, if the user hand-edits a product's price/case, the app should offer
to remember that price for the customer going forward — instead of the typed price only ever
applying to this one order.

- Prompt (all customers): **"Save the custom price(s) for [Customer Name]?"**
- If the customer is **regular**, saying yes to that prompt also converts them to a
  **wholesaler** (custom prices are currently a wholesaler-only concept — see below). Because
  that's a bigger, less-obvious consequence, regular customers get a **second** confirmation
  after the first:
  1. "Save the custom price(s) for [Customer Name]?"
  2. *(only if step 1 = Yes)* "Saving this custom price for [Customer Name] will make them a
     Wholesaler. Continue?"
- Wholesaler customers only ever see prompt 1 — they're already a wholesaler, so there's no
  status change to warn about.

## Current state (as of this writing)

- `OrderCreateModal.jsx` already lets the user hand-edit `unit_price` on any line item, for
  **any** customer type — the input isn't gated by `customer_type` today.
- But the submit payload hardcodes `is_price_overridden: false`
  ([OrderCreateModal.jsx:302](../../../client/src/pages/orders/OrderCreateModal.jsx#L302)), so
  the backend logic that would persist a custom price — an `INSERT INTO customer_product_prices`
  guarded by `if (is_price_overridden)` in
  [orders.js:76-84](../../../server/src/routes/orders.js#L76-L84) — never actually fires today.
  Prices typed on an order are one-time; nothing is remembered for next time. This looks like
  scaffolding for a feature that was never wired up on the frontend — this proposal is that
  wiring, plus new prompt UX on top.
- The only existing way to set a `customer_product_prices` row is manual, via the Customers page
  → custom-pricing panel
  ([CustomerDetailPanel.jsx](../../../client/src/pages/customers/CustomerDetailPanel.jsx)),
  which is gated to `customer_type === 'wholesaler'` only.
- Custom prices are scoped by `order_type` (`'delivery'` vs `'pickup'`, migration 020) — a price
  saved while creating a delivery order only applies to future **delivery** orders for that
  customer, not pickup.
- `customer_type` currently gates exactly three things: the amber "Wholesaler" badge, whether
  the custom-pricing panel shows on the Customers page, and whether `OrderCreateModal` auto-loads
  a customer's existing custom prices. It's a wholesale-only pricing model (no separate retail
  price), so flipping `regular` → `wholesaler` is closer to a **label switch that unlocks custom
  pricing** than a deep business-rule change.
- `PATCH /customers/:id` already supports updating `customer_type`
  ([customers.js:101](../../../server/src/routes/customers.js#L101)) — no new endpoint needed
  for the conversion itself.

## Decisions (from the 2026-07-02 grilling session)

1. **Detecting "edited."** A line is "dirty" if its `unit_price` at submit time differs from
   whatever `priceFor()` returned when that product was added to the order (existing helper in
   `OrderCreateModal.jsx` — custom price if the customer's a wholesaler with one loaded,
   otherwise `base_wholesale_price`). Comparison happens once, at submit.
2. **Granularity: one combined prompt per order.** If N line items are dirty, one prompt lists
   all of them and asks a single Yes/No — no per-product prompting, no partial-save UI. Simpler
   to build, matches "custom price**s**" (plural) in how this was originally described.
3. **Scope: fires on every path that ends in a successful submit** — fresh create, draft
   finalize, *and* real-edit of a live order (`isRealEdit`) — always at the moment `handleSubmit`
   succeeds, never during silent draft auto-save.
4. **Declining never rolls back the order.** The prompt only appears *after* the order is
   already committed with whatever price was typed, so there's nothing to roll back — declining
   (at either step, or dismissing without answering) just means the price isn't remembered for
   next time. Dismissing without an explicit answer (backdrop tap, ✕) counts as "No."
5. **UI pattern: two separate, simple confirm-modals in sequence** (not a multi-step wizard) —
   the second only ever appears for a `regular` customer, immediately after "Yes" on the first.
   One decision per screen, consistent with the rest of the app's plain confirm-dialog style and
   the accessibility bar in `CLAUDE.md` (large touch targets, one thing at a time).
6. **Prompt copy names the order type** — e.g. *"Save the custom price(s) for [Name] on future
   **delivery** orders?"* — since a saved price only applies to the `order_type` it was saved
   under (migration 020), and that's an easy thing to get confused by later without the copy
   spelling it out.
7. **The wholesaler-conversion PATCH carries a richer audit summary** than the generic
   `diffFields` one — something like *"Type: regular → wholesaler (custom price saved from
   order #47)"* — so a future Audit Log reader can see *why* the type changed, not just that it
   did. Small addition at the one `PATCH /customers/:id` call site this flow uses.
8. **Saving a custom price and becoming a wholesaler are inseparable, always** — not just a UX
   choice but a load-bearing one; see
   [ADR 0001](../../adr/0001-wholesaler-status-gates-custom-pricing.md) for why decoupling them
   would silently orphan data given how the read side works today.
