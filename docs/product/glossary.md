# Glossary

Domain and codebase terms used across Leyble Hub. (Some historical terms are included because
they still appear in migrations and the archived spec.)

| Term | Meaning |
|---|---|
| **Leyble General Merchandise** | The business. Name used on receipts (the app/repo is "Leyble Hub"). |
| **Regular customer** | `customer_type = 'regular'`. Uses the product's base wholesale price; no custom pricing. Default for new customers. |
| **Wholesaler customer** | `customer_type = 'wholesaler'`. Can have custom per-product prices, set separately for delivery and pickup. |
| **Suki** | Filipino term for a loyal/regular customer. Historical: an old `suki` customer type was renamed to **wholesaler** (migration 025). Not a current value. |
| **Base wholesale price** | `products.base_wholesale_price`. The single price model — retail price was dropped (012). |
| **`units_per_case`** | Bottles/units in one case. On products, and cached onto `order_items` at order time. |
| **Case / half-case** | Orders and stock are tracked in cases and support `0.5` (half-case) quantities (`NUMERIC`). |
| **`deposit_fee`** | Per-bottle deposit amount on a product (refundable on bottle return). |
| **`unit_deposit_fee`** | Per-line copy of the deposit on `order_items` (can be overridden/waived per line). |
| **`requires_bottle_return`** | Product flag — whether its bottles are returnable and thus carry a deposit. |
| **`bottles_returned`** | Bottles returned for an order line, recorded at close. Deposit is charged only on bottles *not* returned. |
| **Deposit (refundable)** | Charged on un-returned bottles. Excluded from the order total while open; folded in only when the order is **done**. |
| **Order type** | `delivery` or `pickup`. Affects status flow and which custom price applies. |
| **Draft order** | `status = 'draft'`. A parked, possibly-incomplete order. Reserves no stock; hidden except the Drafts tab. Finalizing → `pending`. |
| **Order status** | `draft → pending → in_transit → completed → done` (+ `cancelled`). Pickup skips `in_transit`. See [order-lifecycle](../architecture/order-lifecycle.md). |
| **Batch review / Review Deliveries** | UI queues for reviewing/editing/closing multiple orders at once (incl. counting bottle returns at close). |
| **Adjustment** | Manual ± correction on an order (`adjustment` + `adjustment_reason`) — e.g. a discount. |
| **`order_personnel`** | Join table assigning drivers/helpers to orders (replaced FK columns, migration 016). |
| **Driver / Helper** | Personnel roles on an order. **At most one Driver per order.** |
| **Inventory audit log** | Append-only `inventory_audit_logs` — every stock delta. API: `GET /api/v1/audit`. |
| **Activity log** | Append-only `activity_logs` — cross-entity change log (orders/customers/products/personnel/tickets). API: `GET /api/v1/audit/activity`. |
| **Void (delivery)** | Soft-delete of a supplier delivery (migration 029): reverses the restock and hides it, but keeps the row because audit logs reference it. |
| **Receipt** | 80mm thermal printout; **DELIVERY RECEIPT** or **PICKUP RECEIPT** depending on order type. |
| **PWA** | The website form of the app (Add to Home Screen) — same build as the Android APK. |

See also: [PRD](PRD.md) · [Database Reference](../architecture/DATABASE.md).
