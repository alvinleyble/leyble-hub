import React from 'react';

// The page frame every top-level screen sits in (docs/design/design-standard.md, Q11):
// a 16px edge on phones, 24px from the tablet switch (768px, Q1) up. Sections inside
// a page are 16px apart on phones (`mb-4`) and 24px on tablets (`md:mb-6`).
export const PAGE_PADDING = 'px-4 py-4 md:px-6 md:py-6';
export const SECTION_GAP = 'mb-4 md:mb-6';

export default function Page({ children, className = '', wide = true }) {
  return (
    <div className={`${PAGE_PADDING} ${wide ? 'max-w-7xl' : 'max-w-3xl'} mx-auto ${className}`}>
      {children}
    </div>
  );
}
