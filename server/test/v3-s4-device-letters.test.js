// ADR 0017 slice 4 — the device letter, allocated per person-and-device pair.
//
// This is the slice a customer can see: once it is on a tablet, the next real sale
// prints `1A-00042` instead of `1-00042`. What has to be right is not the format (slice
// 2 already accepts it) but the ALLOCATION, and specifically the four ways two receipts
// could end up sharing a number:
//
//   • one person on two devices        -> two letters, two independent series
//   • two people on one device         -> two person numbers, two independent series
//   • a replacement device             -> a letter that has NEVER been used by that
//                                         person, so it cannot collide with receipts the
//                                         dead device issued and never synced
//   • the sequence                     -> counts within the pair, starting at 00001
//
// The matrix below drives all four against the real endpoint and the real database.
// The device half of the same matrix — the storage, the counters and the serialisation
// that keeps two Saves in flight from printing one number — is in
// client/test/v3-s4-device-letters.test.mjs.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const http = require('node:http');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://localhost/leyble_hub';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-key-32-chars-minimum!!';

const db = require('../src/db');
const stationRoutes = require('../src/routes/stations');
const { errorHandler } = require('../src/middleware/errorHandler');
const { nextDeviceLetter, compareDeviceLetters } = require('../src/lib/deviceLetters');

describe('ADR 0017 slice 4 — device letters', () => {
  let server;
  let baseUrl;
  const people = {};          // name -> { id, email, token }
  const createdUserIds = [];
  const deviceKeys = [];
  let customerId;

  // A device IS a key in storage (ADR 0017 #2/#3), which is why "no second tablet
  // needed" holds: three browser profiles across two accounts is six real pairs.
  const newDeviceKey = (tag) => {
    const key = `TEST_S4_${tag}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    deviceKeys.push(key);
    return key;
  };

  async function makePerson(tag) {
    const email = `test-s4-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@leyblestore.com`;
    const { rows: [user] } = await db.query(
      `INSERT INTO users (email, password_hash, full_name, role)
       VALUES ($1, 'dummyhash', $2, 'admin') RETURNING id, email, full_name, role`,
      [email, `S4 ${tag}`]
    );
    createdUserIds.push(user.id);
    const token = jwt.sign(
      { id: user.id, email: user.email, full_name: user.full_name, role: user.role },
      process.env.JWT_SECRET
    );
    return { ...user, token };
  }

  // The one call this slice is about. Returns the parsed body.
  //
  // Since ADR 0017 removed the slot concept, registration allocates nothing but this
  // person's letter for this device — there is no shared three-slot pool left to hand
  // back, so nothing here has to tidy up after itself beyond its own device rows.
  async function register(person, deviceKey, { label } = {}) {
    const res = await fetch(`${baseUrl}/stations/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${person.token}` },
      body: JSON.stringify({ device_key: deviceKey, label }),
    });
    const body = await res.json();
    assert.ok(res.ok, `register failed: ${res.status} ${JSON.stringify(body)}`);
    return body;
  }

  before(async () => {
    people.alvin = await makePerson('alvin');
    people.josie = await makePerson('josie');

    const { rows: [customer] } = await db.query(
      `INSERT INTO customers (name, customer_type) VALUES ('TEST_S4_CUSTOMER', 'regular') RETURNING id`
    );
    customerId = customer.id;

    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/v1/stations', stationRoutes);
    app.use(errorHandler);
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://localhost:${server.address().port}/api/v1`;
  });

  after(async () => {
    if (deviceKeys.length) {
      await db.query('DELETE FROM user_devices WHERE device_key = ANY($1)', [deviceKeys]);
      await db.query('DELETE FROM stations WHERE device_key = ANY($1)', [deviceKeys]);
    }
    if (customerId) {
      await db.query('DELETE FROM orders WHERE customer_id = $1', [customerId]);
      await db.query('DELETE FROM customers WHERE id = $1', [customerId]);
    }
    if (createdUserIds.length) {
      await db.query('DELETE FROM activity_logs WHERE performed_by = ANY($1)', [createdUserIds]);
      await db.query('DELETE FROM users WHERE id = ANY($1)', [createdUserIds]);
    }
    await new Promise((resolve) => server.close(resolve));
  });

  // ── The enumeration, on its own ───────────────────────────────────────────

  describe('the letter enumeration walks forward and never wraps into a used letter', () => {
    const steps = [
      ['no device yet', null,  'A'],
      ['the ordinary next one', 'A', 'B'],
      ['the last single letter', 'Y', 'Z'],
      ['widening rather than wrapping', 'Z', 'AA'],
      ['carrying inside two characters', 'AZ', 'BA'],
      ['the last two-character letter', 'ZY', 'ZZ'],
    ];

    for (const [what, from, expected] of steps) {
      it(what, () => assert.equal(nextDeviceLetter(from), expected));
    }

    it('refuses a letter the column cannot hold rather than truncating into a used one', () => {
      assert.throws(() => nextDeviceLetter('ZZ'), (err) => err.status === 400);
    });

    // Plain text ordering ranks 'AA' before 'B', which would hand back a letter the
    // person already holds. The query that finds a person's highest letter sorts by
    // length first for exactly this reason.
    it('orders shorter before longer, so Z precedes AA', () => {
      const walked = ['B', 'AA', 'Z', 'A'].sort(compareDeviceLetters);
      assert.deepEqual(walked, ['A', 'B', 'Z', 'AA']);
    });
  });

  // ── The collision matrix ──────────────────────────────────────────────────

  describe('the collision matrix', () => {
    it('one person on two devices gets two letters under one person number', async () => {
      const tablet  = await register(people.alvin, newDeviceKey('one-person-tablet'));
      const phone   = await register(people.alvin, newDeviceKey('one-person-phone'));
      const browser = await register(people.alvin, newDeviceKey('one-person-browser'));

      assert.equal(tablet.person, phone.person);
      assert.equal(tablet.person, browser.person);
      assert.deepEqual(
        [tablet.device_letter, phone.device_letter, browser.device_letter],
        ['A', 'B', 'C'],
        'each new device of the same person takes the next letter'
      );
      assert.equal(tablet.receipt_prefix, `${tablet.person}A`);
      assert.equal(browser.receipt_prefix, `${tablet.person}C`);
    });

    it('two people on ONE device get their own letters, and the letter is not global', async () => {
      const shared = newDeviceKey('shared-tablet');
      const alvin = await register(people.alvin, shared);
      const josie = await register(people.josie, shared);

      assert.notEqual(alvin.person, josie.person, 'the person number is what tells them apart');
      assert.equal(
        josie.device_letter, 'A',
        "Josie's first device is her A, regardless of what letter Alvin gave it"
      );
      assert.notEqual(alvin.receipt_prefix, josie.receipt_prefix);
    });

    it('a replacement device takes a FRESH letter and never inherits the dead one', async () => {
      const person = await makePerson('replacement');
      const dead = await register(person, newDeviceKey('dead'));
      const spare = await register(person, newDeviceKey('spare'));
      assert.deepEqual([dead.device_letter, spare.device_letter], ['A', 'B']);

      // The tablet dies. Nobody does anything: the replacement simply signs in.
      const replacement = await register(person, newDeviceKey('replacement'));

      assert.equal(replacement.device_letter, 'C');
      assert.notEqual(replacement.device_letter, dead.device_letter);
      assert.equal(replacement.person, dead.person, 'the PERSON number is what stays stable');
      assert.equal(
        replacement.next_pair_sequence, 1,
        'and it starts at 00001, because a never-used letter cannot collide with the '
        + 'receipts the dead tablet issued and never synced (ADR 0017 #3)'
      );
    });

    it('the sequence counts within the pair, not within the person or the device', async () => {
      const person = await makePerson('sequences');
      const oneKey = newDeviceKey('seq-one');
      const twoKey = newDeviceKey('seq-two');
      const first = await register(person, oneKey);
      await register(person, twoKey);

      // Five sales on the first device, none on the second.
      await db.query(
        `INSERT INTO orders (customer_id, status, total_amount, receipt_station, receipt_device, receipt_sequence)
         SELECT $3, 'pending', 0, $1, $2, g FROM generate_series(1, 5) g`,
        [first.person, first.device_letter, customerId]
      );

      const backOnFirst = await register(person, oneKey);
      assert.equal(backOnFirst.next_pair_sequence, 6, 'the pair that sold resumes past its own five');

      const backOnSecond = await register(person, twoKey);
      assert.equal(
        backOnSecond.next_pair_sequence, 1,
        'the other device is untouched by them — one series per pair, not per person'
      );

      // The two pairs are also distinguishable on paper, which is the whole point.
      const { rows } = await db.query(
        'SELECT receipt_number FROM orders WHERE receipt_station = $1 AND receipt_device = $2 ORDER BY receipt_sequence',
        [first.person, first.device_letter]
      );
      assert.equal(rows[0].receipt_number, `${first.person}${first.device_letter}-00001`);
    });
  });

  // ── Idempotence and races ─────────────────────────────────────────────────

  describe('allocation happens once per pair', () => {
    it('signing in again on a device you already use returns the same letter', async () => {
      const person = await makePerson('idempotent');
      const key = newDeviceKey('same-device');

      const first = await register(person, key);
      const second = await register(person, key);
      const third = await register(person, key, { label: 'renamed' });

      assert.equal(second.device_letter, first.device_letter);
      assert.equal(third.device_letter, first.device_letter);

      const { rows } = await db.query(
        'SELECT id FROM user_devices WHERE user_id = $1', [person.id]
      );
      assert.equal(rows.length, 1, 'and never writes a second row for the pair');
    });

    it('two devices signing in at the same instant cannot be handed the same letter', async () => {
      const person = await makePerson('race');
      const answers = await Promise.all([
        register(person, newDeviceKey('race-a')),
        register(person, newDeviceKey('race-b')),
        register(person, newDeviceKey('race-c')),
        register(person, newDeviceKey('race-d')),
      ]);

      const letters = answers.map((a) => a.device_letter);
      assert.equal(new Set(letters).size, 4, letters.join(','));
      assert.deepEqual([...letters].sort(compareDeviceLetters), ['A', 'B', 'C', 'D']);
    });

    it('the letter allocation is recorded once, where the owners can read it', async () => {
      const person = await makePerson('logged');
      const key = newDeviceKey('logged-device');
      const body = await register(person, key);
      await register(person, key);

      const { rows } = await db.query(
        `SELECT summary FROM activity_logs
          WHERE performed_by = $1 AND action = 'device_letter_allocated'`,
        [person.id]
      );
      assert.equal(rows.length, 1, 'once per pair, not once per sign-in');
      assert.match(rows[0].summary, new RegExp(`${body.receipt_prefix}-00001`));
    });
  });

  // ── The person number ─────────────────────────────────────────────────────

  describe('the person number', () => {
    it('is permanent, and a second person takes a number nobody has held', async () => {
      const one = await makePerson('person-one');
      const two = await makePerson('person-two');

      const first = await register(one, newDeviceKey('person-one-device'));
      const second = await register(two, newDeviceKey('person-two-device'));

      assert.ok(Number.isInteger(first.person) && first.person >= 1);
      assert.equal(second.person, first.person + 1);

      // Permanent: a later sign-in on a different device never renumbers the person.
      const later = await register(one, newDeviceKey('person-one-second-device'));
      assert.equal(later.person, first.person);
    });

    it('is never reused, including after the account is deactivated', async () => {
      const leaver = await makePerson('leaver');
      const { person } = await register(leaver, newDeviceKey('leaver-device'));

      await db.query('UPDATE users SET is_active = FALSE WHERE id = $1', [leaver.id]);

      const hire = await makePerson('new-hire');
      const hired = await register(hire, newDeviceKey('new-hire-device'));

      assert.notEqual(hired.person, person);
      assert.ok(hired.person > person, 'numbers only ever creep upward');

      // And the leaver's own historical receipts still resolve to them.
      const { rows: [still] } = await db.query(
        'SELECT receipt_person FROM users WHERE id = $1', [leaver.id]
      );
      assert.equal(still.receipt_person, person);
    });
  });

  // ── ADR 0014: the switchover window ───────────────────────────────────────

  it('a pre-letter sale and a lettered one never seed each other, though both are one person', async () => {
    // The exact overlap ADR 0014's switchover window creates: an updated device selling
    // as `1Z-…` while an un-updated one is still numbering as `1-…`. Both rows store the
    // same receipt_station, and only the letter tells the two series apart — which is why
    // `pairHighWater` keys on the PAIR (person AND letter) and not on the person alone.
    //
    // ADR 0016's slot high-water, which had the mirror-image job of keeping the old
    // series clear of the new one, is gone with the slot concept; this is the half of
    // that invariant that still has to hold.
    const FAR_ABOVE = 90000;
    const known = await register(people.alvin, newDeviceKey('switchover-known'));
    const person = known.person;

    // Five pre-letter sales under this person, far above anything any test issues.
    await db.query(
      `INSERT INTO orders (customer_id, status, total_amount, receipt_station, receipt_device, receipt_sequence)
       SELECT $2, 'pending', 0, $1, NULL, $3 + g FROM generate_series(1, 5) g`,
      [person, customerId, FAR_ABOVE]
    );

    try {
      const fresh = await register(people.alvin, newDeviceKey('switchover-fresh'));
      assert.equal(fresh.person, person);
      assert.ok(
        fresh.next_pair_sequence <= FAR_ABOVE,
        `a fresh pair must not be seeded by the pre-letter series (got ${fresh.next_pair_sequence})`
      );
    } finally {
      await db.query(
        'DELETE FROM orders WHERE receipt_station = $1 AND receipt_device IS NULL AND receipt_sequence > $2',
        [person, FAR_ABOVE]
      );
    }
  });

  it('answers no slot fields — ADR 0017 removed the concept, not just the screen', async () => {
    const body = await register(people.alvin, newDeviceKey('no-slot-fields'));

    for (const gone of ['slot_number', 'station_number', 'owner_name', 'unassigned',
                        'next_sequence', 'next_delivery_sequence']) {
      assert.ok(!(gone in body), `${gone} belongs to the removed slot concept`);
    }
    assert.ok(Number.isInteger(body.next_pair_sequence), 'the PAIR count is what is answered now');
  });
});
