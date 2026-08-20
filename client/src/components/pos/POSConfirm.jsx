import React, { useEffect, useRef } from 'react';

// Dark confirm dialog for the V2 POS — same modal shell as the V1 Modal
// (fixed inset-0 z-50, backdrop click + Escape to dismiss), restyled for the
// dark tablet shell. Used only for destructive actions; the Save → Print flow
// itself is deliberately prompt-free.
export default function POSConfirm({
  title,
  children,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
  loading = false,
  // Normally the topmost layer; raised when it has to sit over another z-[60] modal
  // (POS History's 👁️ View, which stays open behind its Cancel confirmation).
  zClass = 'z-50',
  onConfirm,
  onClose,
}) {
  const panelRef = useRef(null);

  useEffect(() => {
    panelRef.current?.focus();
    const handler = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  return (
    <div
      className={`fixed inset-0 ${zClass} flex items-center justify-center bg-black/60 p-4`}
      role="dialog"
      aria-modal="true"
      aria-labelledby="pos-confirm-title"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className="w-full max-w-md rounded-2xl border border-v2-border bg-v2-surface shadow-2xl outline-none"
      >
        <h2 id="pos-confirm-title" className="border-b border-v2-border px-6 py-4 text-xl font-bold text-v2-text">
          {title}
        </h2>
        <div className="px-6 py-5 text-base leading-relaxed text-v2-muted">{children}</div>
        <div className="flex justify-end gap-3 border-t border-v2-border px-6 py-4">
          <button
            type="button"
            onClick={onClose}
            disabled={loading}
            className="flex min-h-tablet items-center rounded-xl bg-v2-raised px-5 text-base font-bold text-v2-text
                       hover:bg-v2-border focus-visible:outline-none focus-visible:ring-2
                       focus-visible:ring-v2-accent disabled:opacity-50"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={loading}
            className={`flex min-h-tablet items-center rounded-xl px-5 text-base font-bold text-white
                        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-v2-accent
                        disabled:opacity-50 ${danger ? 'bg-red-700 hover:bg-red-600' : 'bg-v2-accent-strong hover:bg-v2-accent'}`}
          >
            {loading ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
