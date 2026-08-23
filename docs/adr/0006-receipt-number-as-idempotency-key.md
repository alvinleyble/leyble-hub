# The Receipt Number is the Anti-Duplicate Key for a Resent Record

**Status:** Settled (2026-08-23)  
**Origin:** Captain decision D13 (2026-08-23)  
**See also:** [docs/product/proposals/v2-5-offline-accessibility.md](../product/proposals/v2-5-offline-accessibility.md), [ADR 0003](0003-device-issued-receipt-numbers.md), [ADR 0004](0004-local-first-pos.md), [docs/architecture/DATABASE.md](../architecture/DATABASE.md)

## Context

`POST /api/v1/orders` inserts a new `orders` row unconditionally. Nothing in the request identifies a retry, so nothing distinguishes a first attempt from a second.

That is tolerable while every save is a synchronous round trip a cashier is watching. It stops being tolerable under ADR 0004's local-first POS, where a background outbox retries on the device's behalf. ADR 0004 names the decisive case explicitly: a connection that is up but degraded, where the server receives the request, commits the order, and the response is lost on the way back. The outbox has no way to tell that from a request that never arrived, so it retries — and a retry against today's route is a second order for a sale that happened once.

This is the highest-stakes failure mode in the release. A dropped receipt is visible and recoverable; a silently duplicated one corrupts the sales record, the stock movements and the activity log at the same time, and nobody is looking for it.

ADR 0003 already establishes a value that is unique per receipt, generated before the request is ever made, and stable across every retry of it: the device-issued receipt number.

## Decision

The receipt number is the record's identity on the server, and therefore its anti-duplicate key.

1. **Sent With Every Queued Record:** The outbox includes the device-issued receipt number in every record it drains.
2. **Stored Decomposed, Displayed Derived:** The server stores `orders.receipt_station` and `orders.receipt_sequence`, with the display form (`1-00042`) as a `GENERATED ALWAYS AS ... STORED` column so it can never drift from the pair it derives from.
3. **Unique on Station + Sequence:** A **partial** unique index over rows that actually carry a receipt number. Partial rather than plain so that the rule states what it means — uniqueness applies to issued numbers only — and so the ~1,300 historical rows stay out of the index entirely. A `CHECK` keeps the pair whole, since a half-filled pair would otherwise slip past a partial index.
4. **A Second Arrival is a SUCCESS:** A receipt number already stored is answered with the stored order and `200 OK`. Never an error, never a `409`, never a second row. A pre-flight lookup handles the ordinary case; the unique index catches the race where two drain attempts overlap, and that loser is answered the same way.
5. **`201` vs `200`:** A fresh create returns `201`, a replay `200`. Both are successes and the device treats them identically; the distinction exists for logs and tests.
6. **Reusable, Not Order-Specific:** The mechanism lives in `server/src/lib/idempotency.js` against a table whitelist. Parked orders are `orders` rows and are already covered. Release 2's incoming deliveries adopt it by adding the same column pair and index to `supplier_deliveries` and registering the table.

## Considered Options

- **Option A: The Receipt Number as the Key (Chosen)** — The device already generates a value that is unique, stable across retries, and meaningful to a human reading the paper. Reusing it costs one column pair and one index, adds no new concept for the owners, and makes the resend rule legible in the database itself.
- **Option B: A Separate Client-Generated UUID per Request (Rejected)** — A second identifier alongside the receipt number, serving only the retry logic. Rejected as a duplicate of a key that already exists: two identities for one record invites them to disagree, and a UUID means nothing to anyone reading a row or a receipt.
- **Option C: Answer a Duplicate With `409 Conflict` (Rejected)** — Technically the more conventional status. Rejected because the device needs a *success* to clear the record from its outbox: an error response leaves it retrying forever an order the server already has, which is the stuck state this ADR exists to prevent. The response has to tell the device the truth — the receipt is safely stored — and a conflict does not say that.
- **Option D: Server-Side Dedupe by Content Hash (Rejected)** — Match on customer, items, total and timestamp. Rejected because two genuinely separate sales of the same goods to the same customer in the same minute are ordinary in this shop, and would be silently collapsed into one.

## Consequences

- A resend is invisible when it works. The owners never learn a new idea, and never see this fire.
- The unique index is over nullable columns and applies only to rows carrying a number, so the historical orders — which D1 forbids backfilling — are unaffected.
- The mechanism only protects records that carry a receipt number. A quick-created customer does not, so a retried customer create can still land twice; that case is covered by D4's duplicate surfacing rather than by this key.
- A malformed receipt number is refused with a `400` rather than being dropped. Silently ignoring an unparseable key would silently remove the protection it exists to provide.
