# Custom Pricing Derived from Saved Prices; Customer Type Becomes Pure Descriptive Tag

**Status:** Settled (2026-08-25)  
**Origin:** Captain decision G16 (2026-08-25)  
**Supersedes:** [ADR 0001: Wholesaler status gates custom pricing](0001-wholesaler-status-gates-custom-pricing.md)  
**See also:** [V3.0 Proposal](../product/proposals/v3-0-pos-order-creation-in-v1.md), [Glossary](../product/glossary.md), [Database Reference](../architecture/DATABASE.md)

## Context

In Leyble Hub V1, `customer_type` was tightly coupled to pricing behaviour: the UI explicitly presented choices as "Regular Customer — Without Custom Prices" and "Wholesalers — With Custom Prices". Under [ADR 0001](0001-wholesaler-status-gates-custom-pricing.md), this coupling was enforced at the application level because `OrderCreateModal.jsx` only fetched and applied custom prices if `customer_type === 'wholesaler'`. If a `regular` customer had custom prices saved in `customer_product_prices`, those prices were silently ignored on every order — creating orphaned data. Consequently, saving a custom price prompt always forced a conversion from `regular` to `wholesaler`.

In V2, additional customer types (`discounted`, `markup`, `unassigned`) were introduced to tag customer relationships. However, because each non-regular type was treated identically to `wholesaler` on the read side (`['wholesaler', 'discounted', 'markup', 'unassigned'].includes(...)`), `customer_type` was performing two conflicting jobs: tagging *who* a customer is versus determining *how* they are priced. This introduced severe operational risk: if any new screen missed one of the five type checks, custom prices would silently fail to apply.

## Decision

We are decoupling custom pricing from `customer_type` entirely:

1. **Derived Pricing Rule:** Whether a customer receives custom pricing is derived dynamically from whether they have records in the `customer_product_prices` table for the specified `order_type`. If custom prices exist, they are loaded and applied; if none exist, base wholesale prices are used.
2. **`customer_type` as Pure Descriptive Tag:** The `customer_type` column becomes a purely descriptive label for store owners to categorize accounts (`regular`, `wholesaler`, `discounted`, `markup`). It carries zero pricing logic and affects no calculations.
3. **Collapsing `unassigned` into `regular`:** The redundant `unassigned` type is removed from UI options; any legacy records are mapped to `regular`. `Regular` remains the default for newly created customers.
4. **Simplified Custom Price Saving:** When an operator overrides a product price on an order and chooses to save it for the customer, the price is saved directly to `customer_product_prices`. No mutation of `customer_type` occurs.
5. **UI Label Clean-up:** Form dropdowns and detail panels display plain names ("Regular", "Wholesaler", "Discounted", "Markup") without "— With/Without Custom Prices" suffixes.

## Why ADR 0001's Objection Dissolves

ADR 0001 chose coupling because the legacy read path ignored custom prices for non-wholesalers, leaving dead rows. Under the new read rule ("always load saved custom prices whenever rows exist in `customer_product_prices`"), orphaned price rows cannot exist. A regular customer with agreed special rates will have those rates applied reliably without needing to be labeled a wholesaler.

## Considered Options

- **Option A: Derive Pricing from Saved Rates + Pure Descriptive Tag (Chosen)** — Derives pricing eligibility from the existence of price records and frees `customer_type` to serve purely as human-readable categorization. Eliminates orphaned price data and eliminates fragile multi-string type checks.
- **Option B: Stored Boolean Flag on Customers Table (Rejected)** — Adding a `has_custom_pricing` boolean column on `customers`. Rejected because stored boolean flags can drift out of sync with actual rows in `customer_product_prices`.
- **Option C: Tier-Based Percentage Discounts per Type (Rejected)** — Automating fixed % discounts based on customer type (e.g. 5% off for `discounted`). Rejected because the business operates on negotiated per-product prices, not blanket category percentages.
- **Option D: Retaining ADR 0001 Coupling (Rejected)** — Retaining wholesaler status gating. Rejected because it forces unwanted label conversions and creates silent pricing failures across multi-screen queries.

## Consequences

- ADR 0001 is formally superseded.
- Gating checks in order creation, customer panels, and price search queries are simplified to query `customer_product_prices` directly.
- The "Save custom price?" flow saves prices cleanly without triggering background customer conversions.
