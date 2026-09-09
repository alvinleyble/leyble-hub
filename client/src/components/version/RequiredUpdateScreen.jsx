import React from 'react';
import Button from '../ui/Button';
import { openPlayStore } from '../../version/appVersion';

/**
 * Required Update Screen.
 *
 * Rendered when the installed app version is below the required minimum version.
 * Immediately blocks normal app use with a simple screen containing only an Update button
 * that opens the app's Google Play internal-distribution listing.
 */
export default function RequiredUpdateScreen({ appId }) {
  const handleUpdate = () => {
    openPlayStore(appId);
  };

  return (
    <div
      role="alertdialog"
      aria-labelledby="update-title"
      aria-describedby="update-desc"
      className="flex h-screen flex-col items-center justify-center gap-4 bg-slate-50 px-6 text-center"
    >
      <div className="rounded-full bg-amber-100 p-4 text-amber-600" aria-hidden="true">
        <svg className="h-10 w-10" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
        </svg>
      </div>

      <h1 id="update-title" className="text-2xl font-bold text-slate-800">
        Update Required
      </h1>

      <p id="update-desc" className="max-w-sm text-base text-slate-600">
        A required update for Leyble Hub is available. Please update the app to continue.
      </p>

      <div className="mt-2">
        <Button variant="primary" size="lg" onClick={handleUpdate}>
          Update
        </Button>
      </div>
    </div>
  );
}
