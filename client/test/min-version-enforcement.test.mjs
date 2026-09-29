import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from './render.mjs';
import {
  isBelowMinVersion,
  setMockAppInfo,
  setMockPlayStoreOpener,
  getAppVersion,
  getAppBuild,
} from '../src/version/appVersion.js';
import RequiredUpdateScreen from '../src/components/version/RequiredUpdateScreen.jsx';
import VersionGate from '../src/components/version/VersionGate.jsx';
import { api } from '../src/api/client.js';
import {
  enqueue, drainOutbox, listRecords, listNeedsAttention, __clearOutbox, QUEUED,
} from '../src/offline/outbox.js';

describe('Client minimum version enforcement', () => {
  beforeEach(() => {
    setMockAppInfo({
      version: '1.2.1',
      build: '4',
      id: 'com.leyble.hub',
    });
  });

  afterEach(() => {
    setMockAppInfo(null);
    setMockPlayStoreOpener(null);
  });

  describe('isBelowMinVersion', () => {
    it('returns false when minVersion is null, empty, or 0 (dormant)', () => {
      assert.equal(isBelowMinVersion({ version: '1.2.1', build: '4' }, null), false);
      assert.equal(isBelowMinVersion({ version: '1.2.1', build: '4' }, ''), false);
      assert.equal(isBelowMinVersion({ version: '1.2.1', build: '4' }, '   '), false);
      assert.equal(isBelowMinVersion({ version: '1.2.1', build: '4' }, '0'), false);
    });

    it('correctly compares semantic versions (versionName)', () => {
      // Below min
      assert.equal(isBelowMinVersion({ version: '1.2.1' }, '1.3.0'), true);
      assert.equal(isBelowMinVersion({ version: '1.2.1' }, '1.2.2'), true);
      assert.equal(isBelowMinVersion({ version: '0.9.9' }, '1.0.0'), true);
      assert.equal(isBelowMinVersion('1.2.1', '1.3.0'), true);

      // Equal to min (not below)
      assert.equal(isBelowMinVersion({ version: '1.2.1' }, '1.2.1'), false);
      assert.equal(isBelowMinVersion({ version: '1.3.0' }, '1.3'), false);

      // Above min (not below)
      assert.equal(isBelowMinVersion({ version: '1.3.1' }, '1.3.0'), false);
      assert.equal(isBelowMinVersion({ version: '2.0.0' }, '1.3.0'), false);
    });

    it('correctly compares numeric build codes (versionCode)', () => {
      // Below min
      assert.equal(isBelowMinVersion({ version: '1.2.1', build: '4' }, '5'), true);
      assert.equal(isBelowMinVersion({ version: '1.2.1', build: 13 }, '14'), true);

      // Equal or above
      assert.equal(isBelowMinVersion({ version: '1.2.1', build: '5' }, '5'), false);
      assert.equal(isBelowMinVersion({ version: '1.2.1', build: '6' }, '5'), false);
    });
  });

  describe('RequiredUpdateScreen component', () => {
    it('renders simple required-update screen containing only an Update button', () => {
      let openedAppId = null;
      setMockPlayStoreOpener((id) => { openedAppId = id; });

      const screen = render(React.createElement(RequiredUpdateScreen, { appId: 'com.leyble.hub' }));

      assert.match(screen.text(), /Update Required/i);
      assert.match(screen.text(), /A required update for Leyble Hub is available/i);

      // Verify only ONE button exists (Update button)
      const buttons = screen.all('button');
      assert.equal(buttons.length, 1, 'Screen must contain only an Update button');
      assert.equal(buttons[0].textContent.trim(), 'Update');

      // Clicking Update button invokes Play Store opener with correct appId
      screen.click(buttons[0]);
      assert.equal(openedAppId, 'com.leyble.hub');

      screen.unmount();
    });
  });

  describe('VersionGate component', () => {
    let originalApiGet;

    beforeEach(() => {
      originalApiGet = api.get;
    });

    afterEach(() => {
      api.get = originalApiGet;
    });

    it('renders children when enforcement is dormant (min_version is null)', async () => {
      api.get = async (path) => {
        if (path === '/version') return { min_version: null };
        return {};
      };

      const screen = render(
        React.createElement(
          VersionGate,
          null,
          React.createElement('div', { id: 'child-app' }, 'Normal App Content')
        )
      );

      // Wait a tick for initial check
      await React.act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
      });

      assert.match(screen.text(), /Normal App Content/);
      assert.equal(screen.all('#child-app').length, 1);
      screen.unmount();
    });

    it('immediately blocks normal app use when installed version is below minimum', async () => {
      api.get = async (path) => {
        if (path === '/version') return { min_version: '1.3.0' };
        return {};
      };

      const screen = render(
        React.createElement(
          VersionGate,
          null,
          React.createElement('div', { id: 'child-app' }, 'Normal App Content')
        )
      );

      // Wait for version check
      await React.act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
      });

      assert.match(screen.text(), /Update Required/i);
      assert.equal(screen.all('#child-app').length, 0, 'Normal app content must be completely unmounted/blocked');

      screen.unmount();
    });

    it('preserves existing offline operation when version check cannot reach service', async () => {
      api.get = async (path) => {
        if (path === '/version') {
          const err = new Error('Failed to fetch (offline)');
          err.status = 0;
          throw err;
        }
        return {};
      };

      const screen = render(
        React.createElement(
          VersionGate,
          null,
          React.createElement('div', { id: 'child-app' }, 'Normal App Content')
        )
      );

      await React.act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
      });

      // Offline preserves normal app use
      assert.match(screen.text(), /Normal App Content/);
      assert.equal(screen.all('#child-app').length, 1);

      screen.unmount();
    });

    it('enforces immediately when leyble:update-required event is dispatched', async () => {
      api.get = async (path) => {
        if (path === '/version') return { min_version: null };
        return {};
      };

      const screen = render(
        React.createElement(
          VersionGate,
          null,
          React.createElement('div', { id: 'child-app' }, 'Normal App Content')
        )
      );

      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.match(screen.text(), /Normal App Content/);

      // Simulate a 426 response event triggering update-required
      await React.act(async () => {
        window.dispatchEvent(new window.CustomEvent('leyble:update-required', { detail: { min_version: '1.3.0' } }));
        await new Promise((resolve) => setTimeout(resolve, 20));
      });

      assert.match(screen.text(), /Update Required/i);
      assert.equal(screen.all('#child-app').length, 0);

      screen.unmount();
    });

    // Regression coverage for the staging false "Update Required" defect: a cold-start
    // request can go out before appVersion.js's cache holds the real native build (it
    // reports the pre-init fallback build '4' instead of the true installed code), so
    // the very first check can wrongly latch `blocked`. A later, correctly-initialized
    // check (e.g. on foreground/focus) must be able to recover from that false block —
    // and must never falsely recover a build that is genuinely below minimum.
    it('recovers from a false block once a later confirmed check proves the install (code 21) meets the minimum', async () => {
      setMockAppInfo({ version: '1.2.1', build: '4', id: 'com.leyble.hub' }); // simulates pre-init fallback
      api.get = async (path) => {
        if (path === '/version') return { min_version: '21' };
        return {};
      };

      const screen = render(
        React.createElement(
          VersionGate,
          null,
          React.createElement('div', { id: 'child-app' }, 'Normal App Content')
        )
      );

      await React.act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
      });

      // The initial (falsely fallback-headered) check latches the block.
      assert.match(screen.text(), /Update Required/i);
      assert.equal(screen.all('#child-app').length, 0);

      // appVersion.js's cache finishes initializing with the true installed code (21).
      setMockAppInfo({ version: '1.5.0', build: '21', id: 'com.leyble.hub' });

      // VersionGate's existing foreground listener re-runs the check.
      await React.act(async () => {
        window.dispatchEvent(new window.Event('focus'));
        await new Promise((resolve) => setTimeout(resolve, 30));
      });

      assert.match(screen.text(), /Normal App Content/, 'a confirmed code 21 must recover from the false block');
      assert.equal(screen.all('#child-app').length, 1);

      screen.unmount();
    });

    it('keeps blocking across repeated checks when the confirmed install (code 20) is genuinely below minimum (21)', async () => {
      setMockAppInfo({ version: '1.4.0', build: '20', id: 'com.leyble.hub' });
      api.get = async (path) => {
        if (path === '/version') return { min_version: '21' };
        return {};
      };

      const screen = render(
        React.createElement(
          VersionGate,
          null,
          React.createElement('div', { id: 'child-app' }, 'Normal App Content')
        )
      );

      await React.act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
      });

      assert.match(screen.text(), /Update Required/i);

      // A later foreground re-check with the SAME genuinely below-minimum build must
      // never falsely recover.
      await React.act(async () => {
        window.dispatchEvent(new window.Event('focus'));
        await new Promise((resolve) => setTimeout(resolve, 30));
      });

      assert.match(screen.text(), /Update Required/i, 'code 20 against min_version 21 must remain blocked');
      assert.equal(screen.all('#child-app').length, 0);

      screen.unmount();
    });
  });

  describe('api/client request headers', () => {
    it('provides synchronous app version and build accessors', () => {
      setMockAppInfo({ version: '1.2.1', build: '4', id: 'com.leyble.hub' });
      assert.equal(getAppVersion(), '1.2.1');
      assert.equal(getAppBuild(), '4');
    });
  });

  describe('outbox drain on 426 update_required', () => {
    it('halts drain and preserves queued records without marking needs-attention when server returns 426', async () => {
      await __clearOutbox();

      const originalRequest = api.request;
      api.request = async () => {
        const err = new Error('App update required');
        err.status = 426;
        err.data = { code: 'update_required', min_version: '1.3.0' };
        throw err;
      };

      try {
        await enqueue({
          entityType: 'order',
          endpoint: '/orders',
          method: 'POST',
          payload: { test: true },
          profileKey: 'alvin@leyblestore.com',
        });

        const result = await drainOutbox();
        assert.equal(result.sent, 0);
        assert.equal(result.failed, 0, 'Must NOT fail or mark as needs-attention on 426');
        assert.equal(result.waiting, 1);

        const records = await listRecords();
        assert.equal(records.length, 1);
        assert.equal(records[0].status, QUEUED);

        const needsAttention = await listNeedsAttention();
        assert.equal(needsAttention.length, 0);
      } finally {
        api.request = originalRequest;
        await __clearOutbox();
      }
    });
  });
});
