# Glossary

Domain and codebase terms used across Leyble Hub. (Some historical terms are included because
they still appear in migrations and the archived spec.)

| Term | Meaning |
|---|---|
| **Leyble General Merchandise** | The business. Name used on receipts (the app/repo is "Leyble Hub"). |
| **Customer tag** | The descriptive categorization label on a customer record (`customer_type`: `regular`, `wholesaler`, `discounted`, `markup`). In V3.0, tags carry zero pricing logic; pricing is derived dynamically from whether custom rates exist in `customer_product_prices` ([ADR 0009](../adr/0009-custom-pricing-derived-from-saved-prices.md)). |
| **Regular customer** | Descriptive customer tag (`customer_type = 'regular'`). Default for newly created customers. Uses base wholesale pricing unless custom per-product rates are saved. |
| **Wholesaler customer** | Descriptive customer tag (`customer_type = 'wholesaler'`) identifying wholesale accounts. In V3.0, custom prices apply whenever saved in `customer_product_prices`, not gated by this tag ([ADR 0009](../adr/0009-custom-pricing-derived-from-saved-prices.md)). |
| **Suki** | Filipino term for a loyal/regular customer. Historical: an old `suki` customer type was renamed to **wholesaler** (migration 025). Not a current schema value. |
| **Base wholesale price** | `products.base_wholesale_price`. The single standard price model — retail price was dropped (012). |
| **`units_per_case`** | Bottles/units in one case. Defined on products, and copied onto `order_items` at order time. |
| **Case / half-case** | Orders and stock are tracked in cases and support `0.5` (half-case) quantities (`NUMERIC`). |
| **`deposit_fee`** | Per-bottle deposit amount on a product (refundable on bottle return). |
| **`unit_deposit_fee`** | Per-line copy of the deposit on `order_items` (can be overridden/waived per line). |
| **`requires_bottle_return`** | Product flag — whether its bottles are returnable and thus carry a refundable deposit. |
| **`bottles_returned`** | Bottles returned for an order line, recorded at delivery/pickup close. Deposit is charged only on bottles *not* returned. |
| **Deposit (refundable)** | Charged on un-returned bottles. Excluded from the order total while open/pending; folded into the total only when the order is marked **done** or reviewed at close. |
| **Order type** | `delivery` or `pickup`. Affects state machine transitions and whether delivery or pickup custom prices apply. |
| **Draft order** | `status = 'draft'`. A parked, incomplete order holding zero stock reservations. Auto-saves silently on customer and line selection. Synchronizes to cloud server when online and degrades to device-local storage during outages. Managed via the Drafts modal with search and bulk discard-all actions. Finalizing moves status to `pending`. |
| **Order status** | `draft → pending → in_transit → completed → done` (+ `cancelled`). Delivery transitions `pending → in_transit → completed → done`. Pickup transitions `pending → completed → done`. See [Order Lifecycle](../architecture/order-lifecycle.md). |
| **Batch review / Review Deliveries** | UI queues in Outgoing Orders for reviewing, editing, and closing multiple orders at once (including counting bottle returns at close). |
| **Adjustment** | Manual ± price correction on an order (`adjustment` + `adjustment_reason`) — e.g. a negotiated discount or fee. |
| **`order_personnel`** | Join table assigning drivers and helpers to orders (replaced legacy FK columns, migration 016). |
| **Driver / Helper** | Personnel roles on an order. **At most one Driver per order.** |
| **Inventory audit log** | Append-only `inventory_audit_logs` recording every stock delta and reason. API: `GET /api/v1/audit`. |
| **Activity log** | Append-only `activity_logs` — cross-entity audit trail (orders/customers/products/personnel/tickets). API: `GET /api/v1/audit/activity`. |
| **Void (delivery)** | Soft-delete of an incoming supplier delivery (migration 029): reverses the restock and hides the delivery, preserving audit log integrity. |
| **Receipt** | 80mm thermal printout; header displays **DELIVERY RECEIPT** or **PICKUP RECEIPT** based on order type. |
| **Receipt number** | `<station>-<sequence>` (e.g. `1-00042`) — the customer-facing and routing identity of an order, issued **by the device** at Save with no synchronous network round-trip. Stored decomposed as `orders.receipt_station` / `receipt_sequence` with a generated display column (migration 033). Acts as the primary route identifier (`/orders/<receipt-number>`) and idempotency key on sync ([ADR 0003](../adr/0003-device-issued-receipt-numbers.md), [ADR 0006](../adr/0006-receipt-number-as-idempotency-key.md), [ADR 0010](../adr/0010-receipt-number-addresses-order-across-sync-boundary.md)). Pre-V2.5 historical orders keep reading as `#<id>`. |
| **Station** | A registered physical tablet device, and its permanent integer ID (1, 2, …) — the prefix of every receipt number issued by that device. Claimed once at install via `POST /api/v1/stations/register` using a unique `device_key`, and held permanently in native storage (`@capacitor/preferences`). Numbers only increment and are never reused. Desktop browsers serve as a development tier with persistent `localStorage` registration labeled `dev — <hostname>` ([ADR 0011](../adr/0011-tablets-as-stations-browser-as-dev-tier.md)). |
| **Waiting receipts / Outbox** | Queued records (orders, customer quick-creates, custom prices) saved locally in native device storage under `v25.outbox.*` that have not yet synced with the cloud database. Drained oldest-first in the background upon connectivity. Monitored via the top-bar connection marker. |
| **Needs attention / Attention list** | Queue of outbox records rejected by the server (e.g. referencing a customer account merged or deactivated on another tablet during an outage). Never auto-merged or discarded; flagged via a pulsing red top-bar marker for manual operator reassignment ([`NeedsAttentionModal.jsx`](../../client/src/components/pos/NeedsAttentionModal.jsx)). |
| **Offline mode** | Not a mode. There is no manual toggle and no separate offline code path — offline operation is simply an outbox that has not yet drained, running on the standard local-first path every day ([ADR 0004](../adr/0004-local-first-pos.md)). |
| **Possible duplicate** | An order or customer record flagged for human review (e.g. duplicate customer names created on disconnected tablets, or orders printed from stale parked drafts) surfaced via filter chips rather than being destructively merged. |
| **`device_key`** | A UUID generated by the device at installation and stored natively. Serves as the idempotency key for station registration to ensure repeated registration calls return the same station number. |
| **Sale time** | An order's `created_at` timestamp captured from the **device clock** at the instant of Save, ensuring printed receipts, daily sales filters, and reprints match physical paper records regardless of when outbox drain occurs. |
| **Device state** | Persistent native device storage (`@capacitor/preferences` under `v25.*`) holding the station number, outbox queue, and rolling 30-day receipt cache. Survives user logout and re-login ([ADR 0007](../adr/0007-native-storage-for-device-state.md)). |
| **Release switch (`V25_OFFLINE_CORE`)** | Historical build-time flag used during V2.5 development to land the offline core in four dark PRs. Retired in V3.0 ([ADR 0013](../adr/0013-unswitched-offline-core-no-flag-rollback.md)); the offline core is permanently active. |

See also: [PRD](PRD.md) · [Database Reference](../architecture/DATABASE.md) · [V3.0 Proposal](proposals/v3-0-pos-order-creation-in-v1.md) · [V2.5 Offline Accessibility](proposals/v2-5-offline-accessibility.md).
