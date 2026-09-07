-- 040 — the per-person device letter in a receipt number (ADR 0017).
--
-- A receipt number becomes `<person><device letter>-<sequence>`, e.g. `1A-00042`:
-- the leading number identifies the PERSON who sold it, the letter distinguishes
-- that person's own devices, and the sequence counts within that pair. Delivery
-- references take the same shape, `1A-DEL-00007` (ADR 0017 #14).
--
-- This migration is step 1 of the switchover ordering in ADR 0014's ADR-0017
-- section: the schema and the server must accept BOTH shapes before any tablet can
-- emit a letter, because tablets are updated one at a time over several days and an
-- un-updated one is still issuing `3-00061` while an updated one may still be
-- holding unsynced old-format receipts. Nothing visible changes here and no number
-- is backfilled — the ~1,300 legacy `#<id>` orders and every slot-scheme number
-- stay exactly as they are, and all three shapes coexist permanently (ADR 0017 #12).
--
-- Purely additive and correct standing alone in front of the previously deployed
-- server (Render runs migrations on every deploy, ahead of the code that uses them —
-- ADR 0014): the new column is nullable with no default, the rebuilt generated
-- expression reproduces today's value byte for byte whenever the letter is absent,
-- and the rebuilt index keeps its name so the route code that recognises its unique
-- violation is unaffected.
--
-- EVERY statement below is guarded so a second run against an already-migrated
-- database is a no-op, and so is a run against a database that reached this shape
-- some other way. The end state is identical whichever path the database arrives
-- by. This is not decoration: a copy of this change was applied by hand to the
-- shared development database before it merged (2026-09-04), which left that
-- database unable to replay the migration at all.

-- ── orders ──────────────────────────────────────────────────────────────────

ALTER TABLE orders ADD COLUMN IF NOT EXISTS receipt_device VARCHAR(2);

-- Letters only, and never a letter without the person number it qualifies.
-- CHECK constraints have no ADD ... IF NOT EXISTS, so each is dropped by name
-- first; re-adding re-validates against the existing rows, which is the same work
-- the first run did.
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_receipt_device_shape;
ALTER TABLE orders ADD CONSTRAINT orders_receipt_device_shape
  CHECK (receipt_device IS NULL OR receipt_device ~ '^[A-Z]{1,2}$');
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_receipt_device_requires_station;
ALTER TABLE orders ADD CONSTRAINT orders_receipt_device_requires_station
  CHECK (receipt_device IS NULL OR receipt_station IS NOT NULL);

-- THE detail a reviewer has to actually verify rather than assume (ADR 0017,
-- Implementation Notes). Once a blank letter is possible, a plain
-- (receipt_station, receipt_device, receipt_sequence) unique index STOPS PROTECTING
-- every pre-letter row: SQL treats NULLs as distinct, so `3-00061` could be inserted
-- twice without collision and the anti-duplicate key (ADR 0006) would silently
-- vanish for the entire old format. COALESCE inside the index expression folds the
-- blank letter into a real value so those rows collide as they always did.
--
-- `NULLS NOT DISTINCT` (PostgreSQL 15+) would also work; COALESCE is chosen because
-- it is version-independent and states the intent in the index itself.
--
-- The index keeps the name migration 033 gave it: server/src/routes/orders.js reads
-- err.constraint against RECEIPT_NUMBER_INDEX to tell a duplicate receipt number
-- apart from any other unique violation. Dropping by name and recreating is safe on
-- a re-run precisely because the name is stable — the index that comes back is the
-- COALESCE form either way, so the NULLS-safe uniqueness above is never left off.
DROP INDEX IF EXISTS orders_receipt_number_uniq;
CREATE UNIQUE INDEX orders_receipt_number_uniq
  ON orders (receipt_station, COALESCE(receipt_device, ''), receipt_sequence)
  WHERE receipt_station IS NOT NULL;

-- The display form is GENERATED so it can never drift from the columns it derives
-- from. A generation expression cannot be altered in place before PostgreSQL 17, so
-- the column is dropped and rebuilt; the whole migration runs in one transaction
-- (server/db/migrate.js), so it is never observably absent.
--
-- With no letter this produces exactly what migration 033 produced, which is what
-- keeps every already-issued number unchanged.
--
-- Unlike the adds above, this one cannot simply be repeated: DROP COLUMN is
-- unconditionally destructive, and re-running it would rewrite the whole table to
-- recompute a column that is already correct. So it is guarded on the only thing
-- that actually distinguishes the two shapes — whether the stored generation
-- expression already reads receipt_device. Already rebuilt: skip. Anything else
-- (the 033 expression, or no column at all): rebuild.
DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_attribute a
    JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE a.attrelid = 'orders'::regclass
      AND a.attname = 'receipt_number'
      AND a.attgenerated = 's'
      AND NOT a.attisdropped
      AND pg_get_expr(d.adbin, d.adrelid) LIKE '%receipt_device%'
  ) THEN
    ALTER TABLE orders DROP COLUMN IF EXISTS receipt_number;
    ALTER TABLE orders
      ADD COLUMN receipt_number TEXT GENERATED ALWAYS AS (
        CASE
          WHEN receipt_station IS NULL THEN NULL
          ELSE receipt_station::TEXT || COALESCE(receipt_device, '')
               || '-' || LPAD(receipt_sequence::TEXT, 5, '0')
        END
      ) STORED;
  END IF;
END
$do$;

-- ── supplier_deliveries (same pair since migration 036, same treatment) ──────

ALTER TABLE supplier_deliveries ADD COLUMN IF NOT EXISTS receipt_device VARCHAR(2);

ALTER TABLE supplier_deliveries DROP CONSTRAINT IF EXISTS supplier_deliveries_receipt_device_shape;
ALTER TABLE supplier_deliveries ADD CONSTRAINT supplier_deliveries_receipt_device_shape
  CHECK (receipt_device IS NULL OR receipt_device ~ '^[A-Z]{1,2}$');
ALTER TABLE supplier_deliveries DROP CONSTRAINT IF EXISTS supplier_deliveries_receipt_device_requires_station;
ALTER TABLE supplier_deliveries ADD CONSTRAINT supplier_deliveries_receipt_device_requires_station
  CHECK (receipt_device IS NULL OR receipt_station IS NOT NULL);

DROP INDEX IF EXISTS supplier_deliveries_receipt_number_uniq;
CREATE UNIQUE INDEX supplier_deliveries_receipt_number_uniq
  ON supplier_deliveries (receipt_station, COALESCE(receipt_device, ''), receipt_sequence)
  WHERE receipt_station IS NOT NULL;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_attribute a
    JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE a.attrelid = 'supplier_deliveries'::regclass
      AND a.attname = 'delivery_ref'
      AND a.attgenerated = 's'
      AND NOT a.attisdropped
      AND pg_get_expr(d.adbin, d.adrelid) LIKE '%receipt_device%'
  ) THEN
    ALTER TABLE supplier_deliveries DROP COLUMN IF EXISTS delivery_ref;
    ALTER TABLE supplier_deliveries
      ADD COLUMN delivery_ref TEXT GENERATED ALWAYS AS (
        CASE
          WHEN receipt_station IS NULL THEN NULL
          ELSE receipt_station::TEXT || COALESCE(receipt_device, '')
               || '-DEL-' || LPAD(receipt_sequence::TEXT, 5, '0')
        END
      ) STORED;
  END IF;
END
$do$;
