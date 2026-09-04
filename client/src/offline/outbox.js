import { api } from '../api/client';
import { nativeStore } from './nativeStore';
import { NS, OUTBOX_PREFIX, outboxKey } from './keys';
import { isSimulatedOffline } from '../config/features';
import { markOffline } from './status';
import { handleDrainCompletion } from './drainNotifier.js';
import { newRequestKey } from './requestKeys.js';

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
 * @param {string}   rec.profileKey   D14 — the account SIGNED IN AT SAVE, captured here.
 *                                    Local bookkeeping only since ADR 0017 §5 deleted the
 *                                    `X-Active-Profile` header; still required, because a
 *                                    record with no author is exactly the bug D14 exists
 *                                    to prevent and slice 5 needs the value back.
 * @param {string}  [rec.receiptNumber] The receipt number of the sale this record
 *                                    carries, kept for local lookup. It is NOT the
 *                                    resend key any more — see `request_key` below.
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
    // D14 has no sensible default. A record with no author would be attributed to
    // whoever drains it, which is the exact bug the rule exists to prevent.
    throw new Error('enqueue: profileKey is required — capture the signed-in account at Save');
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
    // ADR 0017 #9 — minted once, here, and resent unchanged on every retry of THIS
    // record. That is what makes a resend recognisable as a resend without the
    // receipt number having to carry the job, so two sales that collide on a receipt
    // number stay two sales instead of the second vanishing into the first.
    request_key: newRequestKey(),
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
      err.refId = value.$ref;
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
    await nativeStore.setJson(`${REF_PREFIX}${id}`, { id: response.id, remembered_at: Date.now() });
  }
}

// Round 4 Fix 6 — a remembered ref must not be deleted just because nothing *yet
// enqueued* depends on it. `stillNeeded` below is derived from whatever happens to be
// in the outbox at the exact moment this pass finishes — it cannot see a dependent
// record that is enqueued moments later (e.g. OrderCreateModal quick-creates a
// customer, which drains and remembers her ref in one pass, and the order that
// depends on her is only enqueued once the operator finishes the rest of the order
// and hits Create Order). Pruning on that snapshot alone deleted the ref forever,
// before the order that would need it even existed — `resolvePayload` then threw
// `unresolvedRef` on every future pass, permanently, with zero attempts counted and
// no visible signal (captain's stuck order 23-00020, `v25.outbox.000000000044`).
//
// A snapshot of "what's in the outbox right now" can never rule out something being
// enqueued a moment later, so this is fixed with a grace window instead: a ref
// survives for REF_PRUNE_GRACE_MS after being remembered regardless of who currently
// depends on it — long enough that no realistic gap between creating a dependency and
// saving the record that references it can lose the ref first. The residual case this
// window can't cover (a dependent enqueued only after the grace window has fully
// elapsed) is caught by the NEEDS_ATTENTION escalation in the drain loop below, so a
// ref this stale is never a silent, permanent dead end even if it is pruned.
const REF_PRUNE_GRACE_MS = 24 * 60 * 60 * 1000; // 24h

// Drop remembered results nothing still depends on, once they're old enough that
// nothing new could plausibly still need them (see REF_PRUNE_GRACE_MS above).
async function pruneRefs(remaining) {
  const stillNeeded = new Set(remaining.flatMap((r) => r.depends_on || []));
  const keys = await nativeStore.keysWithPrefix(REF_PREFIX);
  const now = Date.now();
  for (const key of keys) {
    const id = Number(key.slice(REF_PREFIX.length));
    if (stillNeeded.has(id)) continue;
    const remembered = await nativeStore.getJson(key);
    const rememberedAt = remembered && typeof remembered.remembered_at === 'number' ? remembered.remembered_at : 0;
    if (now - rememberedAt >= REF_PRUNE_GRACE_MS) {
      await nativeStore.remove(key);
    }
  }
}

// ── Draining ────────────────────────────────────────────────────────────────

// ADR 0017 #9 — the retry key rides on the body of every POST the outbox sends.
//
// Injected here rather than baked into each caller's payload so that every queued
// create is covered by construction, including ones added later: a route that does not
// know the field destructures past it, and a route that adopts the mechanism (one entry
// in server/src/lib/idempotency.js's allowlist) needs nothing on the device at all.
//
// Two records deliberately go without. A record queued by a pre-039 build has no
// `request_key` and must still drain — the server falls back to the receipt number for
// exactly that case (ADR 0014's mixed-fleet window). And a PATCH or DELETE is not a
// create: re-sending one is already idempotent, and a queued DELETE that 404s is
// treated as success further down.
function withRequestKey(record, body) {
  if (!record.request_key || record.method !== 'POST') return body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  return { ...body, request_key: record.request_key };
}

// A thrown error with no HTTP status never reached the server (DNS, no route, a
// dropped connection, a timeout). That is an outage, not a rejection: the record stays
// queued and untouched. This is also why the drain must not read a network failure as
// an authentication problem — D15.
function isNetworkFailure(err) {
  return !err?.status;
}

// Comfortably longer than the drain loop's own 30s period, so the loop's screen is
// always fresh enough for the drain that immediately follows it.
const SCREEN_FRESHNESS_MS = 90_000;

function isFreshlyScreened(guard) {
  const at = guard?.screened_at;
  return typeof at === 'number' && (Date.now() - at) < SCREEN_FRESHNESS_MS;
}

let draining = false;

// Round 3 Fix 5 — a caller whose drainOutbox() lands while another pass is already
// running gets an immediate {skipped:true}: fine for that caller, but a record it just
// enqueued (already in nativeStore by the time it called drainOutbox()) was NOT
// necessarily in the in-flight pass's own `records` snapshot — that snapshot was taken
// at the START of the in-flight pass, before this record existed. Without this flag,
// that record would then sit QUEUED until whatever unrelated thing next calls
// drainOutbox() (the 30s periodic loop, an 'online' event, another save) — which the
// captain reported as the chrome-wide OfflineMarker showing "N waiting" for minutes
// after the record it referred to had, from the operator's point of view, already
// finished (a different, already-synced order's own banner cleared fine, because that
// record WAS in the in-flight pass's snapshot). Rather than waiting on the next
// unrelated trigger, a skipped call now schedules an immediate follow-up pass the
// moment the in-flight one finishes.
let queuedRerun = false;

// The remembered-account key this record should be sent under, or null to use the active
// session. Null in the two ordinary cases — the author IS the current session, or this
// device holds no token for them any more (ADR 0017 #7).
async function authorTokenKey(record) {
  const author = record?.profile_key;
  if (!author) return null;
  try {
    const active = await api.getActiveProfile();
    if (active && author === active) return null;
    return (await api.getAccountToken(author)) ? author : null;
  } catch {
    // Never let a storage read decide whether a receipt gets sent. Falling back to the
    // active session costs attribution, which is honour-system by accepted design; not
    // sending would cost the sale.
    return null;
  }
}

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
  if (draining) {
    queuedRerun = true;
    return { sent: 0, failed: 0, waiting: await waitingCount(), skipped: true };
  }
  return runDrainPass();
}

async function runDrainPass() {
  if (isSimulatedOffline()) {
    return { sent: 0, failed: 0, waiting: await waitingCount(), offline: true };
  }

  draining = true;
  queuedRerun = false;
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
      // ADR 0015 §6 — a record carrying a `guard` holds a stock count or a price that
      // another tablet may have corrected in the meantime, and §6 forbids resolving
      // that silently. `screenProductMutations()` (productMutations.js) is what asks
      // the server and stamps `screened_at`; this skip is the fail-safe that makes
      // "never sent unscreened" true of EVERY drain path, not just the two that
      // remember to screen first. The freshness window matters because a stamp from an
      // hour ago says nothing about now: the periodic loop screens immediately before
      // it drains, so anything genuinely ready is stamped seconds ago.
      if (record.guard && !isFreshlyScreened(record.guard)) continue;

      let body;
      try {
        body = withRequestKey(record, await resolvePayload(record.payload));
      } catch (err) {
        if (err.unresolvedRef) {
          // Round 4 Fix 6 safety net — a dependency still present in the outbox
          // (queued, or itself needing attention) simply hasn't synced yet; block and
          // self-heal once it does, exactly as before. But if the id it depends on
          // isn't anywhere in this snapshot at all, that dependency already drained
          // at some point in the past with no ref left behind (the pruning race
          // above, or genuine data loss) — there is no future drain pass that could
          // ever resolve this, so surface it instead of leaving it silently queued
          // forever with zero attempts and no operator-visible signal.
          const dependencyStillInOutbox = records.some((r) => r.id === err.refId);
          if (!dependencyStillInOutbox) {
            record.status = NEEDS_ATTENTION;
            record.last_error = `Depends on outbox record ${err.refId}, which no longer exists and left no resolvable reference.`;
            await saveRecord(record);
            blocked.add(record.id);
            failed++;
            continue;
          }
          blocked.add(record.id);
          continue;
        }
        throw err;
      }

      try {
        // ADR 0017 #7 — the per-record author, back on the wire as a REAL CREDENTIAL.
        //
        // One device can now hold two signed-in people, so the account that saved a
        // record and the account holding the tablet when the line returns are routinely
        // not the same person — and `created_by` on the order is what prints `Sold by:`
        // on the receipt (ADR 0017 #10). So the record goes out under its own author's
        // remembered token when this device still holds one, rather than under whoever is
        // signed in now. That is not the impersonation header ADR 0017 §5 deleted: it is
        // that person's own JWT, issued to this device by a sign-in they made themselves.
        //
        // `authorKey` is null when the author IS the current session (the ordinary case,
        // and the cheapest path) or when their token has gone — then it falls back to the
        // active session, and attribution is honour-system exactly as the captain
        // accepted it to be.
        const authorKey = await authorTokenKey(record);
        const response = await api.request(record.endpoint, {
          method: record.method,
          body: JSON.stringify(body),
          ...(authorKey ? { accountKey: authorKey } : {}),
        });
        await rememberResult(record.id, response);
        await removeRecord(record.id);
        sent++;
      } catch (err) {
        // A 401 is the session ending underneath the drain — a takeover on another
        // device (ADR 0017 #8), a deactivated account, an expired token. It says nothing
        // about the RECORD, so the record must not be marked as needing attention and
        // must certainly not be dropped: receipts waiting to sync are device state and
        // surviving a takeover is a hard requirement of ADR 0017 #8. Leave it queued
        // exactly as it is, stop the pass (every record behind it would fail the same
        // way), and let the sign-in the client is already being sent to resume it.
        if (err.status === 401) {
          blocked.add(record.id);
          break;
        }

        record.attempts = (record.attempts || 0) + 1;
        record.last_error = err.message || String(err);

        if (isNetworkFailure(err) || err.status >= 500) {
          await saveRecord(record);
          blocked.add(record.id);
          markOffline();
          break; // the line is down or the server is unwell; stop the pass
        }

        // A retried DELETE for something already gone has already achieved its goal —
        // treat it as success rather than raising a needs-attention item nobody needs
        // to act on (D13's retry-safety, extended to deletes: piece 3's orphaned-draft
        // cleanup and offline draft discard both rely on this).
        if (record.method === 'DELETE' && err.status === 404) {
          await removeRecord(record.id);
          blocked.add(record.id);
          sent++;
          continue;
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
    if (queuedRerun) {
      queuedRerun = false;
      // Fire-and-forget: the caller that got skipped already has its own
      // {skipped:true} result and isn't waiting on this. Route a successful rerun
      // through the same notifier every other drain path uses, so a record that
      // only missed this pass by a race still tells OrderDetailPage / the marker
      // the moment it actually syncs, instead of waiting on the next unrelated
      // trigger.
      runDrainPass()
        .then((res) => { if (res && res.sent > 0) handleDrainCompletion(res).catch(() => {}); })
        .catch(() => {});
    }
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

/**
 * Queues a DELETE for an order this device cannot reach right now — the orphaned
 * early draft that Confirm & Print's local-first save (D2) leaves behind (piece 3),
 * and discarding a parked order that only this device knows is gone (D6). A repeat
 * arrival is harmless: a 404 on a queued DELETE is treated as success above.
 *
 * The target ref rides in the payload (not just the endpoint string) so a caller can
 * cheaply ask "is this row already headed for deletion?" via pendingDeletionRefs()
 * without parsing endpoints — a genuinely offline device still returns the row from
 * GET /orders?status=draft until the DELETE actually drains, and a list built off
 * that response alone would show a draft the owner already disposed of.
 */
export async function queueOrderDeletion({ orderRef, profileKey } = {}) {
  if (!orderRef) return null;
  if (!profileKey) {
    throw new Error('queueOrderDeletion: profileKey is required — capture the signed-in account at Save (D14)');
  }
  const record = await enqueue({
    entityType: 'order_delete',
    endpoint: `/orders/${orderRef}`,
    method: 'DELETE',
    payload: { orderRef },
    profileKey,
  });
  drainOutbox().catch(() => {});
  return record;
}

// Order refs (row ids or receipt-number strings, compared as strings) with a queued
// DELETE not yet drained. A caller merging in a server-sourced list should exclude
// these — see queueOrderDeletion's doc comment for why.
export async function pendingDeletionRefs() {
  const records = await listRecords();
  const refs = new Set();
  for (const r of records) {
    if (r.entity_type === 'order_delete' && r.status === QUEUED && r.payload?.orderRef !== undefined) {
      refs.add(String(r.payload.orderRef));
    }
  }
  return refs;
}

// Test seam.
export async function __clearOutbox() {
  for (const key of await nativeStore.keysWithPrefix(OUTBOX_PREFIX)) await nativeStore.remove(key);
  for (const key of await nativeStore.keysWithPrefix(REF_PREFIX)) await nativeStore.remove(key);
  draining = false;
  notifyOutboxListeners({ type: 'clear' });
}
