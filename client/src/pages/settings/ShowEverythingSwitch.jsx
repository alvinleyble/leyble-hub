import React from 'react';
import { setShowEverything, useShowEverything } from '../../config/showEverything';

// The one "Show everything" switch (config/showEverything.js). Off, the default, keeps
// the app to what the shop uses every day; on brings back every other screen and step.
// The whole row is the switch, and its state is always said in words as well as shown.
export default function ShowEverythingSwitch() {
  const { showEverything } = useShowEverything();

  return (
    <section className="mt-4 max-w-3xl md:mt-6" aria-label="Show everything">
      <button
        type="button"
        role="switch"
        aria-checked={showEverything}
        aria-labelledby="show-everything-title"
        aria-describedby="show-everything-detail"
        onClick={() => { setShowEverything(!showEverything).catch(() => {}); }}
        data-testid="settings-show-everything"
        className="flex w-full min-h-[72px] items-center gap-4 rounded-xl border border-slate-200 bg-white px-5 py-3
                   text-left shadow-sm hover:bg-slate-50 active:bg-slate-100
                   focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
      >
        <span className="min-w-0 flex-1">
          <span id="show-everything-title" className="block text-lg font-semibold text-slate-900">
            Show everything
          </span>
          <span id="show-everything-detail" className="block break-words text-base text-slate-600">
            {showEverything
              ? 'Showing every screen and step, including delivery stages, stock counts, Incoming, Personnel, Tickets and Audit Log.'
              : 'Off: only the screens used every day. Turn on to see delivery stages, stock counts, Incoming, Personnel, Tickets and Audit Log.'}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-2">
          <span
            className={`w-8 text-right text-base font-semibold ${showEverything ? 'text-blue-700' : 'text-slate-600'}`}
            data-testid="settings-show-everything-state"
          >
            {showEverything ? 'On' : 'Off'}
          </span>
          <span
            aria-hidden="true"
            className={`relative inline-flex h-8 w-14 items-center rounded-full transition-colors duration-150
                        ${showEverything ? 'bg-blue-700' : 'bg-slate-400'}`}
          >
            <span
              className={`inline-block h-6 w-6 rounded-full bg-white shadow transition-transform duration-150
                          ${showEverything ? 'translate-x-7' : 'translate-x-1'}`}
            />
          </span>
        </span>
      </button>
    </section>
  );
}
