import React, { useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import Button from '../../components/ui/Button';
import { api } from '../../api/client';
import { getAppInfo, isBelowMinVersion, openPlayStore } from '../../version/appVersion';
import SettingsSection, { SettingRow, AndroidOnlyNote } from './SettingsSection';

// About: the installed version and build, whether it meets the server's minimum
// (GET /version — the same check VersionGate enforces), and a Check for updates button
// that opens the Play Store listing. The browser build has no installed version to
// report, so it says where to look instead of showing the bundled defaults.
export default function AboutSection({ native = Capacitor.isNativePlatform() }) {
  const [info, setInfo] = useState(null);
  // 'checking' | 'ok' | 'below' | 'none' | 'unknown'
  const [minCheck, setMinCheck] = useState({ state: 'checking', minVersion: null });

  useEffect(() => {
    let alive = true;
    (async () => {
      const appInfo = await getAppInfo().catch(() => null);
      if (!alive) return;
      setInfo(appInfo);
      if (!native) return;
      try {
        const res = await api.get('/version', { retry: false });
        if (!alive) return;
        const minVersion = res?.min_version || null;
        if (!minVersion) setMinCheck({ state: 'none', minVersion: null });
        else setMinCheck({ state: isBelowMinVersion(appInfo, minVersion) ? 'below' : 'ok', minVersion });
      } catch {
        if (alive) setMinCheck({ state: 'unknown', minVersion: null });
      }
    })();
    return () => { alive = false; };
  }, [native]);

  return (
    <SettingsSection id="about">
      {native ? (
        <dl>
          <SettingRow label="Installed" testId="settings-about-version">
            {info ? `Version ${info.version} · build ${info.build}` : '…'}
          </SettingRow>
          <SettingRow label="Server minimum" testId="settings-about-min">
            <MinVersionText check={minCheck} />
          </SettingRow>
        </dl>
      ) : (
        <AndroidOnlyNote testId="settings-about-web-note">
          The version and build number are shown in the Android app.
        </AndroidOnlyNote>
      )}
      <Button
        variant="secondary"
        className="mt-4 w-full sm:w-auto"
        onClick={() => openPlayStore(info?.id)}
        data-testid="settings-about-check-updates"
      >
        Check for updates
      </Button>
    </SettingsSection>
  );
}

function MinVersionText({ check }) {
  switch (check.state) {
    case 'ok':
      return <span className="text-green-800">✓ Meets the minimum ({check.minVersion})</span>;
    case 'below':
      return (
        <span className="text-red-800">
          ✕ Below the minimum ({check.minVersion}). Update from the Play Store.
        </span>
      );
    case 'none':
      return <span>No minimum set</span>;
    case 'unknown':
      return <span className="text-slate-600">Could not check. Connect to the internet and reopen Settings.</span>;
    default:
      return <span className="text-slate-500">Checking…</span>;
  }
}
