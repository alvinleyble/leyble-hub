import React from 'react';
import { Link } from 'react-router-dom';

// Shared landing card for the V2 screens whose real content ships in a later
// slice. Slice 0 only needs the shell, nav chrome and routing to land.
export default function V2Placeholder({ title, slice, description, v1Path }) {
  return (
    <div className="p-6 sm:p-10">
      <div className="max-w-3xl rounded-2xl bg-v2-surface border border-v2-border p-6 sm:p-8">
        <p className="text-base font-semibold uppercase tracking-wide text-v2-accent">{slice}</p>
        <h1 className="mt-2 text-3xl font-bold text-v2-text">{title}</h1>
        <p className="mt-4 text-lg leading-relaxed text-v2-muted">{description}</p>

        {v1Path && (
          <Link
            to={v1Path}
            className="mt-8 inline-flex items-center justify-center min-h-tablet px-6 rounded-xl
                       text-lg font-semibold bg-v2-raised text-v2-text hover:bg-v2-border
                       transition-colors duration-100
                       focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-v2-accent"
          >
            Open the current {title} screen
          </Link>
        )}
      </div>
    </div>
  );
}
