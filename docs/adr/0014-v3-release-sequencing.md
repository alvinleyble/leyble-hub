# V3.0 Release Sequencing: Database Changes Deploy Ahead of Server and APK

**Status:** Settled (2026-08-25)  
**Origin:** Captain decision (2026-08-25)  
**Decision ID:** V3-D19  
**Extended:** 2026-09-03 with the switchover ordering for [ADR 0017](0017-receipt-numbers-keyed-to-user-accounts.md) (see the last section)  
**See also:** [ADR 0009: Custom Pricing Derived from Saved Prices](0009-custom-pricing-derived-from-saved-prices.md), [ADR 0012: Stock Deducts at Dispatch, Not at Save](0012-stock-deducts-at-dispatch-not-at-save.md), [V3.0 Proposal](../product/proposals/v3-0-pos-order-creation-in-v1.md)

## Context

Deploying Leyble Hub V3.0 involves three interdependent components: the PostgreSQL database hosted on Supabase, the Node.js/Express API server hosted on Render, and the Android APK running on physical tablets in the store in Antipolo.

Analysis of the deployment configuration and repository codebase establishes the following operational facts:

1. **Automatic Production Deployment from `main`:**  
   As defined in [`render.yaml`](../../render.yaml) (`production` environment, `branch: main`), the hosted API server redeploys automatically whenever changes are pushed or merged to `main`. The physical tablets in the store communicate directly with this hosted API. Any commit merged to `main` reaches live production within minutes, requiring no APK update and zero action from the store owners.

2. **Automated Migration Execution on Build:**  
   The Render service build command (`npm --prefix server install && node server/db/migrate.js`) executes [`server/db/migrate.js`](../../server/db/migrate.js) against the production database on every deploy. When code merges to `main`, pending migrations are applied automatically during deployment. There is no separate schema step or pause during a standard `main` deploy.

3. **Status and Safety of Pending Migrations:**  
   Migrations `031`, `032`, and `033` have never been applied to production (verified against the live database on 2026-08-25; the `_migrations` tracking table stops at `030`). All three migrations are strictly additive:
   - [`031_add_discounted_and_unassigned_customer_types.sql`](../../server/db/migrations/031_add_discounted_and_unassigned_customer_types.sql) and [`032_add_markup_customer_type.sql`](../../server/db/migrations/032_add_markup_customer_type.sql) widen the `customers_customer_type_check` check constraint.
   - [`033_stations_and_receipt_numbers.sql`](../../server/db/migrations/033_stations_and_receipt_numbers.sql) creates the `stations` table and sequence, and adds nullable `receipt_station`, `receipt_sequence`, and generated `receipt_number` columns along with a partial unique index to `orders`.
   - Nothing is dropped, renamed, or retyped. Existing queries in the running V1 server continue functioning without disruption because the new columns are nullable and the check constraints are purely permissive.

4. **Risk of Invisible Behavioral Shifts:**  
   Two major changes in V3.0 have no visible UI manifestation:
   - **Custom Pricing Derivation (G16 / ADR 0009 / V3-D15):** The server and order calculations begin applying saved prices from `customer_product_prices` across all customer tags.
   - **Stock Deduction Timing (G4 / ADR 0012 / V3-D3):** Stock deduction logic reverts from order save back to status transitions at dispatch (`in_transit` / `completed`).
   
   If backend changes reached `main` before the new APK was installed on store tablets, the tablets' pricing and inventory deduction behaviors would alter immediately while the tablet interface looked completely identical to operators.

## Decision

We are establishing a strict two-stage rollout sequence for the V3.0 release:

1. **Stage 1 (Ahead of Release Day): Database Migrations Deploy Early and Alone**  
   Migrations `031`, `032`, and `033` are applied to the production database prior to release day (executed manually or via an isolated migration run against production Supabase). Because the migrations are purely additive and backward-compatible, the live V1 server and existing V1 tablet APKs continue operating normally without interruption.

2. **Stage 2 (Release Day): Server and Android APK Land Together**  
   On release day, the V3.0 application code is merged to `main` (triggering the automatic Render API deployment) at the exact same time the new signed V3.0 Android APK is sideloaded onto the store tablets. The UI changes and backend behavioral shifts take effect concurrently.

```
Stage 1 (Ahead of Release Day):
  Apply Migrations 031–033 ──► Production Supabase DB
  (Live V1 Server & V1 APK continue running with zero downtime)

Stage 2 (Release Day):
  Merge V3.0 to main       ──► Render API Server Redeploys
  Sideload V3.0 APK        ──► Store Tablets Updated
  (Backend logic and new POS UI activate concurrently)
```

## Considered Options

- **Option A: Database First, Server and APK Together on Release Day (Chosen)** — Isolates schema migration risk ahead of time, ensures zero downtime for the running store, and eliminates the window where backend logic alters pricing and stock behavior on old UI screens.
- **Option B: Single Deploy on Release Day via `main` (Rejected)** — Merging server code and migrations together on release day and letting Render apply migrations during build. Rejected because backend code and schema changes go live immediately upon merge, creating an uncontrolled window where tablets run the old V1 APK against new pricing and stock deduction logic before the APK can be sideloaded.
- **Option C: APK Update Before Server Deploy (Rejected)** — Sideloading the V3.0 APK before deploying server changes. Rejected because the V3.0 APK relies on server endpoints and database columns (`stations`, `receipt_station`, `receipt_sequence`) that must be present before local-first orders and station registrations can drain.

## Consequences

- Database migrations `031`–`033` are verified in production ahead of release day, eliminating database migration surprises during store release.
- Store operators experience no unexpected pricing or inventory shifts on their existing tablets prior to the scheduled APK upgrade.
- The release procedure accounts for Render's automated `main` deployment architecture without requiring changes to hosting infrastructure.

---

## Switchover Ordering for the Receipt-Number Format Change (ADR 0017)

[ADR 0017](0017-receipt-numbers-keyed-to-user-accounts.md) changes the receipt-number format from `<station>-<sequence>` to `<person><device letter>-<sequence>`.
This section records the release ordering it requires.
Nothing here is built yet; it is the sequence to follow when it is.

The hazard is not the schema, it is the window.
Tablets are updated one at a time over several days, and during that window some devices are still holding unsynced receipts issued in the old format.
Those receipts must still be accepted when they finally drain, however long that takes.

1. **Deploy the server change that accepts both formats.**
   Old-format and new-format receipt numbers and delivery references both parse, store and resolve.
   Nothing visible changes for anyone; no tablet has been updated yet.
2. **Wait until every tablet reports no waiting receipts.**
   This is read off the top-bar connection marker on each device, not inferred from the server.
3. **Then update tablets, one at a time.**
   A tablet that has been updated issues new-format numbers; one that has not still issues old-format numbers, and step 1 means the server takes both.
4. **Never remove old-format acceptance.**
   The roughly 1,300 legacy `#<id>` orders and every `3-00061` pre-letter order are permanent and are never backfilled ([ADR 0017](0017-receipt-numbers-keyed-to-user-accounts.md) #12), so read paths must keep resolving all three shapes forever.

One separate prerequisite, unrelated to the window: `assertIssuableStation` (since ADR 0017 in [`server/src/lib/personNumbers.js`](../../server/src/lib/personNumbers.js), formerly `stationSlots.js`) refused any station outside 1-3.
It must be widened before a fourth person is ever created, or that person's first sale is rejected at `POST /orders`.

### Why commit `b1547ef` reverted the earlier receipt-number release

Recorded in full in [ADR 0017's Context](0017-receipt-numbers-keyed-to-user-accounts.md#why-commit-b1547ef-exists).
In short: the work was merged into `main` when the captain had asked for it to be wrapped up to `dev`, and the revert undid a wrong merge target.
It was not a rejection of the design and not a bug rollback.
