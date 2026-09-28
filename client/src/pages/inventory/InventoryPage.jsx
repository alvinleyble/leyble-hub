import React, { useEffect, useState, useCallback } from 'react';
import { useRefreshListener } from '../../offline/refresh';
import { api } from '../../api/client';
import { useToast } from '../../components/ui/Toast';
import Button from '../../components/ui/Button';
import Page, { SECTION_GAP } from '../../components/ui/Page';
import PageHeader from '../../components/ui/PageHeader';
import { ChipRow, Chip } from '../../components/ui/ChipRow';
import SearchFilterBar from '../../components/ui/SearchFilterBar';
import ListCard, { CardCheckbox } from '../../components/ui/ListCard';
import { StockBadge, TagBadge } from '../../components/ui/Badge';
import { stockState } from '../../utils/statusBadges';
import { PHP } from '../../utils/money';
import { Skeleton, SkeletonGroup } from '../../components/ui/Skeleton';
import ProductFormModal from './ProductFormModal';
import ProductDetailPanel from './ProductDetailPanel';
import BatchPriceEditModal from './BatchPriceEditModal';
import PrinterPicker from '../orders/PrinterPicker';
import { usePrintList } from '../shared/usePrintList';
import { productListHtml } from '../shared/listPrintTemplate';
import { productListEscPos } from '../shared/listEscPos';
import { productMatches } from '../../utils/productSearch';
import { getCachedProducts, getCachedEntity } from '../../offline/catalogue.js';
import OfflineBanner from '../../components/ui/OfflineBanner';
import NavIcon from '../../components/layout/NavIcon';
import StockReconcileModal from './StockReconcileModal';
import { listConflicts, subscribeConflicts } from '../../offline/reconcile.js';
import { queuedProductsFromOutbox, pendingProductEditIds } from '../../offline/productMutations.js';
import { subscribeOutbox } from '../../offline/outbox.js';
import { checkIsOnline } from '../../offline/status.js';

// Reserves the same vertical space the category-chip row and the stock-filter
// segmented control occupy once categories are known, so their appearance after load
// doesn't push the table down a beat later.
function InventoryFiltersSkeleton() {
  return (
    <SkeletonGroup label="Loading filters" className="mb-3">
      <div className="flex gap-2 mb-3">
        <Skeleton className="h-12 w-32 rounded-full" />
        <Skeleton className="h-12 w-20 rounded-full" />
        <Skeleton className="h-12 w-36 rounded-full" />
      </div>
      <Skeleton className="h-12 w-72 rounded-full" />
    </SkeletonGroup>
  );
}

// Matches the grouped-category table's row padding/columns (Product, SKU, Price,
// Deposit, Btl/Case, Stock, Status) and its phone-card twin below it.
function InventoryTableSkeleton() {
  const rows = [0, 1, 2, 3, 4, 5];
  return (
    <SkeletonGroup label="Loading inventory" className="bg-white rounded-xl border border-slate-200 overflow-hidden">
      <div className="md:hidden divide-y divide-slate-200">
        {rows.map((i) => (
          <div key={i} className="p-4 flex items-start justify-between gap-3">
            <div className="min-w-0 space-y-1.5">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-3 w-16" />
            </div>
            <div className="text-right space-y-1.5 shrink-0">
              <Skeleton className="h-4 w-16 ml-auto" />
              <Skeleton className="h-4 w-10 ml-auto" />
            </div>
          </div>
        ))}
      </div>

      <table className="hidden md:table w-full text-base">
        <thead>
          <tr className="bg-slate-50 border-b border-slate-400">
            <th className="px-5 py-3"><Skeleton className="h-3 w-16" /></th>
            <th className="px-5 py-3 hidden sm:table-cell"><Skeleton className="h-3 w-10" /></th>
            <th className="px-5 py-3"><Skeleton className="h-3 w-16 ml-auto" /></th>
            <th className="px-5 py-3 hidden md:table-cell"><Skeleton className="h-3 w-16 ml-auto" /></th>
            <th className="px-5 py-3 hidden md:table-cell"><Skeleton className="h-3 w-12 ml-auto" /></th>
            <th className="px-5 py-3"><Skeleton className="h-3 w-12 ml-auto" /></th>
            <th className="px-5 py-3 hidden lg:table-cell"><Skeleton className="h-3 w-12" /></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((i) => (
            <tr key={i} className="border-t border-slate-300">
              <td className="px-5 py-4"><Skeleton className="h-4 w-36" /></td>
              <td className="px-5 py-4 hidden sm:table-cell"><Skeleton className="h-4 w-14" /></td>
              <td className="px-5 py-4"><Skeleton className="h-4 w-16 ml-auto" /></td>
              <td className="px-5 py-4 hidden md:table-cell"><Skeleton className="h-4 w-12 ml-auto" /></td>
              <td className="px-5 py-4 hidden md:table-cell"><Skeleton className="h-4 w-8 ml-auto" /></td>
              <td className="px-5 py-4"><Skeleton className="h-4 w-10 ml-auto" /></td>
              <td className="px-5 py-4 hidden lg:table-cell"><Skeleton className="h-5 w-16 rounded-full" /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </SkeletonGroup>
  );
}

export default function InventoryPage() {
  const { addToast } = useToast();

  const [products, setProducts]         = useState([]);
  const [loading, setLoading]           = useState(true);
  const [search, setSearch]             = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [stockFilter, setStockFilter]   = useState('all');
  const [creating, setCreating]         = useState(false);
  const [selectedId, setSelectedId]     = useState(null);

  // Batch price edit
  const [batchMode, setBatchMode]         = useState(false);
  const [selectedIds, setSelectedIds]     = useState(() => new Set());
  const [batchEditOpen, setBatchEditOpen] = useState(false);

  const [fromCache, setFromCache]       = useState(false);
  const [queuedProducts, setQueued]     = useState([]);
  const [pendingEditIds, setPendingEditIds] = useState(() => new Set());
  const [conflicts, setConflicts]       = useState([]);
  const [reconcileOpen, setReconcileOpen] = useState(false);

  // Offline fallback — Slice 3.2's catalogue sync already holds this device's copy of
  // products (client/src/offline/catalogue.js), the same cache OrderCreateModal reads
  // from; this page just never asked for it, so a blind tablet showed a blank grid.
  const load = useCallback((silent = false) => {
    if (!silent) setLoading(true);
    return api.get(`/products${showInactive ? '?include_inactive=true' : ''}`)
      .then((rows) => { setProducts(rows); setFromCache(false); })
      .catch(async () => {
        const cached = showInactive ? await getCachedEntity('products') : await getCachedProducts();
        if (cached.length === 0) {
          addToast('Offline and this device has no product catalogue yet — connect once to set it up.', 'error');
          return;
        }
        setProducts(cached);
        setFromCache(true);
      })
      .finally(() => {
        if (!silent) setLoading(false);
      });
  }, [showInactive, addToast]);

  useEffect(() => { load(); }, [load]);

  // 7.7 — coming back online has to put the live list back on screen. Without this the
  // page kept the held copy, and its amber "Viewing offline data" banner, until someone
  // happened to change a filter — while the chrome marker already said Online. The
  // reload is silent (no spinner) for the same reason OrderDetailPage's is: the rows
  // are already correct, only their provenance changed.
  useEffect(() => {
    const refresh = () => load(true);
    if (typeof window === 'undefined') return undefined;
    window.addEventListener('online', refresh);
    window.addEventListener('leyble:drain-complete', refresh);
    return () => {
      window.removeEventListener('online', refresh);
      window.removeEventListener('leyble:drain-complete', refresh);
    };
  }, [load]);

  // ADR 0015 §6 — a product added while blind has no server row yet, so a purely
  // server-driven grid would simply not show it (same rule as queued customers).
  // Criteria 7.5 — both halves of the sync-status affordance come from the outbox:
  // products CREATED here that have no server row yet, and existing products carrying
  // an EDIT that has not drained. The second was the invisible one — the grid happily
  // showed the operator's new price with nothing to say it was still sitting on this
  // tablet.
  const loadQueued = useCallback(async () => {
    const [created, editIds] = await Promise.all([
      queuedProductsFromOutbox(),
      pendingProductEditIds(),
    ]);
    setQueued(created);
    setPendingEditIds(editIds);
  }, []);

  useEffect(() => {
    loadQueued();
    return subscribeOutbox(() => loadQueued());
  }, [loadQueued]);

  // §6's mandatory human reconciliation. The prompt lives HERE, on the screen where
  // stock and prices are actually decided, rather than in the chrome-wide offline
  // marker: the marker is a display surface gated behind V25_OFFLINE_CORE, and a
  // pending question about the real contents of the warehouse must not be able to
  // disappear with a build flag.
  const refreshConflicts = useCallback(async () => {
    setConflicts(await listConflicts().catch(() => []));
  }, []);

  useEffect(() => {
    refreshConflicts();
    return subscribeConflicts(() => refreshConflicts());
  }, [refreshConflicts]);

  // Pull-down / re-tapping the menu item — silent for the same reason as the
  // reconnect reload above.
  useRefreshListener(() => Promise.all([load(true), loadQueued(), refreshConflicts()]));

  const {
    printList, printing,
    pickerVisible, pickerDevices, pickerLoading, pickerCurrent, printPending,
    savePrinter, scanWifi, testPrint, closePicker,
  } = usePrintList();

  const displayProducts = [...queuedProducts, ...products];

  // Prints the full active product list (ignores on-screen search/filters) — Dad wants them all.
  // A product added while blind prints alongside the rest: 7.5 says it is real from the
  // moment it is saved, and a count sheet that silently omits it is the opposite of that.
  const handlePrintList = () =>
    printList(productListHtml(displayProducts), productListEscPos(displayProducts));

  const allCategories = [...new Set(displayProducts.map((p) => p.category ?? 'Uncategorised'))].sort();

  const filtered = displayProducts.filter((p) => {
    const matchSearch = productMatches(p, search);
    const matchCategory =
      categoryFilter === 'all' || (p.category ?? 'Uncategorised') === categoryFilter;
    const matchStock =
      stockFilter === 'all' ||
      stockState(p.current_stock) === stockFilter;
    return matchSearch && matchCategory && matchStock;
  });

  const grouped = filtered.reduce((acc, p) => {
    const cat = p.category ?? 'Uncategorised';
    if (!acc[cat]) acc[cat] = [];
    acc[cat].push(p);
    return acc;
  }, {});

  const categories = Object.keys(grouped).sort();

  const toggleSelected = (id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  // A still-queued product has no server row to batch-edit, so it is excluded from
  // selection entirely rather than silently failing at save time.
  const selectableFiltered = filtered.filter((p) => !p._unsynced);
  const allSelected = selectableFiltered.length > 0 && selectableFiltered.every((p) => selectedIds.has(p.id));
  const toggleSelectAll = () => {
    setSelectedIds(allSelected ? new Set() : new Set(selectableFiltered.map((p) => p.id)));
  };

  const exitBatchMode = () => { setBatchMode(false); setSelectedIds(new Set()); };

  const selectedProducts = products.filter((p) => selectedIds.has(p.id));

  const conflictCount = conflicts.length;

  const openProduct = (p) => {
    // A still-queued product has no server row yet, so the detail panel would have
    // nothing to GET. Say so, rather than swallowing the tap — the same answer the
    // customer directory gives for a queued customer.
    if (p._unsynced) {
      addToast('Product is queued for sync — details and editing will be available once connected.', 'info');
      return;
    }
    setSelectedId(p.id);
  };

  const STOCK_CHIPS = [
    { value: 'all', label: 'All stock' },
    { value: 'low', label: 'Low stock', tone: 'amber' },
    { value: 'out', label: 'Out of stock', tone: 'red' },
  ];

  return (
    <Page>
      {/* ── Header (design standard Q2/Q9): Print List and Batch Edit Prices are in
          the ⋮ menu on phones and upright tablets, plain buttons on a landscape one. */}
      <PageHeader
        title="Inventory"
        primary={{ label: '+ Add Product', onClick: () => setCreating(true) }}
        actions={[
          { label: 'Print List', icon: 'printer', onClick: handlePrintList, loading: printing,
            disabled: displayProducts.length === 0 },
          batchMode
            ? { label: 'Cancel Batch Edit', icon: 'close', onClick: exitBatchMode }
            : { label: 'Batch Edit Prices', icon: 'edit', onClick: () => setBatchMode(true),
                disabled: products.length === 0 },
        ]}
      />

      {/* ── Stock/price reconciliation (ADR 0015 §6) ─────────────── */}
      {conflictCount > 0 && (
        <div
          role="status"
          className={`${SECTION_GAP} flex flex-col sm:flex-row sm:items-center gap-3 rounded-xl border-2 border-amber-500
                     bg-amber-50 px-4 py-3 md:px-5 md:py-4`}
        >
          <NavIcon name="scale" className="w-7 h-7 shrink-0 text-amber-800" />
          <div className="min-w-0 flex-1">
            <p className="text-base font-bold text-amber-900">
              {conflictCount} stock or price {conflictCount === 1 ? 'change needs' : 'changes need'} your confirmation
            </p>
            <p className="text-sm text-amber-900 mt-0.5">
              Another tablet changed the same value while this one was offline. Nothing is
              saved until you pick the right one.
            </p>
          </div>
          <Button className="shrink-0" onClick={() => setReconcileOpen(true)}>
            Review now
          </Button>
        </div>
      )}

      {fromCache && <OfflineBanner />}

      {/* ── Search + Filters (Q3): search gets the whole row; "Show inactive" lives in
          the Filters panel instead of squeezing it (UI audit F6). */}
      <SearchFilterBar
        className="mb-3"
        value={search}
        onChange={setSearch}
        placeholder="Name or SKU"
        ariaLabel="Search products"
        testId="inventory-search-input"
        active={showInactive ? [{ key: 'inactive', label: 'Showing inactive', onRemove: () => setShowInactive(false) }] : []}
        panel={(
          <label className="flex items-center gap-3 min-h-[48px] cursor-pointer select-none">
            <input
              type="checkbox"
              checked={showInactive}
              onChange={(e) => setShowInactive(e.target.checked)}
              className="w-6 h-6 accent-blue-700"
            />
            <span className="text-base text-slate-800 font-medium">Show inactive products</span>
          </label>
        )}
      />

      {loading ? (
        <InventoryFiltersSkeleton />
      ) : (
        <>
          {/* ── Category chips (Q4): one row that scrolls, with a faded edge while
              more categories sit off-screen. */}
          {allCategories.length > 1 && (
            <ChipRow label="Category" className="mb-3">
              {['all', ...allCategories].map((cat) => (
                <Chip key={cat} selected={categoryFilter === cat} onClick={() => setCategoryFilter(cat)}>
                  {cat === 'all' ? 'All Categories' : cat}
                </Chip>
              ))}
            </ChipRow>
          )}

          {/* ── Stock chips — the same chip as the row above, so it reads as one kind
              of control; Low/Out turn amber/red when chosen, with the word on them. */}
          <ChipRow label="Stock" className={SECTION_GAP}>
            {STOCK_CHIPS.map((opt) => (
              <Chip key={opt.value} tone={opt.tone} selected={stockFilter === opt.value}
                    onClick={() => setStockFilter(opt.value)}>
                {opt.label}
              </Chip>
            ))}
          </ChipRow>
        </>
      )}

      {/* ── Bulk action bar ─────────────────────────────────────── */}
      {batchMode && selectedIds.size > 0 && (
        <div className="sticky top-0 z-10 bg-blue-50 border border-blue-200 rounded-xl px-4 py-3 mb-4
                        flex items-center justify-between flex-wrap gap-3">
          <p className="text-base font-semibold text-blue-900">
            {selectedIds.size} product{selectedIds.size === 1 ? '' : 's'} selected
          </p>
          <div className="flex gap-2 shrink-0">
            <Button variant="secondary" size="sm" onClick={() => setSelectedIds(new Set())}>
              Clear
            </Button>
            <Button size="sm" onClick={() => setBatchEditOpen(true)}>
              Edit Prices →
            </Button>
          </div>
        </div>
      )}

      {/* ── List ─────────────────────────────────────────────────── */}
      {loading ? (
        <InventoryTableSkeleton />
      ) : filtered.length === 0 ? (
        <p className="text-center text-slate-500 text-base py-20">
          {search ? 'No products match your search.' : 'No products yet. Add one to get started.'}
        </p>
      ) : (
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden overflow-x-auto" data-testid="inventory-list">
          {/* Phone + upright-tablet cards (D5, Q1 switch at 768px) — same rows/testids as
              the table below. Price and stock are both labelled (UI audit F4), and a
              stock state is a worded badge, never just a coloured number. */}
          <div className="md:hidden divide-y divide-slate-200">
            {categories.map((cat) => (
              <React.Fragment key={cat}>
                <div className="bg-slate-100 border-y border-slate-300 px-4 py-2 text-sm font-bold text-slate-600 uppercase tracking-wide">
                  {cat}
                </div>
                {grouped[cat].map((p) => (
                  <ListCard
                    key={p.id}
                    onClick={() => openProduct(p)}
                    data-testid="inventory-row"
                    leading={batchMode && (
                      <CardCheckbox
                        checked={selectedIds.has(p.id)}
                        disabled={p._unsynced}
                        onChange={() => toggleSelected(p.id)}
                        label={`Select ${p.name}`}
                      />
                    )}
                    title={<span className={p.is_active ? '' : 'text-slate-500 line-through'}>{p.name}</span>}
                    titleRight={<>{PHP(p.base_wholesale_price)}<span className="text-sm font-normal text-slate-600"> / {p.unit || 'case'}</span></>}
                    meta={<span className="font-mono">{p.sku ?? p.unit}</span>}
                    metaRight={<>In stock: <b className="text-base text-slate-900 tabular-nums">{p.current_stock}</b> {p.unit}</>}
                    badges={[
                      !p.is_active && <TagBadge key="inactive" kind="inactive" />,
                      stockState(p.current_stock) && <StockBadge key="stock" stock={p.current_stock} />,
                      (p._unsynced || pendingEditIds.has(String(p.id))) && <TagBadge key="sync" kind="unsynced" />,
                    ]}
                  />
                ))}
              </React.Fragment>
            ))}
          </div>

          <table className="hidden md:table w-full text-base">
            <thead>
              <tr className="bg-slate-50 text-slate-600 text-sm uppercase tracking-wider border-b border-slate-400">
                {batchMode && (
                  <th className="px-4 lg:px-5 py-3 w-12">
                    <label className="flex items-center justify-center w-12 h-12 -m-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={allSelected}
                        onChange={toggleSelectAll}
                        className="w-6 h-6 rounded border-slate-300 text-blue-700
                                   focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
                        aria-label="Select all products"
                      />
                    </label>
                  </th>
                )}
                <th className="text-left px-4 lg:px-5 py-3 font-semibold">Product</th>
                <th className="text-left px-4 lg:px-5 py-3 font-semibold hidden lg:table-cell">SKU</th>
                <th className="text-right px-4 lg:px-5 py-3 font-semibold">Price / Case</th>
                <th className="text-right px-4 lg:px-5 py-3 font-semibold hidden lg:table-cell">Deposit / Bottle</th>
                <th className="text-right px-4 lg:px-5 py-3 font-semibold hidden lg:table-cell">Btl / Case</th>
                <th className="text-right px-4 lg:px-5 py-3 font-semibold">Stock</th>
                <th className="text-left px-4 lg:px-5 py-3 font-semibold">Status</th>
              </tr>
            </thead>
            <tbody>
              {categories.map((cat) => (
                <React.Fragment key={cat}>
                  <tr className="bg-slate-100 border-y border-slate-300">
                    <td
                      colSpan={batchMode ? 8 : 7}
                      className="px-4 lg:px-5 py-2 text-sm font-bold text-slate-600 uppercase tracking-wide"
                    >
                      {cat}
                    </td>
                  </tr>

                  {grouped[cat].map((p) => (
                    <tr
                      key={p.id}
                      onClick={() => openProduct(p)}
                      data-testid="inventory-row"
                      className="border-t border-slate-300 hover:bg-blue-50 cursor-pointer transition-colors"
                    >
                      {batchMode && (
                        <td className="px-4 lg:px-5 py-4" onClick={(e) => e.stopPropagation()}>
                          <label className="flex items-center justify-center w-12 h-12 -m-2 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={selectedIds.has(p.id)}
                              disabled={p._unsynced}
                              onChange={() => toggleSelected(p.id)}
                              className="w-6 h-6 rounded border-slate-300 text-blue-700
                                         focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
                              aria-label={`Select ${p.name}`}
                            />
                          </label>
                        </td>
                      )}
                      <td className="px-4 lg:px-5 py-4">
                        <p className={`font-semibold ${p.is_active ? 'text-slate-900' : 'text-slate-500 line-through'}`}>
                          {p.name}
                          {(p._unsynced || pendingEditIds.has(String(p.id))) && (
                            <TagBadge kind="unsynced" className="ml-2 align-middle" />
                          )}
                        </p>
                        <p className="text-sm text-slate-600 mt-0.5">
                          <span className="lg:hidden font-mono">{p.sku ?? '—'} · </span>{p.unit}
                        </p>
                      </td>
                      <td className="px-4 lg:px-5 py-4 text-slate-600 font-mono text-sm hidden lg:table-cell">
                        {p.sku ?? '—'}
                      </td>
                      <td className="px-4 lg:px-5 py-4 text-right font-semibold text-slate-900 tabular-nums whitespace-nowrap">
                        {PHP(p.base_wholesale_price)}
                      </td>
                      <td className="px-4 lg:px-5 py-4 text-right text-slate-600 tabular-nums hidden lg:table-cell">
                        {Number(p.deposit_fee) > 0 ? PHP(p.deposit_fee) : '—'}
                      </td>
                      <td className="px-4 lg:px-5 py-4 text-right text-slate-600 tabular-nums hidden lg:table-cell">
                        {p.units_per_case}
                      </td>
                      <td className="px-4 lg:px-5 py-4 text-right tabular-nums whitespace-nowrap">
                        <span className="font-bold text-base text-slate-900">{p.current_stock}</span>
                        <span className="text-sm text-slate-600 ml-1">{p.unit}</span>
                      </td>
                      <td className="px-4 lg:px-5 py-4">
                        {/* Status + stock state as words (Q5): Inactive, Low stock, Out of stock. */}
                        <div className="flex flex-wrap gap-1.5">
                          {p.is_active ? <TagBadge kind="active" /> : <TagBadge kind="inactive" />}
                          <StockBadge stock={p.current_stock} />
                        </div>
                      </td>
                    </tr>
                  ))}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Modals / Panels ──────────────────────────────────────── */}
      {creating && (
        <ProductFormModal
          offline={fromCache || !checkIsOnline()}
          onClose={() => setCreating(false)}
          onSaved={() => { setCreating(false); load(true); }}
        />
      )}

      {selectedId !== null && (
        <ProductDetailPanel
          productId={selectedId}
          cachedProduct={products.find((p) => String(p.id) === String(selectedId)) || null}
          onClose={() => setSelectedId(null)}
          onSaved={() => load(true)}
        />
      )}

      {batchEditOpen && (
        <BatchPriceEditModal
          products={selectedProducts}
          onClose={() => setBatchEditOpen(false)}
          onSaved={() => { setBatchEditOpen(false); exitBatchMode(); load(true); }}
        />
      )}

      {reconcileOpen && (
        <StockReconcileModal
          onClose={() => { setReconcileOpen(false); load(true); }}
          onResolvedAll={() => setReconcileOpen(false)}
        />
      )}

      {pickerVisible && (
        <PrinterPicker
          devices={pickerDevices}
          loading={pickerLoading}
          current={pickerCurrent}
          printPending={printPending}
          onSave={savePrinter}
          onScanWifi={scanWifi}
          onTestPrint={testPrint}
          onClose={closePicker}
        />
      )}
    </Page>
  );
}
