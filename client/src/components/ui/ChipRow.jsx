import React, { useCallback, useEffect, useRef, useState } from 'react';

/**
 * A row of choice chips (docs/design/design-standard.md, Q4): ONE row that scrolls
 * sideways and never wraps, at every size. When more chips sit past an edge, that
 * edge fades out, which is the hint that the row scrolls.
 */
export function ChipRow({ children, label, className = '' }) {
  const ref = useRef(null);
  const [edges, setEdges] = useState({ left: false, right: false });

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const left = el.scrollLeft > 2;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 2;
    setEdges((prev) => (prev.left === left && prev.right === right ? prev : { left, right }));
  }, []);

  useEffect(() => {
    measure();
    const el = ref.current;
    if (!el) return undefined;
    el.addEventListener('scroll', measure, { passive: true });
    window.addEventListener('resize', measure);
    let ro;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(measure);
      ro.observe(el);
    }
    return () => {
      el.removeEventListener('scroll', measure);
      window.removeEventListener('resize', measure);
      ro?.disconnect();
    };
  }, [measure]);

  // Re-measure when the chips themselves change (e.g. categories load).
  useEffect(() => { measure(); });

  const mask = edges.left && edges.right
    ? 'linear-gradient(to right, transparent, #000 32px, #000 calc(100% - 32px), transparent)'
    : edges.right
      ? 'linear-gradient(to right, #000 calc(100% - 40px), transparent)'
      : edges.left
        ? 'linear-gradient(to right, transparent, #000 32px)'
        : undefined;

  return (
    <div
      ref={ref}
      role="group"
      aria-label={label}
      className={`flex flex-nowrap gap-2 overflow-x-auto no-scrollbar ${className}`}
      style={mask ? { WebkitMaskImage: mask, maskImage: mask } : undefined}
    >
      {children}
    </div>
  );
}

const TONES = {
  blue:  'bg-blue-700 text-white border-blue-700',
  amber: 'bg-amber-500 text-amber-950 border-amber-600',
  red:   'bg-red-700 text-white border-red-700',
};

// One chip: a 48px pill, blue when selected (amber/red only for a filter whose whole
// meaning is "needs attention", e.g. Possible duplicates / Out of stock).
export function Chip({ selected, onClick, children, tone = 'blue', className = '', ...props }) {
  return (
    <button
      type="button"
      aria-pressed={!!selected}
      onClick={onClick}
      className={`shrink-0 inline-flex items-center gap-1.5 min-h-[48px] px-4 rounded-full border text-base
                  font-semibold whitespace-nowrap transition-colors focus-visible:outline-none
                  focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-1
                  ${selected ? (TONES[tone] ?? TONES.blue) : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'}
                  ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}
