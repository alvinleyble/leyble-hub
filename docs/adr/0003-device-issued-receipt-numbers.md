# Device-Issued Receipt Numbers Decoupled from Database Row IDs

**Status:** Settled (2026-08-23)  
**Origin:** Captain decision D1 (2026-08-23)  
**See also:** [docs/product/proposals/v2-5-offline-accessibility.md](../product/proposals/v2-5-offline-accessibility.md), [docs/product/glossary.md](../product/glossary.md), [docs/architecture/DATABASE.md](../architecture/DATABASE.md)

## Context

In Leyble Hub V1 and V2.0, an order's printed and displayed receipt number was identical to the internal PostgreSQL primary key sequence (`orders.id`). When generating orders offline during network outages (which occur roughly weekly in Antipolo and last from several hours to multiple days), multiple devices (e.g. Honor Pad X8B station 1 and a second tablet/phone station 2) must issue printed paper receipts immediately at checkout without performing a synchronous network round-trip to the cloud database.

If receipt numbering remains tied to server-generated database row IDs, an offline tablet cannot determine what number to print on the physical receipt handed to the customer.

## Decision

We are decoupling the customer-facing receipt number from the internal database row ID (`orders.id`), establishing per-device station number spaces:

1. **First-Class Domain Concept:** `receipt_number` is a first-class domain concept generated locally by the device at the moment an order is saved. Online and offline transactions execute the exact same numbering code path every day.
2. **Format:** `<station>-<sequence>`, e.g., `1-00042`, `2-00042` (with zero-padded sequential numbers).
3. **Internal vs Display Identity:** The PostgreSQL `orders.id` integer primary key remains an internal database identifier. The user interface and thermal receipts display `receipt_number` everywhere `#<id>` was previously shown.
4. **One-Time Station Registration:** Each device registers with the cloud API once upon initial installation (`POST /api/v1/stations/register`) and receives the next available station integer (1, 2, ...). This station number is permanently stored in native device storage (`@capacitor/preferences`).
5. **No Number Reuse:** A wiped or reinstalled device registers for a new station number rather than reclaiming its previous station number. Station numbers only creep upward, guaranteeing that local sequences never collide or overlap.
6. **Existing Backlog:** Approximately 1,300 pre-existing orders retain their plain numeric sequence IDs without a station prefix. This one-time visible step in numbering is accepted.
7. **Offline Installation Edge Case:** A brand-new device installed during an active network outage cannot issue receipts until it connects to the internet once to complete station registration. This accepted corner case is covered by the store's physical paper receipt booklet.

## Considered Options

- **Option A: Per-Device Station Number Spaces (Chosen)** — Each device registers once for a permanent station ID and increments its own local sequence counter. Provides complete offline autonomy with zero cross-device coordination, zero network latency, and impossible sequence collisions.
- **Option B: Server-Issued Pre-Allocated Blocks (Rejected)** — The cloud server allocates blocks of numbers (e.g., 50 or 100) to devices in advance. Rejected because devices can exhaust their pre-allocated block during multi-day outages without internet access; unused blocks require complex expiration and reclamation logic; and network drops during block requests risk losing number ranges.
- **Option C: Manual Station Selection in Settings (Rejected)** — Operators manually choose "Station 1" or "Station 2" from a settings menu. Rejected because non-technical operators in their late 50s could accidentally select the same station on both devices with a single careless tap, resulting in duplicate physical receipt numbers issued to customers.
- **Option D: Reusing Active User Profile as Number Space (Rejected)** — Prefixing receipt numbers with the active profile (e.g. `JOSIE-00042` or `LUIS-00042`). Rejected because profiles identify people, not physical devices; operators switch profiles on the same tablet, and multiple devices can operate concurrently under the same active profile.
