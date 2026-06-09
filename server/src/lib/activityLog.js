// Shared helpers for writing to the generic activity_logs table.
// `executor` is anything exposing `.query` — either the pool (`db`) or a
// transaction `client`, matching the call site's existing style.

async function logActivity(executor, { entityType, entityId, action, summary, performedBy }) {
  await executor.query(
    `INSERT INTO activity_logs (entity_type, entity_id, action, summary, performed_by)
     VALUES ($1, $2, $3, $4, $5)`,
    [entityType, entityId, action, summary, performedBy]
  );
}

// Compares `existing[field]` vs `incoming[field]` for each [field, label] pair
// (skipping fields not present in `incoming`) and returns human-readable
// "Label changed from 'old' to 'new'" strings for the ones that differ.
function diffFields(existing, incoming, fieldDefs) {
  const changes = [];
  for (const [field, label] of fieldDefs) {
    if (incoming[field] === undefined) continue;
    const before = existing[field];
    const after = incoming[field];
    if (String(before ?? '') !== String(after ?? '')) {
      changes.push(`${label} changed from '${before ?? '—'}' to '${after ?? '—'}'`);
    }
  }
  return changes;
}

module.exports = { logActivity, diffFields };
