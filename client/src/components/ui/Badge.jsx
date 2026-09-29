import React from 'react';
import NavIcon from '../layout/NavIcon';
import {
  orderStatusBadge, ticketStatusBadge, stockBadge, tagBadge, toneClass,
} from '../../utils/statusBadges';

// Every badge in the app is one of these (docs/design/design-standard.md, Q5): a
// pill with a colour AND a word, 14px text, never wrapping. The colour/word pairs
// live in utils/statusBadges.js so no screen keeps its own copy.
const PILL = 'inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-sm font-semibold border whitespace-nowrap';

const TAG_ICONS = {
  pickup: 'store',
  delivery: 'truck',
  printed: 'printer',
  notPrinted: 'printer',
  unsynced: 'clock',
  duplicate: 'warning',
};

export function StatusBadge({ status, className = '', ...props }) {
  const { label, className: tone } = orderStatusBadge(status);
  return <span className={`${PILL} ${tone} ${className}`} {...props}>{label}</span>;
}

export function TicketStatusBadge({ status, className = '', ...props }) {
  const { label, className: tone } = ticketStatusBadge(status);
  return <span className={`${PILL} ${tone} ${className}`} {...props}>{label}</span>;
}

// Nothing for ordinary stock: a badge is only shown when something is unusual (Q6).
export function StockBadge({ stock, className = '' }) {
  const b = stockBadge(stock);
  if (!b) return null;
  return <span className={`${PILL} ${b.className} ${className}`}>{b.label}</span>;
}

export function TagBadge({ kind, children, className = '', as: As = 'span', ...props }) {
  const { label, className: tone } = tagBadge(kind);
  const icon = TAG_ICONS[kind];
  return (
    <As className={`${PILL} ${tone} ${className}`} {...props}>
      {icon && <NavIcon name={icon} className="w-4 h-4 shrink-0" />}
      {children ?? label}
    </As>
  );
}

const BADGE_TONES = {
  default: 'slate',
  info:    'blue',
  success: 'green',
  warning: 'amber',
  danger:  'red',
};

export function Badge({ children, variant = 'default', className = '' }) {
  return (
    <span className={`${PILL} ${toneClass(BADGE_TONES[variant] ?? 'slate')} ${className}`}>
      {children}
    </span>
  );
}
