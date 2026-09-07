import { enqueue, drainOutbox, listRecords, QUEUED } from './outbox.js';
import { handleDrainCompletion } from './drainNotifier.js';
import { issueDeliveryRef } from './station.js';
import { applyCatalogueDelta, getCachedEntity } from './catalogue.js';

// ADR 0015 §8 — logging an incoming supplier delivery works fully offline.
//
// Brewery trucks arrive and unload during blackouts. If the tablet cannot record what
// came off the truck, warehouse stock immediately desynchronises from what the counter
// is selling from, and the shop starts seeing out-of-stock on pallets it is standing
// next to. Logging a delivery is mathematically additive (ADR 0005 §1) — an
// independent header, its items, and stock going UP — so two tablets blindly logging
// two different trucks merge without a conflict, and this needs none of §6's
// reconciliation machinery.
//
// The delivery carries a device-issued reference, `<station>-DEL-<seq>` (station.js),
// which is its identity — what a human names it by. What makes a RESEND safe is the
// outbox record's own request_key (ADR 0017 #9, requestKeys.js): a resent record
// arrives at a POST /incoming that already holds that key and is answered with the
// stored delivery and a 200, never a second truckload of stock. The mechanism in
// server/src/lib/idempotency.js is table-agnostic and always anticipated this second
// table; migrations 036 and 039 give supplier_deliveries the columns and partial
// unique indexes it needs to join in.
//
// EDITING an already-synced delivery and VOIDING one stay online-only (§8): a void
// reverses stock movements on a record other devices can see, which is the same shape
// as a customer merge, not the same shape as logging a truck.

/**
 * Saves a delivery from this device: reference issued locally, queued, drained.
 * One code path online and blind.
 *
 * @returns {Promise<{record:object, deliveryRef:string, synced:boolean}>}
 */
export async function logDeliveryLocalFirst(payload, { profileKey }) {
  const { delivery_ref } = await issueDeliveryRef();

  const record = await enqueue({
    entityType: 'delivery',
    endpoint:   '/incoming',
    method:     'POST',
    payload:    { ...payload, delivery_ref },
    profileKey,
    // Reuses the outbox's own resend-identity field; the server reads it out of the
    // payload, so this is purely so a caller can find its record again by reference.
    receiptNumber: delivery_ref,
  });

  await applyLocalRestock(payload.items);

  const res = await drainOutbox().catch(() => null);
  if (res && res.sent > 0) handleDrainCompletion(res).catch(() => {});
  const synced = !(await listRecords().catch(() => []))
    .some((r) => r.id === record.id);

  return { record, deliveryRef: delivery_ref, synced };
}

// Stock the truck actually left behind, applied to the held catalogue copy so the
// Inventory screen and the order pickers stop showing the pre-delivery count while the
// record waits. Self-correcting: once the delivery syncs, the next products delta
// replaces the row with the server's own figure (which already includes this).
async function applyLocalRestock(items = []) {
  try {
    const held = await getCachedEntity('products');
    const bumped = [];
    for (const item of items) {
      const row = held.find((p) => String(p.id) === String(item.product_id));
      if (!row) continue;
      bumped.push({
        ...row,
        current_stock: Number(row.current_stock || 0) + Number(item.quantity_received || 0),
      });
    }
    if (bumped.length) await applyCatalogueDelta('products', bumped);
  } catch {
    // Convenience only — never fail the save over the cached copy.
  }
}

/**
 * Deliveries this device logged that have not reached the server yet. The list screen
 * merges these in, or a delivery someone deliberately logged during the outage is
 * invisible on exactly the screen they logged it for (same rule as queued customers
 * and queued products).
 */
export async function queuedDeliveriesFromOutbox() {
  try {
    const records = await listRecords();
    return records
      .filter((r) => r.entity_type === 'delivery' && r.status === QUEUED)
      .map((r) => ({
        id: `local-${r.id}`,
        _outboxId: r.id,
        delivery_ref: r.payload?.delivery_ref || null,
        supplier_name: r.payload?.supplier_name || 'Supplier',
        notes: r.payload?.notes || null,
        received_at: r.payload?.received_at || r.created_at,
        item_count: (r.payload?.items || []).length,
        items: r.payload?.items || [],
        created_by_name: null,
        _unsynced: true,
      }));
  } catch {
    return [];
  }
}

/**
 * Merges the server's list with this device's still-queued ones, newest first,
 * deduped by delivery reference — a queued delivery whose server copy has shown up
 * simply drops out of the local half (same rule as mergeParkedOrders).
 */
export function mergeDeliveries(serverRows = [], localRows = []) {
  const seen = new Set(serverRows.map((d) => d.delivery_ref).filter(Boolean));
  const merged = [...localRows.filter((d) => !seen.has(d.delivery_ref)), ...serverRows];
  return merged.sort((a, b) => new Date(b.received_at) - new Date(a.received_at));
}
