import React, { useEffect, useState, useCallback } from 'react';
import { api } from '../../api/client';
import { useToast } from '../../components/ui/Toast';
import Button from '../../components/ui/Button';
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
  const load = useCallback(() => {
    setLoading(true);
    const params = new URLSearchParams();
    if (supplierFilter.trim()) params.set('supplier_name', supplierFilter.trim());
    if (fromDate) params.set('from_date', fromDate);
    if (toDate)   params.set('to_date', toDate);
    const qs = params.toString();

    loadWithCache(DELIVERIES_CACHE, () => api.get(`/incoming${qs ? `?${qs}` : ''}`), {
      cacheable: !hasFilters, dateField: 'received_at',
    })
      .then(({ data, fromCache: cached, cachedAt: at }) => {
        const rows = Array.isArray(data) ? data : [];
        setDeliveries(cached ? filterDeliveries(rows, { supplierFilter, fromDate, toDate }) : rows);
        setFromCache(cached);
        setCachedAt(at);
      })
      .catch(() => addToast('Offline and this device has no deliveries saved yet — connect once to set it up.', 'error'))
      .finally(() => setLoading(false));
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

  const visibleQueued = filterDeliveries(queuedDeliveries, { supplierFilter, fromDate, toDate });
  const displayDeliveries = mergeDeliveries(deliveries, visibleQueued);

  return (
    <div className="p-6 max-w-7xl mx-auto">

      {/* ── Header ───────────────────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
        <h1 className="text-2xl font-bold text-slate-900">Incoming Supplies</h1>
        {/* ADR 0015 §8 — logging a truck is additive and conflict-free, so it works
            blind. Editing and voiding an already-logged delivery do not. */}
        <Button onClick={() => setCreating(true)}>+ Log Delivery</Button>
      </div>

      {fromCache && <OfflineBanner cachedAt={cachedAt} />}

      {/* ── Filters ──────────────────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row gap-3 mb-6">
        <input
          type="search"
          placeholder="Filter by supplier…"
          value={supplierFilter}
          onChange={(e) => setSupplierFilter(e.target.value)}
          className="flex-1 h-12 px-4 border border-slate-300 rounded-lg text-base text-slate-900
                     focus:outline-none focus:ring-2 focus:ring-blue-600"
          aria-label="Filter by supplier"
        />
        <div className="flex gap-2 items-center">
          <label className="text-sm text-slate-500 font-medium whitespace-nowrap">From</label>
          <input
            type="date"
            value={fromDate}
            onChange={(e) => setFromDate(e.target.value)}
            className="h-12 px-3 border border-slate-300 rounded-lg text-base text-slate-900
                       focus:outline-none focus:ring-2 focus:ring-blue-600"
            aria-label="From date"
          />
        </div>
        <div className="flex gap-2 items-center">
          <label className="text-sm text-slate-500 font-medium whitespace-nowrap">To</label>
          <input
            type="date"
            value={toDate}
            onChange={(e) => setToDate(e.target.value)}
            className="h-12 px-3 border border-slate-300 rounded-lg text-base text-slate-900
                       focus:outline-none focus:ring-2 focus:ring-blue-600"
            aria-label="To date"
          />
        </div>
        {(supplierFilter || fromDate || toDate) && (
          <button
            onClick={() => { setSupplierFilter(''); setFromDate(''); setToDate(''); }}
            className="h-12 px-4 text-sm font-medium text-slate-500 hover:text-slate-800
                       border border-slate-300 rounded-lg bg-white hover:bg-slate-50
                       focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 whitespace-nowrap"
          >
            Clear filters
          </button>
        )}
      </div>

      {/* ── Table ────────────────────────────────────────────────── */}
      {loading ? (
        <div className="flex items-center justify-center h-64">
          <Spinner size="lg" />
        </div>
      ) : displayDeliveries.length === 0 ? (
        <p className="text-center text-slate-400 text-base py-20">
          {(supplierFilter || fromDate || toDate)
            ? 'No deliveries match your filters.'
            : 'No deliveries logged yet. Log one to get started.'}
        </p>
      ) : (
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          <table className="w-full text-base">
            <thead>
              <tr className="bg-slate-50 text-slate-500 text-sm uppercase tracking-wider border-b border-slate-400">
                <th className="text-left px-5 py-3 font-semibold">Date Received</th>
                <th className="text-left px-5 py-3 font-semibold">Supplier</th>
                <th className="text-right px-5 py-3 font-semibold hidden sm:table-cell"># Items</th>
                <th className="text-left px-5 py-3 font-semibold hidden md:table-cell">Logged By</th>
              </tr>
            </thead>
            <tbody>
              {displayDeliveries.map((d) => (
                <tr
                  key={d.id}
                  onClick={() => { if (!d._unsynced) setSelectedId(d.id); }}
                  className="border-t border-slate-300 hover:bg-blue-50 cursor-pointer transition-colors"
                >
                  <td className="px-5 py-4 text-slate-700 tabular-nums">
                    {new Date(d.received_at).toLocaleDateString('en-PH', {
                      year: 'numeric', month: 'short', day: 'numeric',
                    })}
                  </td>
                  <td className="px-5 py-4 font-semibold text-slate-900">
                    {d.supplier_name}
                    {d._unsynced && (
                      <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded-full text-xs
                                       font-semibold border bg-amber-100 text-amber-800 border-amber-300">
                        Waiting to sync
                      </span>
                    )}
                    {d.notes && (
                      <p className="text-xs text-slate-400 font-normal mt-0.5 truncate max-w-xs">{d.notes}</p>
                    )}
                  </td>
                  <td className="px-5 py-4 text-right tabular-nums text-slate-700 hidden sm:table-cell">
                    {d.item_count}
                  </td>
                  <td className="px-5 py-4 text-slate-500 hidden md:table-cell">
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
    </div>
  );
}
