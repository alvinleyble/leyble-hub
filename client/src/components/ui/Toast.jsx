import React, { createContext, useContext, useState, useCallback } from 'react';

const ToastContext = createContext(null);

let _nextId = 1;

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);

  const addToast = useCallback((message, type = 'info', action = null) => {
    const id = _nextId++;
    setToasts((prev) => [...prev, { id, message, type, action }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 5000);
  }, []);

  const dismiss = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const STYLES = {
    success: 'bg-green-50 border-green-300 text-green-800',
    error:   'bg-red-50   border-red-300   text-red-800',
    info:    'bg-white    border-slate-300  text-slate-800',
    warning: 'bg-amber-50 border-amber-300 text-amber-800',
  };

  return (
    <ToastContext.Provider value={{ addToast }}>
      {children}

      {/* Toast container — bottom-right, announced to screen readers */}
      <div
        className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 pointer-events-none"
        aria-live="polite"
        aria-atomic="false"
      >
        {toasts.map((toast) => (
          <div
            key={toast.id}
            data-testid={toast.type === 'error' ? 'toast-error' : undefined}
            className={`flex items-start gap-3 min-w-72 max-w-sm px-4 py-3 rounded-lg shadow-lg border pointer-events-auto
                        ${STYLES[toast.type] ?? STYLES.info}`}
          >
            <p className="flex-1 text-sm font-medium leading-snug">{toast.message}</p>
            {toast.action && (
              <button
                type="button"
                onClick={() => {
                  toast.action.onClick?.();
                  dismiss(toast.id);
                }}
                className="shrink-0 px-2.5 py-1 text-xs font-semibold rounded border border-current opacity-90 hover:opacity-100 hover:bg-black/5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current"
              >
                {toast.action.label}
              </button>
            )}
            <button
              onClick={() => dismiss(toast.id)}
              aria-label="Dismiss notification"
              className="flex items-center justify-center shrink-0 w-12 h-12 -my-2 -mr-2 rounded
                         text-current opacity-60 hover:opacity-100 text-2xl leading-none
                         focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current"
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}
