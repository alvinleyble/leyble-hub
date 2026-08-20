import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../../api/client';
import { useToast } from '../ui/Toast';
import POSConfirm from './POSConfirm';
import POSListModal, { LIST_ACTION_BTN, LIST_ROW, listDateTime } from './POSListModal';
import OrderViewModal from './OrderViewModal';

const PHP = (n) =>
  `₱${Number(n).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const DATE_PRESETS = [
  { id: 'all', label: 'All Time' },
  { id: 'today', label: 'Today' },
  { id: 'yesterday', label: 'Yesterday' },
  { id: '7d', label: 'Last 7 Days' },
];

const datePill = (active) =>
  `flex min-h-tablet items-center justify-center rounded-xl px-4 text-base font-semibold transition-colors duration-100
   focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-v2-accent
   ${active
     ? 'bg-v2-pill-active text-v2-pill-text border border-v2-pill-border shadow-sm'
     : 'bg-v2-raised text-v2-muted hover:bg-v2-border hover:text-v2-text'}`;

// Order history for the V2 POS. Only the states V2 admits are ever fetched: Created
// (backend `pending`) and Cancelled. Drafts have their own popup (POSDraftsModal), and
// in_transit/completed/done are never requested, so they can never surface here
// (see proposal §2.1).
export default function POSHistoryModal({ onClose, onEdit, onReprint, onChanged, products = [] }) {
  const { addToast } = useToast();

  const [orders, setOrders]       = useState([]);
  const [loading, setLoading]     = useState(true);
  const [query, setQuery]         = useState('');
  const [dateFilter, setDateFilter] = useState('all');
  const [unprintedOnly, setUnprintedOnly] = useState(false);
  const [busyId, setBusyId]       = useState(null);
  const [viewOrder, setViewOrder]       = useState(null);   // read-only 👁️ View
  const [cancelTarget, setCancelTarget] = useState(null);
  const [cancelling, setCancelling]     = useState(false);
  const [bulkPrompt, setBulkPrompt]     = useState(false);
  const [bulkBusy, setBulkBusy]         = useState(false);

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
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfYesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    const startOf7DaysAgo = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6);

    return orders.filter((o) => {
      const createdAt = new Date(o.created_at);

      if (dateFilter === 'today') {
        if (createdAt < startOfToday) return false;
      } else if (dateFilter === 'yesterday') {
        if (createdAt < startOfYesterday || createdAt >= startOfToday) return false;
      } else if (dateFilter === '7d') {
        if (createdAt < startOf7DaysAgo) return false;
      }

      // "Not printed" filter composes with whichever date preset is active
      // (Today, Yesterday, Last 7 Days, or All Time).
      if (unprintedOnly && (
        o.status !== 'pending' ||
        o.pending_receipt_printed_at
      )) return false;

      if (!q) return true;
      return (o.customer_name || '').toLowerCase().includes(q) || String(o.id).includes(q);
    });
  }, [orders, query, unprintedOnly, dateFilter]);

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

  // Every row the "not printed only" filter is showing — the set the bulk
  // mark-as-printed acts on.
  const unprintedVisible = useMemo(
    () => visible.filter((o) => o.status === 'pending' && !o.pending_receipt_printed_at),
    [visible]
  );

  // Tag a whole filtered batch as printed in one go. Same write Reprint's auto-tag makes
  // (POST /orders/:id/receipt-printed), just batched — nothing is sent to the printer.
  const markAllPrinted = async () => {
    setBulkBusy(true);
    const results = await Promise.allSettled(
      unprintedVisible.map((o) => api.post(`/orders/${o.id}/receipt-printed`, { phase: 'pending' }))
    );
    const done   = results.filter((r) => r.status === 'fulfilled').length;
    const failed = results.length - done;
    addToast(
      failed
        ? `Marked ${done} order${done === 1 ? '' : 's'} as printed, ${failed} failed.`
        : `${done} order${done === 1 ? '' : 's'} marked as printed.`,
      failed ? 'error' : 'success'
    );
    setBulkBusy(false);
    setBulkPrompt(false);
    load();
    onChanged?.();
  };

  const confirmCancel = async () => {
    setCancelling(true);
    try {
      await api.post(`/orders/${cancelTarget.id}/status`, { status: 'cancelled' });
      addToast(`Order #${cancelTarget.id} cancelled — stock restored.`, 'success');
      setCancelTarget(null);
      load();
      onChanged?.();
    } catch (err) {
      addToast(err.message || 'Failed to cancel the order.', 'error');
    } finally {
      setCancelling(false);
    }
  };

  return (
    <>
      <POSListModal
        id="pos-history"
        title="🕘 Order History"
        closeLabel="Close order history"
        searchLabel="Search by customer or order number"
        query={query}
        onQueryChange={setQuery}
        filters={
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Date range filter">
              {DATE_PRESETS.map((preset) => {
                const active = dateFilter === preset.id;
                return (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => setDateFilter(preset.id)}
                    aria-pressed={active}
                    className={datePill(active)}
                  >
                    {preset.label}
                  </button>
                );
              })}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => setUnprintedOnly((v) => !v)}
                aria-pressed={unprintedOnly}
                className={`${LIST_ACTION_BTN} ${unprintedOnly
                  ? 'bg-amber-500 text-amber-950 hover:bg-amber-400'
                  : 'bg-v2-raised text-v2-text hover:bg-v2-border'}`}
              >
                ⚠️ Not printed only
              </button>
              {unprintedOnly && unprintedVisible.length > 0 && (
                <button
                  type="button"
                  onClick={() => setBulkPrompt(true)}
                  className={`${LIST_ACTION_BTN} bg-emerald-600 text-white hover:bg-emerald-500`}
                >
                  ✅ Mark all {unprintedVisible.length} as printed
                </button>
              )}
            </div>
          </div>
        }
        loading={loading}
        isEmpty={visible.length === 0}
        footnote="Totals here are the saved goods total plus any adjustment — the same goods-only figure the order panel and the receipt show."
        onClose={onClose}
      >
        {visible.map((o) => {
          const cancelled = o.status === 'cancelled';
          const printed   = Boolean(o.pending_receipt_printed_at);
          return (
            <li key={o.id} className={LIST_ROW}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-lg font-bold text-v2-text">
                    #{o.id} · {o.customer_name}
                  </p>
                  <p className="text-base text-v2-muted">
                    {listDateTime(o.created_at)} · {o.order_type === 'pickup' ? '🏪 Pickup' : '🚚 Delivery'}
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
                  disabled={busyId === o.id}
                  onClick={() => withFullOrder(o.id, setViewOrder)}
                  className={`${LIST_ACTION_BTN} bg-v2-raised text-v2-text hover:bg-v2-border`}
                >
                  👁️ View
                </button>
                <button
                  type="button"
                  disabled={cancelled || busyId === o.id}
                  onClick={() => withFullOrder(o.id, onEdit)}
                  className={`${LIST_ACTION_BTN} bg-amber-500 text-amber-950 hover:bg-amber-400`}
                >
                  ✏️ Edit
                </button>
                <button
                  type="button"
                  disabled={cancelled || busyId === o.id}
                  onClick={() => withFullOrder(o.id, onReprint)}
                  className={`${LIST_ACTION_BTN} bg-v2-accent-strong text-white hover:bg-v2-accent`}
                >
                  🖨️ Reprint
                </button>
                <button
                  type="button"
                  disabled={cancelled || busyId === o.id}
                  onClick={() => setCancelTarget(o)}
                  className={`${LIST_ACTION_BTN} bg-red-700 text-white hover:bg-red-600`}
                >
                  🚫 Cancel
                </button>
              </div>
            </li>
          );
        })}
      </POSListModal>

      {/* Read-only view. History stays mounted behind it, so ↩️ Back returns to the list. */}
      {viewOrder && (
        <OrderViewModal
          order={viewOrder}
          products={products}
          onClose={() => setViewOrder(null)}
        />
      )}

      {bulkPrompt && (
        <POSConfirm
          title={`Mark ${unprintedVisible.length} order${unprintedVisible.length === 1 ? '' : 's'} as printed?`}
          confirmLabel={`Yes, mark ${unprintedVisible.length} as printed`}
          cancelLabel="Not now"
          loading={bulkBusy}
          onConfirm={markAllPrinted}
          onClose={() => setBulkPrompt(false)}
        >
          This records a printed receipt for every order in the list below — it does not send
          anything to the printer. Use it when the receipts were printed but never tagged.
        </POSConfirm>
      )}

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
