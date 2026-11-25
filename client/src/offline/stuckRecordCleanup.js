import { nativeStore } from './nativeStore.js';
import { NS, outboxKey, receiptKey } from './keys.js';
import {
  listRecords, NEEDS_ATTENTION, orderCreatesByReceipt, waitsOn, PARK_STREAK_KEY, notifyOutboxListeners,
} from './outbox.js';
import { heldDeviceCodes } from './station.js';
import { parseReceiptNumber } from './receiptNumbers.js';

// ADR 0020 — a ONE-TIME removal of five records stuck on the Needs attention list of
// three production devices, at the owner's explicit instruction of 2026-11-25. The rule
// that a refused record is never discarded (V2.5 D8) stays in force for everything
// else; this file is the only place it is set aside, and only for the set below.
//
// Delete this file, its call in offline/index.js and its test in a later release, once
// every device in the store has run it. Nothing else depends on it.

// The numbers exactly as they were read off each device's list. The list labels a record
// `receipt_number || '#' + id`, so a number here is matched in whichever of those two
// shapes the list would have shown it in (see matchesTarget).
export const STUCK_RECORDS_REMOVED_2026_11_25 = Object.freeze({
  '1C': Object.freeze([478, 981]),
  '3D': Object.freeze([1677, 2345]),
  '2A': Object.freeze([2738]),
});

// Written once the step has run on a device that knew its own code(s), whatever it
// found. Its presence means the step never runs again on this install, so it can never
// act on a record created after it ran.
export const STUCK_RECORDS_MARKER_KEY = `${NS}oneTime.stuckRecordsRemoved20261125`;

// On the named device, a record matches when it is on the attention list RIGHT NOW and
// the list shows it with the named number: `#478` (no receipt number, queue id 478) or
// `1C-00478` (a receipt number that parses to this device's code and that sequence).
// Anything queued, sending or otherwise is never matched. A delivery reference
// (`1C-DEL-00478`) does not parse as a receipt number, so it is never matched either.
function matchesTarget(record, code, numbers) {
  if (record?.status !== NEEDS_ATTENTION) return false;
  if (!record.receipt_number) return numbers.includes(record.id);
  const parsed = parseReceiptNumber(record.receipt_number);
  if (!parsed || !parsed.device) return false;
  return `${parsed.station}${parsed.device}` === code && numbers.includes(parsed.sequence);
}

// The matched records plus everything waiting behind them, directly or through a chain,
// by the same two rules the drain blocks on: `depends_on`, and a write addressed to an
// order whose create is being removed (`waitsOn`). Nothing else.
function withWaiters(records, matchedIds) {
  const removing = new Set(matchedIds);
  const createsByReceipt = orderCreatesByReceipt(records);
  let grew = true;
  while (grew) {
    grew = false;
    for (const record of records) {
      if (removing.has(record.id)) continue;
      if (waitsOn(record, createsByReceipt).some((id) => removing.has(id))) {
        removing.add(record.id);
        grew = true;
      }
    }
  }
  return records.filter((r) => removing.has(r.id));
}

// A sale the server never received leaves its held receipt behind (posSave.js
// saveOrderLocalFirst writes one at Save). With its record gone nothing marks it as
// unsynced any more, so it would read as an ordinary synced order — offline lists, the
// detail page's online-only actions against a row the server does not have. It goes
// with its record, exactly as discardLocalOrder does for an operator's discard.
//
// Only a snapshot with no server row id: one carrying an id came from the server (the
// sync stores server rows under their receipt number too) and is not this device's to drop.
// A parked draft holds no receipt (parkedOrders.js), so there is nothing to look for.
async function heldReceiptKeysFor(removed) {
  const keys = [];
  for (const record of removed) {
    if (record.entity_type !== 'order' || !record.receipt_number) continue;
    if (record.payload?.status === 'draft') continue;
    const key = receiptKey(record.receipt_number);
    const held = await nativeStore.getJson(key);
    if (!held) continue;
    const id = held.id;
    if (id === undefined || id === null || String(id).startsWith('local-')) keys.push(key);
  }
  return keys;
}

let running = null;

/**
 * Runs the one-time removal on this device if it has not run here yet. Never throws;
 * resolves to what it did:
 *   { ran: false, reason: 'already-ran' | 'no-device-code' | 'failed' }
 *   { ran: true, removed: <number of outbox records removed> }
 *
 * A failure restores every key it had touched, exactly as it was, and leaves the marker
 * unset so the next start tries again.
 */
export function runStuckRecordCleanup() {
  if (!running) {
    running = cleanup().finally(() => { running = null; });
  }
  return running;
}

async function cleanup() {
  try {
    if (await nativeStore.getString(STUCK_RECORDS_MARKER_KEY)) return { ran: false, reason: 'already-ran' };
  } catch {
    return { ran: false, reason: 'failed' };
  }

  let codes;
  try {
    codes = await heldDeviceCodes();
  } catch {
    return { ran: false, reason: 'failed' };
  }
  if (!codes.length) return { ran: false, reason: 'no-device-code' };

  const touched = new Map(); // key -> raw value before this step, for the restore
  try {
    const records = await listRecords();
    const matchedIds = records
      .filter((record) => codes.some((code) => {
        const numbers = STUCK_RECORDS_REMOVED_2026_11_25[code];
        return numbers ? matchesTarget(record, code, numbers) : false;
      }))
      .map((r) => r.id);

    if (matchedIds.length) {
      const removed = withWaiters(records, matchedIds);
      const removedIds = new Set(removed.map((r) => r.id));
      const receiptKeys = await heldReceiptKeysFor(removed);

      // The ids moved aside for a 5xx since the last accepted record count toward a cap
      // on how many more may move aside (outbox.js MAX_CONSECUTIVE_SERVER_ERROR_PARKS);
      // a removed record must not keep counting.
      const streak = await nativeStore.getJson(PARK_STREAK_KEY);
      const streakIds = Array.isArray(streak?.ids) ? streak.ids : [];
      const keptStreak = streakIds.filter((id) => !removedIds.has(id));

      const keys = [
        ...removed.map((r) => outboxKey(r.id)),
        ...receiptKeys,
        ...(keptStreak.length !== streakIds.length ? [PARK_STREAK_KEY] : []),
      ];
      for (const key of keys) touched.set(key, await nativeStore.getString(key));

      if (keptStreak.length !== streakIds.length) {
        await nativeStore.setJson(PARK_STREAK_KEY, { ...streak, ids: keptStreak });
      }
      for (const key of receiptKeys) await nativeStore.remove(key);
      for (const record of removed) await nativeStore.remove(outboxKey(record.id));

      await nativeStore.setJson(STUCK_RECORDS_MARKER_KEY, { ran_at: new Date().toISOString() });
      notifyOutboxListeners({ type: 'remove', removed: removed.length });
      return { ran: true, removed: removed.length };
    }

    await nativeStore.setJson(STUCK_RECORDS_MARKER_KEY, { ran_at: new Date().toISOString() });
    return { ran: true, removed: 0 };
  } catch {
    for (const [key, raw] of touched) {
      try {
        if (raw === null || raw === undefined) await nativeStore.remove(key);
        else await nativeStore.setString(key, raw);
      } catch {
        // Nothing more this step can do; the marker stays unset either way.
      }
    }
    return { ran: false, reason: 'failed' };
  }
}
