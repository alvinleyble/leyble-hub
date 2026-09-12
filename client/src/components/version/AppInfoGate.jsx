import React, { useEffect, useState } from 'react';
import { getAppInfo } from '../../version/appVersion';
import Spinner from '../ui/Spinner';

/**
 * Withholds the rest of the app — and therefore every effect that can issue an API
 * request, starting with AuthProvider's own /auth/me check — until the real native
 * app version/build has loaded into appVersion.js's cache.
 *
 * Without this, cold start renders AuthProvider before Capacitor's async App.getInfo()
 * resolves, so the very first request goes out carrying appVersion.js's pre-init
 * fallback build header. The server correctly rejects that fallback as below any real
 * minimum version, and VersionGate then blocks the app before it has ever asked with
 * the true installed build.
 */
export default function AppInfoGate({ children, loadAppInfo = getAppInfo }) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    loadAppInfo().finally(() => {
      if (!cancelled) setReady(true);
    });
    return () => { cancelled = true; };
  }, [loadAppInfo]);

  if (!ready) {
    return (
      <div className="flex h-screen items-center justify-center bg-slate-50">
        <Spinner size="lg" />
      </div>
    );
  }

  return children;
}
