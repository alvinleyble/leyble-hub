import React from 'react';
import Combobox from './Combobox';
import FormField from './FormField';
import { productMatches } from '../../utils/productSearch';

// POS-style "search once, tap to add" bar — a product preset of Combobox in multi-add mode.
// Tap a result to add it (or bump its qty if already on the order). The search text is KEPT after
// each tap (and re-selected), so the same product stays filtered — tap it again and again to add
// 2, 3, … — while typing replaces it to move to a different product. Rows already on the order
// show a green pill with the running quantity (e.g. "✓ 3 added") so you can see what's on.
//
// `quantityFor(product)` returns the qty already on the order/delivery for that product (0 if
// none) — drives both the bump-vs-add decision and the pill count.
const fmtQty = (n) => {
  const num = Number(n) || 0;
  return Number.isInteger(num) ? String(num) : String(num);
};

export default function ProductSearchBar({
  products,
  onAdd,
  onBump,
  quantityFor = () => 0,
  renderMeta,
  label = 'Add a product',
  placeholder = 'Search by name or SKU, then tap to add…',
}) {
  const isAdded = (p) => quantityFor(p) > 0;

  return (
    <FormField label={label}>
      <Combobox
        items={products}
        match={productMatches}
        keepOpenOnSelect
        preserveQueryOnSelect
        inlineDropdown
        isAdded={isAdded}
        emptyText="No products match."
        placeholder={placeholder}
        onSelect={(p) => (isAdded(p) ? onBump(p) : onAdd(p))}
        renderRow={(p) => {
          const qty = quantityFor(p);
          return (
            <>
              <span className="font-medium text-slate-800 shrink-0">{p.sku || p.name}</span>
              <span className="flex items-center gap-2 min-w-0 ml-auto">
                {p.sku && <span className="text-xs text-slate-500 truncate">{p.name}</span>}
                {renderMeta && (
                  <span className="text-sm text-slate-400 shrink-0 tabular-nums">{renderMeta(p)}</span>
                )}
                {qty > 0 && (
                  <span className="shrink-0 text-xs font-semibold text-green-700 bg-green-50
                                   border border-green-200 rounded-full px-2 py-0.5 tabular-nums">
                    ✓ {fmtQty(qty)} added
                  </span>
                )}
              </span>
            </>
          );
        }}
      />
    </FormField>
  );
}
