import { api } from '../api/client';
import { nativeStore } from './nativeStore';
import { NS, OUTBOX_PREFIX, outboxKey } from './keys';
import { isSimulatedOffline } from '../config/features';

// D2/D5/D13/D14 — the outbox: records the device has saved locally and not yet handed
// to the server. Offline is not a mode; it is an outbox that has not drained yet, so
// this runs on a good day and a bad one alike.
//
// Piece 1 builds the store and the drain. Piece 2 puts the POS save path on top of it.

const NEXT_ID_KEY = `${NS}outbox.nextId`;
const REF_PREFIX  = `${NS}ref.`;

export const QUEUED          = 'queued';
export const NEEDS_ATTENTION = 'needs_attention';

// ── Writing ─────────────────────────────────────────────────────────────────

async function nextRecordId() {
  const raw = await nativeStore.getString(NEXT_ID_KEY);
  const next = (Number(raw) || 0) + 1;
  await nativeStore.setString(NEXT_ID_KEY, next);
  return next;
}

/**
 * Queue one record for the server.
 *
 * @param {object}   rec
 * @param {string}   rec.entityType   'order' | 'customer' | 'receipt_printed' | …
 * @param {string}   rec.endpoint     API path, e.g. '/orders'
 * @param {string}  [rec.method]      default 'POST'
 * @param {object}   rec.payload      request body, may contain $ref placeholders
 * @param {string}   rec.profileKey   D14 — the profile ACTIVE AT SAVE, captured here
 *                                    and replayed on drain. Never the profile that
 *                                    happens to be on the tablet when the line returns.
 * @param {string}  [rec.receiptNumber] D13 — the record's identity for resend safety.
 * @param {number[]}[rec.dependsOn]   outbox ids that must sync first (D5: a locally
 *                                    created customer before any order referencing her).
 */
export async function enqueue({
  entityType, endpoint, method = 'POST', payload, profileKey,
  receiptNumber = null, dependsOn = [], createdAt = null,
}) {
  if (!entityType) throw new Error('enqueue: entityType is required');
  if (!endpoint) throw new Error('enqueue: endpoint is required');
  if (!profileKey) {
    // D14 has no sensible default. A record with no profile would be attributed to
    // whoever drains it, which is the exact bug the rule exists to prevent.
    throw new Error('enqueue: profileKey is required — capture the profile at Save');
  }

  const id = await nextRecordId();
  const record = {
    id,
    entity_type: entityType,
    endpoint,
    method,
    payload,
    profile_key: profileKey,
    receipt_number: receiptNumber,
    depends_on: dependsOn,
    status: QUEUED,
    attempts: 0,
    last_error: null,
    created_at: createdAt || new Date().toISOString(),
  };
  await nativeStore.setJson(outboxKey(id), record);
  notifyOutboxListeners({ type: 'enqueue', record });
  return record;
}

async function saveRecord(record) {
  await nativeStore.setJson(outboxKey(record.id), record);
}

async function removeRecord(id) {
  await nativeStore.remove(outboxKey(id));
}

// ── Reading ─────────────────────────────────────────────────────────────────

// Every record still on the device, oldest first. Keys carry a zero-padded id, so the
// sorted key order IS insertion order — no separate index to fall out of step.
export async function listRecords() {
  const keys = (await nativeStore.keysWithPrefix(OUTBOX_PREFIX)).filter((k) => k !== NEXT_ID_KEY);
  const records = [];
  for (const key of keys) {
    const record = await nativeStore.getJson(key);
    if (record) records.push(record);
  }
  return records;
}

// What D7's marker counts: records still waiting to reach the server.
export async function waitingCount() {
  const records = await listRecords();
  return records.filter((r) => r.status === QUEUED).length;
}

// D8's queue — records the server refused. Surfaced by piece 4; never discarded here.
export async function listNeedsAttention() {
  const records = await listRecords();
  return records.filter((r) => r.status === NEEDS_ATTENTION);
}

// ── Dependency references (D5) ──────────────────────────────────────────────
//
// An order queued behind a locally created customer cannot know her real id yet, so
// its payload carries a placeholder: { $ref: <outboxId>, field: 'id' }. When the
// dependency syncs, the server's response is remembered under v25.ref.<outboxId> and
// the placeholder resolves to the real value. The remembered value is persisted, not
// just held in memory, so a drain interrupted between the customer and her order picks
// up where it left off.

export function ref(outboxId, field = 'id') {
  return { $ref: outboxId, field };
}

function isRef(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && '$ref' in value;
}

async function resolvePayload(value) {
  if (Array.isArray(value)) return Promise.all(value.map(resolvePayload));
  if (isRef(value)) {
    const resolved = await nativeStore.getJson(`${REF_PREFIX}${value.$ref}`);
    if (!resolved || resolved[value.field] === undefined) {
      const err = new Error(`Unresolved reference to outbox record ${value.$ref}`);
      err.unresolvedRef = true;
      throw err;
    }
    return resolved[value.field];
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = await resolvePayload(v);
    return out;
  }
  return value;
}

async function rememberResult(id, response) {
  if (response && typeof response === 'object' && response.id !== undefined) {
    await nativeStore.setJson(`${REF_PREFIX}${id}`, { id: response.id });
  }
}

// Drop remembered results nothing still depends on, so they do not accumulate.
async function pruneRefs(remaining) {
  const stillNeeded = new Set(remaining.flatMap((r) => r.depends_on || []));
  const keys = await nativeStore.keysWithPrefix(REF_PREFIX);
  for (const key of keys) {
    const id = Number(key.slice(REF_PREFIX.length));
    if (!stillNeeded.has(id)) await nativeStore.remove(key);
  }
}

// ── Draining ────────────────────────────────────────────────────────────────

// A thrown error with no HTTP status never reached the server (DNS, no route, a
// dropped connection, a timeout). That is an outage, not a rejection: the record stays
// queued and untouched. This is also why the drain must not read a network failure as
// an authentication problem — D15.
function isNetworkFailure(err) {
  return !err?.status;
}

let draining = false;

/**
 * Send what is waiting, oldest first, honouring dependencies.
 *
 * Outcomes per record:
 *   2xx            — done. Removed from the outbox; a 200 replay of an already-stored
 *                    receipt number counts exactly as much as a 201 (D13).
 *   network / 5xx  — left queued; the pass stops, since the next record would fail the
 *                    same way.
 *   other 4xx      — moved to the attention list with the server's reason (D8). Never
 *                    discarded, never guessed at.
 */
export async function drainOutbox() {
  if (draining) return { sent: 0, failed: 0, waiting: await waitingCount(), skipped: true };
  if (isSimulatedOffline()) {
    return { sent: 0, failed: 0, waiting: await waitingCount(), offline: true };
  }

  draining = true;
  let sent = 0;
  let failed = 0;
  try {
    const records = await listRecords();
    const blocked = new Set();

    for (const record of records) {
      if (record.status !== QUEUED) continue;
      // A dependency that has not synced blocks its dependants but not unrelated
      // receipts behind them.
      if ((record.depends_on || []).some((id) => blocked.has(id))) continue;

      let body;
      try {
        body = await resolvePayload(record.payload);
      } catch (err) {
        if (err.unresolvedRef) { blocked.add(record.id); continue; }
        throw err;
      }

      try {
        // D14 — the profile stored with the record, not the one on the tablet now.
        const response = await api.request(record.endpoint, {
          method: record.method,
          body: JSON.stringify(body),
          profileKey: record.profile_key,
        });
        await rememberResult(record.id, response);
        await removeRecord(record.id);
        sent++;
      } catch (err) {
        record.attempts = (record.attempts || 0) + 1;
        record.last_error = err.message || String(err);

        if (isNetworkFailure(err) || err.status >= 500) {
          await saveRecord(record);
          blocked.add(record.id);
          break; // the line is down or the server is unwell; stop the pass
        }

        record.status = NEEDS_ATTENTION;
        await saveRecord(record);
        blocked.add(record.id);
        failed++;
      }
    }

    const remaining = await listRecords();
    await pruneRefs(remaining);
    const waiting = remaining.filter((r) => r.status === QUEUED).length;
    notifyOutboxListeners({ type: 'drain', sent, failed, waiting });
    return { sent, failed, waiting };
  } finally {
    draining = false;
  }
}

// ── Observers & Re-pointing (D8) ─────────────────────────────────────────────

const listeners = new Set();

export function subscribeOutbox(listener) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function notifyOutboxListeners(event = {}) {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {}
  }
}

/**
 * Re-points a refused outbox record (in the needs-attention list) to a new customer
 * (or applies payload fixes) and re-queues it for the next drain pass (D8).
 *
 * @param {number} id Record id
 * @param {object} [updates]
 * @param {number|string} [updates.customerId] Destination customer id
 * @param {object} [updates.payloadUpdates] Any extra fields on record.payload
 */
export async function repointRecord(id, { customerId, payloadUpdates } = {}) {
  const record = await nativeStore.getJson(outboxKey(id));
  if (!record) throw new Error(`Outbox record ${id} not found`);

  if (customerId !== undefined && record.payload) {
    record.payload.customer_id = Number(customerId) || customerId;
  }
  if (payloadUpdates && record.payload) {
    Object.assign(record.payload, payloadUpdates);
  }

  record.status = QUEUED;
  record.last_error = null;
  record.attempts = 0;
  await saveRecord(record);
  notifyOutboxListeners({ type: 'repoint', record });
  return record;
}

// Test seam.
export async function __clearOutbox() {
  for (const key of await nativeStore.keysWithPrefix(OUTBOX_PREFIX)) await nativeStore.remove(key);
  for (const key of await nativeStore.keysWithPrefix(REF_PREFIX)) await nativeStore.remove(key);
  draining = false;
  notifyOutboxListeners({ type: 'clear' });
}
