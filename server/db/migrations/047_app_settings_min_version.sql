-- 047 — create app_settings table and seed dormant min_version setting.
--
-- Enables minimum version enforcement for Android tablets managed via Supabase.
-- The setting is dormant (inactive) by default (value is NULL).
-- The captain can raise or adjust the required minimum version directly in the
-- Supabase SQL Editor (e.g. UPDATE app_settings SET value = '1.3.0' WHERE key = 'min_version';
-- or UPDATE app_settings SET value = '14' WHERE key = 'min_version';) without publishing
-- another build.
--
-- Purely additive, fully guarded, idempotent, and leaves enforcement inactive after deployment.

CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Defense-in-depth lockdown of public Supabase PostgREST endpoints (consistent with migration 045)
ALTER TABLE app_settings ENABLE ROW LEVEL SECURITY;

-- Seed dormant min_version setting (NULL = inactive enforcement)
INSERT INTO app_settings (key, value)
VALUES ('min_version', NULL)
ON CONFLICT (key) DO NOTHING;
