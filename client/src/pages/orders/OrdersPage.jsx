import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useRefreshListener } from '../../offline/refresh';
import { api } from '../../api/client';
import { useToast } from '../../components/ui/Toast';
import Button from '../../components/ui/Button';
import Page, { SECTION_GAP } from '../../components/ui/Page';
import PageHeader from '../../components/ui/PageHeader';
import { ChipRow, Chip } from '../../components/ui/ChipRow';
import SearchFilterBar, { FilterField, FILTER_INPUT } from '../../components/ui/SearchFilterBar';
import ListCard, { CardCheckbox } from '../../components/ui/ListCard';
import { StatusBadge, TagBadge } from '../../components/ui/Badge';
import NavIcon from '../../components/layout/NavIcon';
import { PHP } from '../../utils/money';
import { Skeleton, SkeletonGroup } from '../../components/ui/Skeleton';
import OrderCreateModal from './OrderCreateModal';
import ReviewQueueModal from './ReviewQueueModal';
import { orderRef } from '../../utils/orderRef';
import { orderMatchesSearch } from '../../utils/orderSearch';
import { parseBareSequence } from '../../offline/receiptNumbers';
import { getPossibleDoubleOrderIds } from '../../utils/duplicateOrders';
import { filterLocalHistory, localOrderRoute } from '../../utils/localOrderHistory';
import { formatCardDateTime } from '../../utils/dateFormat';
import { handleStaleOrderWrite, orderStatusLabel } from './orderConcurrency.js';
import {
  listRecords, subscribeOutbox, getReceipt, listReceipts, putOrderSnapshot,
  loadParkedOrders, discardLocalDraft,
} from '../../offline/index.js';

const STATUS_TABS = [
  { value: 'all',        label: 'All' },
  { value: 'draft',      label: 'Drafts' },
  { value: 'pending',    label: 'Pending' },
  { value: 'in_transit', label: 'In Transit' },
  { value: 'completed',  label: 'Delivered' },
  { value: 'done',       label: 'Closed' },
  { value: 'cancelled',  label: 'Cancelled' },
];

// A YYYY-MM-DD filter value, as an active-filter chip says it: "Sep 1, 2026".
function fmtFilterDate(value) {
  const [y, m, d] = String(value).split('-').map(Number);
  if (!y || !m || !d) return value;
  return new Date(y, m - 1, d).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' });
}

// Matches the table's own column widths/padding (px-5 py-4 cells, w-28/w-36/w-64
// column widths) and the phone-card rows below it, so the real content lands in the
// same footprint once it arrives.
const isOrderPrinted = (o) => Boolean(
  (o.status === 'pending' && o.pending_receipt_printed_at) ||
  (['completed', 'done'].includes(o.status) && o.delivered_receipt_printed_at)
);

// The tablet table's Print Status column: "Printed" or "Not Printed", always a word
// (Q5). A draft has no receipt to print, so it reads as a dash.
function PrintStatus({ order }) {
  if (order.status === 'draft') return <span className="text-slate-500">—</span>;
  return <TagBadge kind={isOrderPrinted(order) ? 'printed' : 'notPrinted'} />;
}

// "Sep 5, 2026, 8:05 PM" for the tablet table's Date column (round-8 grill: date + time).
function formatTableDateTime(value) {
  const d = new Date(value);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-PH', {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

// The date and time on the right of an order card's badge line, under Sold by.
function CardDateTime({ value }) {
  return (
    <span className="block text-right text-sm text-slate-600 tabular-nums whitespace-nowrap">
      {formatCardDateTime(value)}
    </span>
  );
}

function OrdersTableSkeleton() {
  const rows = [0, 1, 2, 3, 4, 5];
  return (
    <SkeletonGroup label="Loading orders" className="bg-white rounded-xl border border-slate-200 overflow-hidden">
      <div className="lg:hidden divide-y divide-slate-200">
        {rows.map((i) => (
          <div key={i} className="p-4">
            <div className="flex items-start justify-between gap-2">
              <Skeleton className="h-4 w-20" />
              <Skeleton className="h-4 w-16" />
            </div>
            <div className="flex justify-between items-baseline gap-2 mt-2">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-3 w-20" />
            </div>
            <div className="flex justify-between items-center gap-2 mt-3">
              <Skeleton className="h-5 w-20 rounded-full" />
              <Skeleton className="h-3 w-24" />
            </div>
          </div>
        ))}
      </div>

      <table className="hidden lg:table w-full text-base">
        <thead>
          <tr className="bg-slate-50 border-b border-slate-400">
            <th className="px-4 py-3 w-28"><Skeleton className="h-3 w-14" /></th>
            <th className="px-4 py-3"><Skeleton className="h-3 w-16" /></th>
            <th className="px-4 py-3 w-28"><Skeleton className="h-3 w-14" /></th>
            <th className="px-4 py-3 w-32"><Skeleton className="h-3 w-12 ml-auto" /></th>
            <th className="px-4 py-3 w-40"><Skeleton className="h-3 w-12" /></th>
            <th className="px-4 py-3 w-36"><Skeleton className="h-3 w-14" /></th>
            <th className="px-4 py-3 w-48"><Skeleton className="h-3 w-14" /></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((i) => (
            <tr key={i} className="border-t border-slate-300">
              <td className="px-4 py-4 w-28"><Skeleton className="h-4 w-16" /></td>
              <td className="px-4 py-4"><Skeleton className="h-4 w-32" /></td>
              <td className="px-4 py-4 w-28"><Skeleton className="h-4 w-20" /></td>
              <td className="px-4 py-4 w-32"><Skeleton className="h-4 w-20 ml-auto" /></td>
              <td className="px-4 py-4 w-40"><Skeleton className="h-4 w-28" /></td>
              <td className="px-4 py-4 w-36"><Skeleton className="h-5 w-24 rounded-full" /></td>
              <td className="px-4 py-4 w-48"><Skeleton className="h-5 w-24 rounded-full" /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </SkeletonGroup>
  );
}

export default function OrdersPage() {
  const navigate = useNavigate();
  const { addToast } = useToast();

  const [orders, setOrders]       = useState([]);
  const [loading, setLoading]     = useState(true);
  // Slice 3.2 — true when the table below is being served from this device's own
  // synced order history because the server could not be reached.
  const [fromLocalHistory, setFromLocalHistory] = useState(false);
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
  // The snapshot/revision selected is the precondition reviewed by the operator. A
  // later delta never rewrites it under the selection; it marks that row stale.
  const [selectedSnapshots, setSelectedSnapshots] = useState(() => new Map());
  const [staleSelections, setStaleSelections] = useState(() => new Map());
  const [bulkConfirm, setBulkConfirm]     = useState(null);
  const [bulkRunning, setBulkRunning]     = useState(false);
  const [bulkOutcome, setBulkOutcome]     = useState(null);
  const [reviewPrompt, setReviewPrompt]   = useState(null);
  // { ids: number[], mode: 'pending' | 'in_transit' | 'delivered' } | null
  const [reviewQueue, setReviewQueue]     = useState(null);

  // Slice 3.2 — bulk transitions all POST to the server, so they are meaningless (and
  // would fail one by one) while the table is being served from local history. Hide the
  // selection column entirely rather than offering rows the operator cannot act on.
  const showCheckboxes = ['draft', 'pending', 'in_transit', 'completed'].includes(statusTab)
    && !fromLocalHistory;

  // Round 4 Fix 7 — locally-created orders (saveOrderLocalFirst, G27) are not on the
  // server yet, so the server-driven list above can never include them: navigating
  // away and back to `/orders` lost a freshly-created offline order entirely, landing
  // on a stale row's numeric id instead once the operator clicked back in. Same
  // pattern G29 already established for CustomersPage.jsx — read straight from the
  // outbox rather than the server, merge in, badge "Waiting to sync", and navigate by
  // receipt number (never a numeric id, since there isn't one yet).
  const [localUnsyncedOrders, setLocalUnsyncedOrders] = useState([]);
  const loadDraftsRef = useRef(null);
  // The Drafts tab's own list is served by load() (it is not a slice of the orders
  // list), so a drain that turns a local park into a server draft has to re-run THAT,
  // not just the banner — otherwise the row sits on "Waiting to sync" until the
  // operator happens to switch tabs.
  const loadRef       = useRef(null);
  const statusTabRef  = useRef(null);

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
    // A draft parked or drained by the outbox changes the parked-drafts list too, so
    // the banner and the Drafts tab follow it rather than waiting for a remount.
    return subscribeOutbox(() => {
      loadLocalUnsyncedOrders();
      loadDraftsRef.current?.();
      if (statusTabRef.current === 'draft') loadRef.current?.();
    });
  }, [loadLocalUnsyncedOrders]);

  const load = useCallback(({ silent = false } = {}) => {
    if (!silent) setLoading(true);

    // Criteria 5.1/5.6 — the Drafts tab is not a slice of the orders list, it is the
    // parked-drafts list, and it has to load blind. `GET /orders/sync` deliberately
    // never mirrors a draft (working state, not history), so the local-history
    // fallback the other tabs use could only ever come back empty here — which is
    // exactly what an offline operator saw. loadParkedOrders() is one code path for
    // both: the server's drafts when it answers (cached on the way past), the last
    // cached copy when it does not, unioned either way with the drafts this device
    // parked itself and still holds.
    if (statusTab === 'draft') {
      return loadParkedOrders()
        .then(({ drafts: parked, fromCache }) => {
          setFromLocalHistory(fromCache);
          const matched = filterLocalHistory(parked, {
            statusTab: 'draft', fromDate, toDate, search: debouncedSearch,
          });
          const start = (page - 1) * pageSize;
          setOrders(matched.slice(start, start + pageSize));
          setTotalOrders(matched.length);
          setTotalPages(Math.max(1, Math.ceil(matched.length / pageSize)));
        })
        .finally(() => { if (!silent) setLoading(false); });
    }

    const params = new URLSearchParams();
    if (statusTab !== 'all') params.set('status', statusTab);
    if (fromDate) params.set('from_date', fromDate);
    if (toDate)   params.set('to_date',   toDate);
    if (debouncedSearch.trim()) params.set('search', debouncedSearch.trim());
    params.set('page', String(page));
    params.set('limit', String(pageSize));

    return api.get(`/orders?${params}`)
      .then((res) => {
        setFromLocalHistory(false);
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
      .catch(async () => {
        // Slice 3.2 — the Orders Amnesia fix. This used to be a bare error toast that
        // left the directory empty, so relaunching the tablet during an outage erased
        // every past sale from view. The device now syncs the FULL order history ahead
        // of time (offline/sync.js), so the fallback is a real directory, not a
        // consolation: the same status/date/search filters applied to the local
        // snapshots, paginated the same way.
        try {
          const local = await listReceipts();
          const matched = filterLocalHistory(local, {
            statusTab, fromDate, toDate, search: debouncedSearch,
          });
          const start = (page - 1) * pageSize;
          setOrders(matched.slice(start, start + pageSize));
          setTotalOrders(matched.length);
          setTotalPages(Math.max(1, Math.ceil(matched.length / pageSize)));
          setFromLocalHistory(true);
        } catch {
          setFromLocalHistory(false);
          addToast('Failed to load orders', 'error');
        }
      })
      .finally(() => { if (!silent) setLoading(false); });
  }, [statusTab, fromDate, toDate, debouncedSearch, page, pageSize, addToast]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadRef.current = load; }, [load]);
  useEffect(() => { statusTabRef.current = statusTab; }, [statusTab]);

  // The purple banner reads the same merged list the Drafts tab does, so it survives an
  // outage instead of silently emptying (criterion 5.1). It used to fall back to this
  // device's synced order history, which by construction never contains a draft.
  const loadDrafts = useCallback(() => {
    return loadParkedOrders()
      .then(({ drafts: parked }) => setDrafts(parked))
      .catch(() => setDrafts([]));
  }, []);

  useEffect(() => { loadDrafts(); }, [loadDrafts]);
  useEffect(() => { loadDraftsRef.current = loadDrafts; }, [loadDrafts]);

  // Pull-down / re-tapping the menu item reloads orders and drafts — quietly, since
  // the refresh spinner at the top of the page is already saying so.
  useRefreshListener(() => Promise.all([
    loadRef.current?.({ silent: true }),
    loadDraftsRef.current?.(),
  ]));

  // ADR 0019 — the app-wide poll stores complete snapshots before emitting this event.
  // Refresh this filtered page without a spinner, explain rows that moved away, and
  // freeze any selected revision that changed until the operator removes it.
  useEffect(() => {
    const onOrdersChanged = (event) => {
      const changed = event.detail?.orders || [];
      for (const current of changed) {
        const selected = selectedSnapshots.get(current.id);
        if (selected && selected.status !== 'draft'
            && String(selected.revision) !== String(current.revision)) {
          setStaleSelections((prev) => new Map(prev).set(current.id, current));
          setBulkConfirm(null);
        }

        const visibleBefore = orders.find((row) => String(row.id) === String(current.id));
        if (visibleBefore && statusTab !== 'all' && statusTab !== 'draft'
            && current.status !== statusTab) {
          addToast(
            `${orderRef(current)} moved to ${orderStatusLabel(current.status)} and was removed from this view.`,
            'info'
          );
        }
      }
      loadRef.current?.({ silent: true });
      loadDraftsRef.current?.();
    };
    window.addEventListener('leyble:orders-changed', onOrdersChanged);
    return () => window.removeEventListener('leyble:orders-changed', onOrdersChanged);
  }, [orders, statusTab, selectedSnapshots, addToast]);

  // Reset page to 1 when filters or search criteria change
  useEffect(() => {
    setPage(1);
  }, [statusTab, fromDate, toDate, searchQuery, doubleOnly, printFilter]);

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
    setSelectedSnapshots(new Map());
    setStaleSelections(new Map());
    setBulkConfirm(null);
  }, []);

  useEffect(() => {
    clearSelection();
  }, [statusTab, page, clearSelection]);

  // Handing the selection to the review queue consumes it. OrdersPage stays mounted under
  // the queue, so every dispatch/close made inside it bumps a selected order's revision
  // and the orders-changed listener above would otherwise read the operator's own work
  // as a change from elsewhere (ADR 0019) and freeze bulk actions behind "Clear all".
  const openReviewQueue = (mode) => {
    setReviewQueue({ ids: Array.from(selectedIds), mode });
    clearSelection();
  };

  // D6 / G21 — Possible duplicate detection across loaded orders
  const possibleDoubleIds = useMemo(
    () => getPossibleDoubleOrderIds(orders),
    [orders]
  );

  // Instant client-side search & filtering (G20, G21)
  const filteredOrders = useMemo(() => {
    const q = searchQuery.trim();
    const qLower = q.toLowerCase();
    // Slice 3.2 — a still-queued order is written to local history at Save as well as
    // sitting in the outbox, so when the table is being served FROM local history it
    // would otherwise appear twice: once here and once in the "Waiting to sync" block
    // rendered above it. The outbox row is the better one (it carries the badge), so
    // drop the history copy rather than the other way round.
    const localUnsyncedRefs = new Set(
      localUnsyncedOrders.map((o) => String(o.receipt_number)).filter(Boolean)
    );

    return orders.filter((o) => {
      if (fromLocalHistory && o.receipt_number && localUnsyncedRefs.has(String(o.receipt_number))) return false;
      if (doubleOnly && !possibleDoubleIds.has(o.id)) return false;

      const printed = isOrderPrinted(o);
      if (printFilter === 'printed' && !printed) return false;
      if (printFilter === 'unprinted' && printed) return false;

      // ADR 0017 #11 — bare digits are a SEQUENCE, matched across every prefix, and
      // the same rule the server's `search` parameter applies (utils/orderSearch.js).
      const matchesSearch = orderMatchesSearch(o, q) || (o.sold_by_name || '').toLowerCase().includes(qLower);
      if (!matchesSearch) return false;

      return true;
    });
  }, [orders, searchQuery, doubleOnly, possibleDoubleIds, printFilter, fromLocalHistory, localUnsyncedOrders]);

  // Round 4 Fix 7 — same instant client-side matching filteredOrders applies, minus
  // duplicate detection (that needs the full loaded page of server orders, and a
  // just-created local order can't meaningfully be flagged against it yet) and date
  // range (a locally-created order's date is always "now", so it would only ever be
  // excluded by an unusual from/to combination — not worth the extra complexity for
  // what this fix is actually about: staying reachable from the list at all).
  const visibleLocalUnsyncedOrders = useMemo(() => {
    if (doubleOnly) return [];
    if (statusTab !== 'all' && statusTab !== 'pending') return [];
    const q = searchQuery.trim();
    const qLower = q.toLowerCase();

    return localUnsyncedOrders.filter((o) => {
      const printed = isOrderPrinted(o);
      if (printFilter === 'printed' && !printed) return false;
      if (printFilter === 'unprinted' && printed) return false;

      const matchesSearch = orderMatchesSearch(o, q) || (o.sold_by_name || '').toLowerCase().includes(qLower);
      if (!matchesSearch) return false;

      return true;
    });
  }, [localUnsyncedOrders, statusTab, doubleOnly, searchQuery, printFilter]);

  // ADR 0017 #11 — a bare-digit search is a lookup by SEQUENCE, and several parallel
  // series can hold the same one, so the answer is a disambiguation list. Non-null only
  // while the term is bare digits; the hint it drives stays silent for a name search.
  const searchedSequence = parseBareSequence(searchQuery);
  const matchCount = filteredOrders.length + visibleLocalUnsyncedOrders.length;

  const openDraft = async (o) => {
    // A draft this device parked is already complete in hand — it has no server row to
    // fetch, and it is the one kind of draft that IS editable offline (criterion 5.8:
    // created here, never synced).
    if (o._local) { setResumeDraft(o); return; }
    try {
      const full = await api.get(`/orders/${o.id}`);
      // A historical draft never rode the delta sync (GET /orders/sync deliberately
      // excludes drafts, working state not history) and this fetch used to discard its
      // result the moment it displayed — so a later outage had no snapshot to fall back
      // to and a live draft this device had opened moments earlier still failed offline.
      // Write it the same way OrderDetailPage.jsx does for every other order it sees.
      putOrderSnapshot(full).catch(() => {});
      setResumeDraft(full);
    } catch (err) {
      // Captain decision 2026-09-02: a historical (already-synced) draft is locked to
      // the same offline posture as any other synced order — no edit, no conversion to
      // a real order. So the offline fallback here is OrderDetailPage.jsx's read-only
      // view (via its own local-snapshot fallback), never the editable draft form.
      const offlineOrMissing = err.status === 404 || !err.status;
      if (offlineOrMissing && await getReceipt(o.id).catch(() => null)) {
        navigate(`/orders/${o.id}`);
        return;
      }
      addToast(
        err?.status ? (err.message || 'Failed to open draft.')
                    : 'Offline — this draft is on the server and needs a connection to open.',
        'error'
      );
    }
  };

  const confirmDiscardDraft = async () => {
    if (!discardConfirm) return;
    setDiscarding(true);
    try {
      // Same split as opening one: a locally parked draft is removed from this
      // device's outbox with no network at all; a server draft is a synced row and
      // deleting it stays online-only (ADR 0015 §5).
      if (discardConfirm._local) {
        await discardLocalDraft(discardConfirm.receipt_number);
      } else {
        await api.del(`/orders/${discardConfirm.id}`);
      }
      addToast('Draft discarded.', 'success');
      setDiscardConfirm(null);
      load();
      loadDrafts();
    } catch (err) {
      addToast(
        err?.status ? (err.message || 'Failed to discard draft.')
                    : 'Offline — this draft is on the server and needs a connection to discard.',
        'error'
      );
    } finally {
      setDiscarding(false);
    }
  };

  const toggleSelected = (id) => {
    const row = filteredOrders.find((order) => order.id === id);
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
    setSelectedSnapshots((prev) => {
      const next = new Map(prev);
      if (next.has(id)) next.delete(id); else if (row) next.set(id, row);
      return next;
    });
    setStaleSelections((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  };

  // A row still waiting to reach the server has no id to act on — same exclusion the
  // "Waiting to sync" order rows already carry (Round 4 Fix 7).
  const selectableOrders = filteredOrders.filter((o) => !o._local);

  const allSelected = selectableOrders.length > 0 && selectableOrders.every((o) => selectedIds.has(o.id));

  const toggleSelectAll = () => {
    if (allSelected) {
      clearSelection();
      return;
    }
    setSelectedIds(new Set(selectableOrders.map((o) => o.id)));
    setSelectedSnapshots(new Map(selectableOrders.map((o) => [o.id, o])));
    setStaleSelections(new Map());
  };

  const runBulkTransition = async (targetStatus, pastTenseLabel) => {
    if (staleSelections.size > 0) return [];
    setBulkRunning(true);
    const ids = Array.from(selectedIds);
    const succeeded = [];
    const failed = [];
    for (const orderId of ids) {
      const selected = selectedSnapshots.get(orderId);
      try {
        const updated = await api.post(`/orders/${orderId}/status`, {
          status: targetStatus,
          expected_status: selected?.status,
          revision: selected?.revision,
        });
        succeeded.push(updated);
      } catch (err) {
        let current = null;
        const stale = await handleStaleOrderWrite(err, {
          onCurrent: (order) => { current = order; },
        });
        failed.push({
          id: orderId,
          order: current || selected,
          stale,
          reason: stale ? 'changed on another device' : (err.message || 'failed'),
        });
      }
    }
    setBulkRunning(false);
    clearSelection();
    load({ silent: true });

    if (failed.length === 0) {
      setBulkOutcome(null);
      addToast(`${succeeded.length} order${succeeded.length === 1 ? '' : 's'} ${pastTenseLabel}.`, 'success');
    } else {
      setBulkOutcome({ succeeded: succeeded.length, total: ids.length, pastTenseLabel, failed });
      const failMsg = failed.map((f) => `${orderRef(f.order || { id: f.id })} — ${f.reason}`).join(' · ');
      addToast(
        `${succeeded.length} of ${ids.length} ${pastTenseLabel}; ${failed.length} skipped: ${failMsg}.`,
        'error'
      );
    }
    return succeeded.map((order) => order.id);
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
      clearSelection();
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

  const selectedOrders        = Array.from(selectedSnapshots.values());
  const selectionHasDeliveries = selectedOrders.some((o) => o.order_type !== 'pickup');
  const selectionHasPickups    = selectedOrders.some((o) => o.order_type === 'pickup');
  const selectionIsMixed       = selectionHasDeliveries && selectionHasPickups;

  // Design standard Q3: the dates and the print state live in the Filters panel, and
  // every one that is on shows under the search box as a chip with its own ✕.
  const activeFilters = [
    fromDate && { key: 'from', label: `From ${fmtFilterDate(fromDate)}`, onRemove: () => setFromDate('') },
    toDate && { key: 'to', label: `To ${fmtFilterDate(toDate)}`, onRemove: () => setToDate('') },
    printFilter !== 'all' && {
      key: 'print',
      label: printFilter === 'printed' ? 'Printed' : 'Not Printed',
      onRemove: () => setPrintFilter('all'),
    },
  ].filter(Boolean);

  return (
    <Page>
      <PageHeader title="Outgoing Orders" primary={{ label: '+ New Order', onClick: () => setCreating(true) }} />

      {/* Slice 3.2 — calm, factual, and never a blocker: the table below IS the real
          directory, just served from this device (ADR 0015 §9's banner tone). */}
      {fromLocalHistory && (
        <div className={`${SECTION_GAP} flex items-center gap-2 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3
                        text-base font-medium text-amber-900`}>
          <NavIcon name="clock" className="w-5 h-5 shrink-0" />
          <span>
            {statusTab === 'draft'
              ? "Offline — showing the drafts this device holds. Only drafts started here can be opened or edited."
              : "Offline — showing this device's saved order history. Status changes need a connection."}
          </span>
        </div>
      )}

      {/* Parked-drafts banner — visible from any tab so an in-progress order is never
          lost. One line (UI audit F14): the count and the way in; the names are on the
          Drafts tab itself, and ride along here only where there is room. */}
      {drafts.length > 0 && statusTab !== 'draft' && (
        <div className={`${SECTION_GAP} flex items-center justify-between gap-3 rounded-xl border border-violet-300
                        bg-violet-50 py-1.5 pl-4 pr-1.5`}>
          <p className="min-w-0 flex items-center gap-2 text-base font-semibold text-violet-900">
            <NavIcon name="draft" className="w-5 h-5 shrink-0" />
            <span className="truncate">
              {drafts.length} parked draft{drafts.length === 1 ? '' : 's'}
              <span className="hidden md:inline font-normal text-violet-800">
                {' '}· For: {drafts.map((d) => d.customer_name).join(', ')}
              </span>
            </span>
          </p>
          <Button size="sm" variant="secondary" onClick={() => setStatusTab('draft')} className="shrink-0">
            View drafts →
          </Button>
        </div>
      )}

      {/* Status chips (design standard Q4): one row that scrolls, never wraps. Possible
          Duplicates is the last chip, so it is always one tap away. */}
      <ChipRow label="Order status" className="mb-3">
        {STATUS_TABS.map((tab) => (
          <Chip
            key={tab.value}
            selected={statusTab === tab.value}
            onClick={() => setStatusTab(tab.value)}
            data-testid={`orders-tab-${tab.value}`}
          >
            {tab.label}
          </Chip>
        ))}
        <span aria-hidden="true" className="shrink-0 w-px my-2 bg-slate-300" />
        <Chip tone="amber" selected={doubleOnly} onClick={() => setDoubleOnly((v) => !v)}>
          <NavIcon name="warning" className="w-5 h-5" />
          Possible Duplicates
          {possibleDoubleIds.size > 0 && (
            <b className="ml-0.5 inline-flex min-w-[24px] h-6 items-center justify-center rounded-full bg-amber-200 px-1.5 text-sm text-amber-950">
              {possibleDoubleIds.size}
            </b>
          )}
        </Chip>
      </ChipRow>

      {/* Page-wide instant search (G20) — full width; dates and print state in Filters. */}
      <SearchFilterBar
        className={SECTION_GAP}
        inputType="text"
        value={searchQuery}
        onChange={setSearchQuery}
        placeholder="Name or #"
        ariaLabel="Search orders"
        testId="orders-search-input"
        active={activeFilters}
        panel={(
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <FilterField label="From">
              <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)}
                     className={FILTER_INPUT} aria-label="From date" />
            </FilterField>
            <FilterField label="To">
              <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)}
                     className={FILTER_INPUT} aria-label="To date" />
            </FilterField>
            <FilterField label="Print Status">
              <select value={printFilter} onChange={(e) => setPrintFilter(e.target.value)}
                      className={FILTER_INPUT} aria-label="Filter status by print state">
                <option value="all">All</option>
                <option value="printed">Printed</option>
                <option value="unprinted">Not Printed</option>
              </select>
            </FilterField>
          </div>
        )}
      />

      {/* Bulk action bar */}
      {showCheckboxes && selectedIds.size > 0 && (
        <div className={`sticky top-0 z-10 rounded-xl px-5 py-3 mb-4 flex items-center justify-between flex-wrap gap-3 border ${
          staleSelections.size > 0 ? 'bg-amber-50 border-amber-300' : 'bg-blue-50 border-blue-200'
        }`}>
          {staleSelections.size > 0 ? (
            <>
              <div className="min-w-0">
                <p className="text-sm font-bold text-amber-900">
                  Review changed {staleSelections.size === 1 ? 'order' : 'orders'} before continuing
                </p>
                <p className="mt-1 text-sm text-amber-800">
                  {Array.from(staleSelections.values()).map((current) =>
                    `${orderRef(current)} is now ${orderStatusLabel(current.status)}`
                  ).join(' · ')}. {selectedIds.size - staleSelections.size} unchanged {selectedIds.size - staleSelections.size === 1 ? 'order remains' : 'orders remain'} selected.
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {Array.from(staleSelections.values()).map((current) => (
                    <Button key={current.id} variant="secondary" size="sm" onClick={() => toggleSelected(current.id)}>
                      Remove {orderRef(current)} from batch
                    </Button>
                  ))}
                </div>
              </div>
              <Button variant="secondary" size="sm" onClick={clearSelection}>Clear all</Button>
            </>
          ) : bulkConfirm ? (
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
                <Button variant="secondary" size="sm" onClick={clearSelection}>
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
                    onClick={() => openReviewQueue('pending')}
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
                    onClick={() => openReviewQueue('in_transit')}
                  >
                    Review Selected
                  </Button>
                )}
                {statusTab === 'completed' && (
                  <Button size="sm" onClick={() => openReviewQueue('delivered')}>
                    Review Selected
                  </Button>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {bulkOutcome && (
        <div className="mb-4 rounded-xl border border-amber-300 bg-amber-50 px-5 py-4 text-amber-900" role="status">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm font-bold">
                {bulkOutcome.succeeded} of {bulkOutcome.total} {bulkOutcome.pastTenseLabel}; {bulkOutcome.failed.length} skipped
              </p>
              <p className="mt-1 text-sm">Open each skipped order to review the current server version.</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {bulkOutcome.failed.map((failure) => (
                  <Button
                    key={failure.id}
                    variant="secondary"
                    size="sm"
                    onClick={() => navigate(`/orders/${failure.order?.receipt_number || failure.id}`)}
                  >
                    Open {orderRef(failure.order || { id: failure.id })} — {failure.reason}
                  </Button>
                ))}
              </div>
            </div>
            <button
              type="button"
              onClick={() => setBulkOutcome(null)}
              aria-label="Dismiss bulk result"
              className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg text-2xl text-amber-700 hover:bg-amber-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
            >
              ×
            </button>
          </div>
        </div>
      )}

      {/* Table */}
      {loading ? (
        <OrdersTableSkeleton />
      ) : filteredOrders.length === 0 && visibleLocalUnsyncedOrders.length === 0 ? (
        <p className="text-center text-slate-500 text-base py-20">
          {orders.length === 0
            ? (statusTab === 'all' ? 'No orders yet.' : `No ${orderStatusLabel(statusTab)?.toLowerCase()} orders.`)
            : 'No orders match the search and filter criteria.'}
        </p>
      ) : (
        <>
        {/* ADR 0017 #11 — a bare number can belong to several series at once
            (1A-00042, 2B-00042, the pre-letter 3-00042), so say so rather than
            letting the extra rows read as a bug. The rows below carry the customer
            name and the date, which is what tells them apart. */}
        {searchedSequence !== null && matchCount > 1 && (
          <p className="mb-3 text-base text-slate-600" data-testid="orders-sequence-hint">
            {matchCount} orders numbered <strong>{searchedSequence}</strong> — check the
            customer and date.
          </p>
        )}
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden overflow-x-auto" data-testid="orders-list">
          {/* Phone and upright-tablet cards (D5; tables from 1024px, design standard Q1) —
              same rows/testids as the table below. Round-8 grill line order: left is
              customer, receipt number, badges; right is total, Sold by, date and time. */}
          <div className="lg:hidden divide-y divide-slate-200">
            {visibleLocalUnsyncedOrders.map((o) => (
              <ListCard
                key={o.id}
                onClick={() => navigate(`/orders/${o.receipt_number}`)}
                title={o.customer_name}
                titleRight={PHP(Number(o.total_amount) + Number(o.adjustment || 0))}
                meta={<span className="font-mono">{orderRef(o)}</span>}
                metaRight={`Sold by: ${o.sold_by_name?.trim() || '—'}`}
                badges={[
                  <TagBadge key="sync" kind="unsynced" />,
                  o.order_type === 'pickup' && <TagBadge key="pickup" kind="pickup" />,
                ]}
                badgesRight={<CardDateTime value={o.created_at} />}
              />
            ))}
            {filteredOrders.map((o) => (
              <ListCard
                key={o.id ?? `local-draft-${o._outboxId}`}
                onClick={() => o.status === 'draft'
                  ? openDraft(o)
                  : navigate(`/orders/${localOrderRoute(o)}`)}
                data-testid="orders-row"
                leading={showCheckboxes && !o._local && (
                  <CardCheckbox
                    checked={selectedIds.has(o.id)}
                    onChange={() => toggleSelected(o.id)}
                    label={`Select order #${o.id}`}
                  />
                )}
                title={o.customer_name}
                titleRight={PHP(Number(o.total_amount) + Number(o.adjustment || 0))}
                // orderRef() names a draft 'Draft' — a parked one by its own
                // device-issued number — so neither kind can show a row id.
                meta={<span className="font-mono">{orderRef(o)}</span>}
                metaRight={`Sold by: ${o.sold_by_name?.trim() || '—'}`}
                badges={[
                  <StatusBadge key="status" status={o.status} />,
                  o._local && <TagBadge key="sync" kind="unsynced" />,
                  o.order_type === 'pickup' && <TagBadge key="pickup" kind="pickup" />,
                  isOrderPrinted(o) && <TagBadge key="printed" kind="printed" />,
                  // A <div>, not <span>: the list-filters test counts the table's
                  // <span> badges, and this card copy must not double that count.
                  possibleDoubleIds.has(o.id) && <TagBadge key="dup" kind="duplicate" as="div" />,
                ]}
                badgesRight={(
                  <div className="flex flex-col items-end gap-2">
                    <CardDateTime value={o.created_at} />
                    {statusTab === 'draft' && (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={(e) => { e.stopPropagation(); setDiscardConfirm(o); }}
                      >
                        Discard
                      </Button>
                    )}
                  </div>
                )}
              />
            ))}
          </div>

          <table className="hidden lg:table w-full text-base">
            <thead>
              <tr className="bg-slate-50 text-slate-600 text-sm uppercase tracking-wider border-b border-slate-400 whitespace-nowrap">
                {showCheckboxes && (
                  <th className="px-4 py-3 w-12">
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
                <th className="text-left px-4 py-3 font-semibold w-28">Receipt</th>
                <th className="text-left px-4 py-3 font-semibold">Customer</th>
                <th className="text-left px-4 py-3 font-semibold w-28">Sold by</th>
                <th className="text-right px-4 py-3 font-semibold w-32">Total</th>
                <th className="text-left px-4 py-3 font-semibold w-40">Date</th>
                {/* Round-8 grill: print status is its own column. Its filter stays in
                    the Filters panel (design standard Q3), never in this header. */}
                <th className="text-left px-4 py-3 font-semibold w-36">Print Status</th>
                <th className="text-left px-4 py-3 font-semibold w-48">Status</th>
                {statusTab === 'draft' && <th className="px-4 py-3 w-28" />}
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
                    <td className="px-4 py-4 w-12" />
                  )}
                  <td className="px-4 py-4 font-mono text-slate-600 text-sm whitespace-nowrap w-28">{orderRef(o)}</td>
                  <td className="px-4 py-4">
                    <p className="font-semibold text-slate-900 break-words">{o.customer_name}</p>
                  </td>
                  <td className="px-4 py-4 text-sm text-slate-600 w-28">{o.sold_by_name?.trim() || '—'}</td>
                  <td className="px-4 py-4 text-right font-bold text-slate-900 tabular-nums whitespace-nowrap w-32">
                    {PHP(Number(o.total_amount) + Number(o.adjustment || 0))}
                  </td>
                  <td className="px-4 py-4 text-sm text-slate-600 tabular-nums w-40">
                    {formatTableDateTime(o.created_at)}
                  </td>
                  <td className="px-4 py-4 w-36"><PrintStatus order={o} /></td>
                  <td className="px-4 py-4 w-48">
                    <div className="flex flex-wrap gap-1.5 items-center">
                      <TagBadge kind="unsynced" />
                      {o.order_type === 'pickup' && <TagBadge kind="pickup" />}
                    </div>
                  </td>
                </tr>
              ))}
              {filteredOrders.map((o) => (
                <tr
                  key={o.id ?? `local-draft-${o._outboxId}`}
                  onClick={() => o.status === 'draft'
                    ? openDraft(o)
                    : navigate(`/orders/${localOrderRoute(o)}`)}
                  data-testid="orders-row"
                  className="border-t border-slate-300 hover:bg-blue-50 cursor-pointer transition-colors"
                >
                  {showCheckboxes && o._local && (
                    // Nothing to bulk-act on yet — this draft has no server row.
                    <td className="px-4 py-4 w-12" />
                  )}
                  {showCheckboxes && !o._local && (
                    <td className="px-4 py-4 w-12" onClick={(e) => e.stopPropagation()}>
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
                  {/* A parked draft has no row id yet, so its device-issued reference IS
                      its name here — never `#` from an id that does not exist. A server
                      draft has no number either (none is burned until it is finalized),
                      and orderRef() names that one 'Draft' rather than leaking `#<id>`. */}
                  <td className="px-4 py-4 font-mono text-slate-600 text-sm whitespace-nowrap w-28">
                    {orderRef(o)}
                  </td>
                  <td className="px-4 py-4">
                    <p className="font-semibold text-slate-900 break-words">{o.customer_name}</p>
                  </td>
                  <td className="px-4 py-4 text-sm text-slate-600 w-28">{o.sold_by_name?.trim() || '—'}</td>
                  <td className="px-4 py-4 text-right font-bold text-slate-900 tabular-nums whitespace-nowrap w-32">
                    {PHP(Number(o.total_amount) + Number(o.adjustment || 0))}
                  </td>
                  <td className="px-4 py-4 text-sm text-slate-600 tabular-nums w-40">
                    {formatTableDateTime(o.created_at)}
                  </td>
                  <td className="px-4 py-4 w-36"><PrintStatus order={o} /></td>
                  <td className="px-4 py-4 w-48">
                    <div className="flex flex-wrap gap-1.5 items-center">
                      <StatusBadge status={o.status} />
                      {o._local && <TagBadge kind="unsynced" />}
                      {o.order_type === 'pickup' && <TagBadge kind="pickup" />}
                      {possibleDoubleIds.has(o.id) && (
                        <TagBadge
                          kind="duplicate"
                          title="Same customer, channel and total as another order — possibly the same sale printed twice."
                        />
                      )}
                    </div>
                  </td>
                  {statusTab === 'draft' && (
                    <td className="px-4 py-4 text-right w-28" onClick={(e) => e.stopPropagation()}>
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
        </>
      )}

      {/* Bottom Pagination Bar */}
      <div className="mt-4 flex flex-col sm:flex-row items-center justify-between gap-3 bg-white p-3 md:p-4 rounded-xl border border-slate-200 shadow-sm">
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
              className="h-12 px-3 border border-slate-300 rounded-lg text-base text-slate-800 bg-white focus:outline-none focus:ring-2 focus:ring-blue-600 cursor-pointer shadow-sm"
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
          onClose={() => { setReviewQueue(null); clearSelection(); load(); }}
        />
      )}
    </Page>
  );
}

