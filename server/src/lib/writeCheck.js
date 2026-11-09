// "Can the database take a write right now?" — asked by the offline outbox when one
// queued record gets a 5xx, before it holds that failure against the record.
//
// `/health` answers without touching the database, so it says nothing here. A database
// that is up but refusing writes is the case that matters: Supabase switches a database
// that runs out of disk to read-only (`default_transaction_read_only = on`), and then
// EVERY record fails with a 5xx. If those failures counted against the records, a
// server-wide problem would push a device's whole queue into Needs attention one record
// at a time. So the device only counts a 5xx when this check passes.
//
// The probe is a real write that can never land: create a temporary table and insert
// one row into it inside a transaction that is always rolled back. A read-only session
// refuses both (SQLSTATE 25006), and nothing outside this connection ever sees either —
// no business table is touched and no data changes. Two round trips: the probe as one
// simple-protocol batch, then the ROLLBACK.
const PROBE_SQL = [
  'BEGIN',
  'CREATE TEMP TABLE leyble_write_check (ok INT) ON COMMIT DROP',
  'INSERT INTO leyble_write_check (ok) VALUES (1)',
].join('; ');

/**
 * Resolves when `client` can write, rejects with the database's own error when it
 * cannot. Always leaves the connection outside any transaction.
 */
async function checkDatabaseWritable(client) {
  try {
    await client.query(PROBE_SQL);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
  }
}

module.exports = { checkDatabaseWritable };
