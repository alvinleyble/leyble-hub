import React, { useMemo, useState } from 'react';
import { productMatches } from '../../utils/productSearch';
import useHoldRepeat from '../ui/useHoldRepeat';

const PHP = (n) =>
  `₱${Number(n).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const ALL_CATEGORIES = '__all__';

// One catalogue card. Tapping adds half a case and holding accelerates, exactly
// like the −/+ steppers on the order lines (shared useHoldRepeat).
function ProductCard({ product, quantity, onAdd, disabled }) {
  const add = useHoldRepeat(() => onAdd(product));

  return (
    <button
      type="button"
      {...(disabled ? {} : add)}
      disabled={disabled}
      aria-label={`Add half a case of ${product.name} ${product.sku ? `(${product.sku})` : ''}`}
      className={`flex h-full w-full touch-none select-none flex-col rounded-xl border p-3 text-left
                  transition-colors duration-100 focus-visible:outline-none focus-visible:ring-2
                  focus-visible:ring-v2-accent disabled:opacity-50
                  ${quantity > 0
                    ? 'border-v2-accent bg-v2-raised'
                    : 'border-v2-border bg-v2-surface hover:bg-v2-raised'}`}
    >
      <span className="flex items-start justify-between gap-2">
        <span className="text-base font-bold tracking-wide text-v2-accent">{product.sku || '—'}</span>
        {quantity > 0 && (
          <span className="shrink-0 rounded-lg bg-v2-accent-strong px-2 py-0.5 text-sm font-bold text-white">
            {quantity} cs
          </span>
        )}
      </span>

      <span className="mt-1 line-clamp-2 text-base font-semibold leading-snug text-v2-text">
        {product.name}
      </span>

      <span className="text-sm text-v2-muted">{product.category}</span>

      <span className="mt-auto pt-2 text-lg font-bold text-v2-text">
        {PHP(product.base_wholesale_price)}
        <span className="text-sm font-semibold text-v2-muted"> /cs</span>
      </span>
    </button>
  );
}

// Product catalogue for the V2 POS: a search bar, the category matrix (an "All
// Categories" pill plus one pill per production category — ~12 of them wrap into
// three rows on the tablet) and clean, icon-free product cards showing just name,
// category and price per case.
export default function POSProductGrid({ products, orderQty, onAdd, disabled = false, headerActions = null }) {
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
    `flex min-h-tablet items-center rounded-xl px-4 text-base font-semibold transition-colors duration-100
     focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-v2-accent
     ${active
       ? 'bg-v2-accent-strong text-white'
       : 'bg-v2-raised text-v2-muted hover:bg-v2-border hover:text-v2-text'}`;

  return (
    <section className="flex min-h-0 flex-col" aria-label="Products">
      {/* Search + category matrix. `headerActions` (History, print alert) sits on the
          search row so the top of the screen carries no empty band. */}
      <div className="shrink-0 space-y-2">
        <div className="flex items-end gap-2">
          <div className="min-w-0 flex-1">
            <label htmlFor="pos-product-search" className="block text-sm font-bold uppercase tracking-wide text-v2-muted">
              Search products
            </label>
            <input
              id="pos-product-search"
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoComplete="off"
              placeholder="SKU, name or category…"
              className="mt-1 h-14 w-full rounded-xl border border-v2-border bg-v2-bg px-4 text-lg
                         text-v2-text placeholder:text-slate-500
                         focus:outline-none focus-visible:ring-2 focus-visible:ring-v2-accent"
            />
          </div>
          {headerActions && <div className="flex shrink-0 items-center gap-2">{headerActions}</div>}
        </div>

        <div className="flex flex-wrap gap-2" role="group" aria-label="Product categories">
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
      <div className="mt-2 min-h-0 flex-1 overflow-y-auto pr-1">
        {visible.length === 0 ? (
          <p className="py-10 text-center text-lg text-v2-muted">No products match this search.</p>
        ) : (
          <ul className="grid grid-cols-2 gap-3 pb-2 lg:grid-cols-3 xl:grid-cols-4">
            {visible.map((p) => (
              <li key={p.id}>
                <ProductCard
                  product={p}
                  quantity={orderQty[p.id] ?? 0}
                  onAdd={onAdd}
                  disabled={disabled}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
