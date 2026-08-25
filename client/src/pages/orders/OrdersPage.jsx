import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api/client';
import { useToast } from '../../components/ui/Toast';
import Button from '../../components/ui/Button';
import Spinner from '../../components/ui/Spinner';
import Modal from '../../components/ui/Modal';
import OrderCreateModal from './OrderCreateModal';
import ReviewQueueModal from './ReviewQueueModal';
import { orderRef } from '../../utils/orderRef';

const PHP = (n) =>
  `₱${Number(n).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const STATUS_TABS = [
  { value: 'all',        label: 'All' },
  { value: 'draft',      label: 'Drafts' },
  { value: 'pending',    label: 'Pending' },
  { value: 'in_transit', label: 'In Transit' },
  { value: 'completed',  label: 'Delivered' },
  { value: 'done',       label: 'Closed' },
  { value: 'cancelled',  label: 'Cancelled' },
];

const STATUS_BADGE = {
  draft:      'bg-violet-100 text-violet-800 border-violet-300',
  pending:    'bg-blue-100 text-blue-800 border-blue-300',
  in_transit: 'bg-amber-100 text-amber-800 border-amber-300',
  completed:  'bg-green-100 text-green-800 border-green-300',
  done:       'bg-slate-100 text-slate-500 border-slate-200',
  cancelled:  'bg-red-100 text-red-700 border-red-300',
};

const STATUS_LABEL = {
  draft:      'Draft',
  pending:    'Pending',
  in_transit: 'In Transit',
  completed:  'Delivered',
  done:       'Closed',
  cancelled:  'Cancelled',
};

export default function OrdersPage() {
  const navigate = useNavigate();
  const { addToast } = useToast();

  const [orders, setOrders]       = useState([]);
  const [loading, setLoading]     = useState(true);
  const [statusTab, setStatusTab] = useState('all');
  const [fromDate, setFromDate]   = useState('');
  const [toDate, setToDate]       = useState('');
  const [creating, setCreating]   = useState(false);

  // Drafts: separate banner feed (shown on any tab) + resume/discard state
  const [drafts, setDrafts]                     = useState([]);
  const [draftQuery, setDraftQuery]             = useState('');
  const [resumeDraft, setResumeDraft]           = useState(null);
  const [discardConfirm, setDiscardConfirm]     = useState(null);
  const [discarding, setDiscarding]             = useState(false);
  const [bulkDiscardPrompt, setBulkDiscardPrompt] = useState(false);
  const [bulkDiscarding, setBulkDiscarding]     = useState(false);

  // Bulk selection + actions (only meaningful on pending/in_transit/completed tabs)
  const [selectedIds, setSelectedIds]     = useState(() => new Set());
  const [bulkConfirm, setBulkConfirm]     = useState(null);
  const [bulkRunning, setBulkRunning]     = useState(false);
  const [reviewPrompt, setReviewPrompt]   = useState(null);
  // { ids: number[], mode: 'pending' | 'in_transit' | 'delivered' } | null
  const [reviewQueue, setReviewQueue]     = useState(null);

  const showCheckboxes = ['pending', 'in_transit', 'completed'].includes(statusTab);

  const load = useCallback(() => {
    setLoading(true);
    const params = new URLSearchParams();
    if (statusTab !== 'all') params.set('status', statusTab);
    if (fromDate) params.set('from_date', fromDate);
    if (toDate)   params.set('to_date',   toDate);

    api.get(`/orders?${params}`)
      .then(setOrders)
      .catch(() => addToast('Failed to load orders', 'error'))
      .finally(() => setLoading(false));
  }, [statusTab, fromDate, toDate, addToast]);

  useEffect(() => { load(); }, [load]);

  const loadDrafts = useCallback(() => {
    api.get('/orders?status=draft').then(setDrafts).catch(() => {});
  }, []);

  useEffect(() => { loadDrafts(); }, [loadDrafts]);

  useEffect(() => { setSelectedIds(new Set()); setBulkConfirm(null); }, [statusTab]);

  const openDraft = async (o) => {
    try {
      const full = await api.get(`/orders/${o.id}`);
      setResumeDraft(full);
    } catch (err) {
      addToast(err.message || 'Failed to open draft.', 'error');
    }
  };

  const confirmDiscardDraft = async () => {
    if (!discardConfirm) return;
    setDiscarding(true);
    try {
      await api.del(`/orders/${discardConfirm.id}`);
      addToast('Draft discarded.', 'success');
      setDiscardConfirm(null);
      load();
      loadDrafts();
    } catch (err) {
      addToast(err.message || 'Failed to discard draft.', 'error');
    } finally {
      setDiscarding(false);
    }
  };

  // Filtered orders for table display (including draft-scoped search when in draft tab)
  const displayedOrders = useMemo(() => {
    if (statusTab !== 'draft' || !draftQuery.trim()) return orders;
    const q = draftQuery.trim().toLowerCase();
    return orders.filter((o) =>
      (o.customer_name || '').toLowerCase().includes(q)
      || String(o.id ?? '').includes(q)
      || String(o.receipt_number ?? '').toLowerCase().includes(q)
    );
  }, [orders, statusTab, draftQuery]);

  const handleBulkDiscardAll = async () => {
    setBulkDiscarding(true);
    const targetDrafts = displayedOrders.filter((o) => o.status === 'draft');
    const results = await Promise.allSettled(targetDrafts.map((d) => api.del(`/orders/${d.id}`)));
    const done = results.filter((r) => r.status === 'fulfilled').length;
    const failed = results.length - done;
    addToast(
      failed
        ? `Discarded ${done} draft${done === 1 ? '' : 's'}, ${failed} failed.`
        : `${done} draft${done === 1 ? '' : 's'} discarded.`,
      failed ? 'error' : 'success'
    );
    setBulkDiscarding(false);
    setBulkDiscardPrompt(false);
    load();
    loadDrafts();
  };

  const toggleSelected = (id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const allSelected = displayedOrders.length > 0 && displayedOrders.every((o) => selectedIds.has(o.id));

  const toggleSelectAll = () => {
    setSelectedIds(allSelected ? new Set() : new Set(displayedOrders.map((o) => o.id)));
  };

  const runBulkTransition = async (targetStatus, pastTenseLabel) => {
    setBulkRunning(true);
    const ids = Array.from(selectedIds);
    const succeeded = [];
    const failed = [];
    for (const orderId of ids) {
      try {
        await api.post(`/orders/${orderId}/status`, { status: targetStatus });
        succeeded.push(orderId);
      } catch (err) {
        failed.push({ id: orderId, reason: err.message || 'failed' });
      }
    }
    setBulkRunning(false);
    setBulkConfirm(null);
    setSelectedIds(new Set());
    load();

    if (failed.length === 0) {
      addToast(`${succeeded.length} order${succeeded.length === 1 ? '' : 's'} ${pastTenseLabel}.`, 'success');
    } else {
      const failMsg = failed.map((f) => `#${f.id} — ${f.reason}`).join(' · ');
      addToast(
        `${succeeded.length} of ${ids.length} ${pastTenseLabel}. Failed: ${failMsg}`,
        'error'
      );
    }
    return succeeded;
  };

  const confirmBulkDispatch = () => setBulkConfirm({
    label: 'Dispatch Selected',
    message: `Stock will be deducted from inventory for ${selectedIds.size} order(s). This cannot be undone without cancelling each order individually.`,
    onConfirm: () => runBulkTransition('in_transit', 'dispatched'),
  });

  const confirmBulkPickup = () => setBulkConfirm({
    label: 'Mark Picked Up',
    message: `Stock will be deducted from inventory for ${selectedIds.size} pickup order(s). This cannot be undone without cancelling each order individually.`,
    onConfirm: async () => {
      const succeeded = await runBulkTransition('completed', 'marked as picked up');
      if (succeeded.length > 0) setReviewPrompt({ ids: succeeded, verb: 'marked as picked up' });
    },
  });

  const confirmBulkDeliver = () => setBulkConfirm({
    label: 'Mark Delivered',
    message: `Confirm that ${selectedIds.size} order(s) were received by their customers.`,
    onConfirm: async () => {
      const succeeded = await runBulkTransition('completed', 'marked as delivered');
      if (succeeded.length > 0) setReviewPrompt({ ids: succeeded });
    },
  });

  const selectedOrders        = orders.filter((o) => selectedIds.has(o.id));
  const selectionHasDeliveries = selectedOrders.some((o) => o.order_type !== 'pickup');
  const selectionHasPickups    = selectedOrders.some((o) => o.order_type === 'pickup');
  const selectionIsMixed       = selectionHasDeliveries && selectionHasPickups;

  return (
    <div className="p-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
        <h1 className="text-2xl font-bold text-slate-900">Outgoing Orders</h1>
        <Button onClick={() => setCreating(true)}>+ New Order</Button>
      </div>

      {/* Parked-drafts banner — visible from any tab so an in-progress order is never lost */}
      {drafts.length > 0 && statusTab !== 'draft' && (
        <div className="mb-4 rounded-xl border border-violet-300 bg-violet-50 px-5 py-3
                        flex items-center justify-between gap-3 flex-wrap">
          <div className="min-w-0">
            <p className="text-sm font-bold text-violet-900">
              📝 {drafts.length} parked draft{drafts.length === 1 ? '' : 's'}
            </p>
            <p className="text-sm text-violet-700 truncate">
              For: {drafts.map((d) => d.customer_name).join(', ')}
            </p>
          </div>
          <Button size="sm" variant="secondary" onClick={() => setStatusTab('draft')} className="shrink-0">
            View drafts →
          </Button>
        </div>
      )}

      {/* Status tabs */}
      <div className="flex flex-wrap gap-1.5 mb-4">
        {STATUS_TABS.map((tab) => (
          <button
            key={tab.value}
            onClick={() => setStatusTab(tab.value)}
            className={`px-4 py-2 rounded-lg text-sm font-semibold border transition-colors
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600
              ${statusTab === tab.value
                ? 'bg-blue-700 text-white border-blue-700'
                : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'}`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Scoped Drafts Search & Bulk Actions Bar (when on Drafts tab) */}
      {statusTab === 'draft' && (
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4 p-3 bg-violet-50 border border-violet-200 rounded-xl">
          <div className="flex-1 min-w-[200px]">
            <input
              type="text"
              value={draftQuery}
              onChange={(e) => setDraftQuery(e.target.value)}
              placeholder="Search drafts by customer or order number…"
              className="w-full h-10 px-3.5 border border-slate-300 rounded-lg text-sm text-slate-900 bg-white
                         focus:outline-none focus:ring-2 focus:ring-blue-600"
              aria-label="Search drafts by customer or order number"
            />
          </div>
          {displayedOrders.length > 0 && (
            <Button
              size="sm"
              variant="danger"
              onClick={() => setBulkDiscardPrompt(true)}
              className="shrink-0"
            >
              🗑 Discard all ({displayedOrders.length})
            </Button>
          )}
        </div>
      )}

      {/* Date range filters */}
      {statusTab !== 'draft' && (
        <div className="flex flex-wrap gap-3 mb-6">
          <div className="flex gap-2 items-center">
            <label className="text-sm text-slate-500 font-medium whitespace-nowrap">From</label>
            <input
              type="date"
              value={fromDate}
              onChange={(e) => setFromDate(e.target.value)}
              className="h-10 px-3 border border-slate-300 rounded-lg text-base text-slate-900
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
              className="h-10 px-3 border border-slate-300 rounded-lg text-base text-slate-900
                         focus:outline-none focus:ring-2 focus:ring-blue-600"
              aria-label="To date"
            />
          </div>
          {(fromDate || toDate) && (
            <button
              onClick={() => { setFromDate(''); setToDate(''); }}
              className="h-10 px-4 text-sm font-medium text-slate-500 hover:text-slate-800
                         border border-slate-300 rounded-lg bg-white hover:bg-slate-50
                         focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 whitespace-nowrap"
            >
              Clear dates
            </button>
          )}
        </div>
      )}

      {/* Bulk action bar */}
      {showCheckboxes && selectedIds.size > 0 && (
        <div className="sticky top-0 z-10 bg-blue-50 border border-blue-200 rounded-xl px-5 py-3 mb-4
                        flex items-center justify-between flex-wrap gap-3">
          {bulkConfirm ? (
            <>
              <div>
                <p className="text-sm font-semibold text-blue-900">Confirm: {bulkConfirm.label}</p>
                <p className="text-sm text-blue-700 mt-0.5">{bulkConfirm.message}</p>
              </div>
              <div className="flex gap-2 shrink-0">
                <Button variant="secondary" size="sm" onClick={() => setBulkConfirm(null)} disabled={bulkRunning}>
                  Cancel
                </Button>
                <Button size="sm" onClick={bulkConfirm.onConfirm} loading={bulkRunning}>
                  {bulkConfirm.label}
                </Button>
              </div>
            </>
          ) : (
            <>
              <p className="text-sm font-semibold text-blue-900">
                {selectedIds.size} order{selectedIds.size === 1 ? '' : 's'} selected
              </p>
              <div className="flex gap-2 shrink-0">
                <Button variant="secondary" size="sm" onClick={() => setSelectedIds(new Set())}>
                  Clear
                </Button>
                {statusTab === 'pending' && selectionHasDeliveries && !selectionIsMixed && (
                  <Button size="sm" onClick={confirmBulkDispatch}>
                    Dispatch Selected →
                  </Button>
                )}
                {statusTab === 'pending' && selectionHasPickups && !selectionIsMixed && (
                  <Button size="sm" onClick={confirmBulkPickup}>
                    Mark Picked Up ✓
                  </Button>
                )}
                {statusTab === 'pending' && (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => setReviewQueue({ ids: Array.from(selectedIds), mode: 'pending' })}
                  >
                    Review Selected
                  </Button>
                )}
                {statusTab === 'in_transit' && (
                  <Button size="sm" variant="warning" onClick={confirmBulkDeliver}>
                    Mark Delivered ✓
                  </Button>
                )}
                {statusTab === 'in_transit' && (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => setReviewQueue({ ids: Array.from(selectedIds), mode: 'in_transit' })}
                  >
                    Review Selected
                  </Button>
                )}
                {statusTab === 'completed' && (
                  <Button size="sm" onClick={() => setReviewQueue({ ids: Array.from(selectedIds), mode: 'delivered' })}>
                    Review Selected
                  </Button>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {/* Table */}
      {loading ? (
        <div className="flex items-center justify-center h-64"><Spinner size="lg" /></div>
      ) : displayedOrders.length === 0 ? (
        <p className="text-center text-slate-400 text-base py-20">
          {statusTab === 'all' ? 'No orders yet.' : `No ${STATUS_LABEL[statusTab]?.toLowerCase()} orders.`}
        </p>
      ) : (
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden overflow-x-auto">
          <table className="w-full text-base">
            <thead>
              <tr className="bg-slate-50 text-slate-500 text-sm uppercase tracking-wider border-b border-slate-400">
                {showCheckboxes && (
                  <th className="px-5 py-3 w-12">
                    <label className="flex items-center justify-center w-12 h-12 -m-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={allSelected}
                        onChange={toggleSelectAll}
                        className="w-6 h-6 rounded border-slate-300 text-blue-700
                                   focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
                        aria-label="Select all orders"
                      />
                    </label>
                  </th>
                )}
                <th className="text-left px-5 py-3 font-semibold w-16">#</th>
                <th className="text-left px-5 py-3 font-semibold">Customer</th>
                <th className="text-left px-5 py-3 font-semibold hidden lg:table-cell">Personnel</th>
                <th className="text-right px-5 py-3 font-semibold">Total</th>
                <th className="text-left px-5 py-3 font-semibold hidden md:table-cell">Date</th>
                <th className="text-left px-5 py-3 font-semibold">Status</th>
                {statusTab === 'draft' && <th className="px-5 py-3 w-28" />}
              </tr>
            </thead>
            <tbody>
              {displayedOrders.map((o) => (
                <tr
                  key={o.id}
                  onClick={() => o.status === 'draft' ? openDraft(o) : navigate(`/orders/${o.id}`)}
                  className="border-t border-slate-300 hover:bg-blue-50 cursor-pointer transition-colors"
                >
                  {showCheckboxes && (
                    <td className="px-5 py-4" onClick={(e) => e.stopPropagation()}>
                      <label className="flex items-center justify-center w-12 h-12 -m-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={selectedIds.has(o.id)}
                          onChange={() => toggleSelected(o.id)}
                          className="w-6 h-6 rounded border-slate-300 text-blue-700
                                     focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
                          aria-label={`Select order #${o.id}`}
                        />
                      </label>
                    </td>
                  )}
                  <td className="px-5 py-4 font-mono text-slate-500 text-sm">{orderRef(o)}</td>
                  <td className="px-5 py-4">
                    <p className="font-semibold text-slate-900">{o.customer_name}</p>
                  </td>
                  <td className="px-5 py-4 text-sm text-slate-500 hidden lg:table-cell max-w-[200px]">
                    <span className="block truncate">{o.personnel_summary ?? '—'}</span>
                  </td>
                  <td className="px-5 py-4 text-right font-bold text-slate-900 tabular-nums">
                    {PHP(Number(o.total_amount) + Number(o.adjustment || 0))}
                  </td>
                  <td className="px-5 py-4 text-sm text-slate-500 hidden md:table-cell">
                    {new Date(o.created_at).toLocaleDateString('en-PH', {
                      month: 'short', day: 'numeric', year: 'numeric',
                    })}
                  </td>
                  <td className="px-5 py-4">
                    <div className="flex flex-wrap gap-1.5 items-center">
                      <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-sm font-semibold border ${STATUS_BADGE[o.status] ?? 'bg-slate-100 text-slate-500 border-slate-200'}`}>
                        {STATUS_LABEL[o.status] ?? o.status}
                      </span>
                      {o.order_type === 'pickup' && (
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-sm font-semibold border bg-blue-100 text-blue-800 border-blue-300">
                          Pickup
                        </span>
                      )}
                      {((o.status === 'pending' && o.pending_receipt_printed_at)
                        || (['completed', 'done'].includes(o.status) && o.delivered_receipt_printed_at)) && (
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-sm font-semibold border bg-slate-100 text-slate-600 border-slate-300">
                          🖶 Printed
                        </span>
                      )}
                    </div>
                  </td>
                  {statusTab === 'draft' && (
                    <td className="px-5 py-4 text-right" onClick={(e) => e.stopPropagation()}>
                      <Button size="sm" variant="secondary" onClick={() => setDiscardConfirm(o)}>
                        Discard
                      </Button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {creating && (
        <OrderCreateModal
          onClose={() => { setCreating(false); load(); loadDrafts(); }}
          onSaved={(orderId) => {
            setCreating(false); load(); loadDrafts();
            if (orderId) navigate(`/orders/${orderId}`);
          }}
        />
      )}

      {resumeDraft && (
        <OrderCreateModal
          editOrder={resumeDraft}
          onClose={() => { setResumeDraft(null); load(); loadDrafts(); }}
          onSaved={(orderId) => {
            setResumeDraft(null); load(); loadDrafts();
            if (orderId) navigate(`/orders/${orderId}`);
          }}
        />
      )}

      {discardConfirm && (
        <Modal
          title="Discard draft?"
          onClose={() => setDiscardConfirm(null)}
          onConfirm={confirmDiscardDraft}
          confirmLabel="Discard"
          confirmVariant="danger"
          loading={discarding}
        >
          <p className="text-slate-600">
            The draft order for <strong className="text-slate-900">{discardConfirm.customer_name}</strong> will be
            permanently removed. This can't be undone.
          </p>
        </Modal>
      )}

      {bulkDiscardPrompt && (
        <Modal
          title={`Discard ${displayedOrders.length} draft${displayedOrders.length === 1 ? '' : 's'}?`}
          onClose={() => setBulkDiscardPrompt(false)}
          onConfirm={handleBulkDiscardAll}
          confirmLabel={`Yes, discard ${displayedOrders.length} ${displayedOrders.length === 1 ? 'draft' : 'drafts'}`}
          confirmVariant="danger"
          loading={bulkDiscarding}
        >
          <p className="text-slate-600">
            This will permanently remove {displayedOrders.length === 1 ? 'this draft' : `all ${displayedOrders.length} drafts currently listed`}.
            This cannot be undone.
          </p>
        </Modal>
      )}

      {reviewPrompt && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" role="dialog" aria-modal="true">
          <div className="bg-white rounded-xl max-w-sm w-full mx-4 shadow-2xl p-6">
            <h2 className="text-lg font-bold text-slate-900 mb-2">Review deliveries now?</h2>
            <p className="text-sm text-slate-600 mb-5">
              {reviewPrompt.ids.length} order{reviewPrompt.ids.length === 1 ? '' : 's'} {reviewPrompt.verb ?? 'marked as delivered'}.
              Would you like to review and close {reviewPrompt.ids.length === 1 ? 'it' : 'them'} now?
            </p>
            <div className="flex gap-3 justify-end">
              <Button variant="secondary" onClick={() => setReviewPrompt(null)}>
                Not now
              </Button>
              <Button onClick={() => { setReviewQueue({ ids: reviewPrompt.ids, mode: 'delivered' }); setReviewPrompt(null); }}>
                Review now →
              </Button>
            </div>
          </div>
        </div>
      )}

      {reviewQueue && (
        <ReviewQueueModal
          orderIds={reviewQueue.ids}
          mode={reviewQueue.mode}
          onClose={() => { setReviewQueue(null); load(); }}
        />
      )}
    </div>
  );
}
