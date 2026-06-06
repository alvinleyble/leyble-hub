import React, { createContext, useContext, useState, useCallback } from 'react';

const ToastContext = createContext(null);

let _nextId = 1;

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);

  const addToast = useCallback((message, type = 'info') => {
    const id = _nextId++;
    setToasts((prev) => [...prev, { id, message, type }]);
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
            className={`flex items-start gap-3 min-w-72 max-w-sm px-4 py-3 rounded-lg shadow-lg border pointer-events-auto
                        ${STYLES[toast.type] ?? STYLES.info}`}
          >
            <p className="flex-1 text-sm font-medium leading-snug">{toast.message}</p>
            <button
              onClick={() => dismiss(toast.id)}
              aria-label="Dismiss notification"
              className="text-current opacity-50 hover:opacity-100 text-lg leading-none shrink-0 mt-px"
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
