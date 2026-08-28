import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api/client';
import { useToast } from '../../components/ui/Toast';
import Button from '../../components/ui/Button';
import Spinner from '../../components/ui/Spinner';
import OrderCreateModal from './OrderCreateModal';
import ReviewQueueModal from './ReviewQueueModal';
import { orderRef } from '../../utils/orderRef';
import { getPossibleDoubleOrderIds } from '../../utils/duplicateOrders';
import { listRecords, subscribeOutbox, getReceipt, listReceipts, putReceipt, checkIsOnline } from '../../offline/index.js';

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

  // Pagination state (V3.0 Slice 7)
  const [page, setPage]               = useState(1);
  const [pageSize, setPageSize]       = useState(50);
  const [totalOrders, setTotalOrders] = useState(0);
  const [totalPages, setTotalPages]   = useState(1);

  // Search & Filter controls (G20, G21)
  const [searchQuery, setSearchQuery]         = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [doubleOnly, setDoubleOnly]           = useState(false);
  const [printFilter, setPrintFilter]         = useState('all'); // 'all' | 'printed' | 'unprinted'

  // Debounce search input so we don't fire on every keystroke
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(searchQuery), 300);
    return () => clearTimeout(t);
  }, [searchQuery]);

  // Drafts: separate banner feed (shown on any tab) + resume/discard state
  const [drafts, setDrafts]                     = useState([]);
  const [resumeDraft, setResumeDraft]           = useState(null);
  const [discardConfirm, setDiscardConfirm]     = useState(null);
  const [discarding, setDiscarding]             = useState(false);

  // Bulk selection + actions (uniform across draft, pending, in_transit, completed tabs)
  const [selectedIds, setSelectedIds]     = useState(() => new Set());
  const [bulkConfirm, setBulkConfirm]     = useState(null);
  const [bulkRunning, setBulkRunning]     = useState(false);
  const [reviewPrompt, setReviewPrompt]   = useState(null);
  // { ids: number[], mode: 'pending' | 'in_transit' | 'delivered' } | null
  const [reviewQueue, setReviewQueue]     = useState(null);

  const showCheckboxes = ['draft', 'pending', 'in_transit', 'completed'].includes(statusTab);

  // Round 4 Fix 7 — locally-created orders (saveOrderLocalFirst, G27) are not on the
  // server yet, so the server-driven list above can never include them: navigating
  // away and back to `/orders` lost a freshly-created offline order entirely, landing
  // on a stale row's numeric id instead once the operator clicked back in. Same
  // pattern G29 already established for CustomersPage.jsx — read straight from the
  // outbox rather than the server, merge in, badge "Waiting to sync", and navigate by
  // receipt number (never a numeric id, since there isn't one yet).
  const [localUnsyncedOrders, setLocalUnsyncedOrders] = useState([]);

  const loadLocalUnsyncedOrders = useCallback(async () => {
    try {
      const records = await listRecords();
      // status === 'queued' already covers a record blocked mid-drain behind an
      // unresolved dependency (Fix 6) — it is exactly as "not yet on the server" as
      // any other queued order, so no separate check is needed here.
      const queuedOrders = records.filter((r) => r.entity_type === 'order' && r.status === 'queued' && r.receipt_number);
      const withReceipts = await Promise.all(queuedOrders.map(async (r) => {
        const receipt = await getReceipt(r.receipt_number);
        return receipt ? { ...receipt, id: `local-${r.id}`, _unsynced: true } : null;
      }));
      setLocalUnsyncedOrders(withReceipts.filter(Boolean));
    } catch {
      // Best-effort only — a local listing failure here should not block the page.
    }
  }, []);

  useEffect(() => {
    loadLocalUnsyncedOrders();
    return subscribeOutbox(() => loadLocalUnsyncedOrders());
  }, [loadLocalUnsyncedOrders]);

  const load = useCallback(() => {
    setLoading(true);
    const params = new URLSearchParams();
    if (statusTab !== 'all') params.set('status', statusTab);
    if (fromDate) params.set('from_date', fromDate);
    if (toDate)   params.set('to_date',   toDate);
    if (debouncedSearch.trim()) params.set('search', debouncedSearch.trim());
    params.set('page', String(page));
    params.set('limit', String(pageSize));

    api.get(`/orders?${params}`)
      .then((res) => {
        const orderList = res?.orders || (Array.isArray(res) ? res : []);
        for (const o of orderList) {
          if (o?.receipt_number) putReceipt(o).catch(() => {});
        }
        if (res && res.orders && res.pagination) {
          setOrders(res.orders);
          setTotalOrders(res.pagination.total);
          setTotalPages(res.pagination.totalPages);
        } else if (Array.isArray(res)) {
          setOrders(res);
          setTotalOrders(res.length);
          setTotalPages(1);
        } else {
          setOrders([]);
          setTotalOrders(0);
          setTotalPages(1);
        }
      })
      .catch(async (err) => {
        try {
          const cached = await listReceipts();
          if (cached && cached.length > 0) {
            const filtered = statusTab === 'all'
              ? cached
              : cached.filter((r) => r.status === statusTab);
            setOrders(filtered);
            setTotalOrders(filtered.length);
            setTotalPages(Math.max(1, Math.ceil(filtered.length / pageSize)));
            return;
          }
        } catch {}
        if (!checkIsOnline() || (err instanceof TypeError) || /failed to fetch|network|load failed/i.test(err?.message || '')) {
          setOrders([]);
          setTotalOrders(0);
          setTotalPages(1);
          return;
        }
        addToast('Failed to load orders', 'error');
      })
      .finally(() => setLoading(false));
  }, [statusTab, fromDate, toDate, debouncedSearch, page, pageSize, addToast]);

  useEffect(() => { load(); }, [load]);

  const loadDrafts = useCallback(() => {
    api.get('/orders?status=draft').then(setDrafts).catch(() => {});
  }, []);

  useEffect(() => { loadDrafts(); }, [loadDrafts]);

  // Reset page to 1 when filters or search criteria change
  useEffect(() => {
    setPage(1);
  }, [statusTab, fromDate, toDate, searchQuery, doubleOnly, printFilter]);

  useEffect(() => {
    setSelectedIds(new Set());
    setBulkConfirm(null);
  }, [statusTab, page]);

  // D6 / G21 — Possible duplicate detection across loaded orders
  const possibleDoubleIds = useMemo(
    () => getPossibleDoubleOrderIds(orders),
    [orders]
  );

  const isOrderPrinted = (o) => Boolean(
    (o.status === 'pending' && o.pending_receipt_printed_at) ||
    (['completed', 'done'].includes(o.status) && o.delivered_receipt_printed_at)
  );

  // Instant client-side search & filtering (G20, G21)
  const filteredOrders = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const qClean = q.replace(/^#/, '');

    return orders.filter((o) => {
      if (doubleOnly && !possibleDoubleIds.has(o.id)) return false;

      const printed = isOrderPrinted(o);
      if (printFilter === 'printed' && !printed) return false;
      if (printFilter === 'unprinted' && printed) return false;

      if (q) {
        const matches = (
          (o.customer_name || '').toLowerCase().includes(q) ||
          String(o.id || '').toLowerCase().includes(qClean) ||
          String(o.receipt_number || '').toLowerCase().includes(q) ||
          orderRef(o).toLowerCase().includes(q)
        );
        if (!matches) return false;
      }

      return true;
    });
  }, [orders, searchQuery, doubleOnly, possibleDoubleIds, printFilter]);

  // Round 4 Fix 7 — same instant client-side matching filteredOrders applies, minus
  // duplicate detection (that needs the full loaded page of server orders, and a
  // just-created local order can't meaningfully be flagged against it yet) and date
  // range (a locally-created order's date is always "now", so it would only ever be
  // excluded by an unusual from/to combination — not worth the extra complexity for
  // what this fix is actually about: staying reachable from the list at all).
  const visibleLocalUnsyncedOrders = useMemo(() => {
    if (doubleOnly) return [];
    if (statusTab !== 'all' && statusTab !== 'pending') return [];
    const q = searchQuery.trim().toLowerCase();

    return localUnsyncedOrders.filter((o) => {
      const printed = isOrderPrinted(o);
      if (printFilter === 'printed' && !printed) return false;
      if (printFilter === 'unprinted' && printed) return false;

      if (q) {
        const matches = (
          (o.customer_name || '').toLowerCase().includes(q) ||
          String(o.receipt_number || '').toLowerCase().includes(q) ||
          orderRef(o).toLowerCase().includes(q)
        );
        if (!matches) return false;
      }

      return true;
    });
  }, [localUnsyncedOrders, statusTab, doubleOnly, searchQuery, printFilter]);

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

  const toggleSelected = (id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const allSelected = filteredOrders.length > 0 && filteredOrders.every((o) => selectedIds.has(o.id));

  const toggleSelectAll = () => {
    setSelectedIds(allSelected ? new Set() : new Set(filteredOrders.map((o) => o.id)));
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

  const confirmBulkDiscardDrafts = () => setBulkConfirm({
    label: 'Discard Selected',
    message: `The ${selectedIds.size} selected draft order(s) will be permanently removed. This cannot be undone.`,
    onConfirm: async () => {
      setBulkRunning(true);
      const ids = Array.from(selectedIds);
      const succeeded = [];
      const failed = [];
      for (const orderId of ids) {
        try {
          await api.del(`/orders/${orderId}`);
          succeeded.push(orderId);
        } catch (err) {
          failed.push({ id: orderId, reason: err.message || 'failed' });
        }
      }
      setBulkRunning(false);
      setBulkConfirm(null);
      setSelectedIds(new Set());
      load();
      loadDrafts();

      if (failed.length === 0) {
        addToast(`${succeeded.length} draft${succeeded.length === 1 ? '' : 's'} discarded.`, 'success');
      } else {
        const failMsg = failed.map((f) => `#${f.id} — ${f.reason}`).join(' · ');
        addToast(`${succeeded.length} of ${ids.length} drafts discarded. Failed: ${failMsg}`, 'error');
      }
    },
  });

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

  const selectedOrders        = filteredOrders.filter((o) => selectedIds.has(o.id));
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

      {/* Search, Filter controls, and Date range (G20, G21) */}
      <div className="flex flex-wrap items-center gap-3 mb-6">
        {/* Page-wide instant search (G20) */}
        <div className="relative flex-1 min-w-[220px] max-w-sm">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search orders by customer or #..."
            className="w-full h-10 pl-9 pr-8 border border-slate-300 rounded-lg text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-600 bg-white"
            aria-label="Search orders"
          />
          <span className="absolute left-3 top-2.5 text-slate-400 text-sm select-none pointer-events-none">🔍</span>
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery('')}
              className="absolute right-2.5 top-2 text-slate-400 hover:text-slate-600 p-0.5 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 text-xs font-bold"
              aria-label="Clear search"
            >
              ✕
            </button>
          )}
        </div>

        {/* Possible duplicates filter toggle pill (G21) */}
        <button
          type="button"
          onClick={() => setDoubleOnly((v) => !v)}
          aria-pressed={doubleOnly}
          className={`h-10 px-3.5 rounded-lg text-sm font-semibold border transition-colors flex items-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 whitespace-nowrap ${
            doubleOnly
              ? 'bg-amber-500 text-amber-950 border-amber-600 font-bold shadow-sm'
              : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
          }`}
        >
          <span>⚠️</span> Possible Duplicates
        </button>

        {/* Date range filters */}
        <div className="flex gap-2 items-center">
          <label className="text-sm text-slate-500 font-medium whitespace-nowrap">From</label>
          <input
            type="date"
            value={fromDate}
            onChange={(e) => setFromDate(e.target.value)}
            className="h-10 px-3 border border-slate-300 rounded-lg text-sm text-slate-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-600"
            aria-label="From date"
          />
        </div>
        <div className="flex gap-2 items-center">
          <label className="text-sm text-slate-500 font-medium whitespace-nowrap">To</label>
          <input
            type="date"
            value={toDate}
            onChange={(e) => setToDate(e.target.value)}
            className="h-10 px-3 border border-slate-300 rounded-lg text-sm text-slate-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-600"
            aria-label="To date"
          />
        </div>
        {(fromDate || toDate) && (
          <button
            onClick={() => { setFromDate(''); setToDate(''); }}
            className="h-10 px-4 text-sm font-medium text-slate-500 hover:text-slate-800 border border-slate-300 rounded-lg bg-white hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 whitespace-nowrap"
          >
            Clear dates
          </button>
        )}
      </div>

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
                <Button
                  size="sm"
                  variant={statusTab === 'draft' ? 'danger' : undefined}
                  onClick={bulkConfirm.onConfirm}
                  loading={bulkRunning}
                >
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
                {statusTab === 'draft' && (
                  <Button size="sm" variant="danger" onClick={confirmBulkDiscardDrafts}>
                    Discard Selected
                  </Button>
                )}
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
      ) : filteredOrders.length === 0 && visibleLocalUnsyncedOrders.length === 0 ? (
        <p className="text-center text-slate-400 text-base py-20">
          {orders.length === 0
            ? (statusTab === 'all' ? 'No orders yet.' : `No ${STATUS_LABEL[statusTab]?.toLowerCase()} orders.`)
            : 'No orders match the search and filter criteria.'}
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
                <th className="text-left px-5 py-3 font-semibold w-28">Receipt</th>
                <th className="text-left px-5 py-3 font-semibold">Customer</th>
                <th className="text-right px-5 py-3 font-semibold w-36">Total</th>
                <th className="text-left px-5 py-3 font-semibold hidden md:table-cell w-36">Date</th>
                <th className="text-left px-5 py-3 font-semibold w-64">
                  <div className="flex items-center justify-between gap-2">
                    <span>Status</span>
                    <select
                      value={printFilter}
                      onChange={(e) => setPrintFilter(e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                      className="text-xs font-medium border border-slate-300 rounded-md px-2 py-1 bg-white text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-600 cursor-pointer shadow-sm"
                      aria-label="Filter status by print state"
                    >
                      <option value="all">All</option>
                      <option value="printed">🖶 Printed</option>
                      <option value="unprinted">⚠️ Not Printed</option>
                    </select>
                  </div>
                </th>
                {statusTab === 'draft' && <th className="px-5 py-3 w-28" />}
              </tr>
            </thead>
            <tbody>
              {visibleLocalUnsyncedOrders.map((o) => (
                <tr
                  key={o.id}
                  onClick={() => navigate(`/orders/${o.receipt_number}`)}
                  className="border-t border-slate-300 hover:bg-blue-50 cursor-pointer transition-colors"
                >
                  {showCheckboxes && (
                    // Not selectable for bulk actions — there is no server row yet to
                    // act on (Dispatch/Cancel are disabled on its own detail page for
                    // exactly the same reason, G28).
                    <td className="px-5 py-4 w-12" />
                  )}
                  <td className="px-5 py-4 font-mono text-slate-500 text-sm w-28">{orderRef(o)}</td>
                  <td className="px-5 py-4">
                    <p className="font-semibold text-slate-900">{o.customer_name}</p>
                  </td>
                  <td className="px-5 py-4 text-right font-bold text-slate-900 tabular-nums w-36">
                    {PHP(Number(o.total_amount) + Number(o.adjustment || 0))}
                  </td>
                  <td className="px-5 py-4 text-sm text-slate-500 hidden md:table-cell w-36">
                    {new Date(o.created_at).toLocaleDateString('en-PH', {
                      month: 'short', day: 'numeric', year: 'numeric',
                    })}
                  </td>
                  <td className="px-5 py-4 w-64">
                    <div className="flex flex-wrap gap-1.5 items-center">
                      <span className="inline-flex items-center px-2.5 py-1 rounded-full text-sm font-semibold bg-amber-100 text-amber-800 border border-amber-300">
                        ⏳ Waiting to sync
                      </span>
                      {o.order_type === 'pickup' && (
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-sm font-semibold border bg-blue-100 text-blue-800 border-blue-300">
                          Pickup
                        </span>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {filteredOrders.map((o) => (
                <tr
                  key={o.id || o.receipt_number}
                  onClick={() => o.status === 'draft' ? openDraft(o) : navigate(`/orders/${o.id || o.receipt_number}`)}
                  className="border-t border-slate-300 hover:bg-blue-50 cursor-pointer transition-colors"
                >
                  {showCheckboxes && (
                    <td className="px-5 py-4 w-12" onClick={(e) => e.stopPropagation()}>
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
                  <td className="px-5 py-4 font-mono text-slate-500 text-sm w-28">{orderRef(o)}</td>
                  <td className="px-5 py-4">
                    <p className="font-semibold text-slate-900">{o.customer_name}</p>
                  </td>
                  <td className="px-5 py-4 text-right font-bold text-slate-900 tabular-nums w-36">
                    {PHP(Number(o.total_amount) + Number(o.adjustment || 0))}
                  </td>
                  <td className="px-5 py-4 text-sm text-slate-500 hidden md:table-cell w-36">
                    {new Date(o.created_at).toLocaleDateString('en-PH', {
                      month: 'short', day: 'numeric', year: 'numeric',
                    })}
                  </td>
                  <td className="px-5 py-4 w-64">
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
                      {possibleDoubleIds.has(o.id) && (
                        <span
                          className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-100 text-amber-900 px-2.5 py-0.5 text-xs font-bold"
                          title="Same customer, channel and total as another order — possibly the same sale printed twice."
                        >
                          ⚠️ possible duplicates
                        </span>
                      )}
                    </div>
                  </td>
                  {statusTab === 'draft' && (
                    <td className="px-5 py-4 text-right w-28" onClick={(e) => e.stopPropagation()}>
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

      {/* Bottom Pagination Bar */}
      <div className="mt-4 flex flex-col sm:flex-row items-center justify-between gap-4 bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
        <div className="text-sm font-medium text-slate-600">
          Showing {totalOrders === 0 ? 0 : (page - 1) * pageSize + 1}–{totalOrders === 0 ? 0 : Math.min(page * pageSize, totalOrders)} of {totalOrders} orders
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <label htmlFor="pageSizeSelect" className="text-sm text-slate-500 font-medium whitespace-nowrap">
              Per page:
            </label>
            <select
              id="pageSizeSelect"
              value={pageSize}
              onChange={(e) => {
                setPageSize(Number(e.target.value));
                setPage(1);
              }}
              className="h-10 min-h-[40px] px-3 py-1.5 border border-slate-300 rounded-lg text-sm text-slate-800 bg-white focus:outline-none focus:ring-2 focus:ring-blue-600 cursor-pointer shadow-sm"
              aria-label="Orders per page"
            >
              <option value={25}>25 per page</option>
              <option value={50}>50 per page</option>
              <option value={100}>100 per page</option>
            </select>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1 || loading}
              className="min-h-[48px] px-4 py-2 rounded-lg text-sm font-semibold border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-white transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 flex items-center justify-center shadow-sm"
              aria-label="Previous page"
            >
              &lt; Previous
            </button>

            <span className="text-sm font-medium text-slate-700 px-2 select-none whitespace-nowrap">
              Page {page} of {totalPages}
            </span>

            <button
              type="button"
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages || totalOrders === 0 || loading}
              className="min-h-[48px] px-4 py-2 rounded-lg text-sm font-semibold border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-white transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 flex items-center justify-center shadow-sm"
              aria-label="Next page"
            >
              Next &gt;
            </button>
          </div>
        </div>
      </div>

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
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" role="dialog" aria-modal="true">
          <div className="bg-white rounded-xl max-w-sm w-full mx-4 shadow-2xl p-6">
            <h2 className="text-lg font-bold text-slate-900 mb-2">Discard draft?</h2>
            <p className="text-sm text-slate-600 mb-5">
              The draft order for <span className="font-semibold">{discardConfirm.customer_name}</span> will be
              permanently removed. This can't be undone.
            </p>
            <div className="flex gap-3 justify-end">
              <Button variant="secondary" onClick={() => setDiscardConfirm(null)} disabled={discarding}>
                Keep
              </Button>
              <Button variant="danger" onClick={confirmDiscardDraft} loading={discarding}>
                Discard
              </Button>
            </div>
          </div>
        </div>
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

