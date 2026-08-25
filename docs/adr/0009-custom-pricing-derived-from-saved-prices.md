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

## Production Data Audit & Price Audit Correction

An audit of the live production database on 2026-08-25 verified that 35 live customer accounts carry `discounted` (27) or `markup` (8) tags representing 230 saved price rows, and 4 `regular` customers hold saved prices. Under V1, these agreed prices were dead because V1 strictly gated on `customer_type === 'wholesaler'` (`OrderCreateModal.jsx:104-105`).

A preliminary scan raised concern that out-of-band price entries in `customer_product_prices` (e.g. ₱73,200 for a ₱736 product) would become active upon releasing G16, creating a requirement for a pre-release price audit. However, code and database verification confirmed:
1. `customer_product_prices` is strictly **append-only** (`POST /api/v1/customers/:id/prices` executes `INSERT INTO customer_product_prices ...`).
2. The read path (`server/src/routes/customers.js`, `GET /customers/:id/prices` via `SELECT DISTINCT ON (cpp.product_id) ... ORDER BY cpp.product_id, cpp.created_at DESC`) returns **only the most recent row per customer, product, and order type**. Both the customer profile and order modal consume this exact query.
3. All seven out-of-band rows were superseded by subsequent corrected rows (centavo-style entry slips corrected within minutes). They are dead history in an append-only log.
4. Consequently, no database cleanup is required, and the price audit is **not** a prerequisite of G16.

### Live Customer Impact on Release Day

Under G16, agreed prices begin applying automatically for live customer accounts on release day:

| Tag | Customers | Current saved prices | Effect against base price |
| :--- | ---: | ---: | :--- |
| `discounted` | 27 | 195 | 193 below base; average ₱5.51 lower per case, largest ₱20 |
| `markup` | 8 | 13 | 12 above base; average ₱2.92 higher per case, largest ₱5 |
| `regular` | 4 | 6 | mostly equal to base; one ₱40 below |

This is a correction rather than a new pricing policy: operators previously had to type these negotiated prices in manually from memory, leading to inconsistent billing across orders. As an operational consequence (not a decision), affected customer order totals will visibly change on release day, so store owners should be notified prior to release.

## Considered Options

- **Option A: Derive Pricing from Saved Rates + Pure Descriptive Tag (Chosen)** — Derives pricing eligibility from the existence of price records and frees `customer_type` to serve purely as human-readable categorization. Eliminates orphaned price data and eliminates fragile multi-string type checks.
- **Option B: Stored Boolean Flag on Customers Table (Rejected)** — Adding a `has_custom_pricing` boolean column on `customers`. Rejected because stored boolean flags can drift out of sync with actual rows in `customer_product_prices`.
- **Option C: Tier-Based Percentage Discounts per Type (Rejected)** — Automating fixed % discounts based on customer type (e.g. 5% off for `discounted`). Rejected because the business operates on negotiated per-product prices, not blanket category percentages.
- **Option D: Retaining ADR 0001 Coupling (Rejected)** — Retaining wholesaler status gating. Rejected because it forces unwanted label conversions and creates silent pricing failures across multi-screen queries.

## Consequences

- ADR 0001 is formally superseded.
- Gating checks in order creation, customer panels, and price search queries are simplified to query `customer_product_prices` directly.
- The "Save custom price?" flow saves prices cleanly without triggering background customer conversions.
- The 35 `discounted` and `markup` customers' agreed prices apply automatically on order creation.

## Implementation notes (V3.0 Slice 2)

- Migration `034_collapse_unassigned_customer_type.sql` relabels any `unassigned` row to `regular` and narrows the check constraint to the four surviving types.
- The read rule lives in one place client-side: `hasCustomPricing()` in [`client/src/utils/customerTypes.js`](../../client/src/utils/customerTypes.js), alongside the shared labels/badges and `normalizeCustomerType()` (which keeps any pre-034 payload reading as `Regular`). The repeated `['wholesaler','discounted','markup','unassigned'].includes(...)` checks — the exact fragility this ADR names — are gone from every screen.
- The "Save custom price?" prompt is one step everywhere (V1 `OrderCreateModal`, V2 `POSSavePriceModal`); the second "Select Customer Type" step and its `PATCH /customers/:id` conversion call are removed.

