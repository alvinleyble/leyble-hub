import React, { useEffect, useRef } from 'react';
import Button from './Button';

export default function Modal({
  title,
  children,
  onClose,
  onConfirm,
  confirmLabel = 'Confirm',
  confirmVariant = 'primary',
  loading = false,
}) {
  const panelRef = useRef(null);

  // Trap focus on mount; close on Escape
  useEffect(() => {
    panelRef.current?.focus();
    const handler = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  // Click outside to dismiss
  const handleBackdropClick = (e) => {
    if (e.target === e.currentTarget) onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50"
      role="dialog"
      aria-modal="true"
      aria-labelledby="modal-title"
      onClick={handleBackdropClick}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className="bg-white rounded-xl shadow-2xl w-full max-w-md outline-none"
      >
        <div className="px-6 py-5 border-b border-slate-200">
          <h2 id="modal-title" className="text-xl font-bold text-slate-900">{title}</h2>
        </div>

        <div className="px-6 py-5 text-slate-700 text-base leading-relaxed">
          {children}
        </div>

        <div className="flex gap-3 justify-end px-6 py-4 border-t border-slate-200">
          <Button variant="secondary" onClick={onClose} disabled={loading}>
            Cancel
          </Button>
          {onConfirm && (
            <Button variant={confirmVariant} onClick={onConfirm} loading={loading}>
              {confirmLabel}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
