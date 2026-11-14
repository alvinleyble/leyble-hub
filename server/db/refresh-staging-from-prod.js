// Refresh the staging database with production's data. Rerunnable; run it before a test
// round so staging behaves like the store does today. NOT run automatically.
//
//   node server/db/refresh-staging-from-prod.js --dry-run   # read both sides, print the plan
//   node server/db/refresh-staging-from-prod.js --yes       # wipe staging and load production
//   (from server/: npm run refresh-staging -- --dry-run | --yes)
//
// Source: production, read from PROD_DATABASE_URL in ~/.config/leyble-hub/prod-db.env
//   (override the file with --source-env <path>). It is read inside ONE read-only,
//   repeatable-read transaction, so the copy is a consistent snapshot and nothing is
//   ever written there. The connection string is never printed.
// Target: staging, DATABASE_URL from server/.env (an exported DATABASE_URL wins). The
//   script refuses any target that does not name the staging/dev Supabase project
//   (yzopwoquzfnyqdmuookw) and any target naming production (prauvokvlhptvkadvfqq).
//   --local-target additionally allows a localhost database, for rehearsals only.
//
// What it does, in ONE target transaction (any failure leaves staging exactly as it was):
//   - wipes every business table, plus request_keys (retry keys for rows that are gone);
//   - copies in full: users (so logins match production), customers, products (stock as
//     production has it), customer_product_prices, personnel, stations, user_devices
//     (the device list, so a newly set-up device never reuses a copied receipt number),
//     supplier_deliveries, supplier_delivery_items, tickets;
//   - copies orders created on or after --since (default 2026-10-01, Philippine time,
//     UTC+8 — `created_at` is the order's date; there is no separate business-date
//     column) with their order_items and order_personnel; activity_logs and
//     inventory_audit_logs from the same cutoff, minus any log row about a cut order;
//   - keeps staging's own schema, `_migrations` and `app_settings` (minimum app version)
//     untouched; staging may be ahead of production, so only the columns both sides
//     have are copied and newer columns take their defaults;
//   - moves every id sequence past the copied maximum.
// It stops without writing if a ticket points at a cut order (that needs a decision,
// not a rule), or if staging has a table this script does not know about.
//
// After a refresh, staging logins are production's, and every phone/tablet running the
// staging app must clear app data (or reinstall): its stored device letter, session and
// local order history belong to the old staging data.
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const fs = require('fs');
const os = require('os');
const path = require('path');
const dotenv = require('dotenv');
const { Client } = require('pg');

const STAGING_REF = 'yzopwoquzfnyqdmuookw';
const PROD_REF = 'prauvokvlhptvkadvfqq';
const BATCH_ROWS = 500;

// Insert order respects the foreign keys. `where` filters the SOURCE read; $1 is the cutoff.
const KEPT_ORDERS = 'SELECT id FROM orders WHERE created_at >= $1';
const COPY = [
  { table: 'users' },
  { table: 'customers' },
  { table: 'products' },
  { table: 'personnel' },
  { table: 'stations' },
  { table: 'user_devices' },
  { table: 'customer_product_prices' },
  { table: 'supplier_deliveries' },
  { table: 'supplier_delivery_items' },
  { table: 'orders', where: 'created_at >= $1' },
  { table: 'order_items', where: `order_id IN (${KEPT_ORDERS})` },
  { table: 'order_personnel', where: `order_id IN (${KEPT_ORDERS})` },
  { table: 'tickets' },
  {
    table: 'inventory_audit_logs',
    where: `created_at >= $1 AND (related_order_id IS NULL OR related_order_id IN (${KEPT_ORDERS}))`,
    droppedWhere: `created_at >= $1 AND related_order_id IS NOT NULL
                   AND related_order_id NOT IN (${KEPT_ORDERS})`,
  },
  {
    table: 'activity_logs',
    where: `created_at >= $1 AND NOT (entity_type = 'order' AND entity_id IS NOT NULL
            AND entity_id NOT IN (${KEPT_ORDERS}))`,
    droppedWhere: `created_at >= $1 AND entity_type = 'order' AND entity_id IS NOT NULL
                   AND entity_id NOT IN (${KEPT_ORDERS})`,
  },
];
const WIPE_ONLY = ['request_keys'];
const KEEP = ['_migrations', 'app_settings'];

function parseArgs(argv) {
  const args = { yes: false, dryRun: false, localTarget: false, since: '2026-10-01',
    sourceEnv: path.join(os.homedir(), '.config/leyble-hub/prod-db.env') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--yes') args.yes = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--local-target') args.localTarget = true;
    else if (a === '--since') args.since = argv[++i];
    else if (a === '--source-env') args.sourceEnv = argv[++i];
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.since || '')) throw new Error('--since must be YYYY-MM-DD');
  return args;
}

function hostOf(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

function isLocal(url) {
  return ['localhost', '127.0.0.1', '::1', ''].includes(hostOf(url))
    || /host=(localhost|127\.0\.0\.1)/.test(url);
}

// The hard guards. Every message names the rule, never the URL.
function assertTarget(url, { localTarget }) {
  if (!url) throw new Error('No target DATABASE_URL (server/.env).');
  if (url.includes(PROD_REF)) throw new Error('Refusing: the target names the PRODUCTION project.');
  if (url.includes(STAGING_REF)) return 'staging';
  if (localTarget && isLocal(url)) return 'local';
  throw new Error(`Refusing: the target does not name the staging project (${STAGING_REF}).`);
}

function readSourceUrl(file) {
  if (!fs.existsSync(file)) throw new Error(`Production connection file not found: ${file}`);
  const url = dotenv.parse(fs.readFileSync(file)).PROD_DATABASE_URL;
  if (!url) throw new Error(`${file} has no PROD_DATABASE_URL.`);
  return url;
}

function connect(url) {
  return new Client({
    connectionString: url,
    ssl: isLocal(url) ? false : { rejectUnauthorized: false },
    application_name: 'refresh-staging-from-prod',
  });
}

async function columnsOf(client) {
  const { rows } = await client.query(
    `SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND is_generated = 'NEVER'
     ORDER BY table_name, ordinal_position`);
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.table_name)) map.set(r.table_name, []);
    map.get(r.table_name).push(r.column_name);
  }
  return map;
}

const q = (ident) => `"${ident.replace(/"/g, '""')}"`;

async function readSource(src, targetCols, cutoff) {
  await src.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY');
  await src.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    const sourceCols = await columnsOf(src);
    const missing = COPY.map((c) => c.table).filter((t) => !sourceCols.has(t));
    if (missing.length) throw new Error(`Source is missing tables: ${missing.join(', ')}`);

    // A ticket is not history: if it points at an order the cutoff drops, a person decides.
    const { rows: orphanTickets } = await src.query(
      `SELECT id, related_order_id FROM tickets
       WHERE related_order_id IS NOT NULL AND related_order_id NOT IN (${KEPT_ORDERS})
       ORDER BY id`, [cutoff]);
    if (orphanTickets.length) {
      const list = orphanTickets.map((t) => `ticket ${t.id} -> order ${t.related_order_id}`).join(', ');
      throw new Error(`needs-decision: tickets reference orders before the cutoff (${list}). Nothing was written.`);
    }

    const data = [];
    for (const spec of COPY) {
      const cols = sourceCols.get(spec.table).filter((c) => targetCols.get(spec.table).includes(c));
      const sql = `SELECT COALESCE(json_agg(t ORDER BY t.id), '[]')::text AS rows FROM
        (SELECT ${cols.map(q).join(', ')} FROM ${q(spec.table)}${spec.where ? ` WHERE ${spec.where}` : ''}) t`;
      const { rows } = await src.query(sql, spec.where ? [cutoff] : []);
      const parsed = JSON.parse(rows[0].rows);
      const { rows: [{ n }] } = await src.query(`SELECT count(*)::int AS n FROM ${q(spec.table)}`);
      let dropped = 0;
      if (spec.droppedWhere) {
        const r = await src.query(`SELECT count(*)::int AS n FROM ${q(spec.table)} WHERE ${spec.droppedWhere}`, [cutoff]);
        dropped = r.rows[0].n;
      }
      const skippedCols = sourceCols.get(spec.table).filter((c) => !targetCols.get(spec.table).includes(c));
      data.push({ ...spec, cols, rows: parsed, sourceTotal: n, dropped, skippedCols });
    }
    return data;
  } finally {
    await src.query('ROLLBACK').catch(() => {});
  }
}

async function sequencesOf(client, tables) {
  const { rows } = await client.query(
    `SELECT c.relname AS table_name, a.attname AS column_name,
            (regexp_match(pg_get_expr(d.adbin, d.adrelid), 'nextval\\(''([^'']+)''')) [1] AS seq
     FROM pg_attrdef d
     JOIN pg_class c ON c.oid = d.adrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
     JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
     WHERE pg_get_expr(d.adbin, d.adrelid) LIKE 'nextval(%'`);
  return rows.filter((r) => tables.includes(r.table_name));
}

async function loadTarget(tgt, data, cutoff) {
  await tgt.query('BEGIN');
  try {
    await tgt.query("SET LOCAL statement_timeout = '10min'");
    const before = await tgt.query('SELECT key, value, updated_at FROM app_settings ORDER BY key');

    const wipe = [...COPY.map((c) => c.table), ...WIPE_ONLY];
    // No CASCADE: a table outside this list that still references one of these makes the
    // TRUNCATE fail, instead of silently wiping something the script never meant to touch.
    await tgt.query(`TRUNCATE ${wipe.map(q).join(', ')} RESTART IDENTITY`);

    for (const spec of data) {
      const colList = spec.cols.map(q).join(', ');
      for (let i = 0; i < spec.rows.length; i += BATCH_ROWS) {
        const batch = spec.rows.slice(i, i + BATCH_ROWS);
        await tgt.query(
          `INSERT INTO ${q(spec.table)} (${colList})
           SELECT ${colList} FROM json_populate_recordset(NULL::${q(spec.table)}, $1::json)`,
          [JSON.stringify(batch)]);
      }
    }

    const seqs = await sequencesOf(tgt, wipe);
    for (const s of seqs) {
      await tgt.query(
        `SELECT CASE WHEN m IS NULL THEN setval($1::regclass, 1, false)
                     ELSE setval($1::regclass, m, true) END
         FROM (SELECT max(${q(s.column_name)})::bigint AS m FROM ${q(s.table_name)}) x`, [s.seq]);
    }

    // Checks before COMMIT: anything off rolls the whole refresh back.
    for (const spec of data) {
      const { rows: [{ n }] } = await tgt.query(`SELECT count(*)::int AS n FROM ${q(spec.table)}`);
      if (n !== spec.rows.length) throw new Error(`${spec.table}: loaded ${n}, expected ${spec.rows.length}`);
    }
    const { rows: [{ early }] } = await tgt.query(
      'SELECT count(*)::int AS early FROM orders WHERE created_at < $1', [cutoff]);
    if (early) throw new Error(`${early} orders before the cutoff were loaded`);
    const after = await tgt.query('SELECT key, value, updated_at FROM app_settings ORDER BY key');
    if (JSON.stringify(after.rows) !== JSON.stringify(before.rows)) throw new Error('app_settings changed');

    await tgt.query('COMMIT');
    return { seqs, appSettings: after.rows.length };
  } catch (err) {
    await tgt.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const targetUrl = process.env.DATABASE_URL;
  const targetKind = assertTarget(targetUrl, args);
  const sourceUrl = readSourceUrl(args.sourceEnv);
  if (sourceUrl === targetUrl) throw new Error('Refusing: source and target are the same database.');
  if (sourceUrl.includes(STAGING_REF) && targetKind === 'staging') {
    throw new Error('Refusing: the source is the staging project itself.');
  }
  if (!args.yes && !args.dryRun) {
    console.error('This WIPES the staging database and loads production data into it.');
    console.error('Re-run with --dry-run to see the plan, or --yes to do it.');
    process.exit(1);
  }
  const cutoff = `${args.since}T00:00:00+08:00`;

  const tgt = connect(targetUrl);
  const src = connect(sourceUrl);
  await tgt.connect();
  await src.connect();
  try {
    const targetCols = await columnsOf(tgt);
    const known = new Set([...COPY.map((c) => c.table), ...WIPE_ONLY, ...KEEP]);
    const unknown = [...targetCols.keys()].filter((t) => !known.has(t));
    if (unknown.length) throw new Error(`Target has tables this script does not handle: ${unknown.join(', ')}`);
    const absent = COPY.map((c) => c.table).filter((t) => !targetCols.has(t));
    if (absent.length) throw new Error(`Target is missing tables (run migrations): ${absent.join(', ')}`);

    console.log(`Target: ${targetKind}. Orders and logs from ${cutoff}.`);
    const data = await readSource(src, targetCols, cutoff);

    console.log('\ntable                      source   copied  dropped(cut-order refs)');
    for (const d of data) {
      console.log(`${d.table.padEnd(26)} ${String(d.sourceTotal).padStart(7)} ${String(d.rows.length).padStart(8)}  ${d.dropped || ''}`);
      if (d.skippedCols.length) console.log(`  (source-only columns not copied: ${d.skippedCols.join(', ')})`);
    }

    if (args.dryRun) {
      console.log('\nDry run: nothing written.');
      return;
    }
    const res = await loadTarget(tgt, data, cutoff);
    console.log(`\nCommitted. ${res.seqs.length} sequences moved past the copied ids; ${res.appSettings} app_settings row(s) kept.`);
    console.log('Staging logins are now production\'s. Devices running the staging app must clear app data.');
  } finally {
    await src.end().catch(() => {});
    await tgt.end().catch(() => {});
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`\nFailed: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { assertTarget };
