import React from 'react';
import Combobox from './Combobox';
import FormField from './FormField';
import useHoldRepeat from './useHoldRepeat';
import { productMatches } from '../../utils/productSearch';

// POS-style "search once, tap to add" bar — a product preset of Combobox in multi-add mode.
// Tapping a product adds it (a whole case). Once it's on the order the row shows a compact
// − qty + stepper so the amount can be fixed up or down in 0.5-case steps right there, without
// scrolling to the line card. Press-and-HOLD +/- to ramp continuously; − stops at 0 (removing
// the line), never negative. Tapping never refocuses the field, so the keyboard isn't forced up.
// `onAdd` = first add (whole case); `onBump` = +0.5; `onSub` = −0.5 (removes at 0);
// `quantityFor(product)` = qty already on the order/delivery (0 if none).
const fmtQty = (n) => {
  const num = Number(n) || 0;
  return Number.isInteger(num) ? String(num) : String(num);
};

const STEP_BTN = `w-12 h-12 flex items-center justify-center rounded-lg border border-slate-300
                  text-2xl font-bold text-slate-700 bg-white select-none hover:bg-slate-100
                  active:bg-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600`;

// Hold-to-repeat +/- button — its own component so the hook runs at a component top level
// (not inside renderRow's .map()).
function HoldButton({ onTrigger, label, children }) {
  const handlers = useHoldRepeat(onTrigger);
  return (
    <button type="button" aria-label={label} className={STEP_BTN} {...handlers}>
      {children}
    </button>
  );
}

export default function ProductSearchBar({
  products,
  onAdd,
  onBump,
  onSub,
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
        rawRow
        isAdded={isAdded}
        emptyText="No products match."
        placeholder={placeholder}
        onSelect={(p) => (isAdded(p) ? onBump(p) : onAdd(p))}
        renderRow={(p, { select, blur }) => {
          const qty = quantityFor(p);
          const info = (
            <>
              <span className="font-medium text-slate-800 shrink-0">{p.sku || p.name}</span>
              <span className="flex items-center gap-2 min-w-0 ml-auto">
                {p.sku && <span className="text-xs text-slate-500 truncate">{p.name}</span>}
                {renderMeta && (
                  <span className="text-sm text-slate-400 shrink-0 tabular-nums">{renderMeta(p)}</span>
                )}
              </span>
            </>
          );
          return (
            <div className="flex items-center gap-2 px-2 min-h-[56px]">
              {qty > 0 ? (
                // Already on the order — info only; adjust with the − qty + stepper below.
                <div className="flex-1 min-w-0 flex items-center gap-2 py-2 px-2 text-sm">{info}</div>
              ) : (
                // Not yet added — the whole row is a big tap-to-add target (adds one case).
                <button
                  type="button"
                  onMouseDown={(e) => { e.preventDefault(); select(); }}
                  className="flex-1 min-w-0 text-left flex items-center gap-2 py-3 px-2 text-sm rounded-md
                             hover:bg-blue-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
                >
                  {info}
                </button>
              )}

              {qty > 0 && (
                <div className="flex items-center gap-1 shrink-0 pr-1">
                  <HoldButton label={`Remove half a case of ${p.sku || p.name}`} onTrigger={() => { blur(); onSub(p); }}>
                    −
                  </HoldButton>
                  <span className="w-9 text-center text-base font-bold tabular-nums text-slate-900">
                    {fmtQty(qty)}
                  </span>
                  <HoldButton label={`Add half a case of ${p.sku || p.name}`} onTrigger={() => { blur(); onBump(p); }}>
                    +
                  </HoldButton>
                </div>
              )}
            </div>
          );
        }}
      />
    </FormField>
  );
}
