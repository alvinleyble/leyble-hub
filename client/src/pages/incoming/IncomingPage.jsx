import React, { useEffect, useState, useCallback } from 'react';
import { api } from '../../api/client';
import { useToast } from '../../components/ui/Toast';
import Button from '../../components/ui/Button';
import Spinner from '../../components/ui/Spinner';
import DeliveryFormModal from './DeliveryFormModal';
import DeliveryDetailPanel from './DeliveryDetailPanel';

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

  const load = useCallback(() => {
    setLoading(true);
    const params = new URLSearchParams();
    if (supplierFilter.trim()) params.set('supplier_name', supplierFilter.trim());
    if (fromDate) params.set('from_date', fromDate);
    if (toDate)   params.set('to_date', toDate);
    const qs = params.toString();

    api.get(`/incoming${qs ? `?${qs}` : ''}`)
      .then(setDeliveries)
      .catch(() => addToast('Failed to load deliveries.', 'error'))
      .finally(() => setLoading(false));
  }, [supplierFilter, fromDate, toDate, addToast]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="p-6 max-w-7xl mx-auto">

      {/* ── Header ───────────────────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
        <h1 className="text-2xl font-bold text-slate-900">Incoming Supplies</h1>
        <Button onClick={() => setCreating(true)}>+ Log Delivery</Button>
      </div>

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
      ) : deliveries.length === 0 ? (
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
              {deliveries.map((d) => (
                <tr
                  key={d.id}
                  onClick={() => setSelectedId(d.id)}
                  className="border-t border-slate-300 hover:bg-blue-50 cursor-pointer transition-colors"
                >
                  <td className="px-5 py-4 text-slate-700 tabular-nums">
                    {new Date(d.received_at).toLocaleDateString('en-PH', {
                      year: 'numeric', month: 'short', day: 'numeric',
                    })}
                  </td>
                  <td className="px-5 py-4 font-semibold text-slate-900">
                    {d.supplier_name}
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
          onClose={() => setSelectedId(null)}
          onEdit={(d) => { setSelectedId(null); setEditing(d); }}
          onDeleted={() => { setSelectedId(null); load(); }}
        />
      )}
    </div>
  );
}
