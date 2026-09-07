const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { logActivity } = require('../lib/activityLog');
const { assertIssuableStation } = require('../lib/personNumbers');
const { nextDeviceLetter } = require('../lib/deviceLetters');

const router = express.Router();
router.use(requireAuth);

// ── ADR 0017 — the person number and the per-person device letter ───────────
//
// This is what registration is FOR. A receipt number is
// `<person><device letter>-<sequence>`: the person is the signed-in account, permanent
// and never reused; the letter is allocated per person-and-device PAIR on that person's
// first successful ONLINE sign-in on that device, and a replacement device takes a fresh
// letter rather than inheriting one (ADR 0017 #1/#2/#3). Nothing here is an admin
// action — no device list, no assignment UI, no slot to move. Signing in IS the setup.
//
// ADR 0016's three fixed slots are gone from this file along with the rest of the slot
// concept (ADR 0017 #3): the Devices screen that rendered the roster, the
// `POST /stations/slots/:slot/assign` action that moved one onto a replacement tablet,
// the `REASSIGN_RESERVE` gap that kept the replacement clear of receipts the outgoing
// tablet had never synced, and the slot high-water seeding all existed only because the
// number was tied to hardware. A fresh letter cannot collide with anything, so none of
// it has a job left. `stations` keeps its `slot_number` / `slot_assigned_at` /
// `slot_assigned_by` columns — nothing writes them any more, and dropping columns that
// a device still mid-switchover may yet be described by is not worth the risk.
//
// What did NOT go: the server still ACCEPTS the pre-letter `3-00061` shape forever
// (ADR 0017 #12/#13), and a tablet that already holds one of those numbers keeps
// selling under it until its letter arrives. Acceptance lives in
// server/src/lib/receiptNumbers.js, not here.

// Locks used only for the two allocations below, so two sign-ins racing cannot be handed
// the same number or the same letter. Transaction-scoped: released by COMMIT/ROLLBACK.
// The first argument is the ADR number, purely so a `pg_locks` reading names its owner.
const LOCK_NAMESPACE = 17;
const PERSON_LOCK_KEY = 0;

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
//
// Not to be confused with ADR 0016's slot high-water, which is gone. That one seeded a
// REPLACEMENT device forward past numbers a dead tablet might still be holding; this one
// only ever re-seeds the same pair, which cannot be two devices.
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
// registration: the device row is still worth recording, and a device that gets no
// letter falls back to the number it already holds (see resolveIssuingSeries in
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

// POST /api/v1/stations/register  { device_key, label? }
//
// The ONLINE SIGN-IN that allocates the signed-in person's device letter for this
// device, and the only setup step the letter scheme has. The client calls it on every
// start (and re-confirms periodically), so "first successful online sign-in of that
// person on that device" is simply the first of those calls that gets through; every
// later one returns the same letter.
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
      // untouched. It is NOT a receipt number and is not answered to the client.
      ({ rows: [station] } = await client.query(
        `INSERT INTO stations (device_key, label, last_seen_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (device_key) DO UPDATE SET last_seen_at = NOW()
         RETURNING *`,
        [deviceKey, label || null]
      ));
    }

    const identity = await receiptIdentity(client, req.user?.id, deviceKey, label || null);
    if (identity?.created) {
      // The one moment worth recording. There is no admin action to log — the letter
      // allocates itself — but the owners still need somewhere that says which device
      // `1D` is when a receipt turns up carrying it. Rendered as "Tablet" in the audit
      // log.
      await logActivity(client, {
        entityType: 'station', entityId: identity.deviceRowId, action: 'device_letter_allocated',
        summary: `${identity.body.seller_name || 'This account'} signed in on a new device — `
          + `receipts from it are numbered ${identity.body.receipt_prefix}-00001 onwards`,
        performedBy: req.user?.id ?? null,
      });
    }

    await client.query('COMMIT');
    res.status(created ? 201 : 200).json({
      device_key: station.device_key,
      label: station.label,
      registered_at: station.registered_at,
      created,
      ...(identity?.body || {}),
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
