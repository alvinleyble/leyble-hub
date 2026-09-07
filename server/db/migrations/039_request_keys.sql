-- 039 — the retry key, split off the receipt number (ADR 0017 #9, revising ADR 0006).
--
-- Until now the receipt number WAS the anti-duplicate key for a resent outbox record.
-- That coupling made a duplicated receipt number silently destructive: the second sale
-- is answered with the FIRST sale's stored order, the device clears its outbox, and the
-- sale vanishes with nothing anywhere reporting it. Decoupling them leaves a duplicated
-- receipt number merely ambiguous, which a human can recover from.
--
-- `request_key` is generated on the device, once per outbox record, and resent
-- unchanged on every retry of that record. It labels the ATTEMPT TO SEND a sale;
-- the receipt number labels the SALE. They are not two identities that can disagree,
-- which is the objection ADR 0006 rejected Option B on and ADR 0017 #9 overturns.
--
-- The receipt number keeps its own uniqueness (its partial unique index from
-- migrations 033/036 is untouched) and keeps being the route identifier (ADR 0010).
-- Nothing already issued changes and nothing is backfilled.
--
-- Column names deliberately match across both tables, because
-- server/src/lib/idempotency.js is table-agnostic over exactly this shape — adopting
-- a third table stays one entry in its allowlist rather than a second mechanism.
--
-- Purely additive and correct standing alone: nullable with no default, every existing
-- row satisfies it as NULL, the partial unique index covers only rows that actually
-- carry a key, and the previously deployed server's INSERT/SELECT statements are
-- unaffected by its presence. That matters because Render runs migrations on every
-- deploy to the one production environment, ahead of the server code that uses them
-- (ADR 0014).

ALTER TABLE orders              ADD COLUMN request_key VARCHAR(64);
ALTER TABLE supplier_deliveries ADD COLUMN request_key VARCHAR(64);

-- PARTIAL, for the same reason the receipt-number indexes are: the rule is about keys
-- that were actually issued, and every pre-039 row stays out of the index entirely.
CREATE UNIQUE INDEX orders_request_key_uniq
  ON orders (request_key)
  WHERE request_key IS NOT NULL;

CREATE UNIQUE INDEX supplier_deliveries_request_key_uniq
  ON supplier_deliveries (request_key)
  WHERE request_key IS NOT NULL;
