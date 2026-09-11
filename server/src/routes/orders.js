const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { logActivity } = require('../lib/activityLog');
const { applyDeltaMap, isStockOut } = require('../lib/inventory');
const { parseReceiptNumber, parseBareSequence } = require('../lib/receiptNumbers');
const { assertIssuableStation } = require('../lib/personNumbers');
const {
  normalizeRequestKey, findByRequestKey, findByReceiptNumber,
  isDuplicateRequestKey, isDuplicateReceiptNumber,
} = require('../lib/idempotency');

// Name of the partial unique index from migration 033, rebuilt over the device
// letter by migration 040 under the same name. Used to tell a genuine duplicate
// receipt number apart from any other unique violation.
const RECEIPT_NUMBER_INDEX = 'orders_receipt_number_uniq';
// Migration 039's partial unique index over the retry key (ADR 0017 #9).
const REQUEST_KEY_INDEX = 'orders_request_key_uniq';

const router = express.Router();
router.use(requireAuth);

// Allowed status transitions depend on order_type for pickup orders
function getAllowedTransitions(status, orderType) {
  if (orderType === 'pickup') {
    const map = {
      pending:   ['completed', 'cancelled'],
      completed: ['pending', 'done', 'cancelled'],
      done:      ['completed'],
    };
    return map[status] || [];
  }
  const map = {
    pending:    ['in_transit', 'cancelled'],
    in_transit: ['pending', 'completed', 'cancelled'],
    completed:  ['in_transit', 'done', 'cancelled'],
    done:       ['completed'],
  };
  return map[status] || [];
}

// ─── helpers ────────────────────────────────────────────────────────────────

// D1 — how an order is named to a human. The row id stays an internal detail; an order
// that carries a device-issued receipt number is referred to by it, in the activity log
// as everywhere else. Historical orders (and every order created while the V2.5 client
// switch is off) have no receipt number and keep reading as '#<id>', exactly as today.
function orderLabel(order) {
  return order?.receipt_number ? order.receipt_number : `#${order?.id}`;
}

// ADR 0019 — revisions are optional on the wire during the mixed-APK rollout, but
// whenever a non-draft mutation carries one it is an exact compare-and-swap token.
// Keep it as a decimal string: pg returns BIGINT as text and converting it to Number
// would eventually lose precision for no benefit.
function expectedRevision(value) {
  if (value === undefined || value === null || value === '') return null;
  const revision = String(value);
  if (!/^\d+$/.test(revision) || revision === '0') {
    const err = new Error('revision must be a positive integer');
    err.status = 400;
    throw err;
  }
  return revision;
}

function revisionMatches(order, revision) {
  return revision === null || String(order.revision) === revision;
}

async function sendStaleWrite(client, res, orderId, revision) {
  // Read the order, items and personnel while this transaction still holds the row
  // lock. The 409 therefore carries one authoritative snapshot, not three pool reads
  // that another mutation could slip between. Only then release the loser.
  const current = await getFullOrder(orderId, client);
  await client.query('ROLLBACK');
  return res.status(409).json({
    code: 'stale_write',
    error: 'This order changed on another device. Review the current order before editing again.',
    expected_revision: revision,
    current_revision: current?.revision ?? null,
    order: current,
  });
}

// Resolves an order identifier to the order row id. It has to answer for all three
// shapes that coexist permanently (ADR 0017 #12), because a receipt number is how an
// order is addressed across the sync boundary (ADR 0010) and old-format acceptance is
// never removed (ADR 0014's ADR-0017 switchover ordering, step 4):
//   '1A-00042'  a receipt number carrying a device letter
//   '3-00061'   a receipt number from the pre-letter scheme
//   '1240'      a bare row id — every legacy order, which never had a receipt number
//
// The letter is matched through the same COALESCE the partial unique index uses, so
// '3-00061' finds only the letterless row and never a '3A-00061' belonging to a
// different device.
async function resolveOrderId(runner, param) {
  if (param === undefined || param === null) return null;
  const str = String(param).trim();
  const receipt = /^(\d{1,9})([A-Za-z]{0,2})-(\d{1,9})$/.exec(str);
  if (receipt) {
    const { rows: [row] } = await runner.query(
      `SELECT id FROM orders
        WHERE receipt_station = $1
          AND COALESCE(receipt_device, '') = $2
          AND receipt_sequence = $3`,
      [Number(receipt[1]), receipt[2].toUpperCase(), Number(receipt[3])]
    );
    return row ? row.id : null;
  }
  const num = Number(str);
  return Number.isInteger(num) ? num : null;
}

// The "goods-only while open, deposit folded in once closed" rule (see the totals note in
// CLAUDE.md) expressed as ONE statement: the status test that used to cost a SELECT of its
// own is a CASE over the row being updated, and the sum is a scalar subquery rather than a
// separate round trip. `o.status` inside the SET reads the row's pre-update value, and no
// caller of this ever changes status in the same statement, so the branch is unchanged.
async function recomputeTotal(client, orderId) {
  const { rows: [row] } = await client.query(
    `UPDATE orders o
        SET total_amount = (
              SELECT COALESCE(SUM(CASE WHEN o.status = 'done'
                                       THEN oi.line_total
                                       ELSE oi.quantity * oi.unit_price END), 0)
                FROM order_items oi
               WHERE oi.order_id = o.id),
            updated_at = NOW()
      WHERE o.id = $1
      RETURNING total_amount AS total`,
    [orderId]
  );
  return row ? row.total : null;
}

// Category/name for the packer-order sort below. One query for the whole item list;
// the caller may hand the map to sortItemsByCategory instead of re-fetching it.
async function fetchItemSortInfo(client, items) {
  const productIds = [...new Set(items.map((i) => i.product_id).filter(Boolean))];
  if (!productIds.length) return new Map();

  const { rows: products } = await client.query(
    'SELECT id, category, name FROM products WHERE id = ANY($1::int[])',
    [productIds]
  );
  return new Map(products.map((p) => [p.id, p]));
}

// Orders are typically entered in whatever order the customer texted them in.
// Packers work the warehouse by category, so re-sort items into category order
// (matching the ORDER BY category NULLS LAST, name convention used for the
// product list) before they're written — every downstream view (detail page,
// receipt, review queues) reads order_items back in insertion (id) order.
//
// Pure: `infoById` comes from fetchItemSortInfo. Sorting stays in JS on purpose — an
// ORDER BY in the INSERT would re-sort under the database's collation rather than
// localeCompare's, quietly changing the order lines print in.
function sortItemsByCategory(items, infoById) {
  if (!infoById.size) return items;

  return [...items].sort((a, b) => {
    const pa = infoById.get(a.product_id);
    const pb = infoById.get(b.product_id);
    if (!pa || !pb) return 0; // placeholder/unmatched rows (draft mid-entry): leave as-is

    if (pa.category !== pb.category) {
      if (!pa.category) return 1;
      if (!pb.category) return -1;
      return pa.category.localeCompare(pb.category);
    }
    return pa.name.localeCompare(pb.name);
  });
}

// Validate and normalise the request's item list into the exact column values that get
// written — no I/O, so the whole list costs nothing. It deliberately does NOT persist a
// saved price: `is_price_overridden` records that this line's price was hand-typed on this
// order, which is not the same as an agreed standing rate for the customer. Saving that
// rate is the sole job of the explicit "Save Custom Price?" prompt (POST
// /customers/:id/prices) — before this, order-save wrote a customer_product_prices row on
// the flag alone, so a one-off price became permanent whatever the operator answered, and
// there is no delete endpoint to take it back.
//
// `returnsByProduct` (edit of a closed order) carries the bottle returns recorded at close
// straight into the new rows, clamped per line exactly as the old follow-up UPDATE's
// LEAST(returned, FLOOR(quantity * units_per_case)) did.
function buildItemRows(items, draft = false, returnsByProduct = null) {
  const rows = [];
  for (const item of items) {
    const {
      product_id, quantity, unit_price,
      unit_deposit_fee = 0, is_price_overridden = false,
      units_per_case = 1,
    } = item;

    if (draft) {
      // Drafts can be incomplete: skip placeholder rows with no product selected yet.
      if (!product_id) continue;
    } else if (!product_id || !quantity || unit_price === undefined) {
      const err = new Error('Each item requires product_id, quantity, and unit_price');
      err.status = 400;
      throw err;
    }

    // Drafts tolerate a blank quantity/price (e.g. mid-entry). quantity has a
    // CHECK (> 0), so fall back to 1; unit_price may be 0.
    const qty   = draft ? (Number(quantity) > 0 ? Number(quantity) : 1) : quantity;
    // Money never goes negative on a line: a discount is the order-level
    // `adjustment` (which stays signed), never a negative price. Finalized rows
    // are rejected outright; drafts, which tolerate half-typed values, clamp.
    if (!draft && (Number(unit_price) < 0 || Number(unit_deposit_fee) < 0)) {
      const err = new Error('A price per case and a deposit fee cannot be negative.');
      err.status = 400;
      throw err;
    }
    const price   = draft ? Math.max(0, Number(unit_price) || 0) : unit_price;
    const deposit = draft ? Math.max(0, Number(unit_deposit_fee) || 0) : unit_deposit_fee;

    let returned = 0;
    if (returnsByProduct) {
      const carried = Number(returnsByProduct[product_id] || 0);
      if (carried > 0) {
        const bottles = Math.floor(Number(qty) * (Number(units_per_case) || 1));
        returned = Math.min(carried, bottles);
      }
    }

    // Values go through to the array parameters exactly as the per-row INSERT passed
    // them; pg does the same coercion either way.
    rows.push({
      product_id, qty, price, deposit, is_price_overridden, units_per_case, returned,
    });
  }
  return rows;
}

// The seven parallel arrays the set-based INSERT unnests. Element order IS insertion
// order, which downstream views read back as `ORDER BY oi.id`.
function itemColumnArrays(rows) {
  return [
    rows.map((r) => r.product_id),
    rows.map((r) => r.qty),
    rows.map((r) => r.price),
    rows.map((r) => r.deposit),
    rows.map((r) => r.is_price_overridden),
    rows.map((r) => r.units_per_case),
    rows.map((r) => r.returned),
  ];
}

// Write a whole item list in ONE statement instead of one INSERT per line.
async function insertItemRows(client, orderId, rows) {
  if (!rows.length) return;
  const cols = itemColumnArrays(rows);
  await client.query(
    `INSERT INTO order_items
       (order_id, product_id, quantity, unit_price, unit_deposit_fee,
        is_price_overridden, units_per_case, bottles_returned)
     SELECT $1, t.product_id, t.quantity, t.unit_price, t.unit_deposit_fee,
            t.is_price_overridden, t.units_per_case, t.bottles_returned
       FROM unnest($2::int[], $3::numeric[], $4::numeric[], $5::numeric[],
                   $6::boolean[], $7::int[], $8::int[])
            AS t(product_id, quantity, unit_price, unit_deposit_fee,
                 is_price_overridden, units_per_case, bottles_returned)`,
    [orderId, ...cols]
  );
}

// Fetch-sort-write for callers that have no other reads to batch with (order creation).
// Two round trips whatever the item count.
async function insertItems(client, orderId, items, draft = false) {
  const infoById = await fetchItemSortInfo(client, items);
  const rows = buildItemRows(sortItemsByCategory(items, infoById), draft);
  await insertItemRows(client, orderId, rows);
}

// Replace an order's lines AND settle everything about the order row that the edit
// changes, in one statement:
//
//   • the old lines go (DELETE in a data-modifying CTE, which Postgres always runs to
//     completion whether or not the primary query reads it),
//   • the new lines land in the given order,
//   • notes / customer / order type are written, and
//   • total_amount is recomputed from the rows just inserted — read out of the `inserted`
//     CTE rather than from order_items, because the outer UPDATE's snapshot cannot see
//     them in the table yet.
//
// That is the three-plus-N round trips the edit path used to spend here, collapsed to one.
// COALESCE keeps customer/order type unchanged when the caller passes null (only a parked
// draft may change them at all).
async function replaceItemsAndSettleOrder(
  client, orderId, rows,
  {
    notes, customerId = null, orderType = null, revision = null,
    deliveryFeeTouched = false, deliveryFeeValue = null,
  }
) {
  const cols = itemColumnArrays(rows);
  return client.query(
    `WITH cleared AS (
       DELETE FROM order_items WHERE order_id = $1
     ), inserted AS (
       INSERT INTO order_items
         (order_id, product_id, quantity, unit_price, unit_deposit_fee,
          is_price_overridden, units_per_case, bottles_returned)
       SELECT $1, t.product_id, t.quantity, t.unit_price, t.unit_deposit_fee,
              t.is_price_overridden, t.units_per_case, t.bottles_returned
         FROM unnest($5::int[], $6::numeric[], $7::numeric[], $8::numeric[],
                     $9::boolean[], $10::int[], $11::int[])
              AS t(product_id, quantity, unit_price, unit_deposit_fee,
                   is_price_overridden, units_per_case, bottles_returned)
       RETURNING quantity, unit_price, line_total
     )
     UPDATE orders o
        SET notes        = $2,
            customer_id  = COALESCE($3::int, o.customer_id),
            order_type   = COALESCE($4::text, o.order_type),
            delivery_fee_charged = CASE WHEN $13::boolean
                                        THEN $14::numeric
                                        ELSE o.delivery_fee_charged END,
            total_amount = (
              SELECT COALESCE(SUM(CASE WHEN o.status = 'done'
                                       THEN i.line_total
                                       ELSE i.quantity * i.unit_price END), 0)
                FROM inserted i),
            updated_at   = NOW()
      WHERE o.id = $1
        AND ($12::bigint IS NULL OR o.revision = $12::bigint)`,
    [orderId, notes, customerId, orderType, ...cols, revision, deliveryFeeTouched, deliveryFeeValue]
  );
}

async function syncPersonnel(client, orderId, personnelList) {
  // Business rule: at most one Driver per order (role defaults to 'Driver' below,
  // so the default must be applied when counting).
  const driverCount = personnelList.filter((p) => (p.role || 'Driver') === 'Driver').length;
  if (driverCount > 1) {
    const err = new Error('Only one personnel can be assigned as Driver per order.');
    err.status = 400;
    throw err;
  }

  await client.query('DELETE FROM order_personnel WHERE order_id = $1', [orderId]);
  if (!personnelList.length) return;

  // One row per person, first appearance keeping its position and the LAST role that
  // mentions them — what the sequential INSERT … ON CONFLICT DO UPDATE loop produced.
  // A multi-row INSERT cannot hit the same key twice ("cannot affect row a second time"),
  // so the de-dupe has to happen here rather than in the conflict clause.
  const byPersonnelId = new Map();
  for (const p of personnelList) byPersonnelId.set(p.id, p.role || 'Driver');

  await client.query(
    `INSERT INTO order_personnel (order_id, personnel_id, role)
     SELECT $1, t.personnel_id, t.role
       FROM unnest($2::int[], $3::text[]) AS t(personnel_id, role)
     ON CONFLICT (order_id, personnel_id) DO UPDATE SET role = EXCLUDED.role`,
    [orderId, [...byPersonnelId.keys()], [...byPersonnelId.values()]]
  );
}

// The three reads behind every order response. They share nothing but the id, so they go
// out together on three pool connections — one round trip of wall time instead of three,
// which is ~0.4s of every edit at the production API's distance from the database. Each
// query is byte-for-byte the one it replaced, so the response shape (and pg's own numeric
// -as-string typing) is untouched. Three pool connections for the length of one read is
// well inside the pool, and pg-pool queues rather than fails if it ever were not.
async function getFullOrder(orderId, runner = db) {
  const resolvedId = await resolveOrderId(runner, orderId);
  if (!resolvedId) return null;

  const reads = [
    () => runner.query(
      `SELECT o.*,
            c.name  AS customer_name, c.customer_type,
            c.address AS customer_address, c.phone AS customer_phone,
            up.full_name AS pending_receipt_printed_by_name,
            ud.full_name AS delivered_receipt_printed_by_name,
            -- ADR 0017 #10 — the seller, in words, for the receipt's "Sold by:" line.
            -- NULL for every order created before migration 042; nothing is backfilled
            -- and the line is simply omitted, exactly like a missing receipt number.
            uc.full_name AS sold_by_name
     FROM orders o
     JOIN customers c ON c.id = o.customer_id
     LEFT JOIN users up ON up.id = o.pending_receipt_printed_by
     LEFT JOIN users ud ON ud.id = o.delivered_receipt_printed_by
     LEFT JOIN users uc ON uc.id = o.created_by
     WHERE o.id = $1`,
      [resolvedId]
    ),
    () => runner.query(
      `SELECT oi.*, p.name AS product_name, p.sku, p.unit, p.category, p.requires_bottle_return
     FROM order_items oi
     JOIN products p ON p.id = oi.product_id
     WHERE oi.order_id = $1
     ORDER BY oi.id`,
      [resolvedId]
    ),
    () => runner.query(
      `SELECT op.id, op.personnel_id, op.role, p.full_name, p.phone
     FROM order_personnel op
     JOIN personnel p ON p.id = op.personnel_id
     WHERE op.order_id = $1
     ORDER BY op.id`,
      [resolvedId]
    ),
  ];
  // Pool reads stay parallel on the hot success path. A transaction client must run
  // sequentially (pg queues concurrent client.query calls today and removes that
  // deprecated behaviour in pg 9), while still sharing one locked transaction.
  const [orderRes, itemsRes, personnelRes] = runner === db
    ? await Promise.all(reads.map((read) => read()))
    : [await reads[0](), await reads[1](), await reads[2]()];

  const [order] = orderRes.rows;
  if (!order) return null;

  return { ...order, items: itemsRes.rows, personnel: personnelRes.rows };
}

// Deduct stock for a set of order items. Allows current_stock to go negative —
// orders are never blocked by low inventory.
async function deductStock(client, items, orderId, userId, reason) {
  const deltas = {};
  for (const item of items) {
    if (!item.product_id) continue;
    deltas[item.product_id] = (deltas[item.product_id] || 0) - Number(item.quantity);
  }
  await applyDeltaMap(client, deltas, { actionType: 'order_fulfillment', reason, userId, orderId });
}

// Restore stock for a set of order items (cancellation / revert).
async function restoreStock(client, items, orderId, userId, reason) {
  const deltas = {};
  for (const item of items) {
    if (!item.product_id) continue;
    deltas[item.product_id] = (deltas[item.product_id] || 0) + Number(item.quantity);
  }
  await applyDeltaMap(client, deltas, { actionType: 'order_cancel', reason, userId, orderId });
}

// Reconcile stock after editing an order with deducted stock.
// oldItems: DB rows before replacement. newItems: req.body items array.
// Per-product delta = oldQty − newQty (positive = restore, negative = deduct more).
async function reconcileStock(client, oldItems, newItems, order, userId) {
  const orderId = order.id;
  const deltas = {};
  for (const item of oldItems) {
    if (!item.product_id) continue;
    deltas[item.product_id] = (deltas[item.product_id] || 0) + Number(item.quantity);
  }
  for (const item of newItems) {
    if (!item.product_id) continue;
    deltas[item.product_id] = (deltas[item.product_id] || 0) - Number(item.quantity);
  }
  await applyDeltaMap(client, deltas, {
    actionType: 'order_edit',
    reason: `Order ${orderLabel(order)} items edited`,
    userId,
    orderId,
  });
}

// ─── routes ─────────────────────────────────────────────────────────────────

// GET /api/v1/orders
router.get('/', async (req, res, next) => {
  try {
    const { status, customer_id, from_date, to_date, search, q, page: pageQuery, limit: limitQuery } = req.query;
    const isPaginated = pageQuery !== undefined || limitQuery !== undefined;
    const page = Math.max(1, parseInt(pageQuery, 10) || 1);
    const limit = isPaginated
      ? Math.min(200, Math.max(1, parseInt(limitQuery, 10) || 50))
      : 200;
    const offset = (page - 1) * limit;

    const conditions = [];
    const params = [];
    let idx = 1;

    if (status && status !== 'all') {
      conditions.push(`o.status = $${idx++}`);
      params.push(status);
    } else {
      // Drafts only appear under the dedicated Drafts tab (status=draft), never in
      // the All view or any other tab.
      conditions.push(`o.status <> 'draft'`);
    }
    if (customer_id) {
      conditions.push(`o.customer_id = $${idx++}`);
      params.push(customer_id);
    }
    if (from_date) {
      conditions.push(`o.created_at >= $${idx++}`);
      params.push(from_date);
    }
    if (to_date) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(String(to_date).trim())) {
        conditions.push(`o.created_at < ($${idx++}::date + INTERVAL '1 day')`);
        params.push(String(to_date).trim());
      } else {
        conditions.push(`o.created_at < $${idx++}`);
        params.push(to_date);
      }
    }

    const searchTerm = String(search || q || '').trim();
    if (searchTerm) {
      // ADR 0017 #11 — BARE DIGITS ARE A SEQUENCE, not a substring.
      //
      // Customers read the digits off faded thermal paper and skip the prefix, so `42`
      // must return every order whose sequence is 42 across all prefixes — `1A-00042`,
      // `2B-00042`, the pre-letter `3-00042` — as a short disambiguation list. A
      // substring match cannot express that: `%42%` also drags in `3-00420` and
      // `1-00142`, and the number of parallel series only grows, so the noise grows
      // with it. Equality on receipt_sequence says exactly what is meant.
      //
      // The row id stays in the OR because for the ~1,300 legacy orders the digits ARE
      // the id — they have no sequence at all and are never backfilled (ADR 0017 #12).
      // Exact there too, for the same reason: `42` means order 42, not 420 and 142.
      const bareSequence = parseBareSequence(searchTerm);
      if (bareSequence !== null) {
        const seqIdx = idx++;
        params.push(bareSequence);
        conditions.push(`(o.receipt_sequence = $${seqIdx} OR o.id = $${seqIdx})`);
      } else {
        const cleanTerm = searchTerm.replace(/^#/, '');
        const p1 = `%${searchTerm}%`;
        const p2 = `%${cleanTerm}%`;
        if (p1 === p2) {
          const pIdx = idx++;
          params.push(p1);
          conditions.push(`(c.name ILIKE $${pIdx} OR o.id::text ILIKE $${pIdx} OR (o.receipt_number IS NOT NULL AND o.receipt_number ILIKE $${pIdx}))`);
        } else {
          const p1Idx = idx++;
          params.push(p1);
          const p2Idx = idx++;
          params.push(p2);
          conditions.push(`(c.name ILIKE $${p1Idx} OR o.id::text ILIKE $${p2Idx} OR (o.receipt_number IS NOT NULL AND (o.receipt_number ILIKE $${p1Idx} OR o.receipt_number ILIKE $${p2Idx})))`);
        }
      }
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const limitParamIdx = idx++;
    params.push(limit);
    const offsetParamIdx = idx++;
    params.push(offset);

    const { rows } = await db.query(
      `SELECT o.*,
              c.name AS customer_name,
              uc.full_name AS sold_by_name,
              (SELECT STRING_AGG(per.full_name || ' (' || op.role || ')', ', ' ORDER BY op.id)
               FROM order_personnel op
               JOIN personnel per ON per.id = op.personnel_id
               WHERE op.order_id = o.id) AS personnel_summary,
              COUNT(*) OVER()::int AS total_count
       FROM orders o
       JOIN customers c ON c.id = o.customer_id
       LEFT JOIN users uc ON uc.id = o.created_by
       ${whereClause}
       -- ADR 0017 #12 — NEVER order by receipt number. '#1240', '3-00061' and
       -- '1A-00001' coexist permanently and do not sort as text; every list, export
       -- and report orders by time.
       ORDER BY o.created_at DESC
       LIMIT $${limitParamIdx} OFFSET $${offsetParamIdx}`,
      params
    );

    const totalCount = rows.length > 0 ? (parseInt(rows[0].total_count, 10) || 0) : 0;
    for (const row of rows) {
      delete row.total_count;
    }

    if (isPaginated) {
      return res.json({
        orders: rows,
        pagination: {
          page,
          limit,
          total: totalCount,
          totalPages: Math.ceil(totalCount / limit) || 1,
        },
      });
    }

    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/orders/sync — full order snapshots for a tablet's local history.
//
// ADR 0015 §4 / Slice 3.2. This is NOT the list endpoint above with extra fields: the
// list is what a screen paginates through, this is what a device mirrors. Two things
// make it its own route rather than a flag on `GET /`:
//
//   Complete snapshots. Every row carries its line items (with deposit fees and
//   returned-bottle counts) and its assigned personnel, because a summary row is
//   precisely what used to crash the offline order detail page. Three batched queries
//   per page, never one per order.
//
//   The SERVER mints the cursors. A client cannot build one from the `updated_at` it
//   receives: JSON timestamps are millisecond-precision, Postgres stores microseconds,
//   and a cursor rebuilt from the truncated value sits fractionally BEFORE the row it
//   was meant to mark — so that row comes back on every future delta forever, and a
//   page full of such rows never advances at all. `first_cursor`/`next_cursor` below
//   are rendered with full microsecond precision and are the only cursors anyone
//   should ever send back.
//
//   Keyset pagination on (updated_at, id), in both directions. `direction=back` walks
//   newest → oldest and is how a brand-new tablet backfills history it has never seen,
//   resumably: a stream cut off halfway resumes from its last cursor instead of
//   starting over. `direction=forward` walks oldest → newest from the newest row the
//   device already holds, and is the delta every later login and reconnect asks for —
//   including orders created on OTHER tablets, which is the whole reason a device
//   cannot just remember its own writes.
//
// Drafts ARE included, unlike the list endpoint's default. That default (drafts hidden
// unless `status=draft` is asked for explicitly) exists so a screen doesn't show
// in-progress paperwork next to real orders — a display concern. This route mirrors
// history for offline reading, and a draft is exactly as historical as any other order
// once it has synced: Captain decision 2026-09-02 (following the read-only lock added
// the same day) is that a historical draft the device has never individually opened
// must still open read-only offline, the same unconditional way a regular order
// already does — not only when this device happened to view that specific draft while
// online (client/src/pages/orders/OrdersPage.jsx's `openDraft`, kept as a belt-and-
// braces per-view fallback). Draft volume in practice is a small fraction of order
// history (dozens, not thousands) and drafts are covered by the same keyset delta as
// everything else, so an edited draft simply reappears in the next forward page like
// any other touched order — no special-casing needed here.
//
// MUST stay above `GET /:id`, or Express reads "sync" as an order id.
router.get('/sync', async (req, res, next) => {
  try {
    const { cursor, direction = 'back' } = req.query;
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 100));
    const forward = String(direction) === 'forward';

    const conditions = [];
    const params = [];
    let idx = 1;

    if (cursor) {
      const sep = String(cursor).lastIndexOf('|');
      const cursorAt = sep === -1 ? String(cursor) : String(cursor).slice(0, sep);
      const cursorId = sep === -1 ? null : Number(String(cursor).slice(sep + 1));
      if (!cursorAt || !Number.isFinite(cursorId)) {
        return res.status(400).json({ error: 'cursor must be "<updated_at>|<id>"' });
      }
      // Row-value comparison, so an id tie inside the same microsecond still advances
      // rather than looping on the same page forever.
      conditions.push(
        `(o.updated_at, o.id) ${forward ? '>' : '<'} ($${idx++}::timestamptz, $${idx++}::int)`
      );
      params.push(cursorAt, cursorId);
    }

    const limitIdx = idx++;
    params.push(limit + 1); // one extra row purely to answer has_more
    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const { rows } = await db.query(
      `SELECT o.*,
              to_char(o.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS sync_cursor_at,
              c.name    AS customer_name, c.customer_type,
              c.address AS customer_address, c.phone AS customer_phone,
              up.full_name AS pending_receipt_printed_by_name,
              ud.full_name AS delivered_receipt_printed_by_name,
              uc.full_name AS sold_by_name
       FROM orders o
       JOIN customers c ON c.id = o.customer_id
       LEFT JOIN users up ON up.id = o.pending_receipt_printed_by
       LEFT JOIN users ud ON ud.id = o.delivered_receipt_printed_by
       LEFT JOIN users uc ON uc.id = o.created_by
       ${whereClause}
       ORDER BY o.updated_at ${forward ? 'ASC' : 'DESC'}, o.id ${forward ? 'ASC' : 'DESC'}
       LIMIT $${limitIdx}`,
      params
    );

    const hasMore = rows.length > limit;
    const orders = hasMore ? rows.slice(0, limit) : rows;
    const ids = orders.map((o) => o.id);

    let items = [];
    let personnel = [];
    if (ids.length > 0) {
      ({ rows: items } = await db.query(
        `SELECT oi.*, p.name AS product_name, p.sku, p.unit, p.category, p.requires_bottle_return
         FROM order_items oi
         JOIN products p ON p.id = oi.product_id
         WHERE oi.order_id = ANY($1::int[])
         ORDER BY oi.order_id, oi.id`,
        [ids]
      ));
      ({ rows: personnel } = await db.query(
        `SELECT op.order_id, op.id, op.personnel_id, op.role, p.full_name, p.phone
         FROM order_personnel op
         JOIN personnel p ON p.id = op.personnel_id
         WHERE op.order_id = ANY($1::int[])
         ORDER BY op.order_id, op.id`,
        [ids]
      ));
    }

    const itemsByOrder = new Map(ids.map((id) => [id, []]));
    for (const item of items) itemsByOrder.get(item.order_id)?.push(item);
    const personnelByOrder = new Map(ids.map((id) => [id, []]));
    for (const p of personnel) {
      const { order_id, ...rest } = p;
      personnelByOrder.get(order_id)?.push(rest);
    }

    const cursorFor = (row) => (row ? `${row.sync_cursor_at}|${row.id}` : null);

    res.json({
      orders: orders.map(({ sync_cursor_at, ...o }) => ({
        ...o,
        items: itemsByOrder.get(o.id) || [],
        personnel: personnelByOrder.get(o.id) || [],
      })),
      has_more: hasMore,
      // Where this page starts and ends, in the direction it was walked. A backward
      // page's `first_cursor` is the newest row there is, which is exactly what seeds
      // a device's forward delta watermark on its first setup.
      first_cursor: cursorFor(orders[0]),
      next_cursor: cursorFor(orders[orders.length - 1]),
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/orders — creates a Pending order; no stock check
//
// Three optional fields carry the device's version of the truth when the order was
// created locally (V2.5, D1/D5/D13; ADR 0017 #9). All are absent for an order created
// straight from a connected client, which behaves exactly as before:
//   request_key     the retry key: generated on the device once per outbox record and
//                   resent unchanged on every retry OF THAT RECORD. It is the record's
//                   identity here, so a resend of a key already stored is answered with
//                   the stored order and a 200 rather than a second row.
//   receipt_number  '<person><device letter>-<sequence>' issued on the device at Save,
//                   or the pre-letter '<person>-<sequence>' from a tablet that has not
//                   been updated yet — both are accepted, permanently (ADR 0017 #12).
//                   It names the SALE, and stays unique and the route identifier
//                   (ADR 0010) — but it is no longer what a retry is recognised by.
//                   With no request_key it still is, as the fallback for a pre-039
//                   queued record.
//   created_at      the device's clock at Save — the sale time printed on the paper
//                   the customer is holding, not the moment the outbox drained. Same
//                   pattern as supplier_deliveries.received_at. No clock policing.
router.post('/', async (req, res, next) => {
  const {
    customer_id, notes, items = [], personnel = [], order_type = 'delivery', status,
    receipt_number, request_key, created_at, adjustment = 0, adjustment_reason,
    delivery_fee_charged,
  } = req.body;
  const isDraft = status === 'draft';

  // Validate input before opening a connection/transaction — an early return after
  // BEGIN would release the client mid-transaction (pg won't auto-rollback).
  if (!customer_id) return res.status(400).json({ error: 'customer_id is required' });
  // A finalized order needs at least one item; a draft may be parked while still empty.
  if (!isDraft && !items?.length) return res.status(400).json({ error: 'At least one item is required' });

  // Persistent delivery fee (proposal decision 14: charge-only). `undefined` means the
  // client sent no override, so the snapshot below falls back to the customer's
  // current standing fee (decision 6); explicit null/'' waives it for this order alone
  // (decision 8) without touching that standing fee.
  let deliveryFeeOverride;
  if (delivery_fee_charged !== undefined) {
    if (delivery_fee_charged === null || delivery_fee_charged === '') {
      deliveryFeeOverride = null;
    } else {
      const n = Number(delivery_fee_charged);
      if (!Number.isFinite(n) || n < 0) {
        return res.status(400).json({ error: 'delivery_fee_charged must be a non-negative number' });
      }
      deliveryFeeOverride = n;
    }
  }

  let requestKey = null;
  try {
    requestKey = normalizeRequestKey(request_key);
  } catch (err) {
    return next(err);
  }

  let receipt = null;
  if (receipt_number !== undefined && receipt_number !== null && receipt_number !== '') {
    try {
      // Accepts both shapes: '3-00061' from a tablet that has not been updated yet and
      // '3A-00001' from one that has (ADR 0017 #12, ADR 0014's switchover ordering).
      receipt = parseReceiptNumber(receipt_number);
      // The leading component is a person (ADR 0017 #1). This is the backstop against
      // a garbled or impossible one; it no longer caps at ADR 0016's three slots,
      // because a fourth person's first sale would otherwise be rejected here.
      assertIssuableStation(receipt.station);
    } catch (err) {
      return next(err);
    }
  }

  // The ordinary resend: the first attempt committed and only the response was lost.
  //
  // ADR 0017 #9 — keyed on the retry key when the device sent one, and ONLY on it. The
  // receipt number is deliberately not consulted in that case: two sales that collide
  // on a receipt number are two sales, and answering the second with the first one's
  // stored order is the silent data loss this decision exists to end. Such a collision
  // now hits the receipt-number unique index below and is refused, loudly.
  //
  // With no retry key, the receipt number is still the identity — the fallback for an
  // outbox record queued by a pre-039 build and still waiting to drain (ADR 0014's
  // mixed-fleet window). Never removed.
  const dedupeBy = requestKey
    ? () => findByRequestKey(db, 'orders', requestKey)
    : (receipt ? () => findByReceiptNumber(db, 'orders', receipt) : null);

  if (dedupeBy) {
    try {
      const existingId = await dedupeBy();
      if (existingId) return res.json(await getFullOrder(existingId));
    } catch (err) {
      return next(err);
    }
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { rows: [customer] } = await client.query(
      'SELECT id, name, delivery_fee FROM customers WHERE id = $1 AND is_active = TRUE',
      [customer_id]
    );
    if (!customer) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Customer not found' });
    }

    const adjNum = Number(adjustment) || 0;
    const adjReason = adjNum !== 0 && adjustment_reason ? adjustment_reason.trim() : null;

    // Decisions 6/7: snapshotted from the customer's current standing fee at creation,
    // delivery orders only — never looked up live again after this. An explicit
    // override (deliveryFeeOverride !== undefined) wins over the customer's fee, and a
    // non-delivery order never carries one regardless of what was sent.
    const deliveryFeeCharged = order_type === 'delivery'
      ? (deliveryFeeOverride !== undefined
          ? deliveryFeeOverride
          : (customer.delivery_fee !== null && customer.delivery_fee !== undefined
              ? Number(customer.delivery_fee) : null))
      : null;

    const { rows: [order] } = await client.query(
      `INSERT INTO orders (customer_id, notes, total_amount, order_type, status,
                           receipt_station, receipt_device, receipt_sequence, request_key,
                           created_at, adjustment, adjustment_reason, delivery_fee_charged,
                           created_by)
       VALUES ($1, $2, 0, $3, $4, $5, $6, $7, $8, COALESCE($9::timestamptz, NOW()), $10, $11, $12, $13)
       RETURNING *`,
      [customer_id, notes || null, order_type, isDraft ? 'draft' : 'pending',
       receipt?.station ?? null, receipt?.device ?? null, receipt?.sequence ?? null,
       requestKey, created_at || null, adjNum, adjReason, deliveryFeeCharged,
       // ADR 0017 #10 — who sold it, for the receipt's `Sold by:` line. The JWT is the
       // whole identity since ADR 0017 §5, so this is whoever is signed in on the
       // device that sent it — including a drain hours later, which replays under the
       // same account that made the sale. Slice 5's remembered accounts is what will
       // let one device drain records made by two different people.
       req.user.id]
    );

    await insertItems(client, order.id, items, isDraft);
    await recomputeTotal(client, order.id);
    await syncPersonnel(client, order.id, personnel);

    // Drafts are ephemeral — the activity log entry is written when the draft is finalized.
    //
    // No stock moves here. ADR 0012 puts deduction back on the dispatch transition
    // (in_transit for deliveries, completed for pickups), so an order that was saved on a
    // blind tablet at 2pm and drained at 5pm does not silently move inventory at 5pm.
    if (!isDraft) {
      await logActivity(client, {
        entityType: 'order',
        entityId:   order.id,
        action:     'created',
        summary:    `Order ${orderLabel(order)} created for ${customer.name} (${order_type})`,
        performedBy: req.user.id,
      });
    }

    await client.query('COMMIT');
    res.status(201).json(await getFullOrder(order.id));
  } catch (err) {
    await client.query('ROLLBACK');
    // Two drain attempts of the SAME record overlapping: both looked, neither found,
    // both inserted. A partial unique index caught this one, so answer it with the row
    // the winner wrote — a success, so the device clears it from the outbox and stops
    // retrying.
    //
    // Either index can be the one that fires, and which one Postgres reports first is
    // not ours to predict: an identical resend collides on the retry key AND on the
    // receipt number. So the constraint name only decides whether to look; `dedupeBy`
    // (keyed on the retry key whenever the device sent one) decides what it was. A row
    // carrying this request's own key means the winner was this same record.
    if (dedupeBy && (isDuplicateRequestKey(err, REQUEST_KEY_INDEX)
                  || isDuplicateReceiptNumber(err, RECEIPT_NUMBER_INDEX))) {
      try {
        const existingId = await dedupeBy();
        if (existingId) return res.json(await getFullOrder(existingId));
      } catch (lookupErr) {
        return next(lookupErr);
      }
    }
    // ADR 0017 #9 — the lookup above found nothing under this request's own retry key,
    // so the row that won the index is a DIFFERENT record arriving on a receipt number
    // that is already stored. Two separate sales wearing one label: not a retry, so it
    // must not be answered with the stored order, and not a 500 either, which would
    // stall the whole outbox behind it. A 409 lands the record in the device's needs-attention list
    // carrying this reason, where a human decides — ambiguous and recoverable, which is
    // the whole point of splitting the retry key off the receipt number.
    if (requestKey && receipt && isDuplicateReceiptNumber(err, RECEIPT_NUMBER_INDEX)) {
      return res.status(409).json({
        error: `Receipt number ${receipt_number} is already used by a different order. `
             + 'Two orders cannot share a receipt number — re-issue this one.',
      });
    }
    next(err);
  } finally {
    client.release();
  }
});

// GET /api/v1/orders/:id
router.get('/:id', async (req, res, next) => {
  try {
    const order = await getFullOrder(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    res.json(order);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/v1/orders/:id — edit metadata and/or line items (all statuses)
router.patch('/:id', async (req, res, next) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const orderId = await resolveOrderId(client, req.params.id);
    if (!orderId) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Order not found' });
    }

    const { rows: [order] } = await client.query(
      'SELECT * FROM orders WHERE id = $1 FOR UPDATE',
      [orderId]
    );
    if (!order) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Order not found' });
    }

    const { notes, items, personnel, customer_id, order_type, delivery_fee_charged } = req.body;
    const isDraft = order.status === 'draft';
    let revision = null;
    try {
      // Draft autosaves are the deliberate exclusion. A finalized order always uses
      // the revision the operator last saw; an absent token remains accepted only for
      // mixed-fleet compatibility with older APKs.
      revision = isDraft ? null : expectedRevision(req.body.revision);
    } catch (err) {
      await client.query('ROLLBACK');
      return res.status(err.status).json({ error: err.message });
    }
    if (!revisionMatches(order, revision)) {
      return sendStaleWrite(client, res, order.id, revision);
    }

    const changeNotes = [];

    if (notes !== undefined && notes !== order.notes) changeNotes.push('Notes updated');

    const nextNotes = notes !== undefined ? notes : order.notes;
    // A parked draft may still change its customer / order type (COALESCE keeps the
    // current value when a field is omitted). Live orders never change these here.
    const nextCustomerId = isDraft ? (customer_id ?? null) : null;
    const nextOrderType  = isDraft ? (order_type ?? null) : null;

    // Decision 8: overridable per order, same spirit as `adjustment` — `undefined`
    // means this edit didn't touch it, so the stored value is left alone; explicit
    // null/'' waives it. `deliveryFeeTouched` is what distinguishes "leave unchanged"
    // from "set to NULL" once this reaches the CASE expression below (COALESCE alone
    // cannot express an explicit clear). Decision 7 wins regardless of what was sent:
    // an order that is not `delivery` after this edit never carries a charged fee.
    let deliveryFeeTouched = delivery_fee_charged !== undefined;
    let deliveryFeeValue = null;
    if (deliveryFeeTouched) {
      if (delivery_fee_charged === null || delivery_fee_charged === '') {
        deliveryFeeValue = null;
      } else {
        const n = Number(delivery_fee_charged);
        if (!Number.isFinite(n) || n < 0) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'delivery_fee_charged must be a non-negative number' });
        }
        deliveryFeeValue = n;
      }
    }
    const effectiveOrderType = nextOrderType || order.order_type;
    if (effectiveOrderType !== 'delivery') {
      deliveryFeeTouched = true;
      deliveryFeeValue = null;
    }

    let orderUpdate;
    if (items === undefined) {
      orderUpdate = await client.query(
        `UPDATE orders
            SET notes       = $1,
                customer_id = COALESCE($2::int, customer_id),
                order_type  = COALESCE($3::text, order_type),
                delivery_fee_charged = CASE WHEN $6::boolean
                                            THEN $7::numeric
                                            ELSE delivery_fee_charged END,
                updated_at  = NOW()
          WHERE id = $4
            AND ($5::bigint IS NULL OR revision = $5::bigint)`,
        [nextNotes, nextCustomerId, nextOrderType, order.id, revision,
         deliveryFeeTouched, deliveryFeeValue]
      );
    } else {
      // ONE read for the three things replacing the lines needs: the items being
      // replaced (quantity for stock reconciliation, bottles_returned to preserve
      // returns recorded at close), whether this order's stock is currently out, and
      // the category/name the packer-order sort runs on. They are all reads of state
      // that nothing between here and the write touches, so batching them is the same
      // answer in a third of the round trips.
      const productIds = [...new Set(items.map((i) => i.product_id).filter(Boolean))];
      const { rows: [snapshot] } = await client.query(
        `SELECT
           (SELECT COALESCE(json_agg(json_build_object(
                     'product_id',       oi.product_id,
                     'quantity',         oi.quantity,
                     'bottles_returned', oi.bottles_returned)), '[]'::json)
              FROM order_items oi WHERE oi.order_id = $1)              AS old_items,
           (SELECT COALESCE(SUM(ial.delta), 0)
              FROM inventory_audit_logs ial WHERE ial.related_order_id = $1) AS stock_net,
           (SELECT COALESCE(json_agg(json_build_object(
                     'id', p.id, 'category', p.category, 'name', p.name)), '[]'::json)
              FROM products p WHERE p.id = ANY($2::int[]))            AS products`,
        [order.id, productIds]
      );
      const oldItems = snapshot.old_items;
      const infoById = new Map(snapshot.products.map((p) => [p.id, p]));

      // For a closed (done) order, carry the previously recorded returns back per
      // product so editing a line (e.g. fixing a price) doesn't wipe returns and
      // re-inflate the closed total. The rows are written with the carried value
      // already on them, which also puts it in place before line_total — a GENERATED
      // column over bottles_returned — is computed for the total below.
      let returnsByProduct = null;
      if (order.status === 'done') {
        returnsByProduct = {};
        for (const it of oldItems) {
          returnsByProduct[it.product_id] =
            (returnsByProduct[it.product_id] || 0) + Number(it.bottles_returned);
        }
      }

      const rows = buildItemRows(
        sortItemsByCategory(items, infoById), isDraft, returnsByProduct
      );
      orderUpdate = await replaceItemsAndSettleOrder(client, order.id, rows, {
        notes:      nextNotes,
        customerId: nextCustomerId,
        orderType:  nextOrderType,
        revision,
        deliveryFeeTouched,
        deliveryFeeValue,
      });

      changeNotes.push(`Items replaced (${items.length} item${items.length === 1 ? '' : 's'})`);

      // Same isStockOut question (net of this order's own append-only audit deltas is
      // negative ⇒ the goods are out), answered off the batched read above. Nothing
      // between that read and here writes inventory_audit_logs.
      if (!isDraft && order.status !== 'cancelled' && Number(snapshot.stock_net) < 0) {
        await reconcileStock(client, oldItems, items, order, req.user.id);
      }
    }

    // The condition is part of the UPDATE itself, so authority remains in Postgres
    // even if this route is later refactored and the lock above moves. Every earlier
    // item/stock write is in this same transaction and is rolled back with a loser.
    if (orderUpdate.rowCount === 0) {
      return sendStaleWrite(client, res, order.id, revision);
    }

    if (personnel !== undefined) {
      await syncPersonnel(client, order.id, personnel);
      changeNotes.push('Personnel updated');
    }

    // Draft auto-saves are silent; the activity log records the order at finalize time.
    if (changeNotes.length && !isDraft) {
      await logActivity(client, {
        entityType: 'order',
        entityId:   order.id,
        action:     'edited',
        summary:    `Order ${orderLabel(order)}: ${changeNotes.join('; ')}`,
        performedBy: req.user.id,
      });
    }

    await client.query('COMMIT');
    res.json(await getFullOrder(order.id));
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// POST /api/v1/orders/:id/finalize — turn a draft into a real Pending order
router.post('/:id/finalize', async (req, res, next) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const orderId = await resolveOrderId(client, req.params.id);
    if (!orderId) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Order not found' });
    }

    const { rows: [order] } = await client.query(
      'SELECT * FROM orders WHERE id = $1 FOR UPDATE',
      [orderId]
    );
    if (!order) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Order not found' });
    }
    if (order.status !== 'draft') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Only draft orders can be finalized' });
    }

    const { rows: [{ count }] } = await client.query(
      'SELECT COUNT(*)::INT AS count FROM order_items WHERE order_id = $1',
      [order.id]
    );
    if (count === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Add at least one product before creating the order' });
    }

    const { rows: [customer] } = await client.query(
      'SELECT name FROM customers WHERE id = $1',
      [order.customer_id]
    );

    await client.query(
      `UPDATE orders SET status = 'pending', updated_at = NOW() WHERE id = $1`,
      [order.id]
    );
    await recomputeTotal(client, order.id);

    // No stock moves here either — see the note on POST / above (ADR 0012).
    await logActivity(client, {
      entityType: 'order',
      entityId:   order.id,
      action:     'created',
      summary:    `Order ${orderLabel(order)} created for ${customer?.name || 'customer'} (${order.order_type})`,
      performedBy: req.user.id,
    });

    await client.query('COMMIT');
    res.json(await getFullOrder(order.id));
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// DELETE /api/v1/orders/:id — only drafts may be deleted (real orders are cancelled, not removed)
router.delete('/:id', async (req, res, next) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const orderId = await resolveOrderId(client, req.params.id);
    if (!orderId) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Order not found' });
    }

    const { rows: [order] } = await client.query(
      'SELECT id, status FROM orders WHERE id = $1 FOR UPDATE',
      [orderId]
    );
    if (!order) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Order not found' });
    }
    if (order.status !== 'draft') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Only draft orders can be deleted' });
    }

    await client.query('DELETE FROM order_items WHERE order_id = $1', [order.id]);
    await client.query('DELETE FROM order_personnel WHERE order_id = $1', [order.id]);
    await client.query('DELETE FROM orders WHERE id = $1', [order.id]);

    await client.query('COMMIT');
    res.status(204).end();
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// PATCH /api/v1/orders/:id/adjustment — set billing adjustment and reason
router.patch('/:id/adjustment', async (req, res, next) => {
  const { adjustment, adjustment_reason } = req.body;
  const adjNum = Number(adjustment);

  if (isNaN(adjNum)) {
    return res.status(400).json({ error: 'adjustment must be a number' });
  }
  if (adjNum !== 0 && !adjustment_reason?.trim()) {
    return res.status(400).json({ error: 'adjustment_reason is required when adjustment is non-zero' });
  }

  let revision;
  try {
    revision = expectedRevision(req.body.revision);
  } catch (err) {
    return res.status(err.status).json({ error: err.message });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const orderId = await resolveOrderId(client, req.params.id);
    if (!orderId) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Order not found' });
    }

    const { rows: [order] } = await client.query(
      'SELECT id, receipt_number, revision FROM orders WHERE id = $1 FOR UPDATE', [orderId]
    );
    if (!order) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Order not found' });
    }
    if (!revisionMatches(order, revision)) {
      return sendStaleWrite(client, res, order.id, revision);
    }

    const updated = await client.query(
      `UPDATE orders
          SET adjustment = $1, adjustment_reason = $2, updated_at = NOW()
        WHERE id = $3
          AND ($4::bigint IS NULL OR revision = $4::bigint)`,
      [adjNum, adjNum !== 0 ? adjustment_reason.trim() : null, orderId, revision]
    );
    if (updated.rowCount === 0) {
      return sendStaleWrite(client, res, order.id, revision);
    }

    await logActivity(client, {
      entityType: 'order',
      entityId:   order.id,
      action:     'adjusted',
      summary:    adjNum !== 0
        ? `Order ${orderLabel(order)} adjustment set to ₱${adjNum.toFixed(2)} (reason: ${adjustment_reason.trim()})`
        : `Order ${orderLabel(order)} adjustment cleared`,
      performedBy: req.user.id,
    });

    await client.query('COMMIT');
    res.json(await getFullOrder(order.id));
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// POST /api/v1/orders/:id/receipt-printed — tag that a receipt was printed and
// confirmed by the user, for either the 'pending' or 'delivered' phase
router.post('/:id/receipt-printed', async (req, res, next) => {
  try {
    const { phase } = req.body;
    if (!['pending', 'delivered'].includes(phase)) {
      return res.status(400).json({ error: "phase must be 'pending' or 'delivered'" });
    }

    const orderId = await resolveOrderId(db, req.params.id);
    if (!orderId) return res.status(404).json({ error: 'Order not found' });

    const { rows: [order] } = await db.query(
      'SELECT id, receipt_number FROM orders WHERE id = $1', [orderId]
    );
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const column = phase === 'pending' ? 'pending_receipt_printed' : 'delivered_receipt_printed';
    await db.query(
      `UPDATE orders SET ${column}_at = NOW(), ${column}_by = $1, updated_at = NOW() WHERE id = $2`,
      [req.user.id, order.id]
    );

    await logActivity(db, {
      entityType: 'order',
      entityId:   order.id,
      action:     'receipt_printed',
      summary:    `Order ${orderLabel(order)} receipt printed (${phase} phase)`,
      performedBy: req.user.id,
    });

    res.json(await getFullOrder(order.id));
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/orders/:id/status — state machine transition
router.post('/:id/status', async (req, res, next) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const orderId = await resolveOrderId(client, req.params.id);
    if (!orderId) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Order not found' });
    }

    const { rows: [order] } = await client.query(
      'SELECT * FROM orders WHERE id = $1 FOR UPDATE',
      [orderId]
    );
    if (!order) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Order not found' });
    }

    const { status: newStatus, expected_status: expectedStatus } = req.body;
    let revision;
    try {
      revision = expectedRevision(req.body.revision);
    } catch (err) {
      await client.query('ROLLBACK');
      return res.status(err.status).json({ error: err.message });
    }
    if (!revisionMatches(order, revision)
        || (expectedStatus !== undefined && expectedStatus !== order.status)) {
      return sendStaleWrite(client, res, order.id, revision);
    }

    const allowed = getAllowedTransitions(order.status, order.order_type);

    if (!allowed.includes(newStatus)) {
      await client.query('ROLLBACK');
      return res.status(422).json({
        error:               `Cannot transition from '${order.status}' to '${newStatus}'`,
        allowed_transitions: allowed,
      });
    }

    const { rows: items } = await client.query(
      'SELECT * FROM order_items WHERE order_id = $1',
      [order.id]
    );

    // ADR 0012 — stock moves with the goods, not with the paperwork. A delivery deducts
    // when it is dispatched (in_transit); a pickup when the customer takes it (completed).
    //
    // Both directions are guarded by isStockOut rather than by the transition alone,
    // because the two are not equivalent for every row in the table. Orders created during
    // the V2 window were deducted at save, so dispatching one now must not deduct it a
    // second time; orders created before that window were never deducted at all, so
    // cancelling one must not hand back stock that never left.
    const stockDeducted = await isStockOut(client, order.id);

    const isDeductTransition =
      (order.order_type === 'delivery' && newStatus === 'in_transit') ||
      (order.order_type === 'pickup'   && newStatus === 'completed' && order.status === 'pending');

    if (isDeductTransition && !stockDeducted) {
      await deductStock(client, items, order.id, req.user.id,
        `Order ${orderLabel(order)} ${order.order_type === 'pickup' ? 'picked up' : 'dispatched'}`);
    }

    // Restore on cancellation, and on stepping back behind the deduction boundary.
    const isRestoreTransition =
      newStatus === 'cancelled' ||
      (newStatus === 'pending' && ['in_transit', 'completed'].includes(order.status));

    if (isRestoreTransition && stockDeducted) {
      await restoreStock(client, items, order.id, req.user.id,
        newStatus === 'cancelled'
          ? `Order ${orderLabel(order)} cancelled`
          : `Order ${orderLabel(order)} status reverted to pending`);
    }

    const STEP_BACK = new Set([
      'in_transit→pending',
      'completed→in_transit',
      'completed→pending',
      'done→completed',
    ]);
    const isStepBack = STEP_BACK.has(`${order.status}→${newStatus}`);

    const setClauses = ['status = $1', 'updated_at = NOW()'];
    if (newStatus === 'in_transit') setClauses.push('dispatched_at = NOW()');
    if (newStatus === 'completed')  setClauses.push('delivered_at = NOW()');
    if (['done', 'cancelled'].includes(newStatus)) setClauses.push('closed_at = NOW()');
    if (isStepBack) {
      if (order.status === 'in_transit') setClauses.push('dispatched_at = NULL');
      if (order.status === 'completed') {
        setClauses.push('delivered_at = NULL', 'delivered_receipt_printed_at = NULL', 'delivered_receipt_printed_by = NULL');
      }
      if (order.status === 'done')       setClauses.push('closed_at = NULL');
    }

    const updated = await client.query(
      `UPDATE orders SET ${setClauses.join(', ')}
        WHERE id = $2
          AND ($3::bigint IS NULL OR revision = $3::bigint)`,
      [newStatus, order.id, revision]
    );
    if (updated.rowCount === 0) {
      return sendStaleWrite(client, res, order.id, revision);
    }

    await logActivity(client, {
      entityType: 'order',
      entityId:   order.id,
      action:     'status_changed',
      summary:    `Order ${orderLabel(order)} status changed from '${order.status}' to '${newStatus}'`,
      performedBy: req.user.id,
    });

    await client.query('COMMIT');
    res.json(await getFullOrder(order.id));
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// POST /api/v1/orders/:id/close — record bottle returns then transition completed → done
router.post('/:id/close', async (req, res, next) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const orderId = await resolveOrderId(client, req.params.id);
    if (!orderId) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Order not found' });
    }

    const { rows: [order] } = await client.query(
      'SELECT * FROM orders WHERE id = $1 FOR UPDATE',
      [orderId]
    );
    if (!order) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Order not found' });
    }
    let revision;
    try {
      revision = expectedRevision(req.body.revision);
    } catch (err) {
      await client.query('ROLLBACK');
      return res.status(err.status).json({ error: err.message });
    }
    if (!revisionMatches(order, revision)) {
      return sendStaleWrite(client, res, order.id, revision);
    }
    if (order.status !== 'completed') {
      await client.query('ROLLBACK');
      return res.status(422).json({ error: 'Only completed orders can be closed' });
    }

    // Claim this exact revision before touching the return rows. The trigger bumps the
    // token here; recomputeTotal may bump it again later, which is harmless because
    // revisions are opaque and the response always carries the final value.
    const updated = await client.query(
      `UPDATE orders
          SET status = 'done', closed_at = NOW(), updated_at = NOW()
        WHERE id = $1
          AND ($2::bigint IS NULL OR revision = $2::bigint)`,
      [order.id, revision]
    );
    if (updated.rowCount === 0) {
      return sendStaleWrite(client, res, order.id, revision);
    }

    const { items = [] } = req.body;
    for (const { id, bottles_returned } of items) {
      await client.query(
        `UPDATE order_items
            SET bottles_returned = $1, updated_at = NOW()
          WHERE id = $2 AND order_id = $3`,
        [Number(bottles_returned) || 0, id, order.id]
      );
    }

    await recomputeTotal(client, order.id);

    await logActivity(client, {
      entityType: 'order',
      entityId:   order.id,
      action:     'closed',
      summary:    `Order ${orderLabel(order)} closed; bottle returns recorded for ${items.length} item${items.length === 1 ? '' : 's'}`,
      performedBy: req.user.id,
    });

    await client.query('COMMIT');
    res.json(await getFullOrder(order.id));
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
