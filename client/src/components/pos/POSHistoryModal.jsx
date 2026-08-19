import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../../api/client';
import { useToast } from '../ui/Toast';
import POSConfirm from './POSConfirm';

const PHP = (n) =>
  `₱${Number(n).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const dateTime = (iso) => {
  const d = new Date(iso);
  const h = d.getHours();
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()} ` +
         `${h % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
};

const ACTION_BTN = `flex min-h-tablet items-center justify-center rounded-xl px-4 text-base font-bold
                    transition-colors duration-100 focus-visible:outline-none focus-visible:ring-2
                    focus-visible:ring-v2-accent disabled:cursor-not-allowed disabled:opacity-50`;

// Order history for the V2 POS. Only the three states V2 admits are ever fetched:
// Created (backend `pending`) and Cancelled — drafts stay hidden until they are
// finalized, and in_transit/completed/done are never requested, so they can never
// surface here (see proposal §2.1).
export default function POSHistoryModal({ onClose, onEdit, onReprint, unprintedOnlyDefault = false }) {
  const { addToast } = useToast();

  const [orders, setOrders]   = useState([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery]     = useState('');
  const [unprintedOnly, setUnprintedOnly] = useState(unprintedOnlyDefault);
  const [busyId, setBusyId]   = useState(null);
  const [cancelTarget, setCancelTarget] = useState(null);
  const [cancelling, setCancelling]     = useState(false);

  const load = () => {
    setLoading(true);
    Promise.all([api.get('/orders?status=pending'), api.get('/orders?status=cancelled')])
      .then(([created, cancelled]) =>
        setOrders([...created, ...cancelled].sort(
          (a, b) => new Date(b.created_at) - new Date(a.created_at)
        ))
      )
      .catch((err) => addToast(err.message || 'Failed to load order history.', 'error'))
      .finally(() => setLoading(false));
  };

  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    // "Not printed" is scoped to today on purpose: every pre-V2 order in the backlog
    // is unprinted, and listing those would bury the ones still worth chasing.
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    return orders.filter((o) => {
      if (unprintedOnly && (
        o.status !== 'pending' ||
        o.pending_receipt_printed_at ||
        new Date(o.created_at) < midnight
      )) return false;
      if (!q) return true;
      return (o.customer_name || '').toLowerCase().includes(q) || String(o.id).includes(q);
    });
  }, [orders, query, unprintedOnly]);

  const withFullOrder = async (id, run) => {
    setBusyId(id);
    try {
      run(await api.get(`/orders/${id}`));
    } catch (err) {
      addToast(err.message || 'Failed to load the order.', 'error');
    } finally {
      setBusyId(null);
    }
  };

  const confirmCancel = async () => {
    setCancelling(true);
    try {
      await api.post(`/orders/${cancelTarget.id}/status`, { status: 'cancelled' });
      addToast(`Order #${cancelTarget.id} cancelled — stock restored.`, 'success');
      setCancelTarget(null);
      load();
    } catch (err) {
      addToast(err.message || 'Failed to cancel the order.', 'error');
    } finally {
      setCancelling(false);
    }
  };

  return (
    <>
      <div
        className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-4"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pos-history-title"
        onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      >
        <div className="flex h-[92vh] w-full max-w-4xl flex-col rounded-2xl border border-v2-border bg-v2-surface shadow-2xl">
          {/* Header */}
          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-v2-border px-5 py-4">
            <h2 id="pos-history-title" className="text-2xl font-bold text-v2-text">🕘 Order History</h2>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close order history"
              className="flex h-12 w-12 items-center justify-center rounded-xl text-xl text-v2-muted
                         hover:bg-v2-raised hover:text-v2-text focus-visible:outline-none
                         focus-visible:ring-2 focus-visible:ring-v2-accent"
            >
              ✕
            </button>
          </div>

          {/* Filters */}
          <div className="shrink-0 space-y-3 border-b border-v2-border px-5 py-4">
            <div>
              <label htmlFor="pos-history-search" className="block text-sm font-bold uppercase tracking-wide text-v2-muted">
                Search by customer or order number
              </label>
              <input
                id="pos-history-search"
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                autoComplete="off"
                className="mt-1 h-14 w-full rounded-xl border border-v2-border bg-v2-bg px-4 text-lg text-v2-text
                           placeholder:text-slate-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-v2-accent"
              />
            </div>
            <button
              type="button"
              onClick={() => setUnprintedOnly((v) => !v)}
              aria-pressed={unprintedOnly}
              className={`${ACTION_BTN} ${unprintedOnly
                ? 'bg-amber-500 text-amber-950 hover:bg-amber-400'
                : 'bg-v2-raised text-v2-text hover:bg-v2-border'}`}
            >
              ⚠️ Today, not printed only
            </button>
          </div>

          {/* Rows */}
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            {loading ? (
              <p className="py-10 text-center text-lg text-v2-muted">Loading orders…</p>
            ) : visible.length === 0 ? (
              <p className="py-10 text-center text-lg text-v2-muted">No orders to show.</p>
            ) : (
              <ul className="space-y-3">
                {visible.map((o) => {
                  const cancelled = o.status === 'cancelled';
                  const printed   = Boolean(o.pending_receipt_printed_at);
                  return (
                    <li
                      key={o.id}
                      className="rounded-xl border border-v2-border bg-v2-bg p-3"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-lg font-bold text-v2-text">
                            #{o.id} · {o.customer_name}
                          </p>
                          <p className="text-base text-v2-muted">
                            {dateTime(o.created_at)} · {o.order_type === 'pickup' ? '🏪 Pickup' : '🚚 Delivery'}
                          </p>
                          <div className="mt-2 flex flex-wrap gap-2">
                            <span className={`rounded-lg px-2 py-1 text-sm font-bold ${cancelled
                              ? 'bg-red-500/15 text-red-200'
                              : 'bg-emerald-500/15 text-emerald-200'}`}>
                              {cancelled ? '🚫 Cancelled' : '✅ Created'}
                            </span>
                            {!cancelled && (
                              <span className={`rounded-lg px-2 py-1 text-sm font-bold ${printed
                                ? 'bg-emerald-500/15 text-emerald-200'
                                : 'bg-amber-500/15 text-amber-200'}`}>
                                {printed ? '🖨️ Printed' : '⚠️ NOT PRINTED'}
                              </span>
                            )}
                          </div>
                        </div>

                        <p className="text-right text-xl font-black tabular-nums text-v2-text">
                          {PHP(Number(o.total_amount) + Number(o.adjustment || 0))}
                        </p>
                      </div>

                      <div className="mt-3 flex flex-wrap gap-2">
                        <button
                          type="button"
                          disabled={cancelled || busyId === o.id}
                          onClick={() => withFullOrder(o.id, onEdit)}
                          className={`${ACTION_BTN} bg-amber-500 text-amber-950 hover:bg-amber-400`}
                        >
                          ✏️ Edit
                        </button>
                        <button
                          type="button"
                          disabled={cancelled || busyId === o.id}
                          onClick={() => withFullOrder(o.id, onReprint)}
                          className={`${ACTION_BTN} bg-v2-accent-strong text-white hover:bg-sky-500`}
                        >
                          🖨️ Reprint
                        </button>
                        <button
                          type="button"
                          disabled={cancelled || busyId === o.id}
                          onClick={() => setCancelTarget(o)}
                          className={`${ACTION_BTN} bg-red-700 text-white hover:bg-red-600`}
                        >
                          🚫 Cancel
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <p className="shrink-0 border-t border-v2-border px-5 py-3 text-sm text-v2-muted">
            Totals here are the saved goods total plus any adjustment. The bottle deposit is added on
            the ticket and the receipt only.
          </p>
        </div>
      </div>

      {cancelTarget && (
        <POSConfirm
          title={`Cancel order #${cancelTarget.id}?`}
          confirmLabel="Yes, cancel the order"
          cancelLabel="Keep it"
          danger
          loading={cancelling}
          onConfirm={confirmCancel}
          onClose={() => setCancelTarget(null)}
        >
          This voids the order for <strong className="text-v2-text">{cancelTarget.customer_name}</strong> and
          puts the stock back. It cannot be undone.
        </POSConfirm>
      )}
    </>
  );
}
