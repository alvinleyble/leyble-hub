# Local-First Architecture for POS Order Creation

**Status:** Settled (2026-08-23)  
**Origin:** Captain decision D2 (2026-08-23)  
**See also:** [docs/product/proposals/v2-5-offline-accessibility.md](../product/proposals/v2-5-offline-accessibility.md), [docs/adr/0003-device-issued-receipt-numbers.md](0003-device-issued-receipt-numbers.md), [docs/adr/0005-offline-scope-by-operation.md](0005-offline-scope-by-operation.md)

## Context

The store in Antipolo experiences weekly internet and electrical outages lasting anywhere from several hours to multiple days. In addition, mobile and broadband connections frequently enter degraded, high-latency states where HTTP requests hang and time out after 10–30 seconds.

In a fast-paced retail beverage distribution environment, cashier operations cannot block on unpredictable network round-trips. When a customer stands at the counter, saving an order and printing a receipt must complete instantly in all conditions.

## Decision

The POS operates as **local-first in every case**:

1. **Local Write on Save:** Every POS order creation, customer quick-create, and price capture writes immediately to durable client storage (IndexedDB) on the local device before touching the network.
2. **Instant Printing:** The thermal receipt prints immediately from local data without awaiting server confirmation or an HTTP response.
3. **Outbox Synchronization:** A background synchronization worker continuously monitors network connectivity and drains queued outbox records to the cloud backend API (`POST /api/v1/orders`) whenever a connection is available.
4. **No Special Offline Mode:** Offline is not a separate application mode, manual toggle, or alternative code path — it is simply an outbox that has not yet drained.
5. **Unified Code Path:** Online and offline transactions execute the exact same application code path every day of the year.

## Considered Options

- **Option A: Local-First in Every Case (Chosen)** — Orders are always written locally first, and an outbox drains in the background. Running the same code path 365 days a year ensures the offline mechanism is continuously exercised and verified during normal daily use, eliminating checkout latency and bit-rot.
- **Option B: Dual-Path Online/Offline Fallback (Rejected)** — Attempt a direct cloud API request first; if the request fails or times out, fall back to an offline local queue. Rejected because:
  1. The offline fallback path only runs during actual network outages, remaining untested during ordinary daily operations and failing when stress is highest.
  2. Degraded connections that hang or take 15–30 seconds to fail leave the cashier and customer waiting at the counter before falling back.
  3. Intermediate network failures (where the server receives and commits the order but the client connection drops before receiving the response) create ambiguous states that risk duplicate submissions.
- **Option C: Cloud-First with Optimistic UI (Rejected)** — Standard web optimistic UI rendering that rolls back state on network failure. Rejected because it cannot function across multi-day disconnected outages, requires an active internet connection to finalize transactions, and loses uncommitted state if the device restarts or loses power.
