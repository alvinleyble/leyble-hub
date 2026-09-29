import React from 'react';
import NavIcon from '../layout/NavIcon';

// The one "go back" control (UI audit F23): a chevron and the name of where it goes,
// 48px tall. Settings and Order detail used two different styles before.
export default function BackLink({ onClick, children, className = '' }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1 min-h-[48px] -ml-2 pl-1 pr-3 rounded-lg text-base font-semibold
                  text-blue-700 hover:bg-blue-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 ${className}`}
    >
      <NavIcon name="chevronLeft" className="w-5 h-5" />
      {children}
    </button>
  );
}
