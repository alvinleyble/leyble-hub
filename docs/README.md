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
- [product/proposals/v2-5-offline-accessibility.md](product/proposals/v2-5-offline-accessibility.md) — V2.5 offline / local-first POS, all eighteen settled decisions.

### Architecture & technical
- [architecture/ARCHITECTURE.md](architecture/ARCHITECTURE.md) — stack, topology, auth, layout.
- [architecture/DATABASE.md](architecture/DATABASE.md) — current schema (reconciled to migrations 001–033).
- [architecture/API.md](architecture/API.md) — REST endpoint reference.
- [architecture/order-lifecycle.md](architecture/order-lifecycle.md) — order status, stock, deposit/bottle-return math.

### Decision records (ADRs)
- [adr/](adr/) — one file per settled architectural decision. V2.5 offline core:
  [0003](adr/0003-device-issued-receipt-numbers.md) device-issued receipt numbers,
  [0004](adr/0004-local-first-pos.md) local-first POS,
  [0005](adr/0005-offline-scope-by-operation.md) offline scope by operation,
  [0006](adr/0006-receipt-number-as-idempotency-key.md) the receipt number as the anti-duplicate key,
  [0007](adr/0007-native-storage-for-device-state.md) native storage for device state,
  [0008](adr/0008-release-switch-for-the-offline-core.md) the release switch.

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
