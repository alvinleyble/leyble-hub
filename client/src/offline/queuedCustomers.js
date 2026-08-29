import { listRecords, enqueue, drainOutbox } from './outbox.js';
import { handleDrainCompletion } from './drainNotifier.js';
import { applyCatalogueDelta, getCachedEntity } from './catalogue.js';

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

/**
 * ADR 0015 §7 — editing an existing customer's profile works offline.
 *
 * Contact details and the descriptive `customer_type` tag are per-account facts, not
 * shared operational state: counter staff take a new delivery address over the phone
 * during an outage, and blocking that is what drove them to create duplicate accounts
 * just to record it. So the edit takes the same single code path online and blind as
 * every other additive write — queue it, drain immediately — while MERGES and DELETES
 * stay strictly online-only (§7 Option C rejected: a merge re-parents order history and
 * bottle ledgers irreversibly, and a concurrent one cannot be untangled afterwards).
 *
 * The held catalogue copy is updated at the same time, so the directory and the order
 * modal's picker show the new details rather than reverting to the pre-edit ones.
 */
export async function updateCustomerLocalFirst(customerId, patch, { profileKey }) {
  const record = await enqueue({
    entityType: 'customer_update',
    endpoint:   `/customers/${customerId}`,
    method:     'PATCH',
    payload:    patch,
    profileKey,
  });

  try {
    const held = await getCachedEntity('customers');
    const row = held.find((c) => String(c.id) === String(customerId));
    if (row) await applyCatalogueDelta('customers', [{ ...row, ...patch }]);
  } catch {
    // Convenience only — never fail the save over the cached copy.
  }

  const res = await drainOutbox().catch(() => null);
  if (res && res.sent > 0) handleDrainCompletion(res).catch(() => {});
  const synced = !(await listRecords().catch(() => [])).some((r) => r.id === record.id);
  return { record, synced };
}
