import React from 'react';

// Calm skeleton primitives — replace the generic centered `<Spinner size="lg" />` on
// cold loads with a placeholder shaped like the real content, so the screen never
// jumps when data arrives. Tailwind's `animate-pulse` (opacity 1→0.5→1 over 2s) is
// deliberately the whole animation: no shimmer gradient, no color flash — calm per
// the accessibility/tone bar the rest of the app holds to.
//
// `Skeleton` is a bare block; pass the exact width/height classes the real element
// uses (e.g. `h-4 w-24`) so the loading state occupies the same box the loaded
// content will. `SkeletonGroup` wraps a composed placeholder with the same
// `role="status"` + `aria-label` pattern `Spinner` uses, so it reads the same way to
// assistive tech.

export function Skeleton({ className = '' }) {
  return <div aria-hidden="true" className={`animate-pulse rounded-md bg-slate-200 ${className}`} />;
}

export function SkeletonGroup({ label = 'Loading', className = '', children }) {
  return (
    <div role="status" aria-label={label} className={className}>
      {children}
    </div>
  );
}
