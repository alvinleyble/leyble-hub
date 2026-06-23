# Leyble Hub

Private, internal admin app for **Leyble General Merchandise** — a wholesale beverage distributor
in Antipolo, Philippines. Manages outgoing orders, incoming supplies, inventory, customers, and
personnel. Not customer-facing. Ships **only** as an Android APK (Capacitor), backed by a
cloud Express + PostgreSQL API (no web client).

## Tech stack

| Layer | Technology |
|---|---|
| Frontend | React 18, Vite, Tailwind CSS v3 |
| Backend | Node.js + Express, raw `pg` (no ORM) |
| Auth | JWT — Bearer token (native app) / HTTP-only SameSite=Strict cookie (local browser dev only) |
| Database | PostgreSQL 15+ |
| Hosting | Express on Render, Postgres on Supabase |

## Quick start

```bash
# backend (port 3000)
cd server && node src/index.js
# frontend (port 5173)
cd client && npm run dev
```

Full setup (DB, env, migrate, seed): **[docs/operations/local-development.md](docs/operations/local-development.md)**.

## Documentation

All docs live in **[`docs/`](docs/README.md)**. Start with the
**[AI Context Primer](docs/AI_CONTEXT.md)** for a full-system overview.

| | |
|---|---|
| Product requirements | [docs/product/PRD.md](docs/product/PRD.md) |
| Glossary | [docs/product/glossary.md](docs/product/glossary.md) |
| Architecture | [docs/architecture/ARCHITECTURE.md](docs/architecture/ARCHITECTURE.md) |
| Database reference | [docs/architecture/DATABASE.md](docs/architecture/DATABASE.md) |
| API reference | [docs/architecture/API.md](docs/architecture/API.md) |
| Order lifecycle | [docs/architecture/order-lifecycle.md](docs/architecture/order-lifecycle.md) |
| Local dev | [docs/operations/local-development.md](docs/operations/local-development.md) |
| Android build / deploy | [docs/operations/android.md](docs/operations/android.md) |

Agent/contributor working rules: **[CLAUDE.md](CLAUDE.md)**.
