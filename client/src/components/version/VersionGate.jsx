import React, { useState, useEffect, useCallback } from 'react';
import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import { api } from '../../api/client';
import { getAppInfo, isBelowMinVersion } from '../../version/appVersion';
import RequiredUpdateScreen from './RequiredUpdateScreen';

/**
 * VersionGate: enforces minimum required version on app launch and foreground resume.
 *
 * If the installed app is below the minimum required version, normal app use is immediately
 * blocked and RequiredUpdateScreen is rendered.
 * If offline or server unreachable, existing offline operation is preserved.
 */
export default function VersionGate({ children }) {
  const [blocked, setBlocked] = useState(false);
  const [appId, setAppId] = useState('com.leyble.hub');

  const checkVersion = useCallback(async () => {
    try {
      const info = await getAppInfo();
      if (info?.id) setAppId(info.id);

      const res = await api.get('/version', { retry: false });
      if (res?.min_version) {
        if (isBelowMinVersion(info, res.min_version)) {
          setBlocked(true);
        }
      }
    } catch (err) {
      if (err?.status === 426 || err?.data?.code === 'update_required') {
        setBlocked(true);
      }
      // Preserve existing offline operation on network errors
    }
  }, []);

  useEffect(() => {
    // Check on initial app launch
    checkVersion();

    // Listen for reactive update_required events dispatched by api/client.js on 426 responses
    const handleUpdateRequired = () => {
      setBlocked(true);
    };
    window.addEventListener('leyble:update-required', handleUpdateRequired);

    // Foreground listener for Native Android
    let appStateHandle = null;
    if (Capacitor.isNativePlatform()) {
      App.addListener('appStateChange', (state) => {
        if (state?.isActive) {
          checkVersion();
        }
      }).then((handle) => {
        appStateHandle = handle;
      }).catch(() => {});
    }

    // Foreground listeners for browser / dev
    const handleVisibilityChange = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
        checkVersion();
      }
    };
    const handleWindowFocus = () => {
      checkVersion();
    };

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibilityChange);
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('focus', handleWindowFocus);
    }

    return () => {
      window.removeEventListener('leyble:update-required', handleUpdateRequired);
      if (appStateHandle?.remove) {
        appStateHandle.remove();
      }
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleVisibilityChange);
      }
      if (typeof window !== 'undefined') {
        window.removeEventListener('focus', handleWindowFocus);
      }
    };
  }, [checkVersion]);

  if (blocked) {
    return <RequiredUpdateScreen appId={appId} />;
  }

  return children;
}
