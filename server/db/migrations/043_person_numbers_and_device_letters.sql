-- 043 — the person number and the per-person device letter (ADR 0017 #1, #2, #3).
--
-- Migration 040 taught the schema to STORE `1A-00042`. This one is where the two
-- halves of that prefix come from:
--
--   `1`  the PERSON. It is the user account, it is permanent, and it is never reused —
--        including after someone leaves, because accounts are deactivated
--        (`users.is_active`) and never deleted, and their historical receipts must
--        always still resolve (ADR 0017 #1).
--   `A`  the DEVICE LETTER, allocated per person-and-device PAIR on that person's first
--        successful online sign-in on that device. It is deliberately not globally
--        meaningful: the same physical tablet can be `1A` for Alvin and `2B` for Josie.
--        Its only job is keeping one person's own devices apart (ADR 0017 #2).
--
-- A replacement device takes a FRESH letter and never inherits one (ADR 0017 #3). That
-- is what removes the need for a device list, an assignment UI, high-water seeding and
-- ADR 0016's `REASSIGN_RESERVE` gap: a brand-new letter cannot collide with receipts the
-- dead tablet issued and never synced, so there is nothing to reserve against.
--
-- Purely additive and correct standing alone in front of the previously deployed server
-- (Render runs migrations on every deploy, ahead of the code that uses them — ADR 0014):
-- `users.receipt_person` is nullable with no default and the pre-0017 server neither
-- writes nor reads it, and `user_devices` is a new table nothing else references.
--
-- Every statement is guarded so a second run is a no-op, for the reason recorded in
-- migration 040: a copy of a V3 change was once applied to the shared development
-- database by hand, which left it unable to replay the migration at all.
--
-- Numbered 043, not 042: ADR 0017 slice 7 claimed 042 (`orders.created_by`) and landed
-- first. A gap in the sequence is harmless; two migrations sharing a number is not.

-- ── The person number ───────────────────────────────────────────────────────

ALTER TABLE users ADD COLUMN IF NOT EXISTS receipt_person INT;

-- The same ceiling `assertIssuableStation` enforces in server/src/lib/stationSlots.js
-- (MAX_ISSUABLE_STATION). It is a sanity bound, not a roster: a garbled or absurd
-- number is refused loudly rather than printed onto paper nobody can trace back.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_receipt_person_range;
ALTER TABLE users ADD CONSTRAINT users_receipt_person_range
  CHECK (receipt_person IS NULL OR receipt_person BETWEEN 1 AND 999);

-- PARTIAL, like every other identity index in this schema: the rule applies to numbers
-- that have actually been allocated, and an account that has never sold stays out of
-- the index entirely rather than colliding with every other one on NULL.
CREATE UNIQUE INDEX IF NOT EXISTS users_receipt_person_uniq
  ON users (receipt_person)
  WHERE receipt_person IS NOT NULL;

-- ADR 0017 #1 fixes the three digits deliberately: Alvin is 1, Josie is 2, Luis is 3,
-- the same digits as today's ADR 0016 slot assignments, so each person's series reads
-- as CONTINUING rather than restarting. Seeded here rather than left to the allocator,
-- which would otherwise hand out 1/2/3 in whatever order the three happen to sign in.
--
-- Written only where the account exists, has no number yet, and the number is free, so
-- a database that already reached this state (or that has no such accounts at all — a
-- fresh test database has none) is left exactly as it is. Everyone else is allocated
-- the next free number on their first device claim, in server/src/routes/stations.js.
UPDATE users
   SET receipt_person = seed.person
  FROM (VALUES
          ('alvin@leyblestore.com', 1),
          ('josie@leyblestore.com', 2),
          ('luis@leyblestore.com',  3)
       ) AS seed(email, person)
 WHERE users.email = seed.email
   AND users.receipt_person IS NULL
   AND NOT EXISTS (SELECT 1 FROM users held WHERE held.receipt_person = seed.person);

-- ── The device letter, one row per person-and-device pair ───────────────────
--
-- Deliberately NOT a column on `stations`. A station row is one physical device; a
-- letter belongs to a PAIR, and the same tablet legitimately carries a different letter
-- for each person who has ever signed in on it.
--
-- Rows are never deleted. A device that is retired simply stops appearing, and its
-- letter stays held so the person's next device is guaranteed a letter that has never
-- been used — which is the whole mechanism behind ADR 0017 #3.
CREATE TABLE IF NOT EXISTS user_devices (
  id            SERIAL      PRIMARY KEY,
  user_id       INT         NOT NULL REFERENCES users(id),
  -- The same device-generated key `stations.device_key` uses (VARCHAR(64), minted by
  -- client/src/offline/station.js). Not an FK: a letter is allocated at sign-in and
  -- must not depend on the ADR 0016 station registry, which ADR 0017 retires.
  device_key    VARCHAR(64) NOT NULL,
  device_letter VARCHAR(2)  NOT NULL,
  label         VARCHAR(100),
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at  TIMESTAMPTZ,
  CONSTRAINT user_devices_letter_shape CHECK (device_letter ~ '^[A-Z]{1,2}$')
);

-- One letter per pair: signing in again on a device you already use returns the letter
-- you already have, never a second one. This is what makes allocation idempotent, in
-- the same way `stations.device_key` makes registration idempotent.
CREATE UNIQUE INDEX IF NOT EXISTS user_devices_pair_uniq
  ON user_devices (user_id, device_key);

-- And one device per letter, PER PERSON. This index IS the uniqueness ADR 0017 #2
-- relies on: two of Alvin's devices sharing `A` would print two different sales as
-- `1A-00042`. It is deliberately not global — `1A` and `2A` are different devices and
-- that is the design, not a collision.
CREATE UNIQUE INDEX IF NOT EXISTS user_devices_letter_uniq
  ON user_devices (user_id, device_letter);

CREATE INDEX IF NOT EXISTS user_devices_device_key_idx ON user_devices (device_key);
