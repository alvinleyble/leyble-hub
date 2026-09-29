import React, { useEffect, useState, useCallback } from 'react';
import { useRefreshListener } from '../../offline/refresh';
import { api } from '../../api/client';
import { useToast } from '../../components/ui/Toast';
import Page, { SECTION_GAP } from '../../components/ui/Page';
import PageHeader from '../../components/ui/PageHeader';
import SearchFilterBar, { FilterField, FILTER_INPUT } from '../../components/ui/SearchFilterBar';
import ListCard from '../../components/ui/ListCard';
import { TagBadge } from '../../components/ui/Badge';
import Spinner from '../../components/ui/Spinner';
import OfflineBanner from '../../components/ui/OfflineBanner';
import DeliveryFormModal from './DeliveryFormModal';
import DeliveryDetailPanel from './DeliveryDetailPanel';
import { loadWithCache, DELIVERIES_CACHE } from '../../offline/backOfficeCache.js';
import { queuedDeliveriesFromOutbox, mergeDeliveries } from '../../offline/deliveries.js';
import { subscribeOutbox } from '../../offline/outbox.js';

// The filters the server applies to a live read, applied here instead when the rows
// came from the local cache or from the outbox. Same predicates as GET /incoming.
export function filterDeliveries(rows, { supplierFilter, fromDate, toDate }) {
  const needle = (supplierFilter || '').trim().toLowerCase();
  return rows.filter((d) => {
    if (needle && !(d.supplier_name || '').toLowerCase().includes(needle)) return false;
    const t = Date.parse(d.received_at);
    if (Number.isNaN(t)) return true;
    if (fromDate && t < Date.parse(fromDate)) return false;
    if (toDate && t >= Date.parse(toDate) + 24 * 60 * 60 * 1000) return false;
    return true;
  });
}

export default function IncomingPage() {
  const { addToast } = useToast();

  const [deliveries, setDeliveries]   = useState([]);
  const [loading, setLoading]         = useState(true);
  const [creating, setCreating]       = useState(false);
  const [editing, setEditing]         = useState(null);
  const [selectedId, setSelectedId]   = useState(null);

  const [supplierFilter, setSupplierFilter] = useState('');
  const [fromDate, setFromDate]             = useState('');
  const [toDate, setToDate]                 = useState('');

  const [fromCache, setFromCache]       = useState(false);
  const [cachedAt, setCachedAt]         = useState(null);
  const [queuedDeliveries, setQueued]   = useState([]);

  const hasFilters = Boolean(supplierFilter.trim() || fromDate || toDate);

  // ADR 0015 §9 — the deliveries list is readable offline from a bounded local copy
  // (30 days; see backOfficeCache.js). Only the unfiltered baseline is cached, so a
  // filtered read never overwrites it and the filters are applied to the held copy
  // here instead.
  const load = useCallback(({ silent = false } = {}) => {
    if (!silent) setLoading(true);
    const params = new URLSearchParams();
    if (supplierFilter.trim()) params.set('supplier_name', supplierFilter.trim());
    if (fromDate) params.set('from_date', fromDate);
    if (toDate)   params.set('to_date', toDate);
    const qs = params.toString();

    return loadWithCache(DELIVERIES_CACHE, () => api.get(`/incoming${qs ? `?${qs}` : ''}`), {
      cacheable: !hasFilters, dateField: 'received_at',
    })
      .then(({ data, fromCache: cached, cachedAt: at }) => {
        const rows = Array.isArray(data) ? data : [];
        setDeliveries(cached ? filterDeliveries(rows, { supplierFilter, fromDate, toDate }) : rows);
        setFromCache(cached);
        setCachedAt(at);
      })
      .catch(() => addToast('Offline and this device has no deliveries saved yet — connect once to set it up.', 'error'))
      .finally(() => { if (!silent) setLoading(false); });
  }, [supplierFilter, fromDate, toDate, hasFilters, addToast]);

  useEffect(() => { load(); }, [load]);

  // ADR 0015 §8 — deliveries logged blind live in the outbox until they drain, so the
  // server's list cannot see them. Same rule as queued customers and queued products:
  // merge them in, or the truck someone deliberately logged during the outage is
  // invisible on exactly the screen they logged it for.
  const loadQueued = useCallback(async () => {
    setQueued(await queuedDeliveriesFromOutbox());
  }, []);

  useEffect(() => {
    loadQueued();
    return subscribeOutbox(() => loadQueued());
  }, [loadQueued]);

  // Pull-down / re-tapping the menu item: reload quietly behind the rows on screen.
  useRefreshListener(() => Promise.all([load({ silent: true }), loadQueued()]));

  const visibleQueued = filterDeliveries(queuedDeliveries, { supplierFilter, fromDate, toDate });
  const displayDeliveries = mergeDeliveries(deliveries, visibleQueued);

  const fmtReceived = (d) => new Date(d.received_at).toLocaleDateString('en-PH', {
    year: 'numeric', month: 'short', day: 'numeric',
  });
  const fmtFilterDate = (v) => {
    const [y, m, d] = String(v).split('-').map(Number);
    return y && m && d
      ? new Date(y, m - 1, d).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' })
      : v;
  };
  const activeFilters = [
    fromDate && { key: 'from', label: `From ${fmtFilterDate(fromDate)}`, onRemove: () => setFromDate('') },
    toDate && { key: 'to', label: `To ${fmtFilterDate(toDate)}`, onRemove: () => setToDate('') },
  ].filter(Boolean);
  const openDelivery = (d) => { if (!d._unsynced) setSelectedId(d.id); };

  return (
    <Page>
      {/* ADR 0015 §8 — logging a truck is additive and conflict-free, so it works
          blind. Editing and voiding an already-logged delivery do not. */}
      <PageHeader title="Incoming Supplies" primary={{ label: '+ Log Delivery', onClick: () => setCreating(true) }} />

      {fromCache && <OfflineBanner cachedAt={cachedAt} />}

      {/* ── Search + Filters (design standard Q3) ────────────────── */}
      <SearchFilterBar
        className={SECTION_GAP}
        value={supplierFilter}
        onChange={setSupplierFilter}
        placeholder="Supplier"
        ariaLabel="Filter by supplier"
        active={activeFilters}
        panel={(
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
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

      {/* ── List ─────────────────────────────────────────────────── */}
      {loading ? (
        <div className="flex items-center justify-center h-64">
          <Spinner size="lg" />
        </div>
      ) : displayDeliveries.length === 0 ? (
        <p className="text-center text-slate-500 text-base py-20">
          {(supplierFilter || fromDate || toDate)
            ? 'No deliveries match your filters.'
            : 'No deliveries logged yet. Log one to get started.'}
        </p>
      ) : (
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          {/* Phone + upright-tablet cards (UI audit F7: this was the one list with no
              card view, and it silently dropped # Items and Logged By on phones). */}
          <div className="lg:hidden divide-y divide-slate-200">
            {displayDeliveries.map((d) => (
              <ListCard
                key={d.id}
                onClick={() => openDelivery(d)}
                data-testid="incoming-row"
                title={d.supplier_name}
                titleRight={<span className="text-sm font-semibold text-slate-700">{d.item_count ?? 0} item{Number(d.item_count) === 1 ? '' : 's'}</span>}
                meta={fmtReceived(d)}
                metaRight={`Logged by: ${d.created_by_name ?? '—'}`}
                badges={[d._unsynced && <TagBadge key="sync" kind="unsynced" />]}
              >
                {d.notes && <p className="mt-1 text-sm text-slate-600 line-clamp-2">{d.notes}</p>}
              </ListCard>
            ))}
          </div>

          <table className="hidden lg:table w-full text-base">
            <thead>
              <tr className="bg-slate-50 text-slate-600 text-sm uppercase tracking-wider border-b border-slate-400">
                <th className="text-left px-4 lg:px-5 py-3 font-semibold">Date Received</th>
                <th className="text-left px-4 lg:px-5 py-3 font-semibold">Supplier</th>
                <th className="text-right px-4 lg:px-5 py-3 font-semibold"># Items</th>
                <th className="text-left px-4 lg:px-5 py-3 font-semibold">Logged By</th>
              </tr>
            </thead>
            <tbody>
              {displayDeliveries.map((d) => (
                <tr
                  key={d.id}
                  onClick={() => openDelivery(d)}
                  data-testid="incoming-row"
                  className="border-t border-slate-300 hover:bg-blue-50 cursor-pointer transition-colors"
                >
                  <td className="px-4 lg:px-5 py-4 text-slate-700 tabular-nums whitespace-nowrap">
                    {fmtReceived(d)}
                  </td>
                  <td className="px-4 lg:px-5 py-4 font-semibold text-slate-900">
                    {d.supplier_name}
                    {d._unsynced && <TagBadge kind="unsynced" className="ml-2 align-middle" />}
                    {d.notes && (
                      <p className="text-sm text-slate-600 font-normal mt-0.5 truncate max-w-xs">{d.notes}</p>
                    )}
                  </td>
                  <td className="px-4 lg:px-5 py-4 text-right tabular-nums text-slate-700">
                    {d.item_count}
                  </td>
                  <td className="px-4 lg:px-5 py-4 text-slate-600">
                    {d.created_by_name ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Modal / Panel ─────────────────────────────────────────── */}
      {creating && (
        <DeliveryFormModal
          onClose={() => setCreating(false)}
          onSaved={() => { setCreating(false); load(); }}
        />
      )}

      {editing && (
        <DeliveryFormModal
          delivery={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }}
        />
      )}

      {selectedId !== null && (
        <DeliveryDetailPanel
          deliveryId={selectedId}
          cachedDelivery={displayDeliveries.find((d) => String(d.id) === String(selectedId)) || null}
          onClose={() => setSelectedId(null)}
          onEdit={(d) => { setSelectedId(null); setEditing(d); }}
          onDeleted={() => { setSelectedId(null); load(); }}
        />
      )}
    </Page>
  );
}
