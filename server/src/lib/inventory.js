// Shared inventory helpers — the single place that mutates products.current_stock
// and records the change in the append-only inventory_audit_logs table. Promoted
// from the per-route copies that used to live in orders.js and incoming.js.
//
// `client` MUST be a transaction client (BEGIN already issued): the
// SELECT … FOR UPDATE row lock, the stock UPDATE, and the audit INSERT have to
// commit atomically.

// Apply one stock delta to a product and log it. No-op when delta is 0.
// current_stock is NUMERIC → pg returns it as a string, so coerce with Number().
async function applyStockDelta(
  client,
  { productId, delta, actionType, reason, userId, orderId = null, deliveryId = null }
) {
  if (delta === 0) return;

  const { rows: [product] } = await client.query(
    'SELECT current_stock FROM products WHERE id = $1 FOR UPDATE',
    [productId]
  );
  const newStock = Number(product.current_stock) + delta;

  await client.query(
    'UPDATE products SET current_stock = $1, updated_at = NOW() WHERE id = $2',
    [newStock, productId]
  );
  await client.query(
    `INSERT INTO inventory_audit_logs
       (product_id, action_type, field_changed, previous_value, new_value,
        delta, reason, performed_by, related_order_id, related_delivery_id)
     VALUES ($1, $2, 'current_stock', $3, $4, $5, $6, $7, $8, $9)`,
    [productId, actionType, String(product.current_stock), String(newStock),
     delta, reason, userId, orderId, deliveryId]
  );
}

// Apply a whole { productId: delta } map. Iterates in ascending product_id order
// so concurrent transactions always take row locks in the same order (deadlock
// avoidance — matches the old deductStock pre-lock loop). 0 deltas are skipped.
async function applyDeltaMap(client, deltaMap, opts) {
  const ids = Object.keys(deltaMap).map(Number).sort((a, b) => a - b);
  for (const productId of ids) {
    await applyStockDelta(client, { ...opts, productId, delta: deltaMap[productId] });
  }
}

// Is this order's stock currently OUT of the warehouse?
//
// Not "was it ever deducted" — under ADR 0012 an order can cross the deduction boundary
// more than once (dispatch → step back to pending → dispatch again), and "ever" answers
// yes forever after the first crossing, which would make the second dispatch a no-op and
// leave the stock permanently overstated.
//
// Every stock movement an order causes is logged against it (deduct negative, restore
// positive, edit-reconcile either way), and inventory_audit_logs is append-only, so the
// running sum of an order's own deltas IS its current state: negative while the goods are
// out, zero once they are back. That also reads the ~V2-window orders correctly — they
// were deducted at save, so they sum negative while still `pending`, and this refuses to
// deduct them a second time on dispatch.
async function isStockOut(client, orderId) {
  const { rows: [row] } = await client.query(
    `SELECT COALESCE(SUM(delta), 0) AS net
     FROM inventory_audit_logs
     WHERE related_order_id = $1`,
    [orderId]
  );
  return Number(row.net) < 0;
}

module.exports = { applyStockDelta, applyDeltaMap, isStockOut };
