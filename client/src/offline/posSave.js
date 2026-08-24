import { issueReceiptNumber } from './station.js';
import { putReceipt, getReceipt, removeReceipt } from './receiptHistory.js';
import { enqueue, drainOutbox, listRecords, ref } from './outbox.js';
import { outboxKey } from './keys.js';
import { nativeStore } from './nativeStore.js';
import { api } from '../api/client.js';
import { orderTotals } from '../components/pos/posMath.js';
import { V25_OFFLINE_CORE } from '../config/features.js';
import { checkIsOnline } from './status.js';
import { triggerOfflineAdvisory, triggerOfflineAdvisoryWith } from './advisory.js';

// D2 — The POS is local-first, always.
// Every save goes to the device first, online or offline, every day. Save writes the
// order locally, issues its receipt number via issueReceiptNumber(), puts it in local
// 30-day receipt history (D9), and enqueues the record for the outbox to drain (D13/D14).
// It does NOT wait for the server.

/**
 * Saves an order locally on the device (D2).
 *
 * @param {object} params
 * @param {object} params.customer
 * @param {string} params.orderType
 * @param {string} params.notes
 * @param {object} params.adjustment { value, reason }
 * @param {Array}  params.items
 * @param {string} [params.profileKey]
 * @param {string} [params.createdAt]
 * @param {Function} [params.addToast]
 * @returns {Promise<object>} The local order object
 */
export async function saveOrderLocalFirst({
  customer,
  orderType = 'delivery',
  notes = '',
  adjustment = { value: 0, reason: '' },
  items = [],
  profileKey = null,
  createdAt = null,
  addToast = null,
  offlineCoreEnabled = V25_OFFLINE_CORE,
}) {
  const activeProfileKey = profileKey || (await api.getActiveProfile());
  if (!activeProfileKey) {
    throw new Error('saveOrderLocalFirst: profileKey is required — capture the profile at Save (D14)');
  }

  const { receipt_number, station, sequence } = await issueReceiptNumber();
  const saleTime = createdAt || new Date().toISOString();
  const adjVal = Number(adjustment?.value) || 0;
  const adjReason = adjVal !== 0 && adjustment?.reason ? String(adjustment.reason).trim() : null;

  const totals = orderTotals(items, adjVal);

  const customerId = customer?._outboxId
    ? ref(customer._outboxId, 'id')
    : (customer?.id && !String(customer.id).startsWith('local-') ? Number(customer.id) : null);

  const localOrder = {
    receipt_number,
    receipt_station: station,
    receipt_sequence: sequence,
    created_at: saleTime,
    status: 'pending',
    customer_id: typeof customerId === 'number' ? customerId : null,
    customer_name: customer?.name || 'Customer',
    customer_address: customer?.address || null,
    customer_phone: customer?.phone || null,
    customer_type: customer?.customer_type || 'regular',
    order_type: orderType,
    notes: notes ? notes.trim() : null,
    adjustment: adjVal,
    adjustment_reason: adjReason,
    items: items.map((i, idx) => ({
      id: i.id || idx + 1,
      product_id: Number(i.product_id),
      product_name: i.product_name,
      sku: i.sku || '',
      unit: i.unit || 'cs',
      quantity: Number(i.quantity),
      unit_price: Number(i.unit_price),
      unit_deposit_fee: Number(i.unit_deposit_fee) || 0,
      units_per_case: Number(i.units_per_case) || 1,
      requires_bottle_return: Boolean(i.unit_deposit_fee > 0),
      bottles_returned: 0,
      is_price_overridden: Boolean(i.is_price_overridden || i._priceEdited),
    })),
    total_amount: totals.goods,
    pending_receipt_printed_at: null,
    pending_receipt_printed_by: null,
  };

  // 1. Persist in local 30-day receipt history (D9)
  await putReceipt(localOrder);

  // 2. Queue in outbox for server drain (D5/D13/D14)
  const dependsOn = customer?._outboxId ? [customer._outboxId] : [];
  const outboxRecord = await enqueue({
    entityType: 'order',
    endpoint: '/orders',
    method: 'POST',
    payload: {
      customer_id: customerId,
      order_type: orderType,
      notes: notes ? notes.trim() : null,
      adjustment: adjVal,
      adjustment_reason: adjReason,
      items: items.map((i) => ({
        product_id: Number(i.product_id),
        quantity: Number(i.quantity),
        unit_price: Number(i.unit_price),
        unit_deposit_fee: Number(i.unit_deposit_fee) || 0,
        units_per_case: Number(i.units_per_case) || 1,
        is_price_overridden: false,
      })),
      receipt_number,
      created_at: saleTime,
    },
    profileKey: activeProfileKey,
    receiptNumber: receipt_number,
    dependsOn,
    createdAt: saleTime,
  });

  localOrder._outboxId = outboxRecord.id;

  // 3. Attempt drain in background and trigger advisory toast if saving while offline (D11)
  if (!checkIsOnline()) {
    await triggerOfflineAdvisoryWith({ addToast }, offlineCoreEnabled).catch(() => {});
  } else {
    drainOutbox()
      .then((res) => {
        if (res && res.failed > 0 && !checkIsOnline()) {
          triggerOfflineAdvisoryWith({ addToast }, offlineCoreEnabled).catch(() => {});
        }
      })
      .catch(() => {
        triggerOfflineAdvisoryWith({ addToast }, offlineCoreEnabled).catch(() => {});
      });
  }

  return localOrder;
}

/**
 * Records that a receipt was printed (D14).
 * Updates the local receipt in history (D9) and enqueues a `receipt_printed` event.
 */
export async function queueReceiptPrinted({ order, phase = 'pending', profileKey = null }) {
  if (!order) return;
  const activeProfileKey = profileKey || (await api.getActiveProfile());
  if (!activeProfileKey) {
    throw new Error('queueReceiptPrinted: profileKey is required — capture the profile at Save (D14)');
  }

  const printedAt = new Date().toISOString();
  if (order.receipt_number) {
    const local = (await getReceipt(order.receipt_number)) || order;
    if (phase === 'pending') {
      local.pending_receipt_printed_at = printedAt;
    } else {
      local.delivered_receipt_printed_at = printedAt;
    }
    await putReceipt(local);
  }

  const targetId = order.receipt_number || order.id;
  await enqueue({
    entityType: 'receipt_printed',
    endpoint: `/orders/${targetId}/receipt-printed`,
    method: 'POST',
    payload: { phase },
    profileKey: activeProfileKey,
    dependsOn: order._outboxId ? [order._outboxId] : [],
  });

  drainOutbox().catch(() => {});
}

/**
 * Checks whether an order is still waiting in the outbox (unsynced).
 */
export async function isOrderUnsynced(receiptNumber) {
  if (!receiptNumber) return false;
  const records = await listRecords();
  return records.some(
    (r) => r.entity_type === 'order' && r.receipt_number === receiptNumber && r.status === 'queued'
  );
}

/**
 * Updates an unsynced order on the device (D3):
 * Updates its outbox record payload and its receipt in local history.
 */
export async function updateLocalOrder({ order, items, notes, adjustment, profileKey = null }) {
  if (!order?.receipt_number) throw new Error('updateLocalOrder requires receipt_number');
  const records = await listRecords();
  const record = records.find(
    (r) => r.entity_type === 'order' && r.receipt_number === order.receipt_number && r.status === 'queued'
  );
  if (!record) {
    throw new Error('Order is not queued in the outbox');
  }

  const adjVal = Number(adjustment?.value) || 0;
  const adjReason = adjVal !== 0 && adjustment?.reason ? String(adjustment.reason).trim() : null;
  const totals = orderTotals(items, adjVal);

  const updatedOrder = {
    ...order,
    notes: notes ? notes.trim() : null,
    adjustment: adjVal,
    adjustment_reason: adjReason,
    items: items.map((i, idx) => ({
      id: i.id || idx + 1,
      product_id: Number(i.product_id),
      product_name: i.product_name,
      sku: i.sku || '',
      unit: i.unit || 'cs',
      quantity: Number(i.quantity),
      unit_price: Number(i.unit_price),
      unit_deposit_fee: Number(i.unit_deposit_fee) || 0,
      units_per_case: Number(i.units_per_case) || 1,
      requires_bottle_return: Boolean(i.unit_deposit_fee > 0),
      bottles_returned: 0,
      is_price_overridden: Boolean(i.is_price_overridden || i._priceEdited),
    })),
    total_amount: totals.goods,
  };

  await putReceipt(updatedOrder);

  // Update record payload in outbox
  record.payload = {
    ...record.payload,
    notes: notes ? notes.trim() : null,
    adjustment: adjVal,
    adjustment_reason: adjReason,
    items: items.map((i) => ({
      product_id: Number(i.product_id),
      quantity: Number(i.quantity),
      unit_price: Number(i.unit_price),
      unit_deposit_fee: Number(i.unit_deposit_fee) || 0,
      units_per_case: Number(i.units_per_case) || 1,
      is_price_overridden: false,
    })),
  };
  if (profileKey) {
    record.profile_key = profileKey;
  }
  await nativeStore.setJson(outboxKey(record.id), record);

  drainOutbox().catch(() => {});
  return updatedOrder;
}

/**
 * Discards an unsynced order from the device (D3):
 * Removes it from the outbox and from local receipt history.
 */
export async function discardLocalOrder(receiptNumber) {
  if (!receiptNumber) return;
  const records = await listRecords();
  const matching = records.filter(
    (r) => r.receipt_number === receiptNumber || (r.endpoint && r.endpoint.includes(receiptNumber))
  );
  for (const r of matching) {
    await nativeStore.remove(outboxKey(r.id));
  }
  await removeReceipt(receiptNumber);
}
