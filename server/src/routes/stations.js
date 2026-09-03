const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { logActivity } = require('../lib/activityLog');
const { SLOT_NUMBERS, isSlotNumber, ownerName } = require('../lib/stationSlots');

const router = express.Router();
router.use(requireAuth);

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
async function slotHighWater(runner, slotNumber) {
  const { rows: [row] } = await runner.query(
    `SELECT
       COALESCE((SELECT MAX(receipt_sequence) FROM orders WHERE receipt_station = $1), 0)              AS orders_max,
       COALESCE((SELECT MAX(receipt_sequence) FROM supplier_deliveries WHERE receipt_station = $1), 0) AS deliveries_max`,
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
// Called on every app start until the device holds a slot, and once more per start
// afterwards to re-confirm it: the server is authoritative on who holds which slot, so
// a tablet whose slot was reassigned to its replacement learns it here and stops
// issuing receipts, rather than printing into a number space it no longer owns.
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

    if (isSlotNumber(station.slot_number)) {
      const body = await slotResponse(client, station);
      await client.query('COMMIT');
      return res.status(created ? 201 : 200).json({ ...body, created });
    }

    // No slot yet: take the lowest one nobody holds. The three slots fill themselves on
    // the first three devices to register, so an ordinary three-tablet install needs no
    // admin action at all — and the fourth device is left unassigned rather than being
    // handed a number 4, which is the whole point of ADR 0016.
    //
    // FOR UPDATE on the holders + the unique index together make the claim atomic: two
    // devices registering at the same instant cannot both take slot 1.
    const { rows: held } = await client.query(
      'SELECT slot_number FROM stations WHERE slot_number IS NOT NULL FOR UPDATE'
    );
    const taken = new Set(held.map((r) => r.slot_number));
    const free = SLOT_NUMBERS.find((n) => !taken.has(n));

    if (free === undefined) {
      const body = unassignedResponse(station);
      await client.query('COMMIT');
      return res.status(created ? 201 : 200).json({ ...body, created });
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
    res.status(created ? 201 : 200).json({ ...body, created });
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
         FROM orders WHERE receipt_station IS NOT NULL GROUP BY receipt_station`
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
