import React, { useEffect, useState, useCallback } from 'react';
import { api } from '../../api/client';
import { useToast } from '../../components/ui/Toast';
import Spinner from '../../components/ui/Spinner';
import ProductCreateModal from '../../components/inventory/ProductCreateModal';
import ProductDetailDrawer from '../../components/inventory/ProductDetailDrawer';
import InventoryBatchPriceModal from '../../components/inventory/InventoryBatchPriceModal';
import PrinterPicker from '../orders/PrinterPicker';
import { usePrintList } from '../shared/usePrintList';
import { productListHtml, productCountSheetHtml } from '../shared/listPrintTemplate';
import { productListEscPos, productCountSheetEscPos } from '../shared/listEscPos';
import { productMatches } from '../../utils/productSearch';

const PHP = (n) =>
  `₱${Number(n).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const TOP_BTN = `flex h-12 items-center gap-1.5 rounded-xl bg-v2-raised px-4 text-base font-bold text-v2-text
                 hover:bg-v2-border transition-colors duration-100 disabled:opacity-40
                 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-v2-accent`;

// In-line price cell: local editable text, committed on blur/Enter via PATCH.
// Reverts to the last-known price on failure so the row never shows a stale lie.
function InlinePriceCell({ product, onCommitted }) {
  const { addToast } = useToast();
  const [value, setValue]     = useState(String(product.base_wholesale_price));
  const [saving, setSaving]   = useState(false);

  useEffect(() => {
    setValue(String(product.base_wholesale_price));
  }, [product.base_wholesale_price]);

  const commit = async () => {
    const num = Number(value);
    if (value === '' || isNaN(num) || num < 0) {
      setValue(String(product.base_wholesale_price));
      return;
    }
    if (num === Number(product.base_wholesale_price)) return;

    setSaving(true);
    try {
      const updated = await api.patch(`/products/${product.id}`, { base_wholesale_price: num });
      onCommitted(updated);
    } catch (err) {
      addToast(err.message || 'Failed to update price.', 'error');
      setValue(String(product.base_wholesale_price));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="inline-flex items-center gap-1 rounded-lg border border-v2-border bg-v2-bg px-2 py-1"
      onClick={(e) => e.stopPropagation()}>
      <span className="text-xs font-bold text-v2-muted">₱</span>
      <input
        type="number" min="0" step="0.01" inputMode="decimal"
        value={value}
        disabled={saving}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
        aria-label={`Price per case for ${product.name}`}
        className="w-20 rounded bg-transparent px-1 py-1 text-right text-sm font-bold tabular-nums
                   text-v2-text focus:outline-none focus-visible:ring-2 focus-visible:ring-v2-accent
                   disabled:opacity-50"
      />
    </div>
  );
}

// `w/ dep` toggle badge — proposal §3, Slice 2 item 3. Flips requires_bottle_return
// directly from the row; the deposit amount itself is still edited in the detail drawer.
function DepositToggle({ product, onCommitted }) {
  const { addToast } = useToast();
  const [saving, setSaving] = useState(false);
  const withDep = product.requires_bottle_return;

  const toggle = async (e) => {
    e.stopPropagation();
    setSaving(true);
    try {
      const updated = await api.patch(`/products/${product.id}`, {
        requires_bottle_return: !withDep,
      });
      onCommitted(updated);
    } catch (err) {
      addToast(err.message || 'Failed to update deposit flag.', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={saving}
      title={withDep ? `Deposit ₱${Number(product.deposit_fee).toFixed(2)} / bottle — tap to remove` : 'No bottle deposit — tap to enable'}
      className={`inline-flex min-h-[36px] items-center justify-center rounded-full border px-3 text-xs
                  font-bold transition-colors disabled:opacity-50
                  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-v2-accent
                  ${withDep
                    ? 'border-amber-500/40 bg-amber-500/10 text-amber-300'
                    : 'border-v2-border bg-v2-bg text-v2-muted hover:bg-v2-raised'}`}
    >
      {withDep ? `w/ dep ${PHP(product.deposit_fee)}` : 'w/o dep'}
    </button>
  );
}

export default function InventoryV2Page() {
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

  const load = useCallback(() => {
    setLoading(true);
    api.get(`/products${showInactive ? '?include_inactive=true' : ''}`)
      .then(setProducts)
      .catch(() => addToast('Failed to load products', 'error'))
      .finally(() => setLoading(false));
  }, [showInactive, addToast]);

  useEffect(() => { load(); }, [load]);

  const {
    printList, printing,
    pickerVisible, pickerDevices, pickerLoading, pickerCurrent, printPending,
    savePrinter, scanWifi, testPrint, closePicker,
  } = usePrintList();

  // Prints the full active product list (ignores on-screen search/filters) — same V1 output.
  const handlePrintList = () => printList(productListHtml(products), productListEscPos(products));

  // Physical stock count sheet — blank "Counted" line per item, distinct from the price list above.
  const handleCountSheet = () =>
    printList(productCountSheetHtml(products), productCountSheetEscPos(products));

  // Patch a single product in place after an in-line price/deposit edit, without a full reload.
  const applyPatch = (updated) => {
    setProducts((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
  };

  const allCategories = [...new Set(products.map((p) => p.category ?? 'Uncategorised'))].sort();

  const filtered = products.filter((p) => {
    const matchSearch = productMatches(p, search);
    const matchCategory =
      categoryFilter === 'all' || (p.category ?? 'Uncategorised') === categoryFilter;
    const matchStock =
      stockFilter === 'all' ||
      (stockFilter === 'out' && p.current_stock <= 0) ||
      (stockFilter === 'low' && p.current_stock > 0 && p.current_stock <= 10);
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

  const allSelected = filtered.length > 0 && filtered.every((p) => selectedIds.has(p.id));
  const toggleSelectAll = () => {
    setSelectedIds(allSelected ? new Set() : new Set(filtered.map((p) => p.id)));
  };

  const exitBatchMode = () => { setBatchMode(false); setSelectedIds(new Set()); };

  const selectedProducts = products.filter((p) => selectedIds.has(p.id));

  const stockPill = (active, tone) =>
    `flex min-h-tablet items-center rounded-xl px-4 text-base font-semibold transition-colors duration-100
     focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-v2-accent
     ${active
       ? tone === 'out' ? 'bg-red-600 text-white' : tone === 'low' ? 'bg-amber-500 text-slate-950' : 'bg-v2-pill-active text-v2-pill-text border border-v2-pill-border shadow-sm'
       : 'bg-v2-raised text-v2-muted hover:bg-v2-border hover:text-v2-text'}`;

  const catPill = (active) =>
    `flex min-h-tablet items-center rounded-xl px-4 text-base font-semibold transition-colors duration-100
     focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-v2-accent
     ${active ? 'bg-v2-pill-active text-v2-pill-text border border-v2-pill-border shadow-sm' : 'bg-v2-raised text-v2-muted hover:bg-v2-border hover:text-v2-text'}`;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 px-3 pb-3 pt-2">
      {/* ── Header ───────────────────────────────────────────────── */}
      <div className="flex shrink-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-2xl font-bold text-v2-text">Inventory</h1>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={handlePrintList} disabled={printing || products.length === 0} className={TOP_BTN}>
            🖶 {printing ? 'Printing…' : 'Print List'}
          </button>
          <button type="button" onClick={handleCountSheet} disabled={printing || products.length === 0} className={TOP_BTN}>
            🖶 {printing ? 'Printing…' : 'Stock Count Sheet'}
          </button>
          {batchMode ? (
            <button type="button" onClick={exitBatchMode} className={TOP_BTN}>
              Cancel Batch Edit
            </button>
          ) : (
            <button type="button" onClick={() => setBatchMode(true)} disabled={products.length === 0} className={TOP_BTN}>
              Batch Edit Prices
            </button>
          )}
          <button
            type="button" onClick={() => setCreating(true)}
            className="flex h-12 items-center gap-1.5 rounded-xl bg-emerald-600 px-4 text-base font-bold
                       text-white hover:bg-emerald-500 shadow-sm focus-visible:outline-none focus-visible:ring-2
                       focus-visible:ring-v2-accent"
          >
            + Add Product
          </button>
        </div>
      </div>

      {/* ── Filters ──────────────────────────────────────────────── */}
      <div className="shrink-0 space-y-2">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <input
            type="search"
            placeholder="Search by name, category, or SKU…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search products"
            className="h-12 flex-1 rounded-xl border border-v2-border bg-v2-bg px-4 text-base text-v2-text
                       placeholder:text-v2-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-v2-accent"
          />
          <label className="flex min-h-tablet cursor-pointer select-none items-center gap-3 rounded-xl border
                            border-v2-border bg-v2-bg px-4">
            <input
              type="checkbox"
              checked={showInactive}
              onChange={(e) => setShowInactive(e.target.checked)}
              className="h-6 w-6 accent-v2-accent-strong"
            />
            <span className="whitespace-nowrap text-base font-medium text-v2-text">Show inactive</span>
          </label>
        </div>

        {!loading && allCategories.length > 1 && (
          <div className="flex flex-wrap gap-2" role="group" aria-label="Product categories">
            <button type="button" onClick={() => setCategoryFilter('all')} aria-pressed={categoryFilter === 'all'} className={catPill(categoryFilter === 'all')}>
              All Categories
            </button>
            {allCategories.map((cat) => (
              <button key={cat} type="button" onClick={() => setCategoryFilter(cat)} aria-pressed={categoryFilter === cat} className={catPill(categoryFilter === cat)}>
                {cat}
              </button>
            ))}
          </div>
        )}

        {!loading && (
          <div className="flex flex-wrap gap-2" role="group" aria-label="Stock status">
            <button type="button" onClick={() => setStockFilter('all')} aria-pressed={stockFilter === 'all'} className={stockPill(stockFilter === 'all', 'all')}>
              All Stock
            </button>
            <button type="button" onClick={() => setStockFilter('low')} aria-pressed={stockFilter === 'low'} className={stockPill(stockFilter === 'low', 'low')}>
              ⚠ Low Stock
            </button>
            <button type="button" onClick={() => setStockFilter('out')} aria-pressed={stockFilter === 'out'} className={stockPill(stockFilter === 'out', 'out')}>
              🚨 Out of Stock
            </button>
          </div>
        )}
      </div>

      {/* ── Bulk action bar ─────────────────────────────────────── */}
      {batchMode && selectedIds.size > 0 && (
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 rounded-xl border
                        border-v2-border bg-v2-raised px-5 py-3">
          <p className="text-base font-bold text-v2-text">
            {selectedIds.size} product{selectedIds.size === 1 ? '' : 's'} selected
          </p>
          <div className="flex shrink-0 gap-2">
            <button type="button" onClick={() => setSelectedIds(new Set())} className={TOP_BTN}>
              Clear
            </button>
            <button
              type="button" onClick={() => setBatchEditOpen(true)}
              className="flex h-12 items-center rounded-xl bg-emerald-600 px-5 text-base font-bold
                         text-white hover:bg-emerald-500 shadow-sm focus-visible:outline-none focus-visible:ring-2
                         focus-visible:ring-v2-accent"
            >
              Edit Prices →
            </button>
          </div>
        </div>
      )}

      {/* ── Table ────────────────────────────────────────────────── */}
      <div className="min-h-0 flex-1 overflow-y-auto rounded-2xl border border-v2-border bg-v2-surface">
        {loading ? (
          <div className="flex h-64 items-center justify-center"><Spinner size="lg" /></div>
        ) : filtered.length === 0 ? (
          <p className="py-20 text-center text-lg text-v2-muted">
            {search ? 'No products match your search.' : 'No products yet. Add one to get started.'}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-base">
              <thead className="sticky top-0 z-10 bg-v2-bg">
                <tr className="border-b border-v2-border text-xs uppercase tracking-wider text-v2-muted">
                  {batchMode && (
                    <th className="w-12 px-4 py-3">
                      <label className="flex h-12 w-12 -m-2 cursor-pointer items-center justify-center">
                        <input
                          type="checkbox" checked={allSelected} onChange={toggleSelectAll}
                          className="h-6 w-6 rounded accent-v2-accent-strong
                                     focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-v2-accent"
                          aria-label="Select all products"
                        />
                      </label>
                    </th>
                  )}
                  <th className="px-4 py-3 text-left font-semibold">Product</th>
                  <th className="hidden px-4 py-3 text-left font-semibold sm:table-cell">SKU</th>
                  <th className="px-4 py-3 text-right font-semibold">Price / Case</th>
                  <th className="hidden px-4 py-3 text-right font-semibold md:table-cell">Deposit</th>
                  <th className="hidden px-4 py-3 text-right font-semibold md:table-cell">Btl / Case</th>
                  <th className="px-4 py-3 text-right font-semibold">Stock</th>
                  <th className="hidden px-4 py-3 text-left font-semibold lg:table-cell">Status</th>
                </tr>
              </thead>
              <tbody>
                {categories.map((cat) => (
                  <React.Fragment key={cat}>
                    <tr className="border-y border-v2-border bg-v2-bg/60">
                      <td colSpan={batchMode ? 7 : 6} className="px-4 py-2 text-xs font-bold uppercase tracking-widest text-v2-muted">
                        {cat}
                      </td>
                    </tr>

                    {grouped[cat].map((p) => (
                      <tr
                        key={p.id}
                        onClick={() => setSelectedId(p.id)}
                        className="cursor-pointer border-t border-v2-border transition-colors hover:bg-v2-raised"
                      >
                        {batchMode && (
                          <td className="px-4 py-4" onClick={(e) => e.stopPropagation()}>
                            <label className="flex h-12 w-12 -m-2 cursor-pointer items-center justify-center">
                              <input
                                type="checkbox" checked={selectedIds.has(p.id)} onChange={() => toggleSelected(p.id)}
                                className="h-6 w-6 rounded accent-v2-accent-strong
                                           focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-v2-accent"
                                aria-label={`Select ${p.name}`}
                              />
                            </label>
                          </td>
                        )}
                        <td className="px-4 py-4">
                          <p className={`font-semibold ${p.is_active ? 'text-v2-text' : 'text-v2-muted line-through'}`}>
                            {p.name}
                          </p>
                          <p className="mt-0.5 text-xs text-v2-muted">{p.unit}</p>
                        </td>
                        <td className="hidden px-4 py-4 font-mono text-sm text-v2-muted sm:table-cell">
                          {p.sku ?? '—'}
                        </td>
                        <td className="px-4 py-4 text-right">
                          <InlinePriceCell product={p} onCommitted={applyPatch} />
                        </td>
                        <td className="hidden px-4 py-4 text-right md:table-cell" onClick={(e) => e.stopPropagation()}>
                          <DepositToggle product={p} onCommitted={applyPatch} />
                        </td>
                        <td className="hidden px-4 py-4 text-right tabular-nums text-v2-muted md:table-cell">
                          {p.units_per_case}
                        </td>
                        <td className="px-4 py-4 text-right tabular-nums">
                          <span className={`text-base font-bold ${
                            p.current_stock <= 0  ? 'text-red-400'  :
                            p.current_stock <= 10 ? 'text-amber-400' : 'text-v2-text'
                          }`}>
                            {p.current_stock}
                          </span>
                          <span className="ml-1 text-xs text-v2-muted">{p.unit}</span>
                        </td>
                        <td className="hidden px-4 py-4 lg:table-cell">
                          {p.is_active ? (
                            <span className="inline-flex items-center rounded-full border border-emerald-500/30
                                             bg-emerald-500/10 px-2.5 py-1 text-sm font-semibold text-emerald-300">
                              Active
                            </span>
                          ) : (
                            <span className="inline-flex items-center rounded-full border border-v2-border
                                             bg-v2-raised px-2.5 py-1 text-sm font-semibold text-v2-muted">
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
      </div>

      {/* ── Modals / Drawer ──────────────────────────────────────── */}
      {creating && (
        <ProductCreateModal
          onClose={() => setCreating(false)}
          onSaved={() => { setCreating(false); load(); }}
        />
      )}

      {selectedId !== null && (
        <ProductDetailDrawer
          productId={selectedId}
          onClose={() => setSelectedId(null)}
          onSaved={load}
        />
      )}

      {batchEditOpen && (
        <InventoryBatchPriceModal
          products={selectedProducts}
          onClose={() => setBatchEditOpen(false)}
          onSaved={() => { setBatchEditOpen(false); exitBatchMode(); load(); }}
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
