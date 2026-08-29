import React, { useEffect, useState, useCallback } from 'react';
import { api } from '../../api/client';
import { useToast } from '../../components/ui/Toast';
import Button from '../../components/ui/Button';
import Spinner from '../../components/ui/Spinner';
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
import StockReconcileModal from './StockReconcileModal';
import { listConflicts, subscribeConflicts } from '../../offline/reconcile.js';
import { queuedProductsFromOutbox, pendingProductEditIds } from '../../offline/productMutations.js';
import { subscribeOutbox } from '../../offline/outbox.js';
import { checkIsOnline } from '../../offline/status.js';

const PHP = (n) =>
  `₱${Number(n).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

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
    api.get(`/products${showInactive ? '?include_inactive=true' : ''}`)
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
      (stockFilter === 'out'  && p.current_stock <= 0) ||
      (stockFilter === 'low'  && p.current_stock > 0 && p.current_stock <= 10);
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

  return (
    <div className="p-6 max-w-7xl mx-auto">
      {/* ── Header ───────────────────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
        <h1 className="text-2xl font-bold text-slate-900">Inventory</h1>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={handlePrintList} loading={printing} disabled={displayProducts.length === 0}>
            🖶 Print List
          </Button>
          {batchMode ? (
            <Button variant="secondary" onClick={exitBatchMode}>Cancel Batch Edit</Button>
          ) : (
            <Button variant="secondary" onClick={() => setBatchMode(true)} disabled={products.length === 0}>
              Batch Edit Prices
            </Button>
          )}
          <Button onClick={() => setCreating(true)}>+ Add Product</Button>
        </div>
      </div>

      {/* ── Stock/price reconciliation (ADR 0015 §6) ─────────────── */}
      {conflictCount > 0 && (
        <div
          role="status"
          className="flex flex-col sm:flex-row sm:items-center gap-3 rounded-xl border-2 border-amber-500
                     bg-amber-50 px-5 py-4 mb-6"
        >
          <span className="text-2xl leading-none shrink-0" aria-hidden="true">⚖️</span>
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

      {/* ── Filters ──────────────────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row gap-3 mb-6">
        <input
          type="search"
          placeholder="Search by name, category, or SKU…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="flex-1 h-12 px-4 border border-slate-300 rounded-lg text-base text-slate-900
                     focus:outline-none focus:ring-2 focus:ring-blue-600"
          aria-label="Search products"
        />
        <label className="flex items-center gap-3 h-12 px-4 border border-slate-300 rounded-lg
                          bg-white cursor-pointer select-none">
          <input
            type="checkbox"
            checked={showInactive}
            onChange={(e) => setShowInactive(e.target.checked)}
            className="w-6 h-6 accent-blue-700"
          />
          <span className="text-base text-slate-700 font-medium whitespace-nowrap">Show inactive</span>
        </label>
      </div>

      {/* ── Category chips ───────────────────────────────────────── */}
      {!loading && allCategories.length > 1 && (
        <div className="flex flex-wrap gap-1.5 mb-3">
          {['all', ...allCategories].map((cat) => (
            <button
              key={cat}
              onClick={() => setCategoryFilter(cat)}
              className={`px-3 py-1.5 rounded-full text-sm font-semibold border transition-colors
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600
                ${categoryFilter === cat
                  ? 'bg-blue-700 text-white border-blue-700'
                  : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'}`}
            >
              {cat === 'all' ? 'All Categories' : cat}
            </button>
          ))}
        </div>
      )}

      {/* ── Stock status filter ───────────────────────────────────── */}
      {!loading && (
        <div className="flex gap-1.5 mb-5">
          {[
            { value: 'all', label: 'All Stock' },
            { value: 'low', label: 'Low Stock' },
            { value: 'out', label: 'Out of Stock' },
          ].map((opt) => (
            <button
              key={opt.value}
              onClick={() => setStockFilter(opt.value)}
              className={`px-3 py-1.5 rounded-full text-sm font-semibold border transition-colors
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600
                ${stockFilter === opt.value
                  ? opt.value === 'out' ? 'bg-red-600 text-white border-red-600'
                    : opt.value === 'low' ? 'bg-amber-500 text-white border-amber-500'
                    : 'bg-slate-700 text-white border-slate-700'
                  : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'}`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}

      {/* ── Bulk action bar ─────────────────────────────────────── */}
      {batchMode && selectedIds.size > 0 && (
        <div className="sticky top-0 z-10 bg-blue-50 border border-blue-200 rounded-xl px-5 py-3 mb-4
                        flex items-center justify-between flex-wrap gap-3">
          <p className="text-sm font-semibold text-blue-900">
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

      {/* ── Table ────────────────────────────────────────────────── */}
      {loading ? (
        <div className="flex items-center justify-center h-64">
          <Spinner size="lg" />
        </div>
      ) : filtered.length === 0 ? (
        <p className="text-center text-slate-400 text-base py-20">
          {search ? 'No products match your search.' : 'No products yet. Add one to get started.'}
        </p>
      ) : (
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden overflow-x-auto">
          <table className="w-full text-base">
            <thead>
              <tr className="bg-slate-50 text-slate-500 text-sm uppercase tracking-wider border-b border-slate-400">
                {batchMode && (
                  <th className="px-5 py-3 w-12">
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
                <th className="text-left px-5 py-3 font-semibold">Product</th>
                <th className="text-left px-5 py-3 font-semibold hidden sm:table-cell">SKU</th>
                <th className="text-right px-5 py-3 font-semibold">Price / Case</th>
                <th className="text-right px-5 py-3 font-semibold hidden md:table-cell">Deposit / Bottle</th>
                <th className="text-right px-5 py-3 font-semibold hidden md:table-cell">Btl / Case</th>
                <th className="text-right px-5 py-3 font-semibold">Stock</th>
                <th className="text-left px-5 py-3 font-semibold hidden lg:table-cell">Status</th>
              </tr>
            </thead>
            <tbody>
              {categories.map((cat) => (
                <React.Fragment key={cat}>
                  <tr className="bg-slate-100 border-y border-slate-300">
                    <td
                      colSpan={batchMode ? 8 : 7}
                      className="px-5 py-2 text-xs font-bold text-slate-400 uppercase tracking-widest"
                    >
                      {cat}
                    </td>
                  </tr>

                  {grouped[cat].map((p) => (
                    <tr
                      key={p.id}
                      onClick={() => {
                        // A still-queued product has no server row yet, so the detail
                        // panel would have nothing to GET. Say so, rather than
                        // swallowing the tap — the same answer the customer directory
                        // gives for a queued customer.
                        if (p._unsynced) {
                          addToast('Product is queued for sync — details and editing will be available once connected.', 'info');
                          return;
                        }
                        setSelectedId(p.id);
                      }}
                      className="border-t border-slate-300 hover:bg-blue-50 cursor-pointer transition-colors"
                    >
                      {batchMode && (
                        <td className="px-5 py-4" onClick={(e) => e.stopPropagation()}>
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
                      <td className="px-5 py-4">
                        <p className={`font-semibold ${p.is_active ? 'text-slate-900' : 'text-slate-400 line-through'}`}>
                          {p.name}
                          {(p._unsynced || pendingEditIds.has(String(p.id))) && (
                            <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded-full text-xs
                                             font-semibold border bg-amber-100 text-amber-800 border-amber-300">
                              ⏳ Waiting to sync
                            </span>
                          )}
                        </p>
                        <p className="text-xs text-slate-400 mt-0.5">{p.unit}</p>
                      </td>
                      <td className="px-5 py-4 text-slate-500 font-mono text-sm hidden sm:table-cell">
                        {p.sku ?? '—'}
                      </td>
                      <td className="px-5 py-4 text-right font-semibold text-slate-900 tabular-nums">
                        {PHP(p.base_wholesale_price)}
                      </td>
                      <td className="px-5 py-4 text-right text-slate-500 tabular-nums hidden md:table-cell">
                        {Number(p.deposit_fee) > 0 ? PHP(p.deposit_fee) : '—'}
                      </td>
                      <td className="px-5 py-4 text-right text-slate-500 tabular-nums hidden md:table-cell">
                        {p.units_per_case}
                      </td>
                      <td className="px-5 py-4 text-right tabular-nums">
                        <span className={`font-bold text-base ${
                          p.current_stock <= 0   ? 'text-red-600'   :
                          p.current_stock <= 10  ? 'text-amber-600' :
                                                   'text-slate-900'
                        }`}>
                          {p.current_stock}
                        </span>
                        <span className="text-xs text-slate-400 ml-1">{p.unit}</span>
                      </td>
                      <td className="px-5 py-4 hidden lg:table-cell">
                        {p.is_active ? (
                          <span className="inline-flex items-center px-2.5 py-1 rounded-full text-sm font-semibold bg-green-100 text-green-800 border border-green-300">
                            Active
                          </span>
                        ) : (
                          <span className="inline-flex items-center px-2.5 py-1 rounded-full text-sm font-semibold bg-slate-100 text-slate-500 border border-slate-200">
                            Inactive
                          </span>
                        )}
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
    </div>
  );
}
