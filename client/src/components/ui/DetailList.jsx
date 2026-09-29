import React from 'react';
import Button from './Button';
import NavIcon from '../layout/NavIcon';

/**
 * The read-only face of a detail panel (docs/design/design-standard.md, Q13): tapping
 * a record shows what it is first, and only the Edit button turns it into a form — so
 * nothing changes by accident, and the facts sit at the top (UI audit F17).
 *
 * @param items  [{ label, value, wide? }] — a missing value reads "—"
 */
export function DetailList({ items }) {
  return (
    <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3">
      {items.filter(Boolean).map(({ label, value, wide }) => (
        <div key={label} className={wide ? 'sm:col-span-2' : ''}>
          <dt className="text-sm font-semibold text-slate-600">{label}</dt>
          <dd className="mt-0.5 text-base text-slate-900 break-words">
            {value === null || value === undefined || value === '' ? '—' : value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

// A panel section's heading row: the section name, and (in read mode) its Edit button.
export function SectionHeading({ title, onEdit, editLabel = 'Edit', editDisabled, editTitle, testId }) {
  return (
    <div className="flex items-center justify-between gap-3 mb-3">
      <p className="text-sm font-bold text-slate-600 uppercase tracking-wide">{title}</p>
      {onEdit && (
        <Button variant="secondary" size="sm" onClick={onEdit} disabled={editDisabled} title={editTitle}
                data-testid={testId}>
          <NavIcon name="edit" className="w-5 h-5" />
          {editLabel}
        </Button>
      )}
    </div>
  );
}
