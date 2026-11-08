import { api } from '../api/client';
import { nativeStore } from './nativeStore';
import { NS, OUTBOX_PREFIX, outboxKey } from './keys';
import { isSimulatedOffline } from '../config/features';
import { markOffline } from './status';
import { handleDrainCompletion } from './drainNotifier.js';
import { newRequestKey } from './requestKeys.js';
import { putOrderSnapshot, getReceipt } from './receiptHistory.js';

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

// Serialised through one in-flight chain — same shape as station.js's
// ensureStationRegistered — because two enqueue() calls fired without an await between
// them (e.g. Promise.all over several outbox writes from one save, such as the combined
// customer-defaults prompt's price + delivery-fee writes) would otherwise both read the
// same counter value before either's write lands, mint the same id, and the second
// record silently overwrites the first at that outbox key.
let nextIdChain = Promise.resolve();
async function nextRecordId() {
  const result = nextIdChain.then(async () => {
    const raw = await nativeStore.getString(NEXT_ID_KEY);
    const next = (Number(raw) || 0) + 1;
    await nativeStore.setString(NEXT_ID_KEY, next);
    return next;
  });
  nextIdChain = result.catch(() => {});
  return result;
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
 * @param {object}  [rec.endpointParams] `:name` placeholders in `endpoint`, resolved the
 *                                    same way as `$ref`s in `payload` (see `ref()` below)
 *                                    — for a record whose URL itself depends on another
 *                                    record's real id (e.g. POST /customers/:customerId/prices
 *                                    for a customer created earlier in this same save).
 */
export async function enqueue({
  entityType, endpoint, method = 'POST', payload, profileKey,
  receiptNumber = null, dependsOn = [], createdAt = null, endpointParams = null,
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
    endpoint_params: endpointParams,
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

// A drain pass's per-record bookkeeping (attempts/last_error/status) must land on
// whatever is CURRENTLY stored for this record, not the snapshot `listRecords()` took
// at the start of the pass — an edit made to the same record while this record's own
// send was in flight (updateLocalOrder rewriting it mid-drain, for instance) would
// otherwise be silently reverted the moment the pass gets around to recording that
// send's outcome. Skips the write entirely if the record is gone by then (already
// discarded concurrently) rather than resurrecting it. `patch` may be a function of the
// stored record, for a field that has to count up from what is stored now.
async function saveDrainOutcome(record, patch) {
  const current = await nativeStore.getJson(outboxKey(record.id));
  if (!current) return null;
  const merged = { ...current, ...(typeof patch === 'function' ? patch(current) : patch) };
  await nativeStore.setJson(outboxKey(record.id), merged);
  return merged;
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
  // JSON drops an undefined `$ref`, so a reference to no record would be stored as a
  // bare `{ field }` that no longer looks like a reference at all — and the drain would
  // then send the object itself, e.g. PATCH /customers/[object Object]. Refuse it here,
  // at Save, where the operator still hears about it.
  if (outboxId === undefined || outboxId === null) {
    throw new Error('ref: an outbox record id is required');
  }
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

// ── Adopting an order the drain itself just rewrote ──────────────────────────
//
// Every order write made straight from a screen adopts the row the route hands back.
// A receipt print under V25_OFFLINE_CORE cannot: `queueReceiptPrinted` returns a local
// copy and the POST happens later, inside the drain, so the screen that asked for the
// print never sees the answer. The server still bumps `updated_at` and ADR 0019's
// `revision` (POST /orders/:id/receipt-printed), and the next foreground delta then
// delivers that bump as if another device had made it.
//
// So the drain adopts it on the screen's behalf: the response is written to local
// history and carried out on the drain result, which `handleDrainCompletion` puts on
// `leyble:drain-complete`. Only records this device actually sent appear there — a
// genuine remote edit still arrives unseen through `leyble:orders-changed`, and must.
//
// One entity type today; a second is one entry, provided its route answers with the
// full order row rather than a partial.
const ORDER_SNAPSHOT_ENTITY_TYPES = new Set(['receipt_printed']);

function orderSnapshotFrom(record, response) {
  if (!ORDER_SNAPSHOT_ENTITY_TYPES.has(record.entity_type)) return null;
  if (!response || typeof response !== 'object' || Array.isArray(response)) return null;
  if (response.id === undefined || response.id === null || !response.status) return null;
  return response;
}

// The response is authoritative for the write it answers, but a pass can finish after
// the foreground sync has already stored something later (another device dispatched
// the order while this print was in flight). Held history only ever moves forward.
async function holdOrderSnapshot(snapshot) {
  const held = await getReceipt(snapshot.receipt_number || snapshot.id).catch(() => null);
  const heldRevision = Number(held?.revision);
  if (Number.isFinite(heldRevision) && heldRevision > Number(snapshot.revision)) return;
  await putOrderSnapshot(snapshot).catch(() => {});
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

// A record the server keeps answering with a 5xx while it is otherwise fine is not an
// outage, it is that one record: a server bug its payload trips, a row the route cannot
// handle. Retrying it forever at the head of the queue is how three tablets jammed in
// production (2026-10-23) — every later sale waited behind one bad record.
//
// The queue stays strictly in order: a 5xx still ends the pass, so no record is ever
// sent ahead of an earlier one that failed. What changes is that the device then asks
// the server whether it can SAVE data right now (GET /health/write — a real write that
// is always rolled back; `/health` never touches the database, so it cannot say). Only
// a 2xx there holds the failure against the record as one strike (`server_strikes`), and
// only if at least SERVER_STRIKE_SPACING_MS has passed since that record's previous
// strike (`last_strike_at`). At SERVER_ERROR_PARK_THRESHOLD strikes the record moves to
// the attention list — never deleted, its dependants waiting with it — and the same pass
// carries on behind it. The spacing means a record must keep failing for about five
// minutes before it parks: a reconnect alone runs two passes in a few seconds, so
// without it a bad deploy rolled back within a minute would already have parked valid
// sales.
//
// No strike, and today's behaviour, for everything that says nothing about the record:
// the check failing, timing out, or answering anything but a 2xx (a 404 is a server
// that predates the check, so an un-updated server never moves anything aside), a
// network failure, the client's 5-second timeout, a 401. `attempts` still counts every
// failure of any kind, as it always has; `repointRecord` puts a parked record back in
// the queue with a clean count — with no updates it is the attention list's "Send again
// as is" for a record parked this way (`isParkedForServerError`).
const SERVER_ERROR_PARK_THRESHOLD = 5;
const SERVER_STRIKE_SPACING_MS = 60_000;
const PARKED_FOR_SERVER_ERROR = 'server_error';

// Parked by server-error strikes, as opposed to refused by the server for its data (a
// 4xx), which is what the attention list's customer re-point is for.
export function isParkedForServerError(record) {
  return record?.status === NEEDS_ATTENTION && record.parked_for === PARKED_FOR_SERVER_ERROR;
}

// Safety cap. A check that passes while the problem is really server-wide (a route
// broken for every record, say) must not walk the whole queue into Needs attention one
// record at a time. So at most this many DISTINCT records may be parked for a 5xx with
// no record accepted (2xx) in between; at the cap a new record at the threshold stays
// queued and the pass stops as before. A record already counted may always park again —
// sending it again as is and seeing it fail again moves no more of the queue aside. The
// set of ids is device state — it survives a reload — and any accepted record clears it.
const MAX_CONSECUTIVE_SERVER_ERROR_PARKS = 2;
const PARK_STREAK_KEY = `${NS}serverErrorParkStreak`;

async function readParkedSinceAccepted() {
  const stored = await nativeStore.getJson(PARK_STREAK_KEY);
  return new Set(Array.isArray(stored?.ids) ? stored.ids : []);
}

async function writeParkedSinceAccepted(ids) {
  await nativeStore.setJson(PARK_STREAK_KEY, { ids: [...ids] });
}

// A write addressed to an order (`/orders/<R>`, `/orders/<R>/…`) cannot land before the
// create that makes R exist, whether or not it was queued with a `depends_on` link to it
// — a print of an order read back from local history has none, nor does one queued by an
// older build.
const ORDER_TARGET = /^\/orders\/([^/]+)(?:\/|$)/;

function orderCreatesByReceipt(records) {
  return new Map(records
    .filter((r) => r.entity_type === 'order' && r.receipt_number)
    .map((r) => [r.receipt_number, r.id]));
}

function waitsOn(record, createsByReceipt) {
  const target = ORDER_TARGET.exec(record.endpoint || '')?.[1];
  const create = target === undefined ? undefined : createsByReceipt.get(target);
  const deps = record.depends_on || [];
  return create === undefined || create === record.id ? deps : [...deps, create];
}

// True only when the server answered the write check with a 2xx. Sent under the same
// credential as the record that just failed, which the server has just accepted.
async function serverAcceptsWrites(authorKey) {
  try {
    await api.request('/health/write', {
      method: 'GET',
      ...(authorKey ? { accountKey: authorKey } : {}),
    });
    return true;
  } catch {
    return false;
  }
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
 *   network        — left queued; the pass stops, since the next record would fail the
 *                    same way.
 *   5xx            — left queued and the pass stops, as for a network failure, after
 *                    one write check that may add a strike; at
 *                    SERVER_ERROR_PARK_THRESHOLD strikes it is parked on the attention
 *                    list instead and the pass carries on (see that constant).
 *   other 4xx      — moved to the attention list with the server's reason (D8). Never
 *                    discarded, never guessed at.
 *
 * A record waits while anything it depends on is still on the device — queued, failed
 * earlier in this pass, or on the attention list — and so does anything that depends on
 * IT, however far down the chain.
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
  let result = null;
  const syncedOrders = [];
  try {
    const records = await listRecords();
    // A record already on the attention list has not synced either, so it blocks its
    // dependants from the start — an order's queued status change must not go out
    // ahead of the order it changes just because that order was parked last pass.
    const blocked = new Set(records.filter((r) => r.status !== QUEUED).map((r) => r.id));
    const createsByReceipt = orderCreatesByReceipt(records);
    // Records parked for a 5xx since the last accepted one (MAX_CONSECUTIVE_SERVER_ERROR_PARKS).
    let parkedSinceAccepted = await readParkedSinceAccepted();

    for (const record of records) {
      if (record.status !== QUEUED) continue;
      // A dependency that has not synced blocks its dependants but not unrelated
      // receipts behind them. A skipped dependant blocks ITS dependants in turn, so a
      // chain (customer → order → status change) waits as a whole.
      if (waitsOn(record, createsByReceipt).some((id) => blocked.has(id))) {
        blocked.add(record.id);
        continue;
      }
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
      let endpoint = record.endpoint;
      try {
        if (record.endpoint_params) {
          const resolvedParams = await resolvePayload(record.endpoint_params);
          endpoint = Object.entries(resolvedParams).reduce(
            (acc, [key, value]) => acc.split(`:${key}`).join(encodeURIComponent(value)),
            endpoint,
          );
        }
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
            await saveDrainOutcome(record, {
              status: NEEDS_ATTENTION,
              last_error: `Depends on outbox record ${err.refId}, which no longer exists and left no resolvable reference.`,
            });
            blocked.add(record.id);
            failed++;
            continue;
          }
          blocked.add(record.id);
          continue;
        }
        throw err;
      }

      let authorKey = null;
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
        authorKey = await authorTokenKey(record);
        const response = await api.request(endpoint, {
          method: record.method,
          body: JSON.stringify(body),
          ...(authorKey ? { accountKey: authorKey } : {}),
        });
        await rememberResult(record.id, response);
        const snapshot = orderSnapshotFrom(record, response);
        if (snapshot) {
          await holdOrderSnapshot(snapshot);
          syncedOrders.push(snapshot);
        }
        await removeRecord(record.id);
        sent++;
        if (parkedSinceAccepted.size !== 0) {
          parkedSinceAccepted = new Set();
          await writeParkedSinceAccepted(parkedSinceAccepted);
        }
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

        // An update-required rejection (426) means this client build is obsolete.
        // Leave records queued and untouched so they can safely drain after updating.
        if (err.status === 426 || err.data?.code === 'update_required') {
          blocked.add(record.id);
          break;
        }

        const attempts = (record.attempts || 0) + 1;
        const last_error = err.message || String(err);

        if (isNetworkFailure(err)) {
          await saveDrainOutcome(record, { attempts, last_error });
          blocked.add(record.id);
          markOffline();
          break; // the line is down; stop the pass
        }

        // See SERVER_ERROR_PARK_THRESHOLD. Strictly in order: unless this 5xx parks the
        // record, the pass stops here exactly as it always has.
        if (err.status >= 500) {
          const strike = await serverAcceptsWrites(authorKey);
          const struckAt = Date.now();
          const mayPark = parkedSinceAccepted.has(record.id)
            || parkedSinceAccepted.size < MAX_CONSECUTIVE_SERVER_ERROR_PARKS;
          const saved = await saveDrainOutcome(record, (current) => {
            const lastStrikeAt = current.last_strike_at;
            const tooSoon = typeof lastStrikeAt === 'number'
              && struckAt - lastStrikeAt < SERVER_STRIKE_SPACING_MS;
            if (!strike || tooSoon) return { attempts, last_error };
            const server_strikes = (current.server_strikes || 0) + 1;
            const counted = { attempts, last_error, server_strikes, last_strike_at: struckAt };
            return server_strikes >= SERVER_ERROR_PARK_THRESHOLD && mayPark
              ? { ...counted, status: NEEDS_ATTENTION, parked_for: PARKED_FOR_SERVER_ERROR }
              : counted;
          });
          blocked.add(record.id);
          if (saved?.status === NEEDS_ATTENTION) {
            parkedSinceAccepted.add(record.id);
            await writeParkedSinceAccepted(parkedSinceAccepted);
            failed++;
            continue; // parked aside; its dependants wait, the rest of the queue goes on
          }
          markOffline();
          break; // the server is unwell or this record is still on probation; stop the pass
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

        await saveDrainOutcome(record, { status: NEEDS_ATTENTION, attempts, last_error });
        blocked.add(record.id);
        failed++;
      }
    }

    const remaining = await listRecords();
    await pruneRefs(remaining);
    const waiting = remaining.filter((r) => r.status === QUEUED).length;
    notifyOutboxListeners({ type: 'drain', sent, failed, waiting });
    result = { sent, failed, waiting, orders: syncedOrders };
    return result;
  } finally {
    draining = false;
    // Every pass that sent something notifies from here, the one place a pass can
    // finish. It used to be each caller's job, and the callers that only wanted the
    // send — status.js's reachability recovery, refreshApp, OrderCreateModal,
    // parkedOrders — called the bare drainOutbox() and silently dropped the signal, so
    // whichever of them happened to win the `draining` mutex decided whether any screen
    // heard about the drain at all. Fired after `draining` is cleared so a listener is
    // free to drain again, and not awaited so a slow duplicate-detection GET inside the
    // notifier cannot hold the mutex open.
    if (result && result.sent > 0) handleDrainCompletion(result).catch(() => {});
    if (queuedRerun) {
      queuedRerun = false;
      // Fire-and-forget: the caller that got skipped already has its own
      // {skipped:true} result and isn't waiting on this. The rerun notifies from its
      // own finally block, so a record that only missed this pass by a race still
      // tells OrderDetailPage / the marker the moment it actually syncs, instead of
      // waiting on the next unrelated trigger.
      runDrainPass().catch(() => {});
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
 * (or applies payload fixes) and re-queues it for the next drain pass (D8). With no
 * updates it re-queues the record exactly as it is ("Send again as is").
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
  record.server_strikes = 0;
  record.last_strike_at = null;
  record.parked_for = null;
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
  await nativeStore.remove(PARK_STREAK_KEY);
  draining = false;
  notifyOutboxListeners({ type: 'clear' });
}
