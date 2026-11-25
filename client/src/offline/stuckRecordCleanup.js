import { nativeStore } from './nativeStore.js';
import { outboxKey, receiptKey } from './keys.js';
import {
  listRecords, NEEDS_ATTENTION, orderCreatesByReceipt, waitsOn, PARK_STREAK_KEY,
  notifyOutboxListeners, subscribeOutbox,
} from './outbox.js';
import { heldDeviceCodes } from './station.js';
import { parseReceiptNumber } from './receiptNumbers.js';
import { targetOrderRef } from './syncDetails.js';

// ADR 0020 — the removal of five records stuck on the Needs attention list of three
// production devices, at the owner's explicit instruction of 2026-11-25. The rule that
// a refused record is never discarded (V2.5 D8) stays in force for everything else;
// this file is the only place it is set aside, and only for the set below.
//
// Delete this file, its call in offline/index.js and its test in a later release, once
// the five are gone from all three devices. Nothing else depends on it.

// The numbers exactly as they were read off each device. See matchesTarget for the
// shapes a number is matched in.
export const STUCK_RECORDS_REMOVED_2026_11_25 = Object.freeze({
  '1C': Object.freeze([478, 981]),
  '3D': Object.freeze([1677, 2345]),
  '2A': Object.freeze([2738]),
});

// A named record must have been created before this moment — the end of 2026-11-25 in
// Manila — so nothing made after the instruction can ever match, however long this file
// ships. A record with no readable creation time is not matched: enqueue() has stamped
// one on every record since the outbox was first built.
const CREATED_BEFORE_MS = Date.parse('2026-11-26T00:00:00+08:00');

// `1C-00478` on device 1C. Never another device's code, a pre-letter number (`1-00478`)
// or a delivery reference (`1C-DEL-00478`, which does not parse as a receipt number).
function isOwnReceipt(value, code, numbers) {
  const parsed = parseReceiptNumber(value);
  return Boolean(parsed?.device)
    && `${parsed.station}${parsed.device}` === code
    && numbers.includes(parsed.sequence);
}

// On the named device, a record matches only while it is on the attention list RIGHT
// NOW, was created before the cutoff, and one of the two screens that list it shows it
// with the named number:
//   - the attention card: `#478` (no receipt number, queue id 478) or `1C-00478` (its
//     own receipt number);
//   - Sync details, which names a change addressed to an order by that order
//     (targetOrderRef): `#478` (the order's row id) or `1C-00478`.
// Anything queued or sending is never matched.
function matchesTarget(record, code, numbers) {
  if (record?.status !== NEEDS_ATTENTION) return false;
  const createdAt = typeof record.created_at === 'string' ? Date.parse(record.created_at) : NaN;
  if (!(createdAt < CREATED_BEFORE_MS)) return false;

  const onCard = record.receipt_number
    ? isOwnReceipt(record.receipt_number, code, numbers)
    : numbers.includes(record.id);
  if (onCard) return true;

  const target = targetOrderRef(record);
  if (target === null || target === undefined) return false;
  const ref = String(target);
  return /^\d+$/.test(ref) ? numbers.includes(Number(ref)) : isOwnReceipt(ref, code, numbers);
}

// The matched records, then everything waiting behind them, directly or through a
// chain, by the same two rules the drain blocks on: `depends_on`, and a write addressed
// to an order whose create is being removed (`waitsOn`). Nothing else.
//
// In the order found: every waiter comes after a record it waits on. Removing them back
// to front therefore never leaves a waiter on the device without its chain to a matched
// record, wherever the removal stops.
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
  const byId = new Map(records.map((r) => [r.id, r]));
  return [...removing].map((id) => byId.get(id));
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

let lastPass = Promise.resolve();

/**
 * Runs one removal pass, after any pass already under way (passes never overlap).
 * Never throws; resolves to `{ removed }`, the number of outbox records it removed —
 * 0 when there was nothing to do — plus `failed: true` when storage failed.
 *
 * A pass with nothing to do writes nothing. A failing pass puts back what it changed,
 * newest change first; if that fails too it stops, which leaves the device where a
 * pass cut short would have, and a later pass finishes from there.
 */
export function runStuckRecordCleanup() {
  lastPass = lastPass.then(pass);
  return lastPass;
}

let listening = false;

/**
 * Runs a pass now, and from then on another whenever a drain moves a record to Needs
 * attention: a named record that was being retried at this moment is caught the moment
 * it lands back on the list.
 */
export function startStuckRecordCleanup() {
  if (!listening) {
    listening = true;
    subscribeOutbox((event) => {
      if (event?.type === 'drain' && event.failed > 0) runStuckRecordCleanup();
    });
  }
  return runStuckRecordCleanup();
}

async function pass() {
  const undo = []; // [key, raw value before], in the order the keys were changed
  const change = async (key, write) => {
    undo.push([key, await nativeStore.getString(key)]);
    await write();
  };

  try {
    const codes = (await heldDeviceCodes()).filter((code) => STUCK_RECORDS_REMOVED_2026_11_25[code]);
    if (!codes.length) return { removed: 0 };

    const records = await listRecords();
    const matchedIds = records
      .filter((record) => codes.some((code) => matchesTarget(record, code, STUCK_RECORDS_REMOVED_2026_11_25[code])))
      .map((r) => r.id);
    if (!matchedIds.length) return { removed: 0 };

    const removed = withWaiters(records, matchedIds);
    const removedIds = new Set(removed.map((r) => r.id));
    const receiptKeys = await heldReceiptKeysFor(removed);

    // The ids moved aside for a 5xx since the last accepted record count toward a cap
    // on how many more may move aside (outbox.js MAX_CONSECUTIVE_SERVER_ERROR_PARKS);
    // a removed record must not keep counting.
    const streak = await nativeStore.getJson(PARK_STREAK_KEY);
    const streakIds = Array.isArray(streak?.ids) ? streak.ids : [];
    const keptStreak = streakIds.filter((id) => !removedIds.has(id));
    if (keptStreak.length !== streakIds.length) {
      await change(PARK_STREAK_KEY, () => nativeStore.setJson(PARK_STREAK_KEY, { ...streak, ids: keptStreak }));
    }

    // A held receipt goes before its record, and the records go waiters first, matched
    // last: while anything of a matched record's is left, the record itself is still on
    // the attention list to hold it back and to be matched again.
    for (const key of receiptKeys) await change(key, () => nativeStore.remove(key));
    for (const record of [...removed].reverse()) {
      const key = outboxKey(record.id);
      await change(key, () => nativeStore.remove(key));
    }

    notifyOutboxListeners({ type: 'remove', removed: removed.length });
    return { removed: removed.length };
  } catch {
    for (const [key, raw] of undo.reverse()) {
      try {
        if (raw === null || raw === undefined) await nativeStore.remove(key);
        else await nativeStore.setString(key, raw);
      } catch {
        break;
      }
    }
    return { removed: 0, failed: true };
  }
}
