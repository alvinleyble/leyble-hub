import React, { useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../../api/client';
import { useToast } from '../../components/ui/Toast';
import Button from '../../components/ui/Button';
import { Skeleton, SkeletonGroup } from '../../components/ui/Skeleton';
import Modal from '../../components/ui/Modal';
import { Capacitor } from '@capacitor/core';
import OrderCreateModal from './OrderCreateModal';
import OrderCloseForm from './OrderCloseForm';
import { usePrintReceipt } from './usePrintReceipt';
import PrinterPicker from './PrinterPicker';
import { orderRef } from '../../utils/orderRef';
import {
  getReceipt, putOrderSnapshot, updateLocalOrder, transitionLocalOrder,
  canTransitionOffline, isOrderUnsynced,
} from '../../offline/index.js';
import { handleStaleOrderWrite, orderChangedInEvent } from './orderConcurrency.js';

const IS_NATIVE = Capacitor.isNativePlatform();

// Slice 3.2 — an order can now arrive from a background sync as well as from a live
// fetch, and a snapshot written mid-outage can be missing a numeric field the page
// would otherwise render as "₱NaN". Coerce once, here, rather than sprinkling
// `|| 0` through the arithmetic below.
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const PHP = (n) =>
  `₱${num(n).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const fmtDate = (d, opts = { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) =>
  d ? new Date(d).toLocaleString('en-PH', opts) : null;

const STATUS = {
  pending:    { label: 'Pending',     color: 'bg-blue-100 text-blue-800 border-blue-300' },
  in_transit: { label: 'In Transit',  color: 'bg-amber-100 text-amber-800 border-amber-300' },
  completed:  { label: 'Delivered',   color: 'bg-green-100 text-green-800 border-green-300' },
  done:       { label: 'Closed',      color: 'bg-slate-100 text-slate-600 border-slate-200' },
  cancelled:  { label: 'Cancelled',   color: 'bg-red-100 text-red-700 border-red-300' },
};

const ROLE_COLOR = {
  Driver: 'bg-purple-100 text-purple-800 border-purple-300',
  Helper: 'bg-teal-100 text-teal-800 border-teal-300',
};

const INPUT = `w-full px-4 py-2.5 border border-slate-300 rounded-lg text-base text-slate-900
               focus:outline-none focus:ring-2 focus:ring-blue-600`;

// Matches the loaded page's own section heights: back/print bar, the order header
// card (status badges, customer block, timestamps grid), the line-items table, and
// the totals footer — so the page doesn't jump once the real order lands.
function OrderDetailSkeleton() {
  return (
    <SkeletonGroup label="Loading order" className="p-6 max-w-3xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <Skeleton className="h-4 w-16" />
        <Skeleton className="h-8 w-28 rounded-lg" />
      </div>

      <div className="bg-white rounded-xl border border-slate-200 p-6 mb-4">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="space-y-2">
            <Skeleton className="h-3 w-14" />
            <Skeleton className="h-7 w-36" />
            <Skeleton className="h-3 w-28" />
          </div>
          <div className="flex items-center gap-2">
            <Skeleton className="h-6 w-20 rounded-full" />
            <Skeleton className="h-6 w-20 rounded-full" />
          </div>
        </div>

        <div className="mt-5 pt-5 border-t border-slate-300 space-y-2">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-4 w-44" />
          <Skeleton className="h-3 w-32" />
        </div>

        <div className="mt-4 pt-4 border-t border-slate-300 grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="space-y-1.5">
              <Skeleton className="h-3 w-14" />
              <Skeleton className="h-3 w-20" />
            </div>
          ))}
        </div>
      </div>

      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden mb-4">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-slate-50 border-b border-slate-400">
              <th className="px-5 py-3"><Skeleton className="h-3 w-14" /></th>
              <th className="px-5 py-3"><Skeleton className="h-3 w-8 ml-auto" /></th>
              <th className="px-4 py-3 hidden sm:table-cell"><Skeleton className="h-3 w-14 ml-auto" /></th>
              <th className="px-4 py-3 hidden sm:table-cell"><Skeleton className="h-3 w-12 ml-auto" /></th>
              <th className="px-5 py-3"><Skeleton className="h-3 w-12 ml-auto" /></th>
            </tr>
          </thead>
          <tbody>
            {[0, 1, 2].map((i) => (
              <tr key={i} className="border-t border-slate-300">
                <td className="px-5 py-3"><Skeleton className="h-4 w-28" /></td>
                <td className="px-5 py-3"><Skeleton className="h-4 w-10 ml-auto" /></td>
                <td className="px-4 py-3 hidden sm:table-cell"><Skeleton className="h-4 w-14 ml-auto" /></td>
                <td className="px-4 py-3 hidden sm:table-cell"><Skeleton className="h-4 w-14 ml-auto" /></td>
                <td className="px-5 py-3"><Skeleton className="h-4 w-16 ml-auto" /></td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-slate-400 bg-slate-50">
              <td colSpan={4} className="px-5 py-4 text-right"><Skeleton className="h-4 w-24 ml-auto" /></td>
              <td className="px-5 py-4"><Skeleton className="h-6 w-24 ml-auto" /></td>
            </tr>
          </tfoot>
        </table>
      </div>

      <div className="bg-white rounded-xl border border-slate-200 p-5">
        <Skeleton className="h-3 w-24 mb-2" />
        <Skeleton className="h-4 w-16" />
      </div>
    </SkeletonGroup>
  );
}

export default function OrderDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { addToast } = useToast();
  const [order, setOrder]           = useState(null);
  const [loading, setLoading]       = useState(true);
  const [notFound, setNotFound]     = useState(false);
  // G27 — true while this order only exists in local receipt history (D9), not yet
  // drained to the server. Gates the "Waiting to sync" banner and which actions G28
  // allows offline.
  const [unsynced, setUnsynced]     = useState(false);
  // Slice 3.2 — true when this page is showing the device's own synced snapshot
  // because the server could not be reached. Distinct from `unsynced` above: the order
  // may be perfectly well known to the server, we just cannot ask it right now.
  const [fromLocalSnapshot, setFromLocalSnapshot] = useState(false);
  const [transitioning, setTransitioning] = useState(false);
  const [confirmAction, setConfirmAction] = useState(null);
  const [editing, setEditing]       = useState(false);
  const [closing, setClosing]       = useState(false);
  // A delta that lands while the operator is forming an edit is held beside the form,
  // never merged into or substituted for it. Closing the edit adopts this snapshot;
  // saving against the old revision is still authoritatively rejected by the server.
  const [pendingRemoteOrder, setPendingRemoteOrder] = useState(null);

  // Adjustment form state
  const [adjExpanded, setAdjExpanded] = useState(false);
  const [adjValue, setAdjValue]       = useState('');
  const [adjReason, setAdjReason]     = useState('');
  const [savingAdj, setSavingAdj]     = useState(false);

  // Live, in-progress bottle-return entries — lifted up from OrderCloseForm so its
  // breakdown math can read them. Keyed by order_items.id.
  const [returnCounts, setReturnCounts] = useState({});
  const [returnsDirty, setReturnsDirty] = useState(false);

  const {
    handlePrint, printing,
    pickerVisible, pickerDevices, pickerLoading, pickerCurrent, printPending,
    savePrinter, scanWifi, testPrint, closePickerAndCancel, handleChangePrinter,
    twicePrompt, confirmTwice,
    printPrompt, taggingPrint, confirmPrintTag, cancelPrintTag,
  } = usePrintReceipt(order, returnCounts, setOrder);

  const adoptAuthoritativeOrder = useCallback((current) => {
    setOrder(current);
    setUnsynced(false);
    setFromLocalSnapshot(false);
    setAdjValue(Number(current.adjustment) ? String(current.adjustment) : '');
    setAdjReason(current.adjustment_reason || '');
    setAdjExpanded(Number(current.adjustment) !== 0);
    setReturnsDirty(false);
    putOrderSnapshot(current).catch(() => {});
  }, []);

  // G27 — silent background sync, zero spinner flashes. `silent` is used for the
  // re-read triggered by leyble:drain-complete: it must never touch `loading`, or
  // every background sync would flash the full-page spinner over a screen the
  // operator is actively looking at.
  const load = useCallback(({ silent = false } = {}) => {
    if (!silent) setLoading(true);
    api.get(`/orders/${id}`)
      .then((o) => {
        // ADR 0015 §4 — every order this device has ever SEEN is held in full, not just
        // the ones it created. The background sync is what makes the whole history
        // available, but writing the snapshot here too means the order the operator is
        // looking at right now is guaranteed current the moment the line drops.
        adoptAuthoritativeOrder(o);
      })
      .catch(async (err) => {
        // A 404 here can mean "never synced yet" (a receipt-numbered order the
        // server has no row for) just as easily as "genuinely doesn't exist" — and a
        // network failure (no err.status, same test outbox.js's drain uses) means we
        // simply cannot ask. Either way, fall back to the device's own 30-day
        // receipt history (D9) before giving up.
        const offlineOrMissing = err.status === 404 || !err.status;
        if (offlineOrMissing) {
          const local = await getReceipt(id).catch(() => null);
          if (local) {
            setOrder(local);
            // Slice 3.2 — "we read this from the device" and "this order has never
            // reached the server" stopped being the same thing the moment the device
            // began syncing the WHOLE history ahead of time. Reading a synced order
            // from local storage during an outage must NOT flag it unsynced: that flag
            // is what unlocks the offline status transitions, and ADR 0015 §5 allows
            // those only for orders no other tablet has seen. Ask the outbox, which is
            // the only thing that actually knows.
            setUnsynced(await isOrderUnsynced(local.receipt_number).catch(() => false));
            setFromLocalSnapshot(true);
            setAdjValue(Number(local.adjustment) ? String(local.adjustment) : '');
            setAdjReason(local.adjustment_reason || '');
            setAdjExpanded(Number(local.adjustment) !== 0);
            return;
          }
        }
        if (err.status === 404) setNotFound(true);
        else if (!silent) {
          const msg = err?.friendlyMessage || 'Failed to load order.';
          addToast(msg, 'error', { label: 'Retry', onClick: () => load() });
        }
      })
      .finally(() => { if (!silent) setLoading(false); });
  }, [id, addToast, adoptAuthoritativeOrder]);

  useEffect(() => { load(); }, [load]);

  // G27 — Silent Background Sync + Refresh Button. drainNotifier.js dispatches this once a background
  // drain has actually sent something; re-read quietly so an order that just synced
  // swaps to its server row and drops the "Waiting to sync" banner without anyone
  // asking and without a spinner. leyble:refresh triggers an active reload.
  useEffect(() => {
    const onDrainComplete = () => load({ silent: true });
    const onRefresh = () => load();
    const onOrdersChanged = (event) => {
      const current = orderChangedInEvent(order, event.detail);
      if (!current) return;
      if (editing || adjExpanded || returnsDirty || closing || confirmAction) {
        setPendingRemoteOrder(current);
        return;
      }
      adoptAuthoritativeOrder(current);
    };
    window.addEventListener('leyble:drain-complete', onDrainComplete);
    window.addEventListener('leyble:refresh', onRefresh);
    window.addEventListener('leyble:orders-changed', onOrdersChanged);
    return () => {
      window.removeEventListener('leyble:drain-complete', onDrainComplete);
      window.removeEventListener('leyble:refresh', onRefresh);
      window.removeEventListener('leyble:orders-changed', onOrdersChanged);
    };
  }, [load, order, editing, adjExpanded, returnsDirty, closing, confirmAction, adoptAuthoritativeOrder]);

  useEffect(() => {
    if (!pendingRemoteOrder || editing || adjExpanded || returnsDirty || closing || confirmAction) return;
    adoptAuthoritativeOrder(pendingRemoteOrder);
    setPendingRemoteOrder(null);
  }, [pendingRemoteOrder, editing, adjExpanded, returnsDirty, closing, confirmAction, adoptAuthoritativeOrder]);

  const items = Array.isArray(order?.items) ? order.items : [];
  const bottleItems = items.filter((i) => i?.requires_bottle_return && num(i.unit_deposit_fee) > 0);
  const bottleItemIds = bottleItems.map((i) => i.id).join(',');

  // Reset the in-progress bottle-return entries whenever the set of returnable items
  // changes (initial load, or items added/removed via editing) — otherwise stale
  // item ids could linger in returnCounts.
  useEffect(() => {
    if (!order || order.status !== 'completed' || bottleItems.length === 0) return;
    const counts = {};
    bottleItems.forEach((i) => {
      const stored = num(i.bottles_returned);
      const total  = num(i.quantity) * (num(i.units_per_case) || 1);
      counts[i.id] = String(stored > 0 ? stored : total);
    });
    setReturnCounts(counts);
    setReturnsDirty(false);
  }, [bottleItemIds, order?.status]);

  const transition = async () => {
    if (!confirmAction) return;
    setTransitioning(true);
    try {
      // ADR 0015 §5 — an order this tablet created and has NOT yet synced may move
      // through the fulfillment lifecycle offline: no other device has ever heard of
      // it, so there is no transition to race. Once it has synced this branch stops
      // applying (the buttons for it are disabled below), because the order is shared
      // state that moves central stock. transitionLocalOrder throws if the order
      // drained while this screen was open — fall through to the ordinary server POST
      // rather than losing the operator's action.
      if (unsynced && canTransitionOffline(order.status, confirmAction.newStatus)) {
        try {
          const updated = await transitionLocalOrder({ order, newStatus: confirmAction.newStatus });
          setOrder(updated);
          setConfirmAction(null);
          addToast(`Order ${confirmAction.label.toLowerCase()} — will sync when connected.`, 'success');
          return;
        } catch {
          // Already drained; the online path below is now the right one.
        }
      }

      const updated = await api.post(`/orders/${id}/status`, {
        status: confirmAction.newStatus,
        expected_status: order.status,
        revision: order.revision,
      });
      adoptAuthoritativeOrder(updated);
      setConfirmAction(null);
      addToast(`Order ${confirmAction.label.toLowerCase()}.`, 'success');
    } catch (err) {
      const stale = await handleStaleOrderWrite(err, {
        addToast,
        onCurrent: (current) => {
          setPendingRemoteOrder(null);
          adoptAuthoritativeOrder(current);
        },
      });
      if (!stale) addToast(err.message || 'Transition failed.', 'error');
      setConfirmAction(null);
    } finally {
      setTransitioning(false);
    }
  };

  const saveAdjustment = async () => {
    const adj = Number(adjValue);
    if (isNaN(adj)) { addToast('Enter a valid number.', 'error'); return; }
    if (adj !== 0 && !adjReason.trim()) { addToast('Adjustment reason is required.', 'error'); return; }
    setSavingAdj(true);
    try {
      // Round 3 Fix 4 — G28 already lets the rest of an unsynced order be edited in
      // place via Edit Order/updateLocalOrder; the adjustment shortcut here was the
      // one control left hard-disabled with no offline path of its own. Mirror
      // OrderCreateModal's same updateLocalOrder-then-fall-back-to-PATCH pattern:
      // rewrite the local receipt + queued outbox payload while unsynced, and fall
      // through to the ordinary server PATCH if it turns out the order already
      // drained (updateLocalOrder throws once its outbox record is gone).
      if (unsynced) {
        try {
          const updated = await updateLocalOrder({
            order,
            items: items,
            notes: order.notes,
            adjustment: { value: adj, reason: adjReason.trim() },
            // This widget only touches the adjustment — carry the order's own
            // delivery fee through unchanged rather than letting updateLocalOrder's
            // default (null) silently waive it.
            deliveryFeeCharged: order.delivery_fee_charged,
            personnel: null,
          });
          setOrder(updated);
          setAdjValue(Number(updated.adjustment) ? String(updated.adjustment) : '');
          setAdjReason(updated.adjustment_reason || '');
          addToast('Adjustment saved.', 'success');
          return;
        } catch {
          // Already drained — fall through to the online PATCH below.
        }
      }

      const updated = await api.patch(`/orders/${id}/adjustment`, {
        adjustment: adj,
        adjustment_reason: adjReason.trim(),
        revision: order.revision,
      });
      adoptAuthoritativeOrder(updated);
      setAdjValue(Number(updated.adjustment) ? String(updated.adjustment) : '');
      setAdjReason(updated.adjustment_reason || '');
      addToast('Adjustment saved.', 'success');
    } catch (err) {
      const stale = await handleStaleOrderWrite(err, {
        addToast,
        onCurrent: (current) => {
          setPendingRemoteOrder(null);
          adoptAuthoritativeOrder(current);
        },
      });
      if (!stale) addToast(err.message || 'Failed to save adjustment.', 'error');
    } finally {
      setSavingAdj(false);
    }
  };

  const handleCloseOrder = async () => {
    setClosing(true);
    try {
      let updated;
      if (bottleItems.length > 0) {
        const items = Object.entries(returnCounts).map(([itemId, returned]) => ({
          id: Number(itemId),
          bottles_returned: Number(returned) || 0,
        }));
        updated = await api.post(`/orders/${id}/close`, { items, revision: order.revision });
      } else {
        updated = await api.post(`/orders/${id}/status`, {
          status: 'done', expected_status: order.status, revision: order.revision,
        });
      }
      adoptAuthoritativeOrder(updated);
      setAdjValue(Number(updated.adjustment) ? String(updated.adjustment) : '');
      setAdjReason(updated.adjustment_reason || '');
      addToast('Order closed.', 'success');
    } catch (err) {
      const stale = await handleStaleOrderWrite(err, {
        addToast,
        onCurrent: (current) => {
          setPendingRemoteOrder(null);
          adoptAuthoritativeOrder(current);
        },
      });
      if (!stale) addToast(err.message || 'Failed to close order.', 'error');
    } finally {
      setClosing(false);
    }
  };

  if (loading) {
    return <OrderDetailSkeleton />;
  }

  if (notFound) {
    return (
      <div className="p-6 max-w-2xl mx-auto text-center">
        <p className="text-xl font-semibold text-slate-400 mt-20">Order not found.</p>
        <Button className="mt-4" variant="secondary" onClick={() => navigate('/orders')}>
          ← Back to Orders
        </Button>
      </div>
    );
  }

  if (!order) {
    return (
      <div className="p-6 max-w-2xl mx-auto text-center" data-testid="order-recovery-card">
        <div className="mt-16 p-8 bg-white border border-slate-200 rounded-xl shadow-sm">
          <div className="w-12 h-12 mx-auto mb-4 rounded-full bg-amber-50 border border-amber-200 flex items-center justify-center text-amber-600 text-2xl" aria-hidden="true">
            ⚠️
          </div>
          <h2 className="text-lg font-semibold text-slate-900 mb-2">Unable to reach the server to load this order.</h2>
          <p className="text-sm text-slate-500 mb-6">
            Please check your network connection or try again.
          </p>
          <div className="flex items-center justify-center gap-3">
            <Button variant="secondary" onClick={() => navigate('/orders')}>
              ← Back to Orders
            </Button>
            <Button variant="primary" onClick={() => load()}>
              🔄 Try Again
            </Button>
          </div>
        </div>
      </div>
    );
  }

  const st = STATUS[order.status] ?? { label: order.status, color: 'bg-slate-100 text-slate-500 border-slate-200' };

  // Slice 3.2 / ADR 0015 §5 — two different reasons an action here can be unavailable,
  // and the operator deserves to be told which:
  //   `unsynced`            this order has never reached the server, so there is no row
  //                         to reverse, cancel or settle against yet.
  //   offlineViewingSynced  the order exists and other tablets can see it; we simply
  //                         cannot reach the server from this device right now.
  // The three FORWARD transitions survive the first but not the second; everything that
  // reverses or settles shared state needs a live connection either way.
  const offlineViewingSynced = fromLocalSnapshot && !unsynced;
  const onlineOnlyDisabled   = unsynced || offlineViewingSynced;
  const onlineOnlyTitle      = unsynced ? 'Waiting to sync'
    : offlineViewingSynced ? 'Needs a connection' : undefined;
  const isPickup      = order.order_type === 'pickup';
  const isDepositable = order.status === 'done' || order.status === 'completed';
  const hasAdj     = num(order.adjustment) !== 0;

  const itemsSubtotal = items.length > 0
    ? items.reduce((sum, i) => sum + num(i.quantity) * num(i.unit_price), 0)
    : num(order.total_amount) - num(order.adjustment);

  const itemNetDeposit = (item) => {
    if (!isDepositable) return 0;
    const dep = num(item?.unit_deposit_fee);
    if (!dep) return 0;
    const totalBottles = num(item.quantity) * (num(item.units_per_case) || 1);
    const isLive = item.requires_bottle_return && order.status === 'completed'
                   && returnCounts[item.id] !== undefined && returnCounts[item.id] !== '';
    const returned = isLive
      ? Math.max(num(returnCounts[item.id]), 0)
      : Math.max(num(item.bottles_returned), 0);
    return (totalBottles - returned) * dep;
  };

  const depositTotal = items.reduce((sum, i) => sum + itemNetDeposit(i), 0);

  // Decision 4: unset means the line doesn't exist; configured (including a
  // deliberate ₱0.00) always prints its own line. Decision 12: joins the grand
  // total ahead of the adjustment term.
  const hasDeliveryFee    = order.delivery_fee_charged !== null && order.delivery_fee_charged !== undefined;
  const deliveryFeeCharged = hasDeliveryFee ? num(order.delivery_fee_charged) : 0;

  const liveTotal   = items.length > 0
    ? itemsSubtotal + depositTotal + deliveryFeeCharged + num(order.adjustment)
    : num(order.total_amount);
  const hasDeposits = items.some((i) => num(i?.unit_deposit_fee) > 0);

  return (
    <div className="p-6 max-w-3xl mx-auto" data-testid="order-detail">

      {/* Back + Print */}
      <div className="flex items-center justify-between mb-6">
        <button
          onClick={() => navigate('/orders')}
          className="text-sm font-medium text-blue-700 hover:text-blue-900 flex items-center gap-1"
        >
          ← Orders
        </button>
        {!['in_transit'].includes(order.status) && (
          <div className="flex items-center gap-3">
            <Button variant="secondary" size="sm" onClick={handlePrint} loading={printing}>
              Print Receipt
            </Button>
            {IS_NATIVE && (
              <button
                onClick={handleChangePrinter}
                className="text-xs text-slate-400 hover:text-slate-600 underline
                           focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 rounded"
              >
                Change printer
              </button>
            )}
          </div>
        )}
      </div>

      {/* G27 — static, non-interactive: this is the only sync-state UI on this page. */}
      {unsynced && (
        <div className="mb-4 -mt-4 flex items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-4 py-2.5 text-sm font-medium text-amber-800">
          <span aria-hidden="true">⏳</span>
          <span>Waiting to sync — this order is saved on this device and will reach the server once connected.</span>
        </div>
      )}

      {!unsynced && fromLocalSnapshot && (
        <div className="mb-4 -mt-4 flex items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-4 py-2.5 text-sm font-medium text-amber-800">
          <span aria-hidden="true">⏳</span>
          <span>Offline — showing this device's saved copy of this order. Status changes need a connection.</span>
        </div>
      )}

      {pendingRemoteOrder && !editing && (
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-amber-400 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-900" role="status">
          <span aria-hidden="true">⚠️</span>
          <span>This order changed on another device. Finish or cancel the open action, then review the updated order.</span>
        </div>
      )}

      {(order.pending_receipt_printed_at || order.delivered_receipt_printed_at) && (
        <div className="mb-4 -mt-4 space-y-1">
          {order.pending_receipt_printed_at && (
            <p className="text-sm text-slate-500">
              Printed (pending) {fmtDate(order.pending_receipt_printed_at)} by {order.pending_receipt_printed_by_name}
            </p>
          )}
          {order.delivered_receipt_printed_at && (
            <p className="text-sm text-slate-500">
              Printed (delivered) {fmtDate(order.delivered_receipt_printed_at)} by {order.delivered_receipt_printed_by_name}
            </p>
          )}
        </div>
      )}

      {/* Order header */}
      <div className="bg-white rounded-xl border border-slate-200 p-6 mb-4">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-1">Order</p>
            <h1 className="text-2xl font-bold text-slate-900">{orderRef(order)}</h1>
            <p className="text-sm text-slate-500 mt-1">{fmtDate(order.created_at)}</p>
            {order.sold_by_name?.trim() && (
              <p className="text-sm text-slate-500 mt-0.5">Sold by: {order.sold_by_name.trim()}</p>
            )}
          </div>
          <div className="flex items-center gap-2 flex-wrap justify-end">
            <span className={`inline-flex items-center px-3 py-1 rounded-full text-xs font-semibold border
              ${isPickup
                ? 'bg-blue-100 text-blue-800 border-blue-300'
                : 'bg-slate-100 text-slate-600 border-slate-200'}`}>
              {isPickup ? '🏪 Pickup' : '🚚 Delivery'}
            </span>
            <span className={`inline-flex items-center px-4 py-1.5 rounded-full text-sm font-bold border ${st.color}`}>
              {st.label}
            </span>
          </div>
        </div>

        {/* Customer */}
        <div className="mt-5 pt-5 border-t border-slate-300">
          <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-2">Customer</p>
          <p className="text-base font-semibold text-slate-800">{order.customer_name || 'Customer'}</p>
          {order.customer_address && <p className="text-sm text-slate-500">{order.customer_address}</p>}
          {order.customer_phone   && <p className="text-sm text-slate-500">{order.customer_phone}</p>}
        </div>

        {/* Personnel */}
        {(order.personnel || []).length > 0 && (
          <div className="mt-4 pt-4 border-t border-slate-300">
            <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-2">Assigned Personnel</p>
            <div className="flex flex-wrap gap-2">
              {(order.personnel || []).filter(Boolean).map((p, idx) => (
                <div key={p.id ?? p.personnel_id ?? idx} className="flex items-center gap-1.5">
                  <span className="text-sm font-medium text-slate-700">{p.full_name}</span>
                  <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold border
                    ${ROLE_COLOR[p.role] ?? 'bg-slate-100 text-slate-600 border-slate-200'}`}>
                    {p.role}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Timestamps */}
        <div className="mt-4 pt-4 border-t border-slate-300 grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { label: 'Created',                              val: order.created_at },
            { label: 'Dispatched',                           val: !isPickup ? order.dispatched_at : null },
            { label: isPickup ? 'Picked Up' : 'Delivered',  val: order.delivered_at },
            { label: 'Closed',                               val: order.closed_at },
          ].filter((t) => t.val).map((t) => (
            <div key={t.label}>
              <p className="text-xs font-semibold text-slate-400 uppercase">{t.label}</p>
              <p className="text-xs text-slate-600 mt-0.5">
                {fmtDate(t.val, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
              </p>
            </div>
          ))}
        </div>

        {order.notes && (
          <div className="mt-4 pt-4 border-t border-slate-300">
            <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-1">Notes</p>
            <p className="text-sm text-slate-600 italic">"{order.notes}"</p>
          </div>
        )}
      </div>

      {/* Line items */}
      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden mb-4">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-slate-50 text-slate-500 text-xs uppercase tracking-wide border-b border-slate-400">
              <th className="text-left px-5 py-3 font-semibold">Product</th>
              <th className="text-right px-5 py-3 font-semibold">Qty</th>
              <th className="text-right px-4 py-3 font-semibold hidden sm:table-cell">Price/Case</th>
              <th className="text-right px-4 py-3 font-semibold hidden sm:table-cell">Deposit</th>
              <th className="text-right px-5 py-3 font-semibold">Total</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-5 py-6 text-center text-slate-400">
                  Line items not available offline
                </td>
              </tr>
            ) : (
              items.map((item) => (
              <tr key={item.id ?? `${item.product_id}-${item.unit_price}`} className="border-t border-slate-300">
                <td className="px-5 py-3">
                  <p className="font-medium text-slate-800">{item.sku || item.product_name || 'Item'}</p>
                </td>
                <td className="px-5 py-3 text-right tabular-nums text-slate-700">
                  {item.quantity ?? '—'} {item.unit || ''}
                </td>
                <td className="px-4 py-3 text-right tabular-nums text-slate-500 hidden sm:table-cell">
                  {PHP(item.unit_price)}
                </td>
                <td className="px-4 py-3 text-right tabular-nums text-slate-500 hidden sm:table-cell">
                  {num(item.unit_deposit_fee) > 0 && isDepositable ? (
                    <div>
                      <div>{PHP(item.unit_deposit_fee)}/bottle</div>
                      {num(item.bottles_returned) > 0 && (
                        <div className="text-xs text-green-700 mt-0.5">
                          −{item.bottles_returned} returned
                        </div>
                      )}
                    </div>
                  ) : '—'}
                </td>
                <td className="px-5 py-3 text-right tabular-nums font-semibold text-slate-800">
                  <div>{PHP(num(item.quantity) * num(item.unit_price))}</div>
                  {num(item.unit_deposit_fee) > 0 && isDepositable && (
                    <div className={`text-xs font-normal mt-0.5 ${itemNetDeposit(item) < 0 ? 'text-green-700' : 'text-slate-500'}`}>
                      {itemNetDeposit(item) < 0
                        ? `− ${PHP(Math.abs(itemNetDeposit(item)))} credit`
                        : `+ ${PHP(itemNetDeposit(item))} dep.`}
                    </div>
                  )}
                </td>
              </tr>
            )))}
          </tbody>
          <tfoot>
            {hasDeposits && isDepositable && (
              <>
                <tr className="border-t border-slate-400 bg-slate-50">
                  <td colSpan={4} className="px-5 py-3 text-right text-slate-500">Items</td>
                  <td className="px-5 py-3 text-right tabular-nums text-slate-700">
                    {PHP(itemsSubtotal)}
                  </td>
                </tr>
                <tr className="border-t border-slate-300 bg-slate-50">
                  <td colSpan={4} className="px-5 py-3 text-right text-slate-500">Deposit fee</td>
                  <td className={`px-5 py-3 text-right tabular-nums ${depositTotal < 0 ? 'text-green-700' : 'text-slate-700'}`}>
                    {depositTotal < 0
                      ? `− ${PHP(Math.abs(depositTotal))}`
                      : `+ ${PHP(depositTotal)}`}
                  </td>
                </tr>
              </>
            )}
            {hasDeliveryFee && (
              <tr className="border-t border-slate-300 bg-slate-50">
                <td colSpan={4} className="px-5 py-3 text-right text-slate-500">Delivery Fee</td>
                <td className="px-5 py-3 text-right tabular-nums font-medium text-slate-700">
                  {PHP(deliveryFeeCharged)}
                </td>
              </tr>
            )}
            {hasAdj && (
              <tr className="border-t border-slate-300 bg-slate-50">
                <td colSpan={4} className="px-5 py-3 text-right text-slate-500">
                  Adjustment
                  {order.adjustment_reason && (
                    <span className="ml-2 text-xs text-slate-400 italic">({order.adjustment_reason})</span>
                  )}
                </td>
                <td className={`px-5 py-3 text-right tabular-nums font-medium
                  ${num(order.adjustment) > 0 ? 'text-red-600' : 'text-green-700'}`}>
                  {num(order.adjustment) > 0 ? '+' : ''}{PHP(order.adjustment)}
                </td>
              </tr>
            )}
            <tr className="border-t-2 border-slate-400 bg-slate-50">
              <td colSpan={4} className="px-5 py-4 text-right font-bold text-slate-700">
                Order Total
              </td>
              <td className="px-5 py-4 text-right font-bold text-xl tabular-nums text-slate-900">
                {PHP(liveTotal)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      {/* Bottle returns — review inline before closing */}
      {order.status === 'completed' && bottleItems.length > 0 && (
        <OrderCloseForm
          order={order}
          returnCounts={returnCounts}
          onChangeReturnCounts={(counts) => { setReturnsDirty(true); setReturnCounts(counts); }}
          hideCloseButton
        />
      )}

      {/* Adjustment */}
      <div className="bg-white rounded-xl border border-slate-200 p-5 mb-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs font-bold text-slate-400 uppercase tracking-widest">Adjustment</p>
            {!adjExpanded && (
              <p className="text-sm text-slate-500 mt-1">
                {hasAdj
                  ? <span className={num(order.adjustment) > 0 ? 'text-red-600 font-semibold' : 'text-green-700 font-semibold'}>
                      {num(order.adjustment) > 0 ? '+' : ''}{PHP(order.adjustment)}
                      {order.adjustment_reason && ` — ${order.adjustment_reason}`}
                    </span>
                  : 'None'}
              </p>
            )}
          </div>
          {/* Historical drafts stay under the synced-order-edit-scope lock offline
              (captain decision 2026-09-02) — no reachable edit control, not just a
              non-functional one, so the toggle itself is absent for a draft. */}
          {order.status !== 'draft' && (
            <button
              type="button"
              onClick={() => setAdjExpanded((v) => !v)}
              disabled={offlineViewingSynced}
              title={offlineViewingSynced ? 'Needs a connection' : undefined}
              className="text-sm text-blue-700 hover:text-blue-900 font-medium disabled:opacity-40 disabled:cursor-not-allowed
                         focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 rounded"
            >
              {adjExpanded ? 'Cancel' : hasAdj ? 'Edit' : '+ Add Adjustment'}
            </button>
          )}
        </div>

        {adjExpanded && order.status !== 'draft' && (
          <div className="mt-4 space-y-3">
            <div>
              <label className="block text-sm font-semibold text-slate-700 mb-1">
                Amount (₱) — use negative for discount
              </label>
              <input
                type="number"
                step="0.01"
                value={adjValue}
                onChange={(e) => setAdjValue(e.target.value)}
                className={INPUT}
                placeholder="e.g. -50 for discount, 200 for surcharge"
              />
            </div>
            <div>
              <label className="block text-sm font-semibold text-slate-700 mb-1">
                Reason {Number(adjValue) !== 0 && <span className="text-red-500">*</span>}
              </label>
              <textarea
                value={adjReason}
                onChange={(e) => setAdjReason(e.target.value)}
                rows={2}
                className="w-full px-4 py-2.5 border border-slate-300 rounded-lg text-base text-slate-900
                           focus:outline-none focus:ring-2 focus:ring-blue-600 resize-none"
                placeholder="e.g. Customer rejected 2 cases, negotiated price"
              />
            </div>
            <Button onClick={saveAdjustment} loading={savingAdj}>
              Save Adjustment
            </Button>
          </div>
        )}
      </div>

      {order.status === 'completed' && (
        <div className="bg-white rounded-xl border border-slate-200 p-5 mb-4">
          <Button
            className="w-full"
            onClick={handleCloseOrder}
            loading={closing}
            disabled={onlineOnlyDisabled}
            title={onlineOnlyTitle}
          >
            Close Order
          </Button>
        </div>
      )}

      {/* Actions — a historical draft has none: it stays under the synced-order-edit-
          scope lock (no edit, no convert-to-order, no cancel) whether or not this view
          came from the offline read-only fallback (captain decision 2026-09-02). */}
      {order.status !== 'draft' && (
      <div className="bg-white rounded-xl border border-slate-200 p-5 mb-4">
        <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-4">Actions</p>

        {confirmAction ? (
          <div className={`p-4 rounded-lg border ${confirmAction.danger ? 'bg-red-50 border-red-200' : 'bg-blue-50 border-blue-200'}`}>
            <p className={`text-sm font-semibold mb-1 ${confirmAction.danger ? 'text-red-800' : 'text-blue-800'}`}>
              Confirm: {confirmAction.label}
            </p>
            <p className={`text-sm mb-4 ${confirmAction.danger ? 'text-red-700' : 'text-blue-700'}`}>
              {confirmAction.message}
            </p>
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" onClick={() => setConfirmAction(null)} disabled={transitioning}>
                Cancel
              </Button>
              <Button
                size="sm"
                variant={confirmAction.danger ? 'danger' : 'primary'}
                onClick={transition}
                loading={transitioning}
              >
                {confirmAction.label}
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap gap-3">
            {/* G28 / ADR 0015 §5 — Edit Order and Print Receipt stay enabled while
                unsynced, and so do the three FORWARD transitions (Start Dispatch, Mark
                as Picked Up, Mark as Delivered): an order only this tablet knows about
                can be dispatched and delivered during an outage, which is exactly what
                happens on a blackout day. Everything else here — the reversals, Cancel,
                Close — stays online-required, because each of them undoes or settles
                shared state, and replaying those out of order across disconnected
                tablets is what corrupts the stock and deposit ledgers. */}
            <Button
              variant="secondary"
              data-testid="order-edit-button"
              onClick={() => setEditing(true)}
              disabled={offlineViewingSynced}
              title={offlineViewingSynced ? 'Needs a connection' : undefined}
            >
              Edit Order
            </Button>

            {/* Delivery pending: Start Dispatch */}
            {order.status === 'pending' && !isPickup && (
              <Button
                disabled={offlineViewingSynced}
                title={offlineViewingSynced ? 'Needs a connection' : undefined}
                onClick={() => setConfirmAction({
                  newStatus: 'in_transit',
                  label: 'Start Dispatch',
                  message: unsynced
                    ? 'Saved on this device now; stock is deducted when this order reaches the server.'
                    : 'Stock will be deducted from inventory. This cannot be undone without cancelling.',
                })}
              >
                Start Dispatch →
              </Button>
            )}

            {/* Pickup pending: Mark as Picked Up */}
            {order.status === 'pending' && isPickup && (
              <Button
                disabled={offlineViewingSynced}
                title={offlineViewingSynced ? 'Needs a connection' : undefined}
                onClick={() => setConfirmAction({
                  newStatus: 'completed',
                  label: 'Mark as Picked Up',
                  message: unsynced
                    ? 'Saved on this device now; stock is deducted when this order reaches the server.'
                    : 'Stock will be deducted from inventory once the customer picks up.',
                })}
              >
                Mark as Picked Up ✓
              </Button>
            )}

            {order.status === 'in_transit' && (
              <Button
                variant="secondary"
                disabled={onlineOnlyDisabled}
                title={onlineOnlyTitle}
                onClick={() => setConfirmAction({
                  newStatus: 'pending',
                  label: 'Back to Pending',
                  message: 'Stock will be restored to inventory.',
                })}
              >
                ← Back to Pending
              </Button>
            )}

            {order.status === 'in_transit' && (
              <Button
                variant="warning"
                disabled={offlineViewingSynced}
                title={offlineViewingSynced ? 'Needs a connection' : undefined}
                onClick={() => setConfirmAction({
                  newStatus: 'completed',
                  label: 'Mark as Delivered',
                  message: 'Confirm that this order was received by the customer.',
                })}
              >
                Mark as Delivered ✓
              </Button>
            )}

            {order.status === 'completed' && !isPickup && (
              <Button
                variant="secondary"
                disabled={onlineOnlyDisabled}
                title={onlineOnlyTitle}
                onClick={() => setConfirmAction({
                  newStatus: 'in_transit',
                  label: 'Back to In Transit',
                  message: 'Confirm this order has not yet been delivered.',
                })}
              >
                ← Back to In Transit
              </Button>
            )}

            {order.status === 'completed' && isPickup && (
              <Button
                variant="secondary"
                disabled={onlineOnlyDisabled}
                title={onlineOnlyTitle}
                onClick={() => setConfirmAction({
                  newStatus: 'pending',
                  label: 'Back to Pending',
                  message: 'Stock will be restored to inventory.',
                })}
              >
                ← Back to Pending
              </Button>
            )}

            {order.status === 'done' && (
              <Button
                variant="secondary"
                disabled={onlineOnlyDisabled}
                title={onlineOnlyTitle}
                onClick={() => setConfirmAction({
                  newStatus: 'completed',
                  label: 'Reopen Order',
                  message: 'Reopen this order for further changes.',
                })}
              >
                ← Reopen Order
              </Button>
            )}

            {!['done', 'cancelled'].includes(order.status) && (
              <Button
                variant="danger"
                disabled={onlineOnlyDisabled}
                title={onlineOnlyTitle}
                onClick={() => setConfirmAction({
                  newStatus: 'cancelled',
                  label: 'Cancel Order',
                  message: order.status === 'pending'
                    ? 'The order will be cancelled. No stock was deducted so none will be restored.'
                    : 'The order will be cancelled and all stock will be restored to inventory.',
                  danger: true,
                })}
              >
                Cancel Order
              </Button>
            )}
          </div>
        )}
      </div>
      )}

      {/* Edit modal */}
      {editing && (
        <OrderCreateModal
          editOrder={order}
          offlineUnsynced={unsynced}
          staleWarning={Boolean(pendingRemoteOrder)}
          onStale={(current) => {
            setPendingRemoteOrder(null);
            adoptAuthoritativeOrder(current);
            setEditing(false);
          }}
          onClose={() => setEditing(false)}
          onSaved={() => { setPendingRemoteOrder(null); setEditing(false); load(); }}
        />
      )}

      {/* Printer picker (Android only — shown on first print or "Change printer") */}
      {pickerVisible && (
        <PrinterPicker
          devices={pickerDevices}
          loading={pickerLoading}
          current={pickerCurrent}
          printPending={printPending}
          onSave={savePrinter}
          onScanWifi={scanWifi}
          onTestPrint={testPrint}
          onClose={closePickerAndCancel}
        />
      )}

      {/* Print twice for your copy? — pending orders only, asked before printing */}
      {twicePrompt && (
        <Modal
          title="Print twice for your copy?"
          onClose={() => confirmTwice(false)}
          onConfirm={() => confirmTwice(true)}
          cancelLabel="No"
          confirmLabel="Yes"
          loading={printing}
        >
          Print a second copy for your records?
        </Modal>
      )}

      {/* Confirm tagging this order as printed */}
      {printPrompt && (
        <Modal
          title="Tag receipt as printed?"
          onClose={cancelPrintTag}
          onConfirm={confirmPrintTag}
          confirmLabel="Yes, tag as printed"
          loading={taggingPrint}
        >
          Do you want to tag Order {orderRef(order)} as printed
          ({printPrompt.phase === 'pending' ? 'Pending' : 'Delivered'})?
        </Modal>
      )}

    </div>
  );
}
