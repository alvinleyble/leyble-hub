import { useEffect, useState } from 'react';
import { api } from '../../api/client.js';
import { heldMutationAttempts } from '../../offline/intentKeys.js';
import { putOrderSnapshot } from '../../offline/receiptHistory.js';
import { orderRef } from '../../utils/orderRef.js';

const STATUS_LABEL = {
  draft: 'Draft',
  pending: 'Pending',
  in_transit: 'In Transit',
  completed: 'Delivered',
  done: 'Closed',
  cancelled: 'Cancelled',
};

export function isStaleOrderWrite(err) {
  return err?.status === 409 && err?.data?.code === 'stale_write' && err?.data?.order;
}

/**
 * Adopt the server's authoritative representation from a stale-write response. The
 * rejected intent is deliberately discarded: callers must never retry or merge it.
 */
export async function handleStaleOrderWrite(err, { addToast, onCurrent } = {}) {
  if (!isStaleOrderWrite(err)) return false;
  const current = err.data.order;
  await putOrderSnapshot(current).catch(() => {});
  onCurrent?.(current);
  const status = STATUS_LABEL[current.status] || current.status;
  addToast?.(
    `${orderRef(current)} changed on another device and is now ${status}. `
      + 'Your change was not saved. Review it and enter any change again.',
    'error'
  );
  return true;
}

/**
 * The matching row from a `leyble:orders-changed` delta that this screen has not yet
 * seen. `syncOrderDelta` re-delivers this device's OWN writes too (sync.js has no
 * self-origination filter) and every write path here already adopts the server's
 * response, so an id/receipt-number match alone is not news — the echo of a save
 * arrives at the revision the screen is already showing. `isNewerRevision` is what
 * separates the two, and it also drops a delta page fetched before a save that has
 * since landed, which must never be adopted backwards over the newer value.
 */
export function orderChangedInEvent(order, detail) {
  if (!order || !detail) return null;
  const changed = Array.isArray(detail.orders) ? detail.orders : [];
  const match = changed.find((candidate) =>
    String(candidate.id) === String(order.id)
      || (order.receipt_number && candidate.receipt_number === order.receipt_number)
  ) || null;
  return match && isNewerRevision(order, match) ? match : null;
}

/**
 * `orders.revision` is a `BIGINT` (migration 048) and pg hands it over as a string, so
 * it is compared as a BigInt and never as a Number — past 2^53 a Number silently loses
 * the low digits and two different revisions start comparing equal. `null` is returned
 * for anything that cannot be ordered as an integer, which each predicate below then
 * biases its own way.
 */
function comparableRevision(value) {
  if (value === undefined || value === null || value === '') return null;
  try {
    return BigInt(String(value).trim());
  } catch {
    return null;
  }
}

/**
 * ADR 0019 — a revision only ever counts forward (migration 048's BEFORE UPDATE
 * trigger), so "newer" means strictly greater. An echo carrying a revision a screen
 * already holds is not a change it has yet to see — most often it is this device's
 * own write coming back round, which must never be dressed up as another device's.
 *
 * Either side missing a usable revision (a pre-048 server, a local snapshot that
 * predates the column) is unorderable, and the safe answer there is "newer": warning
 * about a change that turns out to be our own is recoverable, silently swallowing a
 * real one is not.
 */
export function isNewerRevision(held, incoming) {
  const heldRevision = comparableRevision(held?.revision);
  const incomingRevision = comparableRevision(incoming?.revision);
  if (heldRevision === null || incomingRevision === null) return true;
  return incomingRevision > heldRevision;
}

/**
 * The narrower question a drained write can ask: is this row the single write I made,
 * and nothing else? Migration 048's trigger advances the revision by exactly one per
 * UPDATE, and POST /orders/:id/receipt-printed is one UPDATE, so a drained print that
 * lands on `held.revision + 1` is the only change between the two — safe to adopt
 * silently. Anything further ahead means somebody else's write landed in the same
 * window, and that row belongs on the ordinary "changed on another device" path.
 *
 * An unorderable pair answers false: "I cannot prove this is only my own write" is the
 * side that keeps the warning, matching `isNewerRevision`'s bias in the opposite
 * direction.
 */
export function isOneRevisionAhead(held, incoming) {
  const heldRevision = comparableRevision(held?.revision);
  const incomingRevision = comparableRevision(incoming?.revision);
  if (heldRevision === null || incomingRevision === null) return false;
  return incomingRevision === heldRevision + 1n;
}

// ── A delta that may be this device's own unreported write ──────────────────
//
// api/client.js gives every request five seconds. A save the server commits after the
// client has given up leaves the screen holding revision R while the server holds R+1,
// and the next foreground poll delivers that R+1 as strictly newer — which is exactly
// what "changed on another device" means everywhere else. The screen was never told the
// write landed, so nothing it holds can tell the two apart by revision alone: R+1 is
// also what another device's single edit looks like while this one's never arrived.
//
// What it does hold is the unanswered attempt itself (intentKeys.js): the request, and
// the request_key it went out under. Migration 050 claims that key inside the write's
// own transaction, BEFORE the revision check, so resending the attempt verbatim — same
// key, same revision R — is a question the server answers without changing anything:
//
//   key already spent on this order → the write committed; 200 with the order as
//                                     stored (a replay, never a second write)
//   key not spent                   → the attempt never committed; its revision R is
//                                     stale against the R+1 the delta just proved, so
//                                     it is refused with 409 and rolled back
//
// The resend is only safe while both of those hold, so it is only ever made when the
// attempt carried a revision (one without would be a fresh write) and the order is not
// a draft (draft writes skip the revision check). A spent key alone proves the write
// landed, not that nothing else did, so the incoming row must also be exactly ONE
// revision past the revision the attempt was sent against — migration 048 advances it
// once per UPDATE and every guarded order mutation is a single UPDATE of the row — and
// that must be the revision this screen still holds, leaving no gap for someone else's
// write to hide in. Whatever the resend cannot settle (no answer, an unexpected status,
// no candidate at all) counts as another device: a warning about our own change is
// recoverable, silently hiding somebody else's is not.

function ownWriteCandidates(held, incoming) {
  if (!held || !incoming) return [];
  if (held.status === 'draft' || incoming.status === 'draft') return [];
  if (!isOneRevisionAhead(held, incoming)) return [];
  const heldRevision = comparableRevision(held.revision);
  return heldMutationAttempts([held.id, held.receipt_number]).filter((attempt) => (
    comparableRevision(attempt.body?.revision) === heldRevision
  ));
}

/**
 * Could `incoming` be this device's own write — one it still holds an unanswered
 * request key for? Synchronous and local: no candidate means somebody else's change,
 * with nothing to ask the server.
 */
export function hasOwnWriteCandidate(held, incoming) {
  return ownWriteCandidates(held, incoming).length > 0;
}

/**
 * Resends each candidate attempt under its own key and resolves true only when the
 * server answers with a replay of this order. Never rejects.
 */
export async function confirmOwnWrite(held, incoming) {
  for (const attempt of ownWriteCandidates(held, incoming)) {
    const send = attempt.method === 'POST' ? api.post : api.patch;
    try {
      // A body that already carries a request_key bypasses intentKeys.js, so this
      // resend neither mints a key nor forgets the held one: the operator's own retry of
      // the same form still goes out under it and is still answered as a replay.
      const stored = await send(attempt.path, { ...attempt.body, request_key: attempt.key });
      if (stored && String(stored.id) === String(incoming.id)) return true;
    } catch {
      // Refused (never committed) or unanswered (unknown) — not proven.
    }
  }
  return false;
}

/**
 * Who made the delta a screen has parked behind an open form: `'foreign'` (warn),
 * `'own'` (this device's timed-out write — say nothing), or `'checking'` while the
 * server is asked (say nothing yet: the answer is at most one request budget away, and
 * a warning flashed only to be withdrawn is a false alarm of its own). `null` when
 * nothing is parked.
 *
 * The verdict is pinned to the parked object it was reached for, so a later delta that
 * replaces it — another device's edit on top of ours — is judged afresh.
 */
export function useParkedOrderOwnership(held, parked) {
  const [verdict, setVerdict] = useState(null); // { parked, own }
  const candidate = parked ? hasOwnWriteCandidate(held, parked) : false;

  useEffect(() => {
    if (!parked || !candidate) return undefined;
    let live = true;
    confirmOwnWrite(held, parked).then((own) => {
      if (live) setVerdict({ parked, own });
    });
    return () => { live = false; };
  }, [parked, candidate]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!parked) return null;
  if (verdict?.parked === parked) return verdict.own ? 'own' : 'foreign';
  return candidate ? 'checking' : 'foreign';
}

export function orderStatusLabel(status) {
  return STATUS_LABEL[status] || status;
}
