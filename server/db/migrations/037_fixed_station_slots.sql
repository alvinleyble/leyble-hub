-- V3 — three fixed station slots (ADR 0016).
--
-- ADR 0003 gave every device that registered its own station number, drawn from
-- station_number_seq and never reused, so the station component of a receipt number
-- was unbounded: whatever hardware registered first took the next number, and a
-- replaced tablet started a brand-new number space rather than continuing the one
-- the person it replaced had been printing.
--
-- This store runs exactly three tablets, one per person (Alvin, Josie, Luis),
-- confirmed by the owner and never shared or swapped. ADR 0016 therefore caps real
-- receipt issuance to three fixed slots — 1, 2, 3 — that a device is ASSIGNED to,
-- rather than a number it claims. The assignment is captain-reassignable, so a
-- replacement tablet picks up the same slot and continues its numbering.
--
-- Additive only, and correct standing alone in front of the previously deployed
-- server (migrations deploy ahead of code, ADR 0014): every column below is
-- nullable with no default, and a server that does not know about them writes and
-- reads `stations` exactly as before.
--
-- NOT a backfill. `stations.station_number` keeps its historical values and its
-- sequence — it stays the registry's internal id for a device — and no existing
-- row is given a slot. The devices registered so far are test installs; each one
-- is assigned a slot deliberately, by a person, through the Devices screen.
-- Orders already carrying a receipt number keep it unchanged (ADR 0003 #6,
-- ADR 0010 #4, ADR 0016 #4).

ALTER TABLE stations
  ADD COLUMN slot_number      INT,
  ADD COLUMN slot_assigned_at TIMESTAMPTZ,
  ADD COLUMN slot_assigned_by VARCHAR(100);

-- There are three slots and only three. The CHECK is what makes "no receipt number
-- may ever show a station above 3" a property of the database rather than of the
-- code that happens to write it.
ALTER TABLE stations ADD CONSTRAINT stations_slot_number_range
  CHECK (slot_number IS NULL OR slot_number BETWEEN 1 AND 3);

-- One device per slot. Partial, like orders_receipt_number_uniq: the rule applies to
-- devices that actually hold a slot, and every unassigned device stays out of the
-- index entirely rather than colliding on NULL.
--
-- This index IS the "exactly one authoritative claim per slot" invariant ADR 0003
-- relied on the sequence for. Reassignment releases the old device in the same
-- statement that assigns the new one, so the pair can never both hold slot 2.
CREATE UNIQUE INDEX stations_slot_number_uniq
  ON stations (slot_number)
  WHERE slot_number IS NOT NULL;

-- Slot assignment is an owner-visible administrative act — which tablet became
-- Josie's, and when — so it belongs in the same change log as everything else the
-- owners can read. Widening the CHECK is safe standing alone: it only ever accepts
-- more than it did, so the previously deployed server keeps writing and reading
-- activity_logs unchanged.
ALTER TABLE activity_logs DROP CONSTRAINT IF EXISTS activity_logs_entity_type_check;
ALTER TABLE activity_logs ADD CONSTRAINT activity_logs_entity_type_check
  CHECK (entity_type IN ('order', 'customer', 'product', 'personnel', 'ticket', 'station'));
