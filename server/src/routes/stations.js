const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { logActivity } = require('../lib/activityLog');
const { SLOT_NUMBERS, isSlotNumber, ownerName, assertIssuableStation } = require('../lib/stationSlots');
const { nextDeviceLetter } = require('../lib/deviceLetters');

const router = express.Router();
router.use(requireAuth);

// ── ADR 0017 — the person number and the per-person device letter ───────────
//
// This is what registration is FOR from here on. A receipt number is
// `<person><device letter>-<sequence>`: the person is the signed-in account, permanent
// and never reused; the letter is allocated per person-and-device PAIR on that person's
// first successful ONLINE sign-in on that device, and a replacement device takes a fresh
// letter rather than inheriting one (ADR 0017 #1/#2/#3). Nothing here is an admin
// action — no device list, no assignment UI, no slot to move. Signing in IS the setup.
//
// The ADR 0016 slot machinery below stays, as the compatibility path for ADR 0014's
// switchover window: tablets are updated ONE AT A TIME over several days, an un-updated
// tablet still reads `slot_number` and `next_sequence` out of this response to number its
// receipts, and stripping those fields would leave it unable to sell. The new fields are
// additive and separately named for exactly that reason — `next_pair_sequence` is the
// PAIR's count and must never be confused with `next_sequence`, which is the SLOT's.
// Removing the slot half belongs to a later cleanup, once every tablet is on the letter
// build and has reported nothing waiting to sync.
//
// Two things about it did have to change, both to stop the two schemes bleeding into
// each other: `slotHighWater` now ignores lettered rows, and the slot claim takes a real
// lock. Both are commented where they are.

// Locks used only for the two allocations below, so two sign-ins racing cannot be handed
// the same number or the same letter. Transaction-scoped: released by COMMIT/ROLLBACK.
// The first argument is the ADR number, purely so a `pg_locks` reading names its owner.
const LOCK_NAMESPACE = 17;
const PERSON_LOCK_KEY = 0;
// The ADR 0016 slot claim takes one too — see the comment on the claim itself.
const SLOT_LOCK_KEY = 16;

// The person's own number, allocated on demand and then permanent (ADR 0017 #1).
//
// Migration 043 seeds Alvin/Josie/Luis as 1/2/3 deliberately, so their series read as
// continuing rather than restarting. Anyone else — a new hire, or any account on a
// database that never had those three — takes the next free number here on their first
// device claim. A number is NEVER reused: accounts are deactivated, never deleted, and
// their historical receipts must always still resolve, so MAX+1 is taken over every
// account rather than over the active ones.
async function ensurePersonNumber(client, userId) {
  const { rows: [user] } = await client.query(
    'SELECT id, full_name, receipt_person FROM users WHERE id = $1', [userId]
  );
  if (!user) return null;
  if (Number.isInteger(user.receipt_person)) return user;

  await client.query('SELECT pg_advisory_xact_lock($1, $2)', [LOCK_NAMESPACE, PERSON_LOCK_KEY]);

  // Re-read under the lock: a concurrent sign-in of the SAME account may have allocated
  // it while this request was queuing for the lock.
  const { rows: [fresh] } = await client.query(
    'SELECT id, full_name, receipt_person FROM users WHERE id = $1', [userId]
  );
  if (Number.isInteger(fresh?.receipt_person)) return fresh;

  const { rows: [{ next }] } = await client.query(
    'SELECT COALESCE(MAX(receipt_person), 0) + 1 AS next FROM users'
  );
  assertIssuableStation(Number(next), { field: 'person number' });

  const { rows: [allocated] } = await client.query(
    'UPDATE users SET receipt_person = $2 WHERE id = $1 RETURNING id, full_name, receipt_person',
    [userId, Number(next)]
  );
  return allocated;
}

// The letter for THIS person on THIS device, allocated once and then remembered
// (ADR 0017 #2). Idempotent on the pair, exactly as registration is idempotent on
// device_key: signing in again on a device you already use returns the letter you
// already hold, never a second one.
//
// Returns `{ row, created }` so the caller can log the allocation the one time it
// actually happens.
async function ensureDeviceLetter(client, userId, deviceKey, label) {
  const { rows: [existing] } = await client.query(
    `UPDATE user_devices
        SET last_seen_at = NOW(), label = COALESCE($3, label)
      WHERE user_id = $1 AND device_key = $2
      RETURNING *`,
    [userId, deviceKey, label || null]
  );
  if (existing) return { row: existing, created: false };

  // Serialised per person: two of Alvin's devices signing in at the same instant would
  // otherwise both read the same highest letter and both try to take the next one. The
  // unique index would refuse the second with a 500; the lock makes it wait and get 'B'.
  await client.query('SELECT pg_advisory_xact_lock($1, $2)', [LOCK_NAMESPACE, userId]);

  const { rows: [again] } = await client.query(
    'SELECT * FROM user_devices WHERE user_id = $1 AND device_key = $2', [userId, deviceKey]
  );
  if (again) return { row: again, created: false };

  // Strictly forward, never gap-filling — ADR 0017 #3. Ordered the way the enumeration
  // runs (A..Z then AA..ZZ), not as plain text, which would rank 'AA' before 'B' and
  // hand back a letter this person already holds.
  const { rows: [highest] } = await client.query(
    `SELECT device_letter FROM user_devices
      WHERE user_id = $1
      ORDER BY LENGTH(device_letter) DESC, device_letter DESC
      LIMIT 1`,
    [userId]
  );

  const { rows: [row] } = await client.query(
    `INSERT INTO user_devices (user_id, device_key, device_letter, label, last_seen_at)
     VALUES ($1, $2, $3, $4, NOW())
     RETURNING *`,
    [userId, deviceKey, nextDeviceLetter(highest?.device_letter || null), label || null]
  );
  return { row, created: true };
}

// The highest sequence the server has ever seen for one person-and-device PAIR, across
// both series that carry a device-issued number.
//
// For a freshly allocated letter this is 0 and the device starts at 00001, which is the
// point of a fresh letter. It is read anyway because the device seeds its counter to at
// least this and never downwards: a tablet that reinstalled the app but kept its pair
// must not restart a series it has already printed paper for.
async function pairHighWater(runner, person, letter) {
  const { rows: [row] } = await runner.query(
    `SELECT
       COALESCE((SELECT MAX(receipt_sequence) FROM orders
                  WHERE receipt_station = $1 AND COALESCE(receipt_device, '') = $2), 0) AS orders_max,
       COALESCE((SELECT MAX(receipt_sequence) FROM supplier_deliveries
                  WHERE receipt_station = $1 AND COALESCE(receipt_device, '') = $2), 0) AS deliveries_max`,
    [person, letter]
  );
  return { orders: Number(row.orders_max), deliveries: Number(row.deliveries_max) };
}

// Allocates (or re-reads) this sign-in's person number and device letter, and returns
// the fields the device needs to issue receipt numbers with no further round trip.
//
// Answers null when the request carries no usable user id, rather than failing the
// registration: the slot half of the response is still worth serving, and a device that
// gets no letter falls back to the number it already holds (see resolveIssuingSeries in
// client/src/offline/station.js) rather than being unable to sell.
async function receiptIdentity(client, userId, deviceKey, label) {
  if (!Number.isInteger(userId)) return null;

  const user = await ensurePersonNumber(client, userId);
  if (!user || !Number.isInteger(user.receipt_person)) return null;

  const { row: device, created } = await ensureDeviceLetter(client, userId, deviceKey, label);
  const high = await pairHighWater(client, user.receipt_person, device.device_letter);

  return {
    created,
    deviceRowId: device.id,
    body: {
      user_id: user.id,
      person: user.receipt_person,
      seller_name: user.full_name || null,
      device_letter: device.device_letter,
      receipt_prefix: `${user.receipt_person}${device.device_letter}`,
      device_letter_allocated_at: device.first_seen_at,
      next_pair_sequence: high.orders + 1,
      next_pair_delivery_sequence: high.deliveries + 1,
    },
  };
}

// ADR 0016 — this store runs exactly three tablets, one per person, so a device does
// not CLAIM a station number any more: it is ASSIGNED one of three fixed slots.
//
// What did not change: the number is still stored on the device, still issued locally
// with no round trip at Save (ADR 0004), still unique, still what addresses the order
// before it has ever reached the server (ADR 0010). It is no longer the outbox's
// anti-duplicate key — ADR 0017 #9 split that off onto `request_key`. Only where an available number comes from changed — from "the next
// value of a sequence, forever" to "one of slots 1, 2, 3, reassignable by the owner".
//
// Manual per-device number entry is still rejected, for ADR 0003's original reason:
// one careless tap gives two tablets the same number space and the collision only
// shows up on paper in a customer's hand. A slot is assigned to exactly one device by
// a single UPDATE that releases the previous holder in the same statement.

// When a slot moves to a REPLACEMENT device, the new tablet is seeded past the highest
// sequence the server has seen for that slot — plus this reserve. The outgoing tablet
// may still be holding receipts it issued and never managed to sync, and those numbers
// are not visible here; without the gap the replacement would re-issue them. Since
// ADR 0017 #9 that no longer answers the NEW order with the OLD one's row — the retry
// key is a separate value — but the receipt number is still unique, so the collision
// becomes a 409 that strands the new sale until a human re-issues its number.
//
// A gap in a device's numbering is invisible to everyone; a repeat is two customers
// holding the same receipt number. Same trade ADR 0003 made for skipped sequences.
const REASSIGN_RESERVE = 50;

// How many slot-less devices the Devices screen lists (newest first).
const UNASSIGNED_LIMIT = 25;

// The highest sequence this slot has ever reached on the server, across both series
// that carry a device-issued number (orders, and supplier_deliveries since ADR 0015 §8).
//
// `receipt_device IS NULL` is load-bearing since ADR 0017. A letter-scheme receipt shares
// this slot's leading number — `1A-00042` stores receipt_station = 1 — but it is a
// DIFFERENT SERIES, counted within its own pair. Without the filter, every sale an
// updated tablet makes as `1A-…` would drag slot 1's high-water up with it and seed an
// un-updated tablet forward past numbers it never issued. Harmless in the sense that
// matters (a skipped number is invisible, a repeated one is two customers holding the
// same receipt) but wrong, and it would make the old series jump for no reason mid-window.
async function slotHighWater(runner, slotNumber) {
  const { rows: [row] } = await runner.query(
    `SELECT
       COALESCE((SELECT MAX(receipt_sequence) FROM orders
                  WHERE receipt_station = $1 AND receipt_device IS NULL), 0)              AS orders_max,
       COALESCE((SELECT MAX(receipt_sequence) FROM supplier_deliveries
                  WHERE receipt_station = $1 AND receipt_device IS NULL), 0) AS deliveries_max`,
    [slotNumber]
  );
  return { orders: Number(row.orders_max), deliveries: Number(row.deliveries_max) };
}

// The shape every slot-bearing response speaks. `station_number` is the slot: the
// client stores it under that name and prefixes receipts with it, so the rename stays
// server-side and a device that has a slot behaves exactly as it did before.
async function slotResponse(runner, station, { reserve = 0 } = {}) {
  const high = await slotHighWater(runner, station.slot_number);
  return {
    device_key: station.device_key,
    label: station.label,
    slot_number: station.slot_number,
    station_number: station.slot_number,
    owner_name: ownerName(station.slot_number),
    registered_at: station.registered_at,
    slot_assigned_at: station.slot_assigned_at,
    // The device seeds its local counters to at least (next - 1), never downwards —
    // an undrained receipt it already issued must keep the number it printed.
    next_sequence: high.orders + reserve + 1,
    next_delivery_sequence: high.deliveries + reserve + 1,
  };
}

// A device that holds no slot. Answered 200, not an error: the client has to be able
// to tell "the server says you have no slot" (stop issuing, ask for one) apart from
// "the server did not answer" (keep the slot you already hold and carry on blind).
function unassignedResponse(station) {
  return {
    device_key: station.device_key,
    label: station.label,
    slot_number: null,
    station_number: null,
    owner_name: null,
    registered_at: station.registered_at,
    unassigned: true,
  };
}

// POST /api/v1/stations/register  { device_key, label? }
//
// ADR 0017 — this is the ONLINE SIGN-IN that allocates the signed-in person's device
// letter for this device, and the only setup step the letter scheme has. The client
// calls it on every start (and re-confirms periodically), so "first successful online
// sign-in of that person on that device" is simply the first of those calls that gets
// through; every later one returns the same letter.
//
// ADR 0016 — it is also still the slot re-confirmation an un-updated tablet depends on
// during the switchover window: the server is authoritative on who holds which slot, so
// a tablet whose slot was reassigned learns it here and stops issuing, rather than
// printing into a number space it no longer owns.
router.post('/register', async (req, res, next) => {
  const { device_key, label } = req.body || {};

  if (typeof device_key !== 'string' || !device_key.trim()) {
    return res.status(400).json({ error: 'device_key is required' });
  }
  const deviceKey = device_key.trim();
  if (deviceKey.length > 64) {
    return res.status(400).json({ error: 'device_key must be 64 characters or fewer' });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Registration is idempotent on device_key. The device calls this repeatedly, and
    // a reinstall that lost the response must not be able to give the same physical
    // device two identities.
    let { rows: [station] } = await client.query(
      `UPDATE stations SET last_seen_at = NOW(), label = COALESCE($2, label)
        WHERE device_key = $1
        RETURNING *`,
      [deviceKey, label || null]
    );

    const created = !station;
    if (!station) {
      // station_number still comes from the sequence — it is the registry's own id for
      // this device, kept so the existing row shape and its UNIQUE constraint are
      // untouched. It is NOT the receipt station any more; only slot_number is.
      ({ rows: [station] } = await client.query(
        `INSERT INTO stations (device_key, label, last_seen_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (device_key) DO UPDATE SET last_seen_at = NOW()
         RETURNING *`,
        [deviceKey, label || null]
      ));
    }

    // ADR 0017 — the half of this response that actually numbers receipts from here on.
    // Allocated before the slot branches below so all three of them carry it, including
    // "you hold no slot": under the letter scheme a device needs no slot to sell.
    const identity = await receiptIdentity(client, req.user?.id, deviceKey, label || null);
    if (identity?.created) {
      // The one moment worth recording. There is no admin action to log — the letter
      // allocates itself — but the owners still need somewhere that says which device
      // `1D` is when a receipt turns up carrying it. Rendered as "Tablet" in the audit
      // log, alongside the ADR 0016 slot entries.
      await logActivity(client, {
        entityType: 'station', entityId: identity.deviceRowId, action: 'device_letter_allocated',
        summary: `${identity.body.seller_name || 'This account'} signed in on a new device — `
          + `receipts from it are numbered ${identity.body.receipt_prefix}-00001 onwards`,
        performedBy: req.user?.id ?? null,
      });
    }
    const withIdentity = (body) => ({ ...body, ...(identity?.body || {}), created });

    if (isSlotNumber(station.slot_number)) {
      const body = await slotResponse(client, station);
      await client.query('COMMIT');
      return res.status(created ? 201 : 200).json(withIdentity(body));
    }

    // No slot yet: take the lowest one nobody holds. The three slots fill themselves on
    // the first three devices to register, so an ordinary three-tablet install needs no
    // admin action at all — and the fourth device is left unassigned rather than being
    // handed a number 4, which is the whole point of ADR 0016.
    //
    // The advisory lock is what actually makes the claim atomic. `FOR UPDATE` below
    // locks the rows that already hold a slot — and when nobody holds one yet there are
    // no such rows, so it locks NOTHING: two devices registering at the same instant both
    // read an empty `taken`, both pick slot 1, and the second one dies on
    // `stations_slot_number_uniq` with a 500. Reproducible by registering four devices at
    // once, which is what a test with no `await` between them does and what a store
    // powering three tablets on at open comes close to.
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', [LOCK_NAMESPACE, SLOT_LOCK_KEY]);
    const { rows: held } = await client.query(
      'SELECT slot_number FROM stations WHERE slot_number IS NOT NULL FOR UPDATE'
    );
    const taken = new Set(held.map((r) => r.slot_number));
    const free = SLOT_NUMBERS.find((n) => !taken.has(n));

    if (free === undefined) {
      const body = unassignedResponse(station);
      await client.query('COMMIT');
      return res.status(created ? 201 : 200).json(withIdentity(body));
    }

    const { rows: [claimed] } = await client.query(
      `UPDATE stations
          SET slot_number = $2, slot_assigned_at = NOW(), slot_assigned_by = $3
        WHERE device_key = $1
        RETURNING *`,
      [deviceKey, free, req.user?.full_name || null]
    );
    await logActivity(client, {
      entityType: 'station', entityId: claimed.id, action: 'slot_assigned',
      summary: `Slot ${free} (${ownerName(free)}) claimed by a newly registered tablet`,
      performedBy: req.user?.id ?? null,
    });

    const body = await slotResponse(client, claimed);
    await client.query('COMMIT');
    res.status(created ? 201 : 200).json(withIdentity(body));
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

// GET /api/v1/stations — the three slots and who holds them, plus every device that
// has registered without one. This is what the Devices screen renders.
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT id, device_key, station_number, slot_number, label,
              registered_at, last_seen_at, slot_assigned_at, slot_assigned_by
         FROM stations ORDER BY slot_number NULLS LAST, last_seen_at DESC NULLS LAST, id`
    );
    const { rows: highs } = await db.query(
      `SELECT receipt_station AS slot, MAX(receipt_sequence) AS max_sequence
         FROM orders WHERE receipt_station IS NOT NULL AND receipt_device IS NULL
        GROUP BY receipt_station`
    );
    const highBySlot = new Map(highs.map((r) => [Number(r.slot), Number(r.max_sequence)]));

    const slots = SLOT_NUMBERS.map((n) => {
      const holder = rows.find((r) => r.slot_number === n) || null;
      const last = highBySlot.get(n) || 0;
      return {
        slot_number: n,
        owner_name: ownerName(n),
        device: holder && {
          device_key: holder.device_key,
          label: holder.label,
          registered_at: holder.registered_at,
          last_seen_at: holder.last_seen_at,
          slot_assigned_at: holder.slot_assigned_at,
          slot_assigned_by: holder.slot_assigned_by,
        },
        last_sequence: last,
        next_sequence: last + 1,
      };
    });

    res.json({
      slots,
      // Most recently seen first, and capped: a real store has at most one device
      // waiting for a slot at a time, but a shared development database accumulates a
      // registration per worktree and browser profile, and the owners must never be
      // asked to scroll through those to find the tablet in their hand.
      unassigned: rows
        .filter((r) => r.slot_number === null)
        .slice(0, UNASSIGNED_LIMIT)
        .map((r) => ({
          device_key: r.device_key,
          label: r.label,
          registered_at: r.registered_at,
          last_seen_at: r.last_seen_at,
        })),
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/stations/slots/:slot/assign  { device_key }
//
// The device-replacement action (ADR 0016 #2). Moves a slot to another device, so the
// replacement tablet continues that person's numbering instead of starting a fourth
// number space. Reachable from the Devices screen, either on the new tablet itself
// ("use this tablet for Josie's slot") or from another tablet by picking the new
// device out of the unassigned list.
router.post('/slots/:slot/assign', async (req, res, next) => {
  const slot = Number(req.params.slot);
  if (!isSlotNumber(slot)) {
    return res.status(400).json({ error: 'Slot must be 1, 2 or 3' });
  }
  const deviceKey = typeof req.body?.device_key === 'string' ? req.body.device_key.trim() : '';
  if (!deviceKey) return res.status(400).json({ error: 'device_key is required' });

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { rows: [device] } = await client.query(
      'SELECT * FROM stations WHERE device_key = $1 FOR UPDATE', [deviceKey]
    );
    if (!device) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'That device has not registered with this system yet.' });
    }
    if (device.slot_number === slot) {
      const body = await slotResponse(client, device);
      await client.query('COMMIT');
      return res.json({ ...body, changed: false });
    }

    const { rows: [previous] } = await client.query(
      'SELECT * FROM stations WHERE slot_number = $1 FOR UPDATE', [slot]
    );

    // Release both sides before claiming, in one transaction: the outgoing holder of
    // this slot, and this device's own former slot if it had one. Without the second
    // release, moving a device between slots would leave it holding two.
    if (previous) {
      await client.query(
        'UPDATE stations SET slot_number = NULL, slot_assigned_at = NULL, slot_assigned_by = NULL WHERE id = $1',
        [previous.id]
      );
    }

    const { rows: [assigned] } = await client.query(
      `UPDATE stations
          SET slot_number = $2, slot_assigned_at = NOW(), slot_assigned_by = $3
        WHERE id = $1
        RETURNING *`,
      [device.id, slot, req.user?.full_name || null]
    );

    // A replacement starts past the outgoing tablet's known high-water mark plus the
    // reserve; a slot nobody held has nothing to step over.
    const body = await slotResponse(client, assigned, { reserve: previous ? REASSIGN_RESERVE : 0 });

    await logActivity(client, {
      entityType: 'station', entityId: assigned.id, action: 'slot_assigned',
      summary: previous
        ? `Slot ${slot} (${ownerName(slot)}) moved to a replacement tablet; numbering continues at ${slot}-${String(body.next_sequence).padStart(5, '0')}`
        : `Slot ${slot} (${ownerName(slot)}) assigned to a tablet; numbering starts at ${slot}-${String(body.next_sequence).padStart(5, '0')}`,
      performedBy: req.user?.id ?? null,
    });

    await client.query('COMMIT');
    res.json({ ...body, changed: true, replaced_previous: Boolean(previous) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
