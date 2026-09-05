import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, React, act } from './render.mjs';
import { api } from '../src/api/client.js';
import { ToastProvider } from '../src/components/ui/Toast.jsx';
import { AuthProvider, setStoredSession, __setIsNativeForTest } from '../src/context/AuthContext.jsx';
import { __resetMemoryBackend } from '../src/offline/nativeStore.js';
import { rememberAccount } from '../src/offline/accounts.js';

const AccountSwitchModal = (await import('../src/components/accounts/AccountSwitchModal.jsx')).default;

const JOSIE = { id: 1, email: 'josie@leyblestore.com', full_name: 'Josie Leyble', role: 'admin' };
const LUIS = { id: 2, email: 'luis@leyblestore.com', full_name: 'Luis Leyble', role: 'admin' };

beforeEach(async () => {
  __resetMemoryBackend();
  __setIsNativeForTest(false);
  localStorage.clear();
  await api.forgetAccountToken(JOSIE.email);
  await api.forgetAccountToken(LUIS.email);
  await setStoredSession(JOSIE);
  await rememberAccount(JOSIE, 'token-josie');
  await rememberAccount(LUIS, null); // Luis has no token -> works offline
});

afterEach(async () => {
  __setIsNativeForTest(false);
  localStorage.clear();
  await api.forgetAccountToken(JOSIE.email);
  await api.forgetAccountToken(LUIS.email);
});

test('AccountSwitchModal renders viewport-centered without mt-16 or items-start', async () => {
  const view = render(
    React.createElement(ToastProvider, null,
      React.createElement(AuthProvider, null,
        React.createElement(AccountSwitchModal, { onClose: () => {} })
      )
    )
  );
  await act(async () => { await Promise.resolve(); });

  const dialog = view.container.querySelector('[role="dialog"]');
  assert.ok(dialog, 'dialog exists');
  assert.ok(dialog.className.includes('items-center'), 'dialog container has items-center');
  assert.ok(dialog.className.includes('justify-center'), 'dialog container has justify-center');
  assert.ok(!dialog.className.includes('items-start'), 'dialog container does not have items-start');

  const modalPanel = dialog.querySelector('.w-full.max-w-md');
  assert.ok(modalPanel, 'modal panel exists');
  assert.ok(!modalPanel.className.includes('mt-16'), 'modal panel does not have mt-16 positioning hack');

  view.unmount();
});

test('account buttons and secondary button have 52px+ touch targets and proper ergonomics', async () => {
  const view = render(
    React.createElement(ToastProvider, null,
      React.createElement(AuthProvider, null,
        React.createElement(AccountSwitchModal, { onClose: () => {} })
      )
    )
  );
  await act(async () => { await Promise.resolve(); });

  const josieBtn = view.container.querySelector('[data-testid="account-switch-josie@leyblestore.com"]');
  const luisBtn = view.container.querySelector('[data-testid="account-switch-luis@leyblestore.com"]');
  assert.ok(josieBtn, 'Josie button rendered');
  assert.ok(luisBtn, 'Luis button rendered');

  assert.ok(josieBtn.className.includes('min-h-[64px]'), 'account button has min-h-[64px] (>= 52px)');
  assert.ok(luisBtn.className.includes('min-h-[64px]'), 'account button has min-h-[64px] (>= 52px)');

  const addAccountBtn = view.container.querySelector('button.w-full.min-h-\\[52px\\]');
  assert.ok(addAccountBtn, 'Sign in as someone else button has 52px+ touch target');

  // Check internal ergonomics: avatar, name, email
  assert.match(josieBtn.textContent, /Josie Leyble/, 'renders full name');
  assert.match(josieBtn.textContent, /josie@leyblestore.com/, 'renders email');
  assert.match(josieBtn.textContent, /Using now/, 'marks current account as Using now');

  view.unmount();
});

test('offline warning notice banner renders for accounts without token with status role and icon', async () => {
  const view = render(
    React.createElement(ToastProvider, null,
      React.createElement(AuthProvider, null,
        React.createElement(AccountSwitchModal, { onClose: () => {} })
      )
    )
  );
  await act(async () => { await Promise.resolve(); });

  const luisBtn = view.container.querySelector('[data-testid="account-switch-luis@leyblestore.com"]');
  const warningBanner = luisBtn.querySelector('[role="status"]');
  assert.ok(warningBanner, 'offline warning banner has role="status"');
  assert.match(warningBanner.textContent, /Works offline — will ask for their password once there is internet/);
  assert.ok(warningBanner.className.includes('bg-amber-50'), 'banner has calm amber background');
  assert.ok(warningBanner.className.includes('border-amber-300'), 'banner has amber border');

  // Josie has token, so she should NOT have the warning banner
  const josieBtn = view.container.querySelector('[data-testid="account-switch-josie@leyblestore.com"]');
  assert.equal(josieBtn.querySelector('[role="status"]'), null, 'Josie does not have warning banner');

  view.unmount();
});

test('clicking another account triggers switch and callback', async () => {
  let closed = false;
  let switchedResult = null;

  // Give Luis a token so switch succeeds without error
  await rememberAccount(LUIS, 'token-luis');

  const view = render(
    React.createElement(ToastProvider, null,
      React.createElement(AuthProvider, null,
        React.createElement(AccountSwitchModal, {
          onClose: () => { closed = true; },
          onSwitched: (res) => { switchedResult = res; },
        })
      )
    )
  );
  await act(async () => { await Promise.resolve(); });

  const luisBtn = view.container.querySelector('[data-testid="account-switch-luis@leyblestore.com"]');
  await act(async () => {
    view.click(luisBtn);
    await Promise.resolve();
  });

  assert.equal(closed, true, 'closed modal after switch');
  assert.ok(switchedResult, 'received switch result');
  assert.equal(switchedResult.email, 'luis@leyblestore.com');

  view.unmount();
});

test('close button and Escape key dismiss the modal', async () => {
  let closed = false;

  const view = render(
    React.createElement(ToastProvider, null,
      React.createElement(AuthProvider, null,
        React.createElement(AccountSwitchModal, { onClose: () => { closed = true; } })
      )
    )
  );
  await act(async () => { await Promise.resolve(); });

  const closeBtn = view.container.querySelector('button[aria-label="Close"]');
  assert.ok(closeBtn, 'close button exists');
  assert.ok(closeBtn.className.includes('w-12') && closeBtn.className.includes('h-12'), 'close button is 48px touch target');

  await act(async () => {
    view.press('Escape');
  });
  assert.equal(closed, true, 'Escape key closed modal');

  view.unmount();
});
