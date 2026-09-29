import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from './render.mjs';
import AppInfoGate from '../src/components/version/AppInfoGate.jsx';

// Regression coverage for the staging false "Update Required" defect: AuthProvider's
// /auth/me check (and any other provider's effect) must never fire before appVersion.js's
// cache holds the real native app version/build. AppInfoGate is what withholds mounting
// of the rest of the app until that load resolves, so this proves the ordering guarantee
// directly, independent of Capacitor/native mocking.
describe('AppInfoGate startup ordering', () => {
  it('withholds children — and any effect they would run, e.g. an API-issuing provider — until app info finishes loading', async () => {
    let resolveInfo;
    const pending = new Promise((resolve) => { resolveInfo = resolve; });
    let effectFireCount = 0;

    function Probe() {
      React.useEffect(() => { effectFireCount += 1; }, []);
      return React.createElement('div', { id: 'probe' }, 'mounted');
    }

    const screen = render(
      React.createElement(
        AppInfoGate,
        { loadAppInfo: () => pending },
        React.createElement(Probe)
      )
    );

    // Still loading: the child (and its effect) must not have run yet.
    await React.act(async () => {
      await Promise.resolve();
    });
    assert.equal(effectFireCount, 0, 'child effect must not fire before app info resolves');
    assert.equal(screen.all('#probe').length, 0, 'child must not be mounted before app info resolves');

    // App info finishes loading (simulating Capacitor's async App.getInfo() resolving).
    await React.act(async () => {
      resolveInfo();
      await pending;
    });

    assert.equal(effectFireCount, 1, 'child effect must fire exactly once app info has resolved');
    assert.equal(screen.all('#probe').length, 1);

    screen.unmount();
  });

  it('renders children immediately once loadAppInfo resolves synchronously (non-native / already-cached case)', async () => {
    const screen = render(
      React.createElement(
        AppInfoGate,
        { loadAppInfo: () => Promise.resolve({ version: '1.5.0', build: '21' }) },
        React.createElement('div', { id: 'child-app' }, 'Normal App Content')
      )
    );

    await React.act(async () => {
      await Promise.resolve();
    });

    assert.match(screen.text(), /Normal App Content/);
    screen.unmount();
  });
});
