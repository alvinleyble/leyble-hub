# Leyble Hub — Documentation

Internal admin app for **Leyble General Merchandise**, a wholesale beverage distributor in
Antipolo, Philippines. This folder is the single home for project documentation.

## Start here

- 🤖 **[AI_CONTEXT.md](AI_CONTEXT.md)** — orientation primer. Read this first (humans and AI) to
  understand the whole system before touching the code.
- For agent *working rules* (git policy, conventions, reporting), see [../CLAUDE.md](../CLAUDE.md).

## Map

### Product
- [product/PRD.md](product/PRD.md) — what the app is, who uses it, goals, modules, business rules.
- [product/glossary.md](product/glossary.md) — domain & codebase terms.
- [product/proposals/v3-0-pos-order-creation-in-v1.md](product/proposals/v3-0-pos-order-creation-in-v1.md) — V3.0 POS-style order creation in V1, settled decisions and re-hosted offline core.
- [product/proposals/v2-5-offline-accessibility.md](product/proposals/v2-5-offline-accessibility.md) — V2.5 offline / local-first POS, all eighteen settled decisions.

### Architecture & technical
- [architecture/ARCHITECTURE.md](architecture/ARCHITECTURE.md) — stack, topology, auth, layout.
- [architecture/DATABASE.md](architecture/DATABASE.md) — current schema (reconciled to migrations 001–033).
- [architecture/API.md](architecture/API.md) — REST endpoint reference.
- [architecture/order-lifecycle.md](architecture/order-lifecycle.md) — order status, stock, deposit/bottle-return math.

### Decision records (ADRs)
- [adr/](adr/) — one file per settled architectural decision.
  - Offline core & receipt numbering:
    [0003](adr/0003-device-issued-receipt-numbers.md) device-issued receipt numbers,
    [0004](adr/0004-local-first-pos.md) local-first POS,
    [0005](adr/0005-offline-scope-by-operation.md) offline scope by operation,
    [0006](adr/0006-receipt-number-as-idempotency-key.md) receipt number as idempotency key,
    [0007](adr/0007-native-storage-for-device-state.md) native storage for device state,
    [0008](adr/0008-release-switch-for-the-offline-core.md) release switch *(superseded by 0013)*.
  - V3.0 architecture:
    [0009](adr/0009-custom-pricing-derived-from-saved-prices.md) custom pricing derived from saved prices *(supersedes 0001)*,
    [0010](adr/0010-receipt-number-addresses-order-across-sync-boundary.md) receipt number addresses order across sync boundary,
    [0011](adr/0011-tablets-as-stations-browser-as-dev-tier.md) tablets as stations / browser as dev tier,
    [0012](adr/0012-stock-deducts-at-dispatch-not-at-save.md) stock deducts at dispatch *(provisional)*,
    [0013](adr/0013-unswitched-offline-core-no-flag-rollback.md) unswitched offline core *(supersedes 0008)*.

### Operations
- [operations/local-development.md](operations/local-development.md) — run it locally.
- [operations/android.md](operations/android.md) — build & sideload the Android APK; cloud setup.

### Archive (historical, not maintained)
- [archive/SPECIFICATION.md](archive/SPECIFICATION.md) — original spec (superseded; predates migrations 012–029).
- [archive/ORDERS_AUDIT.md](archive/ORDERS_AUDIT.md) — one-off Orders bug-sweep snapshot.

## Source of truth

When docs and code disagree, the **code wins** — specifically the migrations in
`server/db/migrations/`, the route files in `server/src/routes/`, and `CLAUDE.md`. These docs are
derived from those and should be updated alongside them.
