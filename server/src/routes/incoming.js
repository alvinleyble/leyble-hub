const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { applyStockDelta, applyDeltaMap } = require('../lib/inventory');
const { parseDeliveryRef } = require('../lib/receiptNumbers');
const { assertIssuableStation } = require('../lib/stationSlots');
const {
  normalizeRequestKey, findByRequestKey, findByReceiptNumber,
  isDuplicateRequestKey, isDuplicateReceiptNumber,
} = require('../lib/idempotency');

// Matches the partial unique index created by migration 036.
const DELIVERY_REF_INDEX = 'supplier_deliveries_receipt_number_uniq';
// Migration 039's partial unique index over the retry key (ADR 0017 #9).
const REQUEST_KEY_INDEX = 'supplier_deliveries_request_key_uniq';

const router = express.Router();
router.use(requireAuth);

// ─── helpers ────────────────────────────────────────────────────────────────

async function getFullDelivery(deliveryId) {
  const { rows: [delivery] } = await db.query(
    `SELECT sd.*, u.full_name AS created_by_name
     FROM supplier_deliveries sd
     LEFT JOIN users u ON u.id = sd.created_by
     WHERE sd.id = $1`,
    [deliveryId]
  );
  if (!delivery) return null;

  const { rows: items } = await db.query(
    `SELECT sdi.*, p.name AS product_name, p.sku, p.unit
     FROM supplier_delivery_items sdi
     JOIN products p ON p.id = sdi.product_id
     WHERE sdi.delivery_id = $1
     ORDER BY sdi.id`,
    [deliveryId]
  );
  return { ...delivery, items };
}

// Reconcile stock after editing/voiding a delivery. Deliveries ADD stock, so the
// per-product change is (newQty − oldQty); pass newItems = [] to fully reverse.
//
// `delivery_edit`, not `manual_adjustment` (migration 038): this is business activity,
// not somebody's stock recount, and the offline guard's HUMAN_ACTION_FOR_FIELD map
// reads `manual_adjustment` on current_stock as exactly that. Labelling a delivery
// reversal that way raised a reconciliation question about a value nobody disputed.
async function reconcileDeliveryStock(client, oldItems, newItems, deliveryId, userId, reason) {
  const deltas = {};
  for (const it of oldItems) {
    deltas[it.product_id] = (deltas[it.product_id] || 0) - Number(it.quantity_received);
  }
  for (const it of newItems) {
    deltas[it.product_id] = (deltas[it.product_id] || 0) + Number(it.quantity_received);
  }
  await applyDeltaMap(client, deltas, { actionType: 'delivery_edit', reason, userId, deliveryId });
}

// ─── routes ─────────────────────────────────────────────────────────────────

// GET /api/v1/incoming
router.get('/', async (req, res, next) => {
  try {
    const { supplier_name, from_date, to_date } = req.query;
    const conditions = ['sd.voided_at IS NULL']; // voided deliveries never appear
    const params = [];
    let idx = 1;

    if (supplier_name) {
      conditions.push(`sd.supplier_name ILIKE $${idx++}`);
      params.push(`%${supplier_name}%`);
    }
    if (from_date) {
      conditions.push(`sd.received_at >= $${idx++}`);
      params.push(from_date);
    }
    if (to_date) {
      // Inclusive of the whole "to" day (received_at is a TIMESTAMPTZ).
      conditions.push(`sd.received_at < ($${idx++}::date + INTERVAL '1 day')`);
      params.push(to_date);
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    const { rows } = await db.query(
      `SELECT sd.*, u.full_name AS created_by_name,
              COUNT(sdi.id)::INT AS item_count
       FROM supplier_deliveries sd
       LEFT JOIN users u ON u.id = sd.created_by
       LEFT JOIN supplier_delivery_items sdi ON sdi.delivery_id = sd.id
       ${whereClause}
       GROUP BY sd.id, u.full_name
       ORDER BY sd.received_at DESC`,
      params
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/incoming — log delivery and restock products
//
// Two optional fields carry the device's version of the truth when the delivery was
// logged locally (ADR 0015 §8; ADR 0017 #9). Both are absent for a delivery logged from
// a connected client, which behaves exactly as before:
//   request_key   the retry key: generated on the device once per outbox record and
//                 resent unchanged on every retry OF THAT RECORD. It is the record's
//                 identity here, so a resend of a key already stored is answered with
//                 the stored delivery and a 200 rather than a second truckload of stock.
//   delivery_ref  '<station>-DEL-<sequence>' issued on the device at Save. It names the
//                 DELIVERY and stays unique, but is no longer what a retry is recognised
//                 by. With no request_key it still is, as the fallback for a pre-039
//                 queued record (ADR 0006's mechanism, second table).
router.post('/', async (req, res, next) => {
  const { supplier_name, notes, received_at, items, delivery_ref, request_key } = req.body;

  // Validate input before opening a connection/transaction — an early return after
  // BEGIN would release the client mid-transaction (pg won't auto-rollback).
  if (!supplier_name) return res.status(400).json({ error: 'supplier_name is required' });
  if (!items?.length) return res.status(400).json({ error: 'At least one item is required' });
  if (items.some((it) => !it.product_id || !it.quantity_received)) {
    return res.status(400).json({ error: 'Each item requires product_id and quantity_received' });
  }

  let requestKey = null;
  try {
    requestKey = normalizeRequestKey(request_key);
  } catch (err) {
    return next(err);
  }

  let ref = null;
  if (delivery_ref !== undefined && delivery_ref !== null && delivery_ref !== '') {
    try {
      ref = parseDeliveryRef(delivery_ref);
      // ADR 0016 — same three-slot cap the receipt numbers carry; a delivery reference
      // is issued off the same station number.
      assertIssuableStation(ref.station, { field: 'delivery_ref' });
    } catch (err) {
      return next(err);
    }
  }

  // The ordinary resend: the first attempt committed and only the response was lost.
  // Keyed on the retry key when the device sent one, and only on it (ADR 0017 #9);
  // on the delivery reference otherwise, which is the pre-039 fallback and stays.
  const dedupeBy = requestKey
    ? () => findByRequestKey(db, 'supplier_deliveries', requestKey)
    : (ref ? () => findByReceiptNumber(db, 'supplier_deliveries', ref) : null);

  if (dedupeBy) {
    try {
      const existingId = await dedupeBy();
      if (existingId) return res.json(await getFullDelivery(existingId));
    } catch (err) {
      return next(err);
    }
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { rows: [delivery] } = await client.query(
      `INSERT INTO supplier_deliveries
         (supplier_name, notes, received_at, created_by, receipt_station, receipt_sequence,
          request_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [supplier_name, notes || null, received_at || new Date().toISOString(), req.user.id,
       ref?.station ?? null, ref?.sequence ?? null, requestKey]
    );

    for (const item of items) {
      const { product_id, quantity_received, unit_cost, notes: itemNotes } = item;

      await client.query(
        `INSERT INTO supplier_delivery_items (delivery_id, product_id, quantity_received, unit_cost, notes)
         VALUES ($1, $2, $3, $4, $5)`,
        [delivery.id, product_id, quantity_received, unit_cost || null, itemNotes || null]
      );

      await applyStockDelta(client, {
        productId:  product_id,
        delta:      Number(quantity_received),
        actionType: 'restock',
        reason:     `Supplier delivery: ${supplier_name}`,
        userId:     req.user.id,
        deliveryId: delivery.id,
      });
    }

    await client.query('COMMIT');
    res.status(201).json(await getFullDelivery(delivery.id));
  } catch (err) {
    await client.query('ROLLBACK');
    // Two drain attempts of the SAME record overlapping: both looked, neither found,
    // both inserted. Either index can be the one that fires — an identical resend
    // collides on both — so the constraint name only decides whether to look, and
    // `dedupeBy` decides what it was. See orders.js for the full reasoning.
    if (dedupeBy && (isDuplicateRequestKey(err, REQUEST_KEY_INDEX)
                  || isDuplicateReceiptNumber(err, DELIVERY_REF_INDEX))) {
      try {
        const existingId = await dedupeBy();
        if (existingId) return res.json(await getFullDelivery(existingId));
      } catch (lookupErr) {
        return next(lookupErr);
      }
    }
    // ADR 0017 #9 — a DIFFERENT record arriving on a delivery reference already stored.
    // Two separate truckloads wearing one label: never answered with the stored one, and
    // refused rather than 500'd so the outbox is not stalled behind it. See orders.js.
    if (requestKey && ref && isDuplicateReceiptNumber(err, DELIVERY_REF_INDEX)) {
      return res.status(409).json({
        error: `Delivery reference ${delivery_ref} is already used by a different delivery. `
             + 'Two deliveries cannot share a reference — re-issue this one.',
      });
    }
    next(err);
  } finally {
    client.release();
  }
});

// GET /api/v1/incoming/:id
router.get('/:id', async (req, res, next) => {
  try {
    const delivery = await getFullDelivery(req.params.id);
    if (!delivery) return res.status(404).json({ error: 'Delivery not found' });
    res.json(delivery);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/v1/incoming/:id — edit a logged delivery (header + items), reconciling stock
router.patch('/:id', async (req, res, next) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { rows: [delivery] } = await client.query(
      'SELECT * FROM supplier_deliveries WHERE id = $1 FOR UPDATE',
      [req.params.id]
    );
    if (!delivery) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Delivery not found' });
    }
    if (delivery.voided_at) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Cannot edit a voided delivery' });
    }

    const { supplier_name, notes, received_at, items } = req.body;

    if (supplier_name !== undefined && !supplier_name.trim()) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'supplier_name cannot be empty' });
    }
    if (items !== undefined) {
      if (!items.length) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'At least one item is required' });
      }
      for (const it of items) {
        if (!it.product_id || !(Number(it.quantity_received) > 0)) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Each item requires a product and a quantity greater than 0' });
        }
      }
    }

    await client.query(
      `UPDATE supplier_deliveries
          SET supplier_name = COALESCE($1, supplier_name),
              notes         = $2,
              received_at   = COALESCE($3, received_at)
        WHERE id = $4`,
      [supplier_name !== undefined ? supplier_name.trim() : null,
       notes !== undefined ? (notes || null) : delivery.notes,
       received_at ?? null,
       delivery.id]
    );

    if (items !== undefined) {
      const { rows: oldItems } = await client.query(
        'SELECT product_id, quantity_received FROM supplier_delivery_items WHERE delivery_id = $1',
        [delivery.id]
      );

      await client.query('DELETE FROM supplier_delivery_items WHERE delivery_id = $1', [delivery.id]);
      for (const it of items) {
        await client.query(
          `INSERT INTO supplier_delivery_items (delivery_id, product_id, quantity_received, unit_cost, notes)
           VALUES ($1, $2, $3, $4, $5)`,
          [delivery.id, it.product_id, Number(it.quantity_received),
           it.unit_cost != null && it.unit_cost !== '' ? Number(it.unit_cost) : null,
           it.notes?.trim() || null]
        );
      }

      await reconcileDeliveryStock(client, oldItems, items, delivery.id, req.user.id,
        `Delivery #${delivery.id} edited`);
    }

    await client.query('COMMIT');
    res.json(await getFullDelivery(delivery.id));
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// DELETE /api/v1/incoming/:id — void a delivery: reverse its restock, keep the audit trail
router.delete('/:id', async (req, res, next) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { rows: [delivery] } = await client.query(
      'SELECT * FROM supplier_deliveries WHERE id = $1 FOR UPDATE',
      [req.params.id]
    );
    if (!delivery) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Delivery not found' });
    }
    if (delivery.voided_at) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Delivery is already voided' });
    }

    const { rows: items } = await client.query(
      'SELECT product_id, quantity_received FROM supplier_delivery_items WHERE delivery_id = $1',
      [delivery.id]
    );

    await reconcileDeliveryStock(client, items, [], delivery.id, req.user.id,
      `Delivery #${delivery.id} voided`);

    await client.query(
      'UPDATE supplier_deliveries SET voided_at = NOW(), voided_by = $1 WHERE id = $2',
      [req.user.id, delivery.id]
    );

    await client.query('COMMIT');
    res.status(204).end();
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
