import React from 'react';

// One card on the Settings page. Every section shares this frame so the page reads as
// one list of cards, top to bottom.
export default function SettingsSection({ id, title, children, testId }) {
  const headingId = `settings-${id}-heading`;
  return (
    <section
      aria-labelledby={headingId}
      className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
      data-testid={testId || `settings-${id}`}
    >
      <h2 id={headingId} className="text-lg font-semibold text-slate-900 mb-4">
        {title}
      </h2>
      {children}
    </section>
  );
}

// A read-only "label / value" pair. The label sits above the value, same as a form
// field's visible label, so nothing depends on column width at phone size.
export function SettingRow({ label, children, testId }) {
  return (
    <div className="py-2 first:pt-0">
      <dt className="text-base font-medium text-slate-500">{label}</dt>
      <dd className="text-lg font-semibold text-slate-900 break-words" data-testid={testId}>
        {children}
      </dd>
    </div>
  );
}

// The calm "this lives in the Android app" note the web build shows instead of a
// control it cannot drive.
export function AndroidOnlyNote({ children, testId }) {
  return (
    <p
      className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-base text-slate-700"
      data-testid={testId}
    >
      {children}
    </p>
  );
}
