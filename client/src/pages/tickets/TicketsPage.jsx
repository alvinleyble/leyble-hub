import React, { useEffect, useState, useCallback } from 'react';
import { api } from '../../api/client';
import { useToast } from '../../components/ui/Toast';
import Button from '../../components/ui/Button';
import Spinner from '../../components/ui/Spinner';
import OfflineBanner from '../../components/ui/OfflineBanner';
import TicketFormModal from './TicketFormModal';
import TicketDetailPanel from './TicketDetailPanel';
import { orderRefFromId } from '../../utils/orderRef';
import { loadWithCache, TICKETS_CACHE } from '../../offline/backOfficeCache.js';
import { checkIsOnline } from '../../offline/status.js';

const PHP = (n) =>
  `₱${Number(n).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function TicketsPage() {
  const { addToast } = useToast();

  const [tickets, setTickets]     = useState([]);
  const [loading, setLoading]     = useState(true);
  const [creating, setCreating]   = useState(false);
  const [selectedId, setSelectedId] = useState(null);
  const [statusFilter, setStatusFilter] = useState('pending');
  const [fromCache, setFromCache] = useState(false);
  const [cachedAt, setCachedAt]   = useState(null);
  const [unreachable, setUnreachable] = useState(false);

  // ADR 0015 §9 — tickets are readable offline from a quietly-kept copy.
  //
  // The status filter moved from the query string to the client. Caching one list per
  // filter combination would fragment the copy into whichever slice was looked at last;
  // the shop's ticket volume is small enough that fetching all of them once and
  // filtering here is both simpler and strictly more useful blind, since every tab
  // then works off the same cached copy instead of only the one that was open when the
  // line dropped.
  const load = useCallback(() => {
    setLoading(true);
    loadWithCache(TICKETS_CACHE, () => api.get('/tickets'))
      .then(({ data, fromCache: cached, cachedAt: at }) => {
        setTickets(Array.isArray(data) ? data : []);
        setFromCache(cached);
        setUnreachable(cached);
        setCachedAt(at);
      })
      .catch(() => {
        // Nothing live and nothing held. Still offline, so the mutation gate below has
        // to hold — a first-run tablet must not offer an action that cannot work.
        setUnreachable(true);
        addToast('Offline and this device has no tickets saved yet — connect once to set it up.', 'error');
      })
      .finally(() => setLoading(false));
  }, [addToast]);

  useEffect(() => { load(); }, [load]);

  const visibleTickets = statusFilter === 'all'
    ? tickets
    : tickets.filter((t) => t.status === statusFilter);

  // §9's shared-mutation gate. Creating a ticket is NOT one of the additive offline
  // operations the ADR grants (unlike an order, a customer or a delivery), so it is
  // blocked blind with an explanation rather than left to fail as a raw fetch error.
  //
  // `fromCache` leads the test, not `checkIsOnline()` alone: a failed read is proof the
  // server is unreachable, whereas navigator.onLine (all `checkIsOnline` has to go on
  // when V25_OFFLINE_CORE is off) happily reports true on a tablet sitting on Wi-Fi
  // with no route out — exactly the Antipolo failure mode this release is about.
  const mutationsBlocked = unreachable || !checkIsOnline();

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
        <Button
          onClick={() => setCreating(true)}
          disabled={mutationsBlocked}
          title={mutationsBlocked ? "Needs a connection — new tickets can't be raised offline" : undefined}
        >
          + New Ticket
        </Button>
      </div>

      {fromCache && <OfflineBanner cachedAt={cachedAt} />}

      {/* ── Status filter ────────────────────────────────────────── */}
      <div className="flex gap-1.5 mb-6">
        {STATUS_OPTS.map((opt) => (
          <button
            key={opt.value}
            onClick={() => setStatusFilter(opt.value)}
            data-testid={`tickets-filter-${opt.value}`}
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
      ) : visibleTickets.length === 0 ? (
        <p className="text-center text-slate-400 text-base py-20">
          {statusFilter === 'pending'
            ? 'No open tickets. All clear!'
            : statusFilter === 'resolved'
            ? 'No resolved tickets yet.'
            : 'No tickets yet. Create one to get started.'}
        </p>
      ) : (
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden" data-testid="tickets-list">
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
              {visibleTickets.map((t) => (
                <tr
                  key={t.id}
                  onClick={() => setSelectedId(t.id)}
                  data-testid="tickets-row"
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
                      <span className="inline-block mr-2">Order {orderRefFromId(t.related_order_id, t.related_order_receipt_number)}</span>
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
                    <span
                      data-testid="tickets-status-badge"
                      className={`inline-flex items-center px-2.5 py-1 rounded-full text-sm font-semibold border
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
          cachedTicket={tickets.find((t) => String(t.id) === String(selectedId)) || null}
        />
      )}
    </div>
  );
}
