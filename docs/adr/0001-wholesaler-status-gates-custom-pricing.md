# Wholesaler status gates custom pricing, even though the schema doesn't enforce it

`customer_product_prices` (migration 004) has no database constraint tying it to
`customer_type`. We're keeping "has custom prices" and "is a wholesaler" coupled at the
application level anyway, because the *read* side isn't built to support decoupling them:
`OrderCreateModal.jsx` only loads and applies a customer's custom prices when
`customer_type === 'wholesaler'`. A `regular` customer with saved `customer_product_prices` rows
would have those rows silently ignored on every future order — orphaned data with no visible
effect. So the "save custom price" flow
([docs/product/proposals/save-custom-price-prompt.md](../product/proposals/save-custom-price-prompt.md))
always converts a regular customer to wholesaler in the same action that saves their first
custom price; the two can't be decoupled without also reworking the read side.

## Considered options

- **Decouple** — let any customer have saved custom prices regardless of `customer_type`, and
  let a human flip `customer_type` separately whenever they choose. Rejected: the app would
  never read those prices back for a `regular` customer, so this silently accumulates dead data.
- **Couple (chosen)** — saving a customer's first custom price and becoming a wholesaler always
  happen together, as one action.
