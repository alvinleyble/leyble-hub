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

// Apply a whole { productId: delta } map in THREE round trips, whatever the map's size —
// lock, update, log — instead of the three-per-product the sequential loop cost. The
// production API sits ~200ms from the database, so a 10-product order edit was spending
// six seconds here alone and blowing the client's (correct) 5s write budget.
//
// The three guarantees the per-product loop gave are each preserved deliberately:
//
//  • Lock ORDER. `ORDER BY id … FOR UPDATE` locks the rows in ascending id order — the
//    LockRows node sits above the Sort, so it takes each lock as the sorted row reaches
//    it. Concurrent transactions therefore still queue in the same order and cannot
//    deadlock against each other, exactly as the old ascending-id loop ensured.
//  • Arithmetic. The new stock is still computed in JS from the locked previous value and
//    written as a literal, so the stored number and the audit row's `new_value` text are
//    byte-for-byte what the loop produced.
//  • Atomicity. Still one caller-supplied transaction; nothing here opens its own.
//
// 0 deltas are skipped, as before.
async function applyDeltaMap(client, deltaMap, opts) {
  const {
    actionType, reason, userId, orderId = null, deliveryId = null,
  } = opts;

  const ids = Object.keys(deltaMap)
    .map(Number)
    .filter((id) => Number.isInteger(id) && Number(deltaMap[id]) !== 0)
    .sort((a, b) => a - b);
  if (!ids.length) return;

  const { rows: locked } = await client.query(
    `SELECT id, current_stock FROM products
      WHERE id = ANY($1::int[])
      ORDER BY id
        FOR UPDATE`,
    [ids]
  );
  const previousById = new Map(locked.map((r) => [Number(r.id), r.current_stock]));

  const previousValues = [];
  const newValues      = [];
  const deltas         = [];
  for (const productId of ids) {
    if (!previousById.has(productId)) {
      // The per-product loop dereferenced an undefined row here and threw; keep it loud
      // rather than silently logging a movement against a product that does not exist.
      const err = new Error(`Product ${productId} not found while applying stock deltas`);
      err.status = 400;
      throw err;
    }
    const previous = previousById.get(productId);
    const delta    = deltaMap[productId];
    previousValues.push(String(previous));
    newValues.push(String(Number(previous) + delta));
    deltas.push(String(delta));
  }

  await client.query(
    `UPDATE products p
        SET current_stock = d.new_stock,
            updated_at    = NOW()
       FROM unnest($1::int[], $2::numeric[]) AS d(product_id, new_stock)
      WHERE p.id = d.product_id`,
    [ids, newValues]
  );

  await client.query(
    `INSERT INTO inventory_audit_logs
       (product_id, action_type, field_changed, previous_value, new_value,
        delta, reason, performed_by, related_order_id, related_delivery_id)
     SELECT d.product_id, $4, 'current_stock', d.previous_value, d.new_value,
            d.delta, $5, $6, $7, $8
       FROM unnest($1::int[], $2::text[], $3::text[], $9::numeric[])
            AS d(product_id, previous_value, new_value, delta)`,
    [ids, previousValues, newValues, actionType, reason, userId, orderId, deliveryId, deltas]
  );
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
