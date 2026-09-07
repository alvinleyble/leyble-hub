// One-off data script — NOT run automatically. ADR 0017 §5/§6: every person signs in with
// their OWN account, and profiles are gone. This activates the three real `users` rows
// (Alvin/admin, Josie, Luis) so each can sign in directly.
//
// The two non-Josie accounts already exist with the right names — `setup-profiles.js`,
// which this replaces, had deactivated them because login was restricted to the shared
// Josie account. They are RE-ACTIVATED here, never created, so their ids (which
// `activity_logs.performed_by` already references) are unchanged.
//
// All three keep the same password by captain decision — receipt attribution is
// honour-system, exactly as the profile picker it replaces was. Josie's existing
// password_hash is deliberately left untouched; only the two re-activated accounts get
// one written. Run manually: `node server/db/setup-accounts.js`.
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const bcrypt = require('bcrypt');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

const JOSIE_EMAIL = 'josie@leyblestore.com';
const ACCOUNT_PASSWORD = process.env.ACCOUNT_PASSWORD || 'leyble123';

// The people who can sign in. Anyone else in `users` is deactivated.
const ACCOUNT_EMAILS = [JOSIE_EMAIL, 'luis@leyblestore.com', 'alvin@leyblestore.com'];

async function setupAccounts() {
  const client = await pool.connect();
  try {
    const { rows: users } = await client.query('SELECT id, email FROM users');
    if (!users.length) {
      console.error('No users found — nothing to do.');
      process.exit(1);
    }

    const missing = ACCOUNT_EMAILS.filter((e) => !users.some((u) => u.email === e));
    if (missing.length) {
      console.warn(`  ! not present in users, skipped: ${missing.join(', ')}`);
    }

    for (const user of users) {
      if (!ACCOUNT_EMAILS.includes(user.email)) {
        await client.query('UPDATE users SET is_active = FALSE WHERE id = $1', [user.id]);
        console.log(`  ✓ ${user.email}: is_active=FALSE`);
        continue;
      }

      if (user.email === JOSIE_EMAIL) {
        // Josie's account and password are unchanged — it simply stops being shared.
        await client.query('UPDATE users SET is_active = TRUE WHERE id = $1', [user.id]);
        console.log(`  ✓ ${user.email}: is_active=TRUE (password left as-is)`);
        continue;
      }

      const hash = await bcrypt.hash(ACCOUNT_PASSWORD, 12);
      await client.query(
        'UPDATE users SET password_hash = $1, is_active = TRUE WHERE id = $2',
        [hash, user.id]
      );
      console.log(`  ✓ ${user.email}: password set, is_active=TRUE`);
    }
  } catch (err) {
    console.error('setup-accounts failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

setupAccounts();
