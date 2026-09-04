-- 044 — one session per account (ADR 0017 #8).
--
-- Signing in somewhere new ends that account's session everywhere else. The whole
-- mechanism is the three columns below plus a `sid` claim inside the JWT: login mints a
-- fresh `session_id` and signs it into the token, and `requireAuth` refuses a token
-- whose `sid` is no longer the one on the row.
--
-- What this is NOT: it is not what makes receipt numbers unique. That comes from the
-- per-person device letter alone (ADR 0017 #2), and it has to, because a takeover is a
-- SERVER-SIDE act — an offline tablet never hears it, keeps selling, and only finds out
-- on reconnect. A uniqueness rule that a blind device cannot observe is not a uniqueness
-- rule.
--
-- And the hard requirement it must never break: a takeover must never discard receipts
-- waiting to sync. Those are device state, not session state (ADR 0015 §3) — nothing
-- here or in the client's 401 path may touch the outbox.
--
-- Purely additive and correct standing alone in front of the previously deployed server
-- (Render runs migrations on every deploy, ahead of the code that uses them — ADR 0014):
-- all three columns are nullable with no default, and a server that neither writes nor
-- reads them behaves exactly as it does today. A token minted before this slice carries
-- no `sid` at all and stays valid, which is what keeps a tablet still on the old build
-- selling through the multi-day update window (ADR 0017 #13).
--
-- Guarded so a second run is a no-op, per the rule migration 040 learned the hard way.

-- The live session. NULL means "no session anywhere": a fresh account, or one that has
-- signed out. A token whose `sid` does not match this value is refused.
ALTER TABLE users ADD COLUMN IF NOT EXISTS session_id UUID;

-- Which device holds it, as the device_key minted by client/src/offline/station.js —
-- the same value `stations.device_key` and `user_devices.device_key` carry. Not an FK,
-- for the same reason `user_devices.device_key` is not one: a sign-in must not depend on
-- the ADR 0016 station registry, which ADR 0017 retires. It exists so the person whose
-- session was ended can be told something more useful than "signed out".
ALTER TABLE users ADD COLUMN IF NOT EXISTS session_device VARCHAR(64);

ALTER TABLE users ADD COLUMN IF NOT EXISTS session_started_at TIMESTAMPTZ;
