import React, { useEffect, useState, useCallback } from 'react';
import { useRefreshListener } from '../../offline/refresh';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import { useToast } from '../../components/ui/Toast';
import Spinner from '../../components/ui/Spinner';
import Page, { SECTION_GAP } from '../../components/ui/Page';
import PageHeader from '../../components/ui/PageHeader';
import { ChipRow, Chip } from '../../components/ui/ChipRow';
import SearchFilterBar, { FilterField, FILTER_INPUT } from '../../components/ui/SearchFilterBar';
import ListCard from '../../components/ui/ListCard';
import OfflineBanner from '../../components/ui/OfflineBanner';
import { orderRefFromId } from '../../utils/orderRef';
import { getCachedEntity } from '../../offline/catalogue.js';
import {
  loadWithCache, AUDIT_INVENTORY_CACHE, AUDIT_ACTIVITY_CACHE,
} from '../../offline/backOfficeCache.js';

const ACTION_LABELS = {
  manual_adjustment: 'Manual Adjustment',
  restock:           'Restock',
  price_change:      'Price Change',
  order_fulfillment: 'Order Fulfilled',
  order_edit:        'Order Edit',
  order_cancel:      'Order Cancelled',
  delivery_edit:     'Delivery Edited',
};

const ACTION_COLORS = {
  manual_adjustment: 'bg-purple-100 text-purple-800 border-purple-300',
  restock:           'bg-green-100  text-green-800  border-green-300',
  price_change:      'bg-blue-100   text-blue-800   border-blue-300',
  order_fulfillment: 'bg-slate-100  text-slate-700  border-slate-300',
  order_edit:        'bg-amber-100  text-amber-800  border-amber-300',
  order_cancel:      'bg-red-100    text-red-800    border-red-300',
  delivery_edit:     'bg-teal-100   text-teal-800   border-teal-300',
};

const ACTION_TYPES = Object.keys(ACTION_LABELS);

const ENTITY_LABELS = {
  order:     'Order',
  customer:  'Customer',
  product:   'Product',
  personnel: 'Personnel',
  ticket:    'Ticket',
  station:   'Tablet',
};

const ENTITY_TYPES = Object.keys(ENTITY_LABELS);

const ACTIVITY_ACTION_LABELS = {
  created:        'Created',
  edited:         'Edited',
  status_changed: 'Status Changed',
  adjusted:       'Adjusted',
  closed:         'Closed',
  resolved:       'Resolved',
  price_set:      'Price Set',
  // ADR 0017 removed the slot concept, so nothing writes this action any more. The label
  // stays because `activity_logs` is append-only: the entries already recorded must keep
  // reading as words rather than falling back to the raw key.
  slot_assigned:  'Slot Assigned',
  device_letter_allocated: 'New Tablet',
};

const ACTIVITY_ACTION_COLORS = {
  created:        'bg-green-100  text-green-800  border-green-300',
  edited:         'bg-amber-100  text-amber-800  border-amber-300',
  status_changed: 'bg-blue-100   text-blue-800   border-blue-300',
  adjusted:       'bg-purple-100 text-purple-800 border-purple-300',
  closed:         'bg-slate-100  text-slate-700  border-slate-300',
  resolved:       'bg-slate-100  text-slate-700  border-slate-300',
  price_set:      'bg-blue-100   text-blue-800   border-blue-300',
};

function fmtFilterDate(v) {
  const [y, m, d] = String(v).split('-').map(Number);
  return y && m && d
    ? new Date(y, m - 1, d).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' })
    : v;
}

const fmtCardDateTime = (value) => new Date(value).toLocaleString('en-PH', {
  month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit',
});

// Renders an "Order 1-00042" / "Customer: Name" style reference for an activity entry,
// linking through to the relevant detail page where one exists. Orders are named by their
// receipt number (ADR 0010) — GET /audit/activity joins it in as entity_receipt_number —
// falling back to '#<id>' for the historical rows that never had one.
function EntityRef({ entry }) {
  const label = ENTITY_LABELS[entry.entity_type] ?? entry.entity_type;
  if (entry.entity_type === 'order' && entry.entity_id) {
    return (
      <Link
        to={`/orders/${entry.entity_id}`}
        className="text-blue-700 hover:underline font-medium"
        onClick={(ev) => ev.stopPropagation()}
        data-testid="audit-order-ref-link"
      >
        Order {orderRefFromId(entry.entity_id, entry.entity_receipt_number)}
      </Link>
    );
  }
  return (
    <span className="font-medium text-slate-900">
      {label}{entry.entity_id ? ` #${entry.entity_id}` : ''}
    </span>
  );
}

// The filters the server applies to a live read, applied here instead when the rows
// came out of the local cache. Same predicates, same meaning — the only difference is
// that the cached copy can't reach further back than the window it holds.
function withinDates(createdAt, fromDate, toDate) {
  const t = Date.parse(createdAt);
  if (Number.isNaN(t)) return true;
  if (fromDate && t < Date.parse(fromDate)) return false;
  // Inclusive of the whole "to" day, matching the server's `created_at <= to_date`
  // applied against a date-only string.
  if (toDate && t > Date.parse(toDate) + 24 * 60 * 60 * 1000 - 1) return false;
  return true;
}

export function filterInventoryRows(rows, { productId, actionType, fromDate, toDate }) {
  return rows.filter((e) =>
    (!productId  || String(e.product_id) === String(productId)) &&
    (!actionType || e.action_type === actionType) &&
    withinDates(e.created_at, fromDate, toDate)
  );
}

export function filterActivityRows(rows, { entityType, fromDate, toDate }) {
  return rows.filter((e) =>
    (!entityType || e.entity_type === entityType) &&
    withinDates(e.created_at, fromDate, toDate)
  );
}

export default function AuditPage() {
  const { addToast } = useToast();

  const [tab, setTab] = useState('inventory');

  // ── Inventory tab state ─────────────────────────────────────────────────
  const [entries, setEntries]   = useState([]);
  const [products, setProducts] = useState([]);
  const [loading, setLoading]   = useState(true);

  const [productId, setProductId]     = useState('');
  const [actionType, setActionType]   = useState('');
  const [fromDate, setFromDate]       = useState('');
  const [toDate, setToDate]           = useState('');

  const [fromCache, setFromCache] = useState(false);
  const [cachedAt, setCachedAt]   = useState(null);

  // Load product list once (including inactive — old logs may reference them).
  // Offline this comes from the catalogue the tablet already holds, so the product
  // filter still names things instead of collapsing to "All Products".
  useEffect(() => {
    api.get('/products?include_inactive=true')
      .then((p) => setProducts(p.sort((a, b) => a.name.localeCompare(b.name))))
      .catch(async () => {
        const cached = await getCachedEntity('products');
        setProducts([...cached].sort((a, b) => a.name.localeCompare(b.name)));
      });
  }, []);

  const hasFilters = Boolean(productId || actionType || fromDate || toDate);

  const load = useCallback(({ silent = false } = {}) => {
    if (!silent) setLoading(true);
    const params = new URLSearchParams();
    if (productId)  params.set('product_id',  productId);
    if (actionType) params.set('action_type', actionType);
    if (fromDate)   params.set('from_date',   fromDate);
    if (toDate)     params.set('to_date',     toDate);
    params.set('limit', '500');
    const qs = params.toString();

    // ADR 0015 §9 supersedes the audit report's older "Audit Log requires internet"
    // recommendation: the log is readable offline like every other back-office screen.
    //
    // Only the UNFILTERED baseline is cached (see backOfficeCache.js) — a bounded,
    // quietly-refreshed window rather than a mirror of an append-only table that grows
    // forever. When the live call fails, the held copy is filtered here instead, so
    // the same filter controls keep working on the copy.
    return loadWithCache(AUDIT_INVENTORY_CACHE, () => api.get(`/audit?${qs}`), { cacheable: !hasFilters })
      .then(({ data, fromCache: cached, cachedAt: at }) => {
        const rows = Array.isArray(data) ? data : [];
        setEntries(cached ? filterInventoryRows(rows, { productId, actionType, fromDate, toDate }) : rows);
        setFromCache(cached);
        setCachedAt(at);
      })
      .catch(() => addToast('Offline and this device has no audit log saved yet — connect once to set it up.', 'error'))
      .finally(() => { if (!silent) setLoading(false); });
  }, [productId, actionType, fromDate, toDate, hasFilters, addToast]);

  useEffect(() => { if (tab === 'inventory') load(); }, [tab, load]);

  // ── Activity tab state ──────────────────────────────────────────────────
  const [activityEntries, setActivityEntries]   = useState([]);
  const [activityLoading, setActivityLoading]   = useState(true);

  const [entityType, setEntityType]           = useState('');
  const [activityFromDate, setActivityFromDate] = useState('');
  const [activityToDate, setActivityToDate]     = useState('');

  const hasActivityFilters = Boolean(entityType || activityFromDate || activityToDate);

  const loadActivity = useCallback(({ silent = false } = {}) => {
    if (!silent) setActivityLoading(true);
    const params = new URLSearchParams();
    if (entityType)       params.set('entity_type', entityType);
    if (activityFromDate) params.set('from_date',   activityFromDate);
    if (activityToDate)   params.set('to_date',     activityToDate);
    params.set('limit', '500');
    const qs = params.toString();

    return loadWithCache(AUDIT_ACTIVITY_CACHE, () => api.get(`/audit/activity?${qs}`), { cacheable: !hasActivityFilters })
      .then(({ data, fromCache: cached, cachedAt: at }) => {
        const rows = Array.isArray(data) ? data : [];
        setActivityEntries(cached
          ? filterActivityRows(rows, { entityType, fromDate: activityFromDate, toDate: activityToDate })
          : rows);
        setFromCache(cached);
        setCachedAt(at);
      })
      .catch(() => addToast('Offline and this device has no activity log saved yet — connect once to set it up.', 'error'))
      .finally(() => { if (!silent) setActivityLoading(false); });
  }, [entityType, activityFromDate, activityToDate, hasActivityFilters, addToast]);

  useEffect(() => { if (tab === 'activity') loadActivity(); }, [tab, loadActivity]);

  // Pull-down / re-tapping the menu item reloads whichever tab is open, quietly.
  useRefreshListener(() => (tab === 'activity' ? loadActivity({ silent: true }) : load({ silent: true })));

  const formatDateTime = (value) => (
    <>
      {new Date(value).toLocaleDateString('en-PH', {
        month: 'short', day: 'numeric', year: 'numeric',
      })}
      <span className="block text-sm">
        {new Date(value).toLocaleTimeString('en-PH', {
          hour: '2-digit', minute: '2-digit',
        })}
      </span>
    </>
  );

  const productLabel = (id) => {
    const p = products.find((x) => String(x.id) === String(id));
    return p ? (p.sku || p.name) : `Product #${id}`;
  };
  const inventoryActive = [
    productId && { key: 'product', label: productLabel(productId), onRemove: () => setProductId('') },
    actionType && { key: 'action', label: ACTION_LABELS[actionType] ?? actionType, onRemove: () => setActionType('') },
    fromDate && { key: 'from', label: `From ${fmtFilterDate(fromDate)}`, onRemove: () => setFromDate('') },
    toDate && { key: 'to', label: `To ${fmtFilterDate(toDate)}`, onRemove: () => setToDate('') },
  ].filter(Boolean);
  const activityActive = [
    entityType && { key: 'entity', label: ENTITY_LABELS[entityType] ?? entityType, onRemove: () => setEntityType('') },
    activityFromDate && { key: 'from', label: `From ${fmtFilterDate(activityFromDate)}`, onRemove: () => setActivityFromDate('') },
    activityToDate && { key: 'to', label: `To ${fmtFilterDate(activityToDate)}`, onRemove: () => setActivityToDate('') },
  ].filter(Boolean);

  return (
    <Page>

      {/* ── Header ───────────────────────────────────────────────── */}
      <PageHeader
        title="Audit Log"
        subtitle={(
          <>
            <span className="md:hidden">Read-only record of every change.</span>
            <span className="hidden md:inline">
              Read-only record of everything that happens in the system — inventory and
              pricing history, plus orders, customers, products, personnel, and tickets.
            </span>
          </>
        )}
      />

      {/* ── Tab switcher — the same chips as every list (design standard Q4) ── */}
      <ChipRow label="Audit log" className="mb-3">
        <Chip selected={tab === 'inventory'} onClick={() => setTab('inventory')} data-testid="audit-tab-inventory">
          Inventory
        </Chip>
        <Chip selected={tab === 'activity'} onClick={() => setTab('activity')} data-testid="audit-tab-activity">
          Activity
        </Chip>
      </ChipRow>

      {fromCache && <OfflineBanner cachedAt={cachedAt} />}

      {tab === 'inventory' ? (
        <>
          {/* ── Filters (Q3): one Filters button; each filter that is on shows as a chip ── */}
          <SearchFilterBar
            className={SECTION_GAP}
            active={inventoryActive}
            panel={(
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <FilterField label="Product">
                  <select value={productId} onChange={(e) => setProductId(e.target.value)}
                          className={FILTER_INPUT} aria-label="Filter by product">
                    <option value="">All Products</option>
                    {products.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.sku || p.name}{!p.is_active ? ' (inactive)' : ''}
                      </option>
                    ))}
                  </select>
                </FilterField>
                <FilterField label="Action">
                  <select value={actionType} onChange={(e) => setActionType(e.target.value)}
                          className={FILTER_INPUT} aria-label="Filter by action type" data-testid="audit-filter-action">
                    <option value="">All Actions</option>
                    {ACTION_TYPES.map((a) => (
                      <option key={a} value={a}>{ACTION_LABELS[a]}</option>
                    ))}
                  </select>
                </FilterField>
                <FilterField label="From">
                  <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)}
                         className={FILTER_INPUT} aria-label="From date" />
                </FilterField>
                <FilterField label="To">
                  <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)}
                         className={FILTER_INPUT} aria-label="To date" />
                </FilterField>
              </div>
            )}
          />

          {/* ── Table ────────────────────────────────────────────────── */}
          {loading ? (
            <div className="flex items-center justify-center h-64">
              <Spinner size="lg" />
            </div>
          ) : entries.length === 0 ? (
            <p className="text-center text-slate-500 text-base py-20">
              {hasFilters ? 'No entries match your filters.' : 'No audit entries yet.'}
            </p>
          ) : (
            <>
              <div className="bg-white rounded-xl border border-slate-200 overflow-hidden overflow-x-auto" data-testid="audit-list">
                {/* Phone-width cards (D5) — same rows/testids as the table below, hidden
                    at lg. The action badge's data-testid lives ONLY here (not on the
                    table's copy below) because e2e/appium/tests/audit.test.mjs reads its
                    text with getText(), which returns "" for a display:none element. */}
                <div className="md:hidden divide-y divide-slate-200">
                  {entries.map((e) => (
                    <ListCard
                      key={e.id}
                      data-testid="audit-row"
                      title={e.sku || e.product_name}
                      titleRight={e.delta != null ? (
                        <span className={Number(e.delta) >= 0 ? 'text-green-800' : 'text-red-700'}>
                          {Number(e.delta) >= 0 ? '+' : '\u2212'}{Math.abs(Number(e.delta))}
                        </span>
                      ) : <span className="text-slate-500 font-normal">—</span>}
                      meta={<span className="tabular-nums">{fmtCardDateTime(e.created_at)}</span>}
                      metaRight={e.performed_by_name ?? null}
                      badges={(
                        <span
                          data-testid="audit-action-badge"
                          className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-sm font-semibold border whitespace-nowrap
                          ${ACTION_COLORS[e.action_type] ?? 'bg-slate-100 text-slate-700 border-slate-300'}`}>
                          {ACTION_LABELS[e.action_type] ?? e.action_type}
                        </span>
                      )}
                    />
                  ))}
                </div>

                <table className="hidden md:table w-full text-sm">
                  <thead>
                    <tr className="bg-slate-50 text-slate-500 text-sm uppercase tracking-wider border-b border-slate-400">
                      <th className="text-left px-5 py-3 font-semibold whitespace-nowrap">Date / Time</th>
                      <th className="text-left px-5 py-3 font-semibold">Product</th>
                      <th className="text-left px-5 py-3 font-semibold">Action</th>
                      <th className="text-right px-5 py-3 font-semibold">Change</th>
                      <th className="text-left px-5 py-3 font-semibold hidden lg:table-cell">Prev → New</th>
                      <th className="text-left px-5 py-3 font-semibold hidden md:table-cell">Reason / Reference</th>
                      <th className="text-left px-5 py-3 font-semibold hidden xl:table-cell">By</th>
                    </tr>
                  </thead>
                  <tbody>
                    {entries.map((e) => (
                      <tr key={e.id} data-testid="audit-row" className="border-t border-slate-300 hover:bg-slate-50">
                        <td className="px-5 py-3 text-slate-500 tabular-nums whitespace-nowrap">
                          {formatDateTime(e.created_at)}
                        </td>
                        <td className="px-5 py-3 font-medium text-slate-900">
                          {e.sku || e.product_name}
                        </td>
                        <td className="px-5 py-3">
                          <span
                            className={`inline-flex items-center px-2 py-0.5 rounded-full text-sm font-semibold border whitespace-nowrap
                            ${ACTION_COLORS[e.action_type] ?? 'bg-slate-100 text-slate-600 border-slate-200'}`}>
                            {ACTION_LABELS[e.action_type] ?? e.action_type}
                          </span>
                        </td>
                        <td className="px-5 py-3 text-right tabular-nums font-bold">
                          {e.delta != null ? (
                            <span className={Number(e.delta) >= 0 ? 'text-green-700' : 'text-red-600'}>
                              {Number(e.delta) >= 0 ? '+' : ''}{e.delta}
                            </span>
                          ) : (
                            <span className="text-slate-500 font-normal">—</span>
                          )}
                        </td>
                        <td className="px-5 py-3 text-slate-500 tabular-nums hidden lg:table-cell whitespace-nowrap">
                          {e.previous_value != null && e.new_value != null
                            ? `${e.previous_value} → ${e.new_value}`
                            : '—'}
                        </td>
                        <td className="px-5 py-3 text-slate-500 hidden md:table-cell max-w-xs">
                          <span className="block truncate">
                            {e.reason ?? (
                              e.related_order_id
                                ? <Link
                                    to={`/orders/${e.related_order_id}`}
                                    className="text-blue-700 hover:underline"
                                    onClick={(ev) => ev.stopPropagation()}
                                    data-testid="audit-order-ref-link"
                                  >
                                    Order {orderRefFromId(e.related_order_id, e.related_order_receipt_number)}
                                  </Link>
                                : e.related_delivery_id
                                ? `Delivery #${e.related_delivery_id}`
                                : '—'
                            )}
                          </span>
                        </td>
                        <td className="px-5 py-3 text-slate-500 hidden xl:table-cell whitespace-nowrap">
                          {e.performed_by_name ?? '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <p className="text-sm text-slate-600 mt-3 text-right">
                {entries.length} {entries.length === 1 ? 'entry' : 'entries'} shown
                {entries.length === 500 && ' (limit reached — refine filters to see more)'}
              </p>
            </>
          )}
        </>
      ) : (
        <>
          {/* ── Activity filters (Q3) ─────────────────────────────────── */}
          <SearchFilterBar
            className={SECTION_GAP}
            active={activityActive}
            panel={(
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <FilterField label="Type">
                  <select value={entityType} onChange={(e) => setEntityType(e.target.value)}
                          className={FILTER_INPUT} aria-label="Filter by entity type" data-testid="audit-filter-entity">
                    <option value="">All Types</option>
                    {ENTITY_TYPES.map((t) => (
                      <option key={t} value={t}>{ENTITY_LABELS[t]}</option>
                    ))}
                  </select>
                </FilterField>
                <FilterField label="From">
                  <input type="date" value={activityFromDate} onChange={(e) => setActivityFromDate(e.target.value)}
                         className={FILTER_INPUT} aria-label="From date" />
                </FilterField>
                <FilterField label="To">
                  <input type="date" value={activityToDate} onChange={(e) => setActivityToDate(e.target.value)}
                         className={FILTER_INPUT} aria-label="To date" />
                </FilterField>
              </div>
            )}
          />

          {/* ── Activity table ───────────────────────────────────────── */}
          {activityLoading ? (
            <div className="flex items-center justify-center h-64">
              <Spinner size="lg" />
            </div>
          ) : activityEntries.length === 0 ? (
            <p className="text-center text-slate-500 text-base py-20">
              {hasActivityFilters ? 'No entries match your filters.' : 'No activity recorded yet.'}
            </p>
          ) : (
            <>
              <div className="bg-white rounded-xl border border-slate-200 overflow-hidden overflow-x-auto" data-testid="audit-list">
                {/* Phone-width cards (D5) — same rows/testids as the table below, hidden at lg */}
                <div className="md:hidden divide-y divide-slate-200">
                  {activityEntries.map((e) => (
                    <ListCard
                      key={e.id}
                      data-testid="audit-row"
                      title={<EntityRef entry={e} />}
                      titleRight={(
                        <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-sm font-semibold border whitespace-nowrap
                          ${ACTIVITY_ACTION_COLORS[e.action] ?? 'bg-slate-100 text-slate-700 border-slate-300'}`}>
                          {ACTIVITY_ACTION_LABELS[e.action] ?? e.action}
                        </span>
                      )}
                      meta={<span className="tabular-nums">{fmtCardDateTime(e.created_at)}</span>}
                      metaRight={e.performed_by_name ?? null}
                    >
                      <p className="text-slate-700 text-sm mt-1.5">{e.summary}</p>
                    </ListCard>
                  ))}
                </div>

                <table className="hidden md:table w-full text-sm">
                  <thead>
                    <tr className="bg-slate-50 text-slate-500 text-sm uppercase tracking-wider border-b border-slate-400">
                      <th className="text-left px-5 py-3 font-semibold whitespace-nowrap">Date / Time</th>
                      <th className="text-left px-5 py-3 font-semibold">Entity</th>
                      <th className="text-left px-5 py-3 font-semibold">Action</th>
                      <th className="text-left px-5 py-3 font-semibold">Summary</th>
                      <th className="text-left px-5 py-3 font-semibold hidden xl:table-cell">By</th>
                    </tr>
                  </thead>
                  <tbody>
                    {activityEntries.map((e) => (
                      <tr key={e.id} data-testid="audit-row" className="border-t border-slate-300 hover:bg-slate-50">
                        <td className="px-5 py-3 text-slate-500 tabular-nums whitespace-nowrap">
                          {formatDateTime(e.created_at)}
                        </td>
                        <td className="px-5 py-3 whitespace-nowrap">
                          <EntityRef entry={e} />
                        </td>
                        <td className="px-5 py-3">
                          <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-sm font-semibold border whitespace-nowrap
                            ${ACTIVITY_ACTION_COLORS[e.action] ?? 'bg-slate-100 text-slate-600 border-slate-200'}`}>
                            {ACTIVITY_ACTION_LABELS[e.action] ?? e.action}
                          </span>
                        </td>
                        <td className="px-5 py-3 text-slate-600 max-w-lg">
                          <span className="block">{e.summary}</span>
                        </td>
                        <td className="px-5 py-3 text-slate-500 hidden xl:table-cell whitespace-nowrap">
                          {e.performed_by_name ?? '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <p className="text-sm text-slate-600 mt-3 text-right">
                {activityEntries.length} {activityEntries.length === 1 ? 'entry' : 'entries'} shown
                {activityEntries.length === 500 && ' (limit reached — refine filters to see more)'}
              </p>
            </>
          )}
        </>
      )}
    </Page>
  );
}
