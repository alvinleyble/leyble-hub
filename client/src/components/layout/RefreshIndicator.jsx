import React from 'react';
import Spinner from '../ui/Spinner';
import { PULL_THRESHOLD } from './usePullToRefresh';

const SIZE = 44;
const REST_OFFSET = 16;

/**
 * The circle that slides down from the top of the page: follows the finger during a
 * pull (its arrow turning as it nears the release point), then holds a spinner in place
 * while the refresh runs. Overlays the page rather than pushing it down, so nothing on
 * screen shifts.
 */
export default function RefreshIndicator({ pull, refreshing }) {
  if (!refreshing && pull <= 0) return null;
  const progress = Math.min(1, pull / PULL_THRESHOLD);
  const offset = refreshing ? REST_OFFSET : pull - SIZE + REST_OFFSET * progress;
  return (
    <div
      className="pointer-events-none absolute inset-x-0 top-0 z-30 flex justify-center"
      data-testid="refresh-indicator"
    >
      <div
        className={`flex items-center justify-center rounded-full border border-slate-200 bg-white shadow-md
                    ${pull > 0 ? '' : 'transition-transform duration-200'}`}
        style={{ width: SIZE, height: SIZE, transform: `translateY(${offset}px)`, opacity: refreshing ? 1 : 0.4 + 0.6 * progress }}
      >
        {refreshing ? (
          <>
            <Spinner size="md" />
            <span className="sr-only">Refreshing</span>
          </>
        ) : (
          <svg
            className="h-6 w-6 text-blue-600"
            style={{ transform: `rotate(${progress * 270}deg)` }}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M21 12a9 9 0 1 1-2.64-6.36" />
            <path d="M21 3v6h-6" />
          </svg>
        )}
      </div>
    </div>
  );
}
