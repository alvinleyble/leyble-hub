import React from 'react';

/**
 * The phone list card (docs/design/design-standard.md, Q6), one recipe for every list:
 *   line 1 — what it is (a name), wrapping onto as many lines as it needs and never
 *            cut short (UI audit F5: the cut-off part was the size that told two
 *            products apart), with the money or key number on the right;
 *   line 2 — the one most useful detail, and a secondary fact on the right;
 *   line 3 — badges, only when there is something to say, and any per-row action.
 * The whole card is the tap target. Text is 16px for line 1 and 14px (slate-600) for
 * the details — the design standard's Q7 floor.
 */
export default function ListCard({
  onClick, leading, title, titleRight, meta, metaRight, badges, badgesRight, children,
  className = '', ...props
}) {
  const badgeList = Array.isArray(badges) ? badges.filter(Boolean) : badges;
  const hasBadges = Array.isArray(badgeList) ? badgeList.length > 0 : !!badgeList;
  return (
    <div
      onClick={onClick}
      className={`flex gap-3 px-4 py-3 ${onClick ? 'cursor-pointer active:bg-blue-50' : ''} ${className}`}
      {...props}
    >
      {leading}
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-3" data-card-line="1">
          <p className="min-w-0 font-semibold text-base text-slate-900 break-words">{title}</p>
          {titleRight != null && titleRight !== false && (
            <div className="shrink-0 text-right font-bold text-base text-slate-900 tabular-nums whitespace-nowrap">
              {titleRight}
            </div>
          )}
        </div>
        {(meta || metaRight) && (
          <div className="mt-0.5 flex items-baseline justify-between gap-3 text-sm text-slate-600" data-card-line="2">
            <div className="min-w-0 break-words">{meta}</div>
            {metaRight && <div className="shrink-0 text-right whitespace-nowrap">{metaRight}</div>}
          </div>
        )}
        {(hasBadges || badgesRight) && (
          <div className="mt-2 flex items-center justify-between gap-2" data-card-line="3">
            <div className="flex flex-wrap items-center gap-1.5">{badgeList}</div>
            {badgesRight && <div className="shrink-0">{badgesRight}</div>}
          </div>
        )}
        {children}
      </div>
    </div>
  );
}

// A row checkbox with a 48px tap area (Q8), for list cards in bulk-select mode.
export function CardCheckbox({ checked, onChange, disabled, label }) {
  return (
    <label
      className="flex items-center justify-center w-12 h-12 -my-1 -ml-2 shrink-0 cursor-pointer"
      onClick={(e) => e.stopPropagation()}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={onChange}
        aria-label={label}
        className="w-6 h-6 rounded border-slate-300 text-blue-700
                   focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
      />
    </label>
  );
}
