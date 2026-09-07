-- 045 — enable Row Level Security (RLS) across all tables
--
-- Defense-in-depth lockdown of public Supabase PostgREST endpoints in preparation
-- for repository public visibility.
--
-- The Express backend connects to PostgreSQL via DATABASE_URL as user `postgres`.
-- In PostgreSQL and Supabase, the `postgres` superuser/role has `BYPASSRLS = true`,
-- so all backend application queries, background sync tasks, and migrations bypass
-- RLS completely and continue to operate normally without any changes.
--
-- No public policies are added to any table. As a result, unauthenticated or
-- `anon`-keyed API calls targeting Supabase's PostgREST / GraphQL HTTP endpoints
-- fail closed and cannot read, write, or enumerate any data.
--
-- Running `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` is idempotent in PostgreSQL.

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_product_prices ENABLE ROW LEVEL SECURITY;
ALTER TABLE personnel ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_delivery_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_personnel ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE stations ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE _migrations ENABLE ROW LEVEL SECURITY;
