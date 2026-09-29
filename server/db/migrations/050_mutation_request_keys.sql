-- 050 — the anti-duplicate retry key, extended from CREATES to order MUTATIONS.
--
-- Migration 039 gave `orders` and `supplier_deliveries` a `request_key` column, which
-- works because a create's result IS a new row: the key rides on the row it made, and a
-- resend finds that row and is answered with it. An UPDATE has no such row. The order
-- already exists, it is edited many times over its life, and each edit is its own
-- attempt — so the key needs a home of its own.
--
-- Why it is needed at all: client/src/api/client.js aborts every request after 5s. That
-- abort cancels nothing on the server — the Express handler runs on and the transaction
-- commits — so the operator is told the save failed while it actually landed. The
-- retry then either commits a SECOND edit (two edits seconds apart on the same order)
-- or is refused with ADR 0019's `409 stale_write`, because the revision it holds is the
-- one its own successful-but-unreported write superseded.
--
-- With this table, the retry carries the same client-generated key, the claim below
-- conflicts, and the server answers with the order as stored instead of editing it
-- again. Exactly-once, without the client having to know whether its first attempt
-- landed — which, having been aborted mid-flight, it cannot know.
--
-- Same mechanism as 039, not a second one: the key is minted on the device, validated
-- by the same `normalizeRequestKey`, and recognised by the same unique-violation path in
-- server/src/lib/idempotency.js. Only the storage site differs, because an update has no
-- row of its own to carry it.
--
-- `entity_type` is carried so the mechanism can cover a second entity later without a
-- schema change (orders are the only one today) and so a key that is somehow replayed
-- against a DIFFERENT order is recognisable as a misuse rather than answered with the
-- wrong order's data.
--
-- Purely additive and correct standing alone (ADR 0014 / the V2.5 migration rule):
-- nothing reads or writes it until the server code that uses it deploys, and a client
-- that sends no key never reaches it.

CREATE TABLE IF NOT EXISTS request_keys (
  request_key VARCHAR(64)  PRIMARY KEY,
  entity_type VARCHAR(32)  NOT NULL,
  entity_id   BIGINT       NOT NULL,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- For the eventual retention sweep, and for "what did this order's edits look like".
-- The table grows by one row per guarded order mutation — a few hundred a day at this
-- store's volume — so nothing prunes it yet; a sweep is a later migration's job.
CREATE INDEX IF NOT EXISTS request_keys_entity_idx
  ON request_keys (entity_type, entity_id, created_at DESC);

-- ADR 0018's posture: RLS on, zero public policies, so Supabase's PostgREST/GraphQL
-- endpoints fail closed while the Express backend (connecting as `postgres`, which has
-- BYPASSRLS) is unaffected. A new table has to opt in explicitly or it would be the one
-- gap in an otherwise closed schema. Idempotent, like every ENABLE ROW LEVEL SECURITY.
ALTER TABLE request_keys ENABLE ROW LEVEL SECURITY;
