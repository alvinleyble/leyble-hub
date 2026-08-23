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
| **Draft order** | `status = 'draft'`. A parked, possibly-incomplete order. Reserves no stock; hidden except the Drafts popup. In V2.0+ it syncs to the server and is shared across devices; offline degradation to device-local drafts is planned for V2.5 (see [proposal](proposals/v2-5-offline-accessibility.md)). Finalizing → `pending`. |
| **Order status** | `draft → pending → in_transit → completed → done` (+ `cancelled`). Pickup skips `in_transit`. See [order-lifecycle](../architecture/order-lifecycle.md). |
| **Batch review / Review Deliveries** | UI queues for reviewing/editing/closing multiple orders at once (incl. counting bottle returns at close). |
| **Adjustment** | Manual ± correction on an order (`adjustment` + `adjustment_reason`) — e.g. a discount. |
| **`order_personnel`** | Join table assigning drivers/helpers to orders (replaced FK columns, migration 016). |
| **Driver / Helper** | Personnel roles on an order. **At most one Driver per order.** |
| **Inventory audit log** | Append-only `inventory_audit_logs` — every stock delta. API: `GET /api/v1/audit`. |
| **Activity log** | Append-only `activity_logs` — cross-entity change log (orders/customers/products/personnel/tickets). API: `GET /api/v1/audit/activity`. |
| **Void (delivery)** | Soft-delete of a supplier delivery (migration 029): reverses the restock and hides it, but keeps the row because audit logs reference it. |
| **Receipt** | 80mm thermal printout; **DELIVERY RECEIPT** or **PICKUP RECEIPT** depending on order type. |
| **Receipt number** | `<station>-<sequence>` (e.g. `1-00042`) — the customer-facing identity of a receipt, issued **by the device** at Save with no server round trip, online or offline. Stored decomposed as `orders.receipt_station` / `receipt_sequence` with the display form a `GENERATED` column (migration 033). It is also the anti-duplicate key: a resend of a number already stored is answered as success, never as a second order ([ADR 0006](../adr/0006-receipt-number-as-idempotency-key.md)). Orders predating V2.5 have none and keep reading as `#<id>`. |
| **Station** | A registered device, and its number (1, 2, …) — the prefix of every receipt that device issues. Claimed once at install via `POST /api/v1/stations/register`, keyed on a device-generated `device_key`, and then held permanently in native storage. Numbers come from a sequence, so they only creep upward: a wiped device gets a new one, never its old one. Not the active profile — that identifies the person and can be switched. |
| **Waiting receipts / Outbox** | Records saved on a device and not yet accepted by the server. Held in native storage under `v25.outbox.*`, one key per record, drained oldest first in the background. Each record carries the profile that was active when it was saved, so attribution follows the sale rather than whoever is holding the tablet at drain time. Counted by D7's `Offline · N waiting` marker. |
| **Offline mode** | Not a mode. There is no toggle and no second code path — "offline" is simply an outbox that has not drained yet, on the same local-first path the app runs every day. |
| **Attention list** | The short queue of outbox records the server refused (a merged or deactivated customer, a deleted product). Never discarded and never auto-resolved: each waits with a plain-language reason until the owner points it at the right record. A network failure or a 5xx does **not** land here — those stay queued and retry. |
| **Possible duplicate** | A record (e.g. customer created offline with the same name on two devices, or an order printed on both devices from a stale parked draft) flagged for human review and merge rather than being automatically overwritten or joined. |
| **`device_key`** | A UUID the device generates for itself at install and stores natively. The idempotency key for station registration: a retried register call returns the same station rather than claiming a second one. A reinstall generates a new one, which is how a wiped device gets a new station number. |
| **Sale time** | An order's `created_at` — the **device's** clock at Save, not the server's insert time, so a Tuesday outage's sales are filed under Tuesday and a reprint agrees with the paper in the customer's hand. Same pattern as `supplier_deliveries.received_at`. No clock-skew checking is performed. |
| **Device state** | The station number, the outbox and the 30-day local receipt history: everything under the `v25.` native-storage prefix. Belongs to the tablet, not to the session — it survives logout and re-login, and never lives in `localStorage` or IndexedDB ([ADR 0007](../adr/0007-native-storage-for-device-state.md)). |
| **Release switch (`V25_OFFLINE_CORE`)** | The build-time flag the whole V2.5 offline core sits behind, off by default. The core lands as four reviewable pieces and is switched on as one release ([ADR 0008](../adr/0008-release-switch-for-the-offline-core.md)). |

See also: [PRD](PRD.md) · [Database Reference](../architecture/DATABASE.md) · [V2.5 Offline Accessibility](proposals/v2-5-offline-accessibility.md).
