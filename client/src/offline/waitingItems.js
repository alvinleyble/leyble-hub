import { listRecords, NEEDS_ATTENTION } from './outbox.js';
import { getCachedEntity } from './catalogue.js';

// Settings' read-only "Waiting to send" list: every record still in the outbox, named
// the way the owners would name it — "Order 1A-00042 · Aling Nena", "Stock count ·
// Coke 1.5L" — rather than as an endpoint. Reads the outbox and the held catalogue and
// writes nothing; the drain is what empties it.

const STATUS_WORDS = {
  in_transit: 'In Transit',
  completed:  'Completed',
  done:       'Done',
  cancelled:  'Cancelled',
  pending:    'Pending',
};

// `/orders/1A-00042/status` -> '1A-00042'; `/orders/1240` -> '#1240' (a legacy row id).
function orderRefFromEndpoint(endpoint) {
  const match = /^\/orders\/([^/]+)/.exec(endpoint || '');
  if (!match) return null;
  const ref = decodeURIComponent(match[1]);
  return /^\d+$/.test(ref) ? `#${ref}` : ref;
}

// The numeric id in `/customers/12/prices` or `/products/7`, or null for a `:param`
// placeholder (a row this device created, still waiting itself).
function idFromEndpoint(endpoint, collection) {
  const match = new RegExp(`^/${collection}/(\\d+)`).exec(endpoint || '');
  return match ? Number(match[1]) : null;
}

function isRef(value) {
  return Boolean(value && typeof value === 'object' && '$ref' in value);
}

function join(...parts) {
  return parts.filter(Boolean).join(' · ');
}

/**
 * Names one outbox record. Pure, so it is tested without storage.
 *
 * @param {object} record          an outbox record
 * @param {object} lookups
 * @param {Map}    lookups.customers  id -> customer (held catalogue)
 * @param {Map}    lookups.products   id -> product
 * @param {Map}    lookups.personnel  id -> person
 * @param {Map}    lookups.records    outbox id -> record (for a customer created here)
 * @returns {{ id, kind, label, needsAttention: boolean, createdAt }}
 */
export function describeOutboxRecord(record, {
  customers = new Map(), products = new Map(), personnel = new Map(), records = new Map(),
} = {}) {
  const payload = record?.payload || {};
  const endpoint = record?.endpoint || '';

  // A customer is named by her catalogue row, or — quick-created on this device and
  // still waiting herself — by the name on her own queued record.
  const customerName = (id) => {
    if (isRef(id)) return records.get(id.$ref)?.payload?.name || 'New customer';
    return customers.get(Number(id))?.name || null;
  };
  const customerFromEndpoint = () => {
    const id = idFromEndpoint(endpoint, 'customers');
    if (id !== null) return customerName(id);
    const param = record?.endpoint_params?.customerId;
    return param ? customerName(param) : null;
  };
  const productName = (id) => products.get(Number(id))?.name || null;

  let kind;
  let label;

  switch (record?.entity_type) {
    case 'order': {
      kind = payload.status === 'draft' ? 'Draft order' : 'Order';
      label = join(
        record.receipt_number || payload.receipt_number || null,
        record.display?.customer_name || customerName(payload.customer_id),
      );
      break;
    }
    case 'order_status': {
      kind = 'Order status';
      const status = STATUS_WORDS[payload.status] || payload.status;
      label = join(orderRefFromEndpoint(endpoint), status ? `now ${status}` : null);
      break;
    }
    case 'receipt_printed':
      kind = 'Receipt printed';
      label = orderRefFromEndpoint(endpoint);
      break;
    case 'order_delete':
      kind = 'Draft discarded';
      label = orderRefFromEndpoint(endpoint);
      break;
    case 'customer':
      kind = 'New customer';
      label = payload.name;
      break;
    case 'customer_update':
      kind = 'Customer change';
      label = customerFromEndpoint();
      break;
    case 'customer_price':
      kind = 'Custom price';
      label = join(customerFromEndpoint(), productName(payload.product_id));
      break;
    case 'product':
      kind = 'New product';
      label = payload.name;
      break;
    case 'product_update': {
      const id = idFromEndpoint(endpoint, 'products');
      kind = payload.current_stock !== undefined ? 'Stock count'
        : payload.base_wholesale_price !== undefined ? 'Price change'
          : 'Product change';
      label = productName(id);
      break;
    }
    case 'product_stock_confirm':
      kind = 'Stock count';
      label = productName(idFromEndpoint(endpoint, 'products'));
      break;
    case 'product_price_confirm':
      kind = 'Price change';
      label = productName(idFromEndpoint(endpoint, 'products'));
      break;
    case 'product_batch_price': {
      const count = (payload.updates || []).length;
      kind = 'Price change';
      label = `${count} product${count === 1 ? '' : 's'}`;
      break;
    }
    case 'delivery':
      kind = 'Incoming delivery';
      label = join(payload.delivery_ref || record.receipt_number, payload.supplier_name);
      break;
    case 'personnel':
      kind = 'New personnel';
      label = payload.full_name;
      break;
    case 'personnel_update': {
      kind = 'Personnel change';
      const id = idFromEndpoint(endpoint, 'personnel');
      label = personnel.get(Number(id))?.full_name || null;
      break;
    }
    default:
      kind = 'Change';
      label = null;
  }

  return {
    id: record?.id,
    kind,
    label: label || null,
    needsAttention: record?.status === NEEDS_ATTENTION,
    createdAt: record?.created_at || null,
  };
}

async function byId(entity) {
  try {
    return new Map((await getCachedEntity(entity)).map((row) => [Number(row.id), row]));
  } catch {
    return new Map();
  }
}

// Everything still waiting on this device, oldest first, already named.
export async function listWaitingItems() {
  const records = await listRecords();
  if (!records.length) return [];
  const [customers, products, personnel] = await Promise.all([
    byId('customers'), byId('products'), byId('personnel'),
  ]);
  const lookups = {
    customers, products, personnel,
    records: new Map(records.map((r) => [r.id, r])),
  };
  return records.map((r) => describeOutboxRecord(r, lookups));
}
