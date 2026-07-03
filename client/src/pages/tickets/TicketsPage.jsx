import React, { useEffect, useState, useCallback } from 'react';
import { api } from '../../api/client';
import { useToast } from '../../components/ui/Toast';
import Button from '../../components/ui/Button';
import Spinner from '../../components/ui/Spinner';
import TicketFormModal from './TicketFormModal';
import TicketDetailPanel from './TicketDetailPanel';

const PHP = (n) =>
  `₱${Number(n).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function TicketsPage() {
  const { addToast } = useToast();

  const [tickets, setTickets]     = useState([]);
  const [loading, setLoading]     = useState(true);
  const [creating, setCreating]   = useState(false);
  const [selectedId, setSelectedId] = useState(null);
  const [statusFilter, setStatusFilter] = useState('pending');

  const load = useCallback(() => {
    setLoading(true);
    const qs = statusFilter !== 'all' ? `?status=${statusFilter}` : '';
    api.get(`/tickets${qs}`)
      .then(setTickets)
      .catch(() => addToast('Failed to load tickets.', 'error'))
      .finally(() => setLoading(false));
  }, [statusFilter, addToast]);

  useEffect(() => { load(); }, [load]);

  const STATUS_OPTS = [
    { value: 'pending',  label: 'Pending' },
    { value: 'resolved', label: 'Resolved' },
    { value: 'all',      label: 'All' },
  ];

  return (
    <div className="p-6 max-w-7xl mx-auto">

      {/* ── Header ───────────────────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
        <h1 className="text-2xl font-bold text-slate-900">Tickets</h1>
        <Button onClick={() => setCreating(true)}>+ New Ticket</Button>
      </div>

      {/* ── Status filter ────────────────────────────────────────── */}
      <div className="flex gap-1.5 mb-6">
        {STATUS_OPTS.map((opt) => (
          <button
            key={opt.value}
            onClick={() => setStatusFilter(opt.value)}
            className={`px-4 py-2 rounded-full text-sm font-semibold border transition-colors
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600
              ${statusFilter === opt.value
                ? opt.value === 'pending'
                  ? 'bg-amber-500 text-white border-amber-500'
                  : opt.value === 'resolved'
                  ? 'bg-green-600 text-white border-green-600'
                  : 'bg-slate-700 text-white border-slate-700'
                : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'}`}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {/* ── Table ────────────────────────────────────────────────── */}
      {loading ? (
        <div className="flex items-center justify-center h-64">
          <Spinner size="lg" />
        </div>
      ) : tickets.length === 0 ? (
        <p className="text-center text-slate-400 text-base py-20">
          {statusFilter === 'pending'
            ? 'No open tickets. All clear!'
            : statusFilter === 'resolved'
            ? 'No resolved tickets yet.'
            : 'No tickets yet. Create one to get started.'}
        </p>
      ) : (
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          <table className="w-full text-base">
            <thead>
              <tr className="bg-slate-50 text-slate-500 text-sm uppercase tracking-wider border-b border-slate-400">
                <th className="text-left px-5 py-3 font-semibold">#</th>
                <th className="text-left px-5 py-3 font-semibold">Title</th>
                <th className="text-left px-5 py-3 font-semibold hidden md:table-cell">Related</th>
                <th className="text-right px-5 py-3 font-semibold hidden sm:table-cell">Amount</th>
                <th className="text-left px-5 py-3 font-semibold">Status</th>
                <th className="text-left px-5 py-3 font-semibold hidden lg:table-cell">Date</th>
              </tr>
            </thead>
            <tbody>
              {tickets.map((t) => (
                <tr
                  key={t.id}
                  onClick={() => setSelectedId(t.id)}
                  className="border-t border-slate-300 hover:bg-blue-50 cursor-pointer transition-colors"
                >
                  <td className="px-5 py-4 text-slate-400 font-mono text-sm">
                    #{t.id}
                  </td>
                  <td className="px-5 py-4">
                    <p className="font-semibold text-slate-900">{t.title}</p>
                    <p className="text-xs text-slate-400 mt-0.5 line-clamp-1">{t.description}</p>
                  </td>
                  <td className="px-5 py-4 text-sm text-slate-500 hidden md:table-cell">
                    {t.related_order_id && (
                      <span className="inline-block mr-2">Order #{t.related_order_id}</span>
                    )}
                    {t.personnel_name && (
                      <span className="inline-block">{t.personnel_name}</span>
                    )}
                    {!t.related_order_id && !t.personnel_name && '—'}
                  </td>
                  <td className="px-5 py-4 text-right tabular-nums hidden sm:table-cell">
                    {t.amount != null ? (
                      <span className={`font-semibold ${Number(t.amount) < 0 ? 'text-red-600' : 'text-green-700'}`}>
                        {Number(t.amount) >= 0 ? '+' : ''}{PHP(t.amount)}
                      </span>
                    ) : (
                      <span className="text-slate-300">—</span>
                    )}
                  </td>
                  <td className="px-5 py-4">
                    <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-sm font-semibold border
                      ${t.status === 'resolved'
                        ? 'bg-green-100 text-green-800 border-green-300'
                        : 'bg-amber-100 text-amber-800 border-amber-300'}`}>
                      {t.status === 'resolved' ? 'Resolved' : 'Pending'}
                    </span>
                  </td>
                  <td className="px-5 py-4 text-sm text-slate-400 hidden lg:table-cell tabular-nums">
                    {new Date(t.created_at).toLocaleDateString('en-PH', {
                      year: 'numeric', month: 'short', day: 'numeric',
                    })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Modal / Panel ─────────────────────────────────────────── */}
      {creating && (
        <TicketFormModal
          onClose={() => setCreating(false)}
          onSaved={() => { setCreating(false); load(); }}
        />
      )}

      {selectedId !== null && (
        <TicketDetailPanel
          ticketId={selectedId}
          onClose={() => setSelectedId(null)}
          onResolved={load}
        />
      )}
    </div>
  );
}
