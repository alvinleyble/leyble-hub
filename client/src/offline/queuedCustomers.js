import { listRecords } from './outbox.js';

// G29 / ADR 0015 §7 — customers created while blind live in the outbox until their
// POST /customers drains, so the server's own /customers list cannot see them. Every
// screen that shows or picks customers has to merge them in, or a customer someone
// deliberately added during an outage is invisible on exactly the screens they added
// her for.
//
// One reader, three callers (the Customers directory, the order modal's picker, and
// anything later that needs the same), because the `local-<outboxId>` id shape is a
// contract: `isLocalCustomer()` in OrderCreateModal recognises it, saveOrderLocalFirst
// turns `_outboxId` into the outbox `$ref` that resolves once she really exists, and
// getting that shape subtly different per screen is how a queued customer ends up
// unreachable on one of them.

export async function queuedCustomersFromOutbox() {
  try {
    const records = await listRecords();
    return records
      .filter((r) => r.entity_type === 'customer' && r.status === 'queued')
      .map((r) => ({
        id: `local-${r.id}`,
        _outboxId: r.id,
        name: r.payload?.name || 'Customer',
        customer_type: r.payload?.customer_type || 'regular',
        phone: r.payload?.phone || null,
        address: r.payload?.address || null,
        notes: r.payload?.notes || null,
        is_active: true,
        _unsynced: true,
      }));
  } catch {
    // Best-effort only — a local listing failure must never block the screen that
    // asked, which would be strictly worse than not showing the queued rows.
    return [];
  }
}
