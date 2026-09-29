# Proposal: Combined customer-defaults save prompt

**Status:** Shipped — `OrderCreateModal.jsx` (`defaultsPrompt`/`persistDefaultsSave`).
**Origin:** captain-approved launch brief, 2026-09-12.
**See also:** [save-custom-price-prompt.md](./save-custom-price-prompt.md) (the original,
price-only prompt this supersedes), [persistent-delivery-fee.md](./persistent-delivery-fee.md)
(the delivery fee this now also offers to save), [ADR 0009](../../adr/0009-custom-pricing-derived-from-saved-prices.md).

## The idea

Before this, a custom product price hand-typed during order creation had its own
"Save Custom Price?" prompt at save time. A delivery fee typed or changed in the same order
had no equivalent — it only ever applied to that one order; the customer's standing fee could
only be changed on the Customer edit form. If an operator changed both a price and the delivery
fee on the same order, they would (in a naive implementation) see two sequential prompts. This
proposal combines both into one confirmation surface.

## Current state (as of this writing)

- Custom pricing: `dirtyItems` in `OrderCreateModal.jsx`'s `handleSubmit` — a line whose typed
  `unit_price` differs from `priceFor(product)` (the customer's saved rate, or base wholesale
  price) at submit time.
- Delivery fee: `orders.delivery_fee_charged` (persistent-delivery-fee.md) auto-fills per order
  from `customers.delivery_fee` but had no path back to the customer record from the order form.

## Decisions

1. **One combined modal, not two sequential ones.** Whichever of "a price is dirty" and "the
   delivery fee changed relative to the customer's saved default" are true this save, both show
   in the same `Modal`, titled "Save as Customer Defaults?".
2. **Each kind lists independently and is selected by default.** A checkbox per kind (not per
   product line — the existing per-product list still renders under the price checkbox). Only a
   selected kind's write is enqueued; the order itself is completely unaffected either way (it
   already saved before this prompt appears, same as the original price-only prompt).
3. **No prompt when nothing is eligible.** If neither kind changed relative to its saved default,
   `handleSubmit` calls `onSaved(orderId)` directly — no modal ever mounts.
4. **Detecting a dirty delivery fee requires an actual edit this session, not just a stale
   snapshot.** Gated on `deliveryFeeEdited` (the operator touched the field) *and* the final
   value disagreeing with the customer's current `delivery_fee` — an auto-filled, untouched value
   is by definition unchanged, and a real-edit order whose stored fee predates a later change to
   the customer's default must not itself trigger the prompt.
5. **The two kinds keep their pre-existing connectivity behavior, independently.** Custom pricing
   still requires `checkIsOnline()` (`customer_product_prices` has no unique constraint — two
   offline tablets could otherwise both write silently, see the comment in `handleSubmit`); the
   delivery fee has no such hazard (a plain mutable column, already offline-capable elsewhere via
   `updateCustomerLocalFirst`) and is eligible regardless of connectivity. Offline with only a
   dirty price: no prompt at all, exactly as before. Offline with only a dirty fee: prompt shows,
   fee-only.
6. **Both writes route through the outbox** (`enqueue`), matching the original price prompt and
   supporting a still-`local-` (quick-created-this-order) customer via the same
   `endpointParams`/`dependsOn` `$ref` mechanism. The delivery fee write is a `customer_update`
   PATCH (`{ delivery_fee }`), the same entity type and shape `CustomerDetailPanel.jsx` already
   uses for an offline profile edit — so it also surfaces on the "waiting to sync" badges that key
   off `customer_update` today.

## Not in scope

- No redesign of the delivery fee feature itself, or of how/where it is configured outside this
  prompt.
- No change to when or how a price becomes eligible for its own prompt (decision 1 in
  save-custom-price-prompt.md still governs "dirty").
