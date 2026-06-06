import React from 'react';

// Status badges: always pair color WITH text — never color alone.
const STATUS_STYLES = {
  pending:    'bg-amber-100 text-amber-800 border border-amber-300',
  in_transit: 'bg-blue-100  text-blue-800  border border-blue-300',
  completed:  'bg-green-100 text-green-800 border border-green-300',
  done:       'bg-slate-100 text-slate-600 border border-slate-300',
  cancelled:  'bg-red-100   text-red-800   border border-red-300',
};

const STATUS_LABELS = {
  pending:    'Pending',
  in_transit: 'In Transit',
  completed:  'Completed',
  done:       'Done',
  cancelled:  'Cancelled',
};

export function StatusBadge({ status }) {
  const style = STATUS_STYLES[status] ?? 'bg-slate-100 text-slate-600 border border-slate-200';
  const label = STATUS_LABELS[status] ?? status;
  return (
    <span className={`inline-flex items-center px-3 py-1 rounded-full text-sm font-semibold whitespace-nowrap ${style}`}>
      {label}
    </span>
  );
}

const BADGE_STYLES = {
  default: 'bg-slate-100 text-slate-700 border border-slate-200',
  info:    'bg-blue-100  text-blue-800  border border-blue-300',
  success: 'bg-green-100 text-green-800 border border-green-300',
  warning: 'bg-amber-100 text-amber-800 border border-amber-300',
  danger:  'bg-red-100   text-red-800   border border-red-300',
};

export function Badge({ children, variant = 'default', className = '' }) {
  return (
    <span className={`inline-flex items-center px-3 py-1 rounded-full text-sm font-semibold ${BADGE_STYLES[variant] ?? BADGE_STYLES.default} ${className}`}>
      {children}
    </span>
  );
}
