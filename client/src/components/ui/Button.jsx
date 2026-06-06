import React from 'react';

const VARIANTS = {
  primary:   'bg-blue-700   text-white      hover:bg-blue-800   focus-visible:ring-blue-700',
  secondary: 'bg-white      text-slate-800  border border-slate-300 hover:bg-slate-100 focus-visible:ring-slate-400',
  danger:    'bg-red-700    text-white      hover:bg-red-800    focus-visible:ring-red-700',
  ghost:     'bg-transparent text-slate-700 hover:bg-slate-100  focus-visible:ring-slate-400',
  warning:   'bg-amber-600  text-white      hover:bg-amber-700  focus-visible:ring-amber-600',
};

const SIZES = {
  sm: 'min-h-[40px] px-4 text-sm',
  md: 'min-h-[48px] px-5 text-base',
  lg: 'min-h-[56px] px-6 text-lg',
};

export default function Button({
  children,
  variant = 'primary',
  size = 'md',
  className = '',
  disabled,
  loading,
  type = 'button',
  ...props
}) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      className={`
        inline-flex items-center justify-center gap-2 font-semibold rounded-lg
        transition-colors duration-150
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2
        disabled:opacity-50 disabled:cursor-not-allowed
        ${VARIANTS[variant] ?? VARIANTS.primary}
        ${SIZES[size] ?? SIZES.md}
        ${className}
      `}
      {...props}
    >
      {loading && (
        <svg className="animate-spin h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" aria-hidden="true">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
        </svg>
      )}
      {children}
    </button>
  );
}
