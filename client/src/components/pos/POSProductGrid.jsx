import React, { useMemo, useState } from 'react';
import { productMatches } from '../../utils/productSearch';
import useHoldRepeat from '../ui/useHoldRepeat';

const PHP = (n) =>
  `₱${Number(n).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const ALL_CATEGORIES = '__all__';

// One catalogue card. Tapping adds half a case and holding accelerates, exactly
// like the −/+ steppers on the order lines (shared useHoldRepeat).
function ProductCard({ product, quantity, onAdd, disabled, priceFor }) {
  const add = useHoldRepeat(() => onAdd(product));

  // The card must read the same price the line will be created with — the selected
  // customer's rate for the current delivery/pickup channel, not the standard price.
  const base      = Number(product.base_wholesale_price);
  const effective = priceFor(product);
  // How far off standard this customer's rate is, in pesos and percent — the operator
  // quotes from this card, so the saving is spelled out rather than merely hinted at.
  const diff      = base - effective;
  const pct       = base > 0 ? Math.abs((diff / base) * 100).toFixed(1) : null;
  const isSuki    = diff !== 0;
  const isCheaper = diff > 0;
  const gapLabel  = `${isCheaper ? '−' : '+'}${PHP(Math.abs(diff))}${pct ? ` (${pct}%)` : ''}`;

  return (
    <button
      type="button"
      {...(disabled ? {} : add)}
      disabled={disabled}
      aria-label={`Add half a case of ${product.name} ${product.sku ? `(${product.sku})` : ''}, `
                  + `${PHP(effective)} per case`
                  + (isSuki
                      ? `, Suki price — ${PHP(Math.abs(diff))} ${isCheaper ? 'less' : 'more'} than `
                        + `standard${pct ? ` (${pct}%)` : ''}`
                      : '')}
      className={`flex h-full w-full touch-none select-none flex-col rounded-xl border p-3 text-left
                  transition-colors duration-100 focus-visible:outline-none focus-visible:ring-2
                  focus-visible:ring-blue-600 disabled:opacity-50
                  ${quantity > 0
                    ? 'border-blue-600 bg-blue-50/60 shadow-sm ring-1 ring-blue-600'
                    : 'border-slate-200 bg-white hover:bg-slate-50 hover:border-slate-300 shadow-sm'}`}
    >
      <span className="flex items-start justify-between gap-2">
        <span className="text-sm font-bold tracking-wide text-slate-500">{product.sku || '—'}</span>
        {quantity > 0 && (
          <span className="shrink-0 rounded-lg bg-emerald-600 px-2 py-0.5 text-xs font-bold text-white shadow-sm">
            {quantity} cs
          </span>
        )}
      </span>

      <span className="mt-1 line-clamp-2 text-base font-semibold leading-snug text-slate-900">
        {product.name}
      </span>

      <span className="text-xs text-slate-500">{product.category}</span>

      <span className="mt-auto flex flex-wrap items-baseline gap-x-2 gap-y-1 pt-2">
        <span className="text-base font-bold text-slate-900">
          {PHP(effective)}
          <span className="text-xs font-medium text-slate-500"> /cs</span>
        </span>
        {/* Emerald for a discount (the normal Suki case); purple for markup */}
        {isSuki && (
          <span
            className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[11px] font-bold tabular-nums
              ${isCheaper
                ? 'bg-emerald-100 border-emerald-300 text-emerald-800'
                : 'bg-purple-100 border-purple-300 text-purple-800'}`}
            aria-hidden="true"
          >
            {gapLabel}
          </span>
        )}
      </span>
    </button>
  );
}

// Product catalogue for the POS order creation: search bar, category pill matrix
// and clean touch product cards.
export default function POSProductGrid({
  products,
  orderQty,
  onAdd,
  disabled = false,
  headerActions = null,
  priceFor = (p) => Number(p.base_wholesale_price),
}) {
  const [category, setCategory] = useState(ALL_CATEGORIES);
  const [query, setQuery]       = useState('');

  const categories = useMemo(() => {
    const set = new Set(products.map((p) => p.category).filter(Boolean));
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [products]);

  const visible = useMemo(
    () => products
      .filter((p) => category === ALL_CATEGORIES || p.category === category)
      .filter((p) => productMatches(p, query))
      .sort((a, b) =>
        (a.category ?? '').localeCompare(b.category ?? '') || a.name.localeCompare(b.name)
      ),
    [products, category, query]
  );

  const pill = (active) =>
    `flex min-h-[38px] items-center rounded-xl px-3.5 text-sm font-semibold transition-colors duration-100
     focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 border
     ${active
       ? 'bg-blue-700 text-white border-blue-700 shadow-sm'
       : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50 hover:text-slate-900'}`;

  return (
    <section className="flex min-h-0 flex-col h-full" aria-label="Products">
      {/* Search + category matrix. `headerActions` (Drafts, History) sits on top */}
      <div className="shrink-0 space-y-2.5 pb-2">
        <div className="flex items-end gap-2">
          <div className="min-w-0 flex-1">
            <label htmlFor="pos-product-search" className="block text-xs font-bold uppercase tracking-wider text-slate-500">
              Search products
            </label>
            <input
              id="pos-product-search"
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoComplete="off"
              placeholder="SKU, name or category…"
              className="mt-1 h-11 w-full rounded-xl border border-slate-300 bg-white px-4 text-base
                         text-slate-900 placeholder:text-slate-400
                         focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
            />
          </div>
          {headerActions && <div className="flex shrink-0 items-center gap-2">{headerActions}</div>}
        </div>

        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Product categories">
          <button
            type="button"
            onClick={() => setCategory(ALL_CATEGORIES)}
            aria-pressed={category === ALL_CATEGORIES}
            className={pill(category === ALL_CATEGORIES)}
          >
            All Categories
          </button>
          {categories.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setCategory(c)}
              aria-pressed={category === c}
              className={pill(category === c)}
            >
              {c}
            </button>
          ))}
        </div>
      </div>

      {/* Cards */}
      <div className="min-h-0 flex-1 overflow-y-auto pr-1">
        {visible.length === 0 ? (
          <p className="py-12 text-center text-base text-slate-400">No products match this search.</p>
        ) : (
          <ul className="grid grid-cols-2 gap-2.5 pb-2 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4">
            {visible.map((p) => (
              <li key={p.id}>
                <ProductCard
                  product={p}
                  quantity={orderQty[p.id] ?? 0}
                  onAdd={onAdd}
                  disabled={disabled}
                  priceFor={priceFor}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
