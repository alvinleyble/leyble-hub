import { listRecords, enqueue, drainOutbox } from './outbox.js';
import { handleDrainCompletion } from './drainNotifier.js';
import { applyCatalogueDelta, getCachedEntity } from './catalogue.js';

// G3 (docs/offline-accessibility-acceptance-criteria.md), captain decision 2026-09-02
// reversing the 2026-08-29 "let it be for now" deferral — Personnel now follows the
// same edit/create pattern as Customers (queuedCustomers.js) and Inventory
// (productMutations.js): additive creates and non-destructive profile edits queue and
// drain like every other offline-safe write. Deactivating/reactivating and the ID photo
// stay online-only (ADR 0015 §9, unchanged) — they are shared-state and irreversible-
// enough-in-practice that a competing edit from another tablet has no clean resolution,
// same reasoning as customer merges and delivery voids. Deleting personnel stays
// online-only too (rule 9.0, unchanged).

export async function queuedPersonnelFromOutbox() {
  try {
    const records = await listRecords();
    return records
      .filter((r) => r.entity_type === 'personnel' && r.status === 'queued')
      .map((r) => ({
        id: `local-${r.id}`,
        _outboxId: r.id,
        full_name: r.payload?.full_name || 'Personnel',
        remarks: r.payload?.remarks || null,
        phone: r.payload?.phone || null,
        license_number: r.payload?.license_number || null,
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
 * Edits the rest of an existing personnel record's profile (name, phone, remarks,
 * license number) offline. Mirrors updateCustomerLocalFirst exactly: queue it, drain
 * immediately — one code path online and blind. The active/inactive flag and the ID
 * photo are NOT sent through here; callers keep those off the payload while offline
 * (ADR 0015 §9's carve-out, unchanged).
 *
 * The held catalogue copy is updated at the same time, so the roster and every picker
 * (Driver/Helper comboboxes in OrderCreateModal) show the new details rather than
 * reverting to the pre-edit ones on the next render.
 */
export async function updatePersonnelLocalFirst(personnelId, patch, { profileKey }) {
  const record = await enqueue({
    entityType: 'personnel_update',
    endpoint:   `/personnel/${personnelId}`,
    method:     'PATCH',
    payload:    patch,
    profileKey,
  });

  try {
    const held = await getCachedEntity('personnel');
    const row = held.find((p) => String(p.id) === String(personnelId));
    if (row) await applyCatalogueDelta('personnel', [{ ...row, ...patch }]);
  } catch {
    // Convenience only — never fail the save over the cached copy.
  }

  const res = await drainOutbox().catch(() => null);
  if (res && res.sent > 0) handleDrainCompletion(res).catch(() => {});
  const synced = !(await listRecords().catch(() => [])).some((r) => r.id === record.id);
  return { record, synced };
}

// ── Queued EDITS to personnel that already exist on the server ──────────────
//
// Distinct from queuedPersonnelFromOutbox above, and the distinction is the whole
// point: a queued CREATE has no server row to show, so it is merged into the list as
// a `local-` row; a queued EDIT belongs to a row that is already on screen, showing
// the operator's new details (updatePersonnelLocalFirst wrote them to the held copy),
// with nothing at all to say those details have not reached anyone else yet.
//
// Mirrors pendingCustomerEditIds() in queuedCustomers.js / pendingProductEditIds() in
// productMutations.js — same "Waiting to sync" affordance those already give.

/** Ids (as strings) of existing personnel carrying an edit that has not drained yet. */
export async function pendingPersonnelEditIds() {
  try {
    const records = await listRecords();
    const ids = new Set();
    for (const r of records) {
      if (r.status !== 'queued' || r.entity_type !== 'personnel_update') continue;
      const id = String(r.endpoint || '').split('/').pop();
      if (id) ids.add(id);
    }
    return ids;
  } catch {
    // Best-effort, exactly like queuedPersonnelFromOutbox — a badge is never worth
    // failing the screen that asked for it.
    return new Set();
  }
}
