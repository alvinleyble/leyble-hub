import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../../api/client';
import { useToast } from '../ui/Toast';
import POSConfirm from './POSConfirm';
import POSListModal, { LIST_ACTION_BTN, LIST_ROW, listDateTime } from './POSListModal';
import OrderViewModal from './OrderViewModal';
import { orderRef } from '../../utils/orderRef';
import { V25_OFFLINE_CORE } from '../../config/features.js';
import {
  listReceipts, putReceipt, getReceipt, pruneReceipts, queueReceiptPrinted,
  isOrderUnsynced, discardLocalOrder,
} from '../../offline/index.js';
import { getPossibleDoubleOrderIds } from '../../utils/duplicateOrders.js';

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

  const load = async () => {
    setLoading(true);
    let dateParams = '';
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfYesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    const startOf7DaysAgo = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6);

    if (dateFilter === 'today') {
      dateParams = `&from_date=${encodeURIComponent(startOfToday.toISOString())}`;
    } else if (dateFilter === 'yesterday') {
      dateParams = `&from_date=${encodeURIComponent(startOfYesterday.toISOString())}&to_date=${encodeURIComponent(startOfToday.toISOString())}`;
    } else if (dateFilter === '7d' || dateFilter === 'week') {
      dateParams = `&from_date=${encodeURIComponent(startOf7DaysAgo.toISOString())}`;
    }

    if (!V25_OFFLINE_CORE) {
      Promise.all([
        api.get(`/orders?status=pending${dateParams}`),
        api.get(`/orders?status=cancelled${dateParams}`),
      ])
        .then(([created, cancelled]) =>
          setOrders([...created, ...cancelled].sort(
            (a, b) => new Date(b.created_at) - new Date(a.created_at)
          ))
        )
        .catch((err) => addToast(err.message || 'Failed to load order history.', 'error'))
        .finally(() => setLoading(false));
      return;
    }

    // V2.5 Offline Core path: read local 30-day receipts first (D9)
    const localReceipts = await listReceipts().catch(() => []);

    try {
      const [created, cancelled] = await Promise.all([
        api.get(`/orders?status=pending${dateParams}`),
        api.get(`/orders?status=cancelled${dateParams}`),
      ]);
      const serverOrders = [...created, ...cancelled];

      for (const ord of serverOrders) {
        if (ord.receipt_number) {
          await putReceipt(ord).catch(() => {});
        }
      }
      await pruneReceipts().catch(() => {});

      const serverReceiptNums = new Set(serverOrders.map((o) => o.receipt_number).filter(Boolean));
      const serverIds = new Set(serverOrders.map((o) => o.id).filter(Boolean));

      const unsyncedLocals = localReceipts.filter((lr) => {
        if (lr.receipt_number && serverReceiptNums.has(lr.receipt_number)) return false;
        if (lr.id && serverIds.has(lr.id)) return false;
        return true;
      });

      const merged = [...serverOrders, ...unsyncedLocals].sort(
        (a, b) => new Date(b.created_at) - new Date(a.created_at)
      );
      setOrders(merged);
    } catch (err) {
      // Offline / blind: read from local 30-day history (D9)
      setOrders(localReceipts);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [dateFilter]); // eslint-disable-line react-hooks/exhaustive-deps

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
      } else if (dateFilter === '7d' || dateFilter === 'week') {
        if (createdAt < startOf7DaysAgo) return false;
      }

      // "Not printed" filter composes with whichever date preset is active
      // (Today, Yesterday, Last 7 Days, or All Time).
      if (unprintedOnly && (
        o.status !== 'pending' ||
        o.pending_receipt_printed_at
      )) return false;

      if (!q) return true;
      return (
        (o.customer_name || '').toLowerCase().includes(q) ||
        String(o.id || '').includes(q) ||
        String(o.receipt_number || '').toLowerCase().includes(q)
      );
    });
  }, [orders, query, unprintedOnly, dateFilter]);

  // D6 — the accepted double-print risk, surfaced: same shape D4 already established
  // for possible-duplicate customers (utils/duplicateOrders.js).
  const possibleDoubleIds = useMemo(
    () => (V25_OFFLINE_CORE ? getPossibleDoubleOrderIds(orders) : new Set()),
    [orders]
  );

  const withFullOrder = async (orderOrId, run) => {
    const isObj = typeof orderOrId === 'object' && orderOrId !== null;
    const targetId = isObj ? (orderOrId.id || orderOrId.receipt_number) : orderOrId;
    const targetReceiptNo = isObj ? orderOrId.receipt_number : (String(orderOrId).includes('-') ? String(orderOrId) : null);

    setBusyId(targetId);
    try {
      if (V25_OFFLINE_CORE) {
        if (isObj && Array.isArray(orderOrId.items) && orderOrId.items.length > 0) {
          run(orderOrId);
          return;
        }
        if (targetReceiptNo) {
          const local = await getReceipt(targetReceiptNo);
          if (local && Array.isArray(local.items) && local.items.length > 0) {
            run(local);
            return;
          }
        }
        try {
          const full = await api.get(`/orders/${targetId}`);
          if (full.receipt_number) await putReceipt(full).catch(() => {});
          run(full);
          return;
        } catch (err) {
          if (targetReceiptNo) {
            const local = await getReceipt(targetReceiptNo);
            if (local) { run(local); return; }
          }
          throw err;
        }
      } else {
        const id = isObj ? orderOrId.id : orderOrId;
        run(await api.get(`/orders/${id}`));
      }
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

  // Tag a whole filtered batch as printed in one go (D14).
  const markAllPrinted = async () => {
    setBulkBusy(true);
    let done = 0;
    let failed = 0;
    try {
      for (const o of unprintedVisible) {
        try {
          if (V25_OFFLINE_CORE) {
            await queueReceiptPrinted({ order: o, phase: 'pending' });
            done++;
          } else {
            await api.post(`/orders/${o.id}/receipt-printed`, { phase: 'pending' });
            done++;
          }
        } catch (_) {
          failed++;
        }
      }
      addToast(
        failed
          ? `Marked ${done} order${done === 1 ? '' : 's'} as printed, ${failed} failed.`
          : `${done} order${done === 1 ? '' : 's'} marked as printed.`,
        failed ? 'error' : 'success'
      );
    } finally {
      setBulkBusy(false);
      setBulkPrompt(false);
      load();
      onChanged?.();
    }
  };

  const confirmCancel = async () => {
    setCancelling(true);
    try {
      if (V25_OFFLINE_CORE && cancelTarget?.receipt_number && (await isOrderUnsynced(cancelTarget.receipt_number))) {
        await discardLocalOrder(cancelTarget.receipt_number);
        addToast(`Order ${orderRef(cancelTarget)} discarded.`, 'success');
      } else {
        await api.post(`/orders/${cancelTarget.id || cancelTarget.receipt_number}/status`, { status: 'cancelled' });
        addToast(`Order ${orderRef(cancelTarget)} cancelled — stock restored.`, 'success');
      }
      setCancelTarget(null);
      setViewOrder(null);   // back to the list, which reloads with the new status
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
        footnote={
          <div className="space-y-1">
            {orders.length >= 200 && (
              <p className="text-amber-300">
                Showing the 200 most recent — narrow the date range or search to see older orders.
              </p>
            )}
            <p>
              Totals here are the saved goods total plus any adjustment — the same goods-only figure the order panel and the receipt show.
            </p>
          </div>
        }
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
                    {orderRef(o)} · {o.customer_name}
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
                    {!cancelled && possibleDoubleIds.has(o.id) && (
                      <button
                        type="button"
                        onClick={() => withFullOrder(o, setViewOrder)}
                        className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/20 px-2.5 py-0.5 text-xs font-bold text-amber-300 hover:bg-amber-500/30 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-v2-accent"
                        title="Same customer, channel and total as another order — possibly the same sale printed twice. Click to review."
                      >
                        ⚠️ possible double
                      </button>
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
                  disabled={busyId === (o.id || o.receipt_number)}
                  onClick={() => withFullOrder(o, setViewOrder)}
                  className={`${LIST_ACTION_BTN} bg-v2-raised text-v2-text hover:bg-v2-border`}
                >
                  👁️ View
                </button>
                <button
                  type="button"
                  disabled={cancelled || busyId === (o.id || o.receipt_number)}
                  onClick={() => withFullOrder(o, onEdit)}
                  className={`${LIST_ACTION_BTN} bg-amber-500 text-amber-950 hover:bg-amber-400`}
                >
                  ✏️ Edit
                </button>
                <button
                  type="button"
                  disabled={cancelled || busyId === (o.id || o.receipt_number)}
                  onClick={() => withFullOrder(o, onReprint)}
                  className={`${LIST_ACTION_BTN} bg-v2-accent-strong text-white hover:bg-v2-accent`}
                >
                  🖨️ Reprint
                </button>
                <button
                  type="button"
                  disabled={cancelled || busyId === (o.id || o.receipt_number)}
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

      {/* The open order, with the same actions its row offers. History stays mounted
          behind it, so ↩️ Back returns to the list. */}
      {viewOrder && (
        <OrderViewModal
          order={viewOrder}
          products={products}
          busy={busyId === viewOrder.id || cancelling}
          onClose={() => setViewOrder(null)}
          onEdit={(o) => { setViewOrder(null); onEdit(o); }}
          onReprint={(o) => { setViewOrder(null); onReprint(o); }}
          onCancel={(o) => setCancelTarget(o)}
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
          zClass={viewOrder ? 'z-[70]' : 'z-50'}
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
