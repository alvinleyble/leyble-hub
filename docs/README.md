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

### Architecture & technical
- [architecture/ARCHITECTURE.md](architecture/ARCHITECTURE.md) — stack, topology, auth, layout.
- [architecture/DATABASE.md](architecture/DATABASE.md) — current schema (reconciled to migrations 001–029).
- [architecture/API.md](architecture/API.md) — REST endpoint reference.
- [architecture/order-lifecycle.md](architecture/order-lifecycle.md) — order status, stock, deposit/bottle-return math.

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
