// One-off data script — NOT run automatically. Restricts login to Josie and wires up the
// Josie / Luis / Admin profile picker by tagging the corresponding user rows with a
// profile_key (see migration 030). Run manually: `node server/db/setup-profiles.js`.
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const bcrypt = require('bcrypt');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

const JOSIE_EMAIL = 'josie@leyblestore.com';
const JOSIE_PASSWORD = process.env.JOSIE_PASSWORD || 'leyble123';

// email -> profile_key (accounts not listed here are deactivated with no profile_key)
const PROFILE_MAP = {
  'josie@leyblestore.com': 'josie',
  'luis@leyblestore.com': 'luis',
  'alvin@leyblestore.com': 'admin',
};

async function setupProfiles() {
  const client = await pool.connect();
  try {
    const { rows: users } = await client.query('SELECT id, email FROM users');
    if (!users.length) {
      console.error('No users found — nothing to do.');
      process.exit(1);
    }

    for (const user of users) {
      const profileKey = PROFILE_MAP[user.email] || null;
      const isJosie = user.email === JOSIE_EMAIL;

      if (isJosie) {
        const hash = await bcrypt.hash(JOSIE_PASSWORD, 12);
        await client.query(
          `UPDATE users SET password_hash = $1, is_active = TRUE, profile_key = $2 WHERE id = $3`,
          [hash, profileKey, user.id]
        );
        console.log(`  ✓ ${user.email}: password reset, is_active=TRUE, profile_key='${profileKey}'`);
      } else {
        await client.query(
          `UPDATE users SET is_active = FALSE, profile_key = $1 WHERE id = $2`,
          [profileKey, user.id]
        );
        console.log(`  ✓ ${user.email}: is_active=FALSE, profile_key=${profileKey ? `'${profileKey}'` : 'NULL'}`);
      }
    }
  } catch (err) {
    console.error('setup-profiles failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

setupProfiles();
