import React, { useEffect, useState, useCallback } from 'react';
import { useRefreshListener } from '../../offline/refresh';
import { api } from '../../api/client';
import { useToast } from '../../components/ui/Toast';
import Page, { SECTION_GAP } from '../../components/ui/Page';
import PageHeader from '../../components/ui/PageHeader';
import { ChipRow, Chip } from '../../components/ui/ChipRow';
import ListCard from '../../components/ui/ListCard';
import { TicketStatusBadge } from '../../components/ui/Badge';
import { formatSignedPeso } from '../../utils/money';
import Spinner from '../../components/ui/Spinner';
import OfflineBanner from '../../components/ui/OfflineBanner';
import TicketFormModal from './TicketFormModal';
import TicketDetailPanel from './TicketDetailPanel';
import { orderRefFromId, keepRefsWhole } from '../../utils/orderRef';
import { loadWithCache, TICKETS_CACHE } from '../../offline/backOfficeCache.js';
import { checkIsOnline } from '../../offline/status.js';

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
  const load = useCallback(({ silent = false } = {}) => {
    if (!silent) setLoading(true);
    return loadWithCache(TICKETS_CACHE, () => api.get('/tickets'))
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
      .finally(() => { if (!silent) setLoading(false); });
  }, [addToast]);

  useEffect(() => { load(); }, [load]);

  // Pull-down / re-tapping the menu item: reload quietly behind the rows on screen.
  useRefreshListener(() => load({ silent: true }));

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

  // Money in a list that mixes credits and debits (design standard Q15): "+₱120.00" /
  // "−₱135.00", red for money owed, never split across lines.
  const amountText = (t) => (
    <span className={`font-semibold tabular-nums whitespace-nowrap ${Number(t.amount) < 0 ? 'text-red-700' : 'text-green-800'}`}>
      {formatSignedPeso(t.amount)}
    </span>
  );
  const fmtCreated = (t) => new Date(t.created_at).toLocaleDateString('en-PH', {
    year: 'numeric', month: 'short', day: 'numeric',
  });

  return (
    <Page>
      <PageHeader
        title="Tickets"
        primary={{
          label: '+ New Ticket',
          onClick: () => setCreating(true),
          disabled: mutationsBlocked,
        }}
      />
      {mutationsBlocked && (
        <p className="-mt-2 mb-4 text-sm text-slate-600">Needs a connection — new tickets can&apos;t be raised offline.</p>
      )}

      {fromCache && <OfflineBanner cachedAt={cachedAt} />}

      {/* ── Status filter — the same chips as every other list (design standard Q4) ── */}
      <ChipRow label="Ticket status" className={SECTION_GAP}>
        {STATUS_OPTS.map((opt) => (
          <Chip
            key={opt.value}
            selected={statusFilter === opt.value}
            onClick={() => setStatusFilter(opt.value)}
            data-testid={`tickets-filter-${opt.value}`}
          >
            {opt.label}
          </Chip>
        ))}
      </ChipRow>

      {/* ── List ─────────────────────────────────────────────────── */}
      {loading ? (
        <div className="flex items-center justify-center h-64">
          <Spinner size="lg" />
        </div>
      ) : visibleTickets.length === 0 ? (
        <p className="text-center text-slate-500 text-base py-20">
          {statusFilter === 'pending'
            ? 'No open tickets. All clear!'
            : statusFilter === 'resolved'
            ? 'No resolved tickets yet.'
            : 'No tickets yet. Create one to get started.'}
        </p>
      ) : (
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden" data-testid="tickets-list">
          {/* Phone + upright-tablet cards (D5, Q1). The status badge's data-testid lives
              ONLY here (not on the table's copy below) because
              e2e/appium/tests/tickets.test.mjs reads its text with getText(), which
              returns "" for a display:none element — duplicating the testid onto the
              hidden table row would make that assertion fail on a phone emulator. */}
          <div className="lg:hidden divide-y divide-slate-200">
            {visibleTickets.map((t) => (
              <ListCard
                key={t.id}
                onClick={() => setSelectedId(t.id)}
                data-testid="tickets-row"
                title={(
                  <>
                    <span className="block font-mono text-sm font-normal text-slate-500">#{t.id}</span>
                    {keepRefsWhole(t.title)}
                  </>
                )}
                titleRight={t.amount != null && amountText(t)}
                meta={t.description ? <span className="line-clamp-1">{keepRefsWhole(t.description)}</span> : null}
                badges={<TicketStatusBadge status={t.status} data-testid="tickets-status-badge" />}
              />
            ))}
          </div>

          <table className="hidden lg:table w-full text-base">
            <thead>
              <tr className="bg-slate-50 text-slate-600 text-sm uppercase tracking-wider border-b border-slate-400">
                <th className="text-left px-4 lg:px-5 py-3 font-semibold">#</th>
                <th className="text-left px-4 lg:px-5 py-3 font-semibold">Title</th>
                <th className="text-left px-4 lg:px-5 py-3 font-semibold hidden lg:table-cell">Related</th>
                <th className="text-right px-4 lg:px-5 py-3 font-semibold">Amount</th>
                <th className="text-left px-4 lg:px-5 py-3 font-semibold">Status</th>
                <th className="text-left px-4 lg:px-5 py-3 font-semibold hidden lg:table-cell">Date</th>
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
                  <td className="px-4 lg:px-5 py-4 text-slate-600 font-mono text-sm">
                    #{t.id}
                  </td>
                  <td className="px-4 lg:px-5 py-4">
                    <p className="font-semibold text-slate-900">{keepRefsWhole(t.title)}</p>
                    <p className="text-sm text-slate-600 mt-0.5 line-clamp-1">{keepRefsWhole(t.description)}</p>
                  </td>
                  <td className="px-4 lg:px-5 py-4 text-sm text-slate-600 hidden lg:table-cell">
                    {t.related_order_id && (
                      <span className="inline-block mr-2 whitespace-nowrap">Order {orderRefFromId(t.related_order_id, t.related_order_receipt_number)}</span>
                    )}
                    {t.personnel_name && (
                      <span className="inline-block">{t.personnel_name}</span>
                    )}
                    {!t.related_order_id && !t.personnel_name && '—'}
                  </td>
                  <td className="px-4 lg:px-5 py-4 text-right">
                    {t.amount != null ? amountText(t) : <span className="text-slate-500">—</span>}
                  </td>
                  <td className="px-4 lg:px-5 py-4">
                    <TicketStatusBadge status={t.status} />
                  </td>
                  <td className="px-4 lg:px-5 py-4 text-sm text-slate-600 hidden lg:table-cell tabular-nums whitespace-nowrap">
                    {fmtCreated(t)}
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
    </Page>
  );
}
