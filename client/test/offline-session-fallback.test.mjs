import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Node = dom.window.Node;
globalThis.Event = dom.window.Event;
globalThis.KeyboardEvent = dom.window.KeyboardEvent;
globalThis.MouseEvent = dom.window.MouseEvent;
globalThis.localStorage = dom.window.localStorage;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { createRoot } = await import('react-dom/client');
const { act } = React;
const { MemoryRouter } = await import('react-router-dom');

const { api } = await import('../src/api/client.js');
const { AuthProvider, useAuth } = await import('../src/context/AuthContext.jsx');
const { default: LoginPage } = await import('../src/pages/LoginPage.jsx');
const { default: DashboardPage } = await import('../src/pages/DashboardPage.jsx');
const { default: OrdersPage } = await import('../src/pages/orders/OrdersPage.jsx');
const { ToastProvider } = await import('../src/components/ui/Toast.jsx');
const { putReceipt } = await import('../src/offline/index.js');
const { nativeStore, __resetMemoryBackend } = await import('../src/offline/nativeStore.js');

test('Regression: Fresh install offline login provides human-friendly connection message instead of Failed to fetch', async () => {
  localStorage.clear();

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new TypeError('Failed to fetch');
  };

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  try {
    let authCtx;
    function Consumer() {
      authCtx = useAuth();
      return React.createElement(LoginPage);
    }

    await act(async () => {
      root.render(
        React.createElement(
          MemoryRouter,
          null,
          React.createElement(AuthProvider, null, React.createElement(Consumer))
        )
      );
    });

    assert.equal(authCtx.user, null, 'User must be null initially');

    const form = container.querySelector('form');
    const emailInput = container.querySelector('input[type="email"]');
    const passwordInput = container.querySelector('input[type="password"]');

    emailInput.value = 'josie@leyblestore.com';
    emailInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    passwordInput.value = 'leyble123';
    passwordInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }));

    await act(async () => {
      form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    });

    const alertBox = container.querySelector('[role="alert"]');
    assert.ok(alertBox, 'Alert box should be rendered on failure');
    assert.match(
      alertBox.textContent,
      /Cannot connect to server/i,
      'Error message must be user-friendly, not raw "Failed to fetch"'
    );
  } finally {
    globalThis.fetch = originalFetch;
    act(() => root.unmount());
    container.remove();
  }
});

test('Regression: Returning user with native token recovers session even if localStorage was wiped', async () => {
  localStorage.clear();

  // Mock a valid JWT payload: { id: 3, email: 'josie@leyblestore.com', full_name: 'Josie', role: 'admin' }
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({ id: 3, email: 'josie@leyblestore.com', full_name: 'Josie', role: 'admin' })
  ).toString('base64url');
  const signature = 'mockSignature';
  const token = `${header}.${payload}.${signature}`;

  // Enable native mode simulation for this test
  api.__setNativeForTest(true);

  // Store token in native preferences
  await api.setToken(token);

  // Ensure localStorage is empty (simulating WebView storage eviction)
  localStorage.removeItem('cached_user');
  localStorage.removeItem('cachedUser');

  // Device is offline
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new TypeError('Failed to fetch');
  };

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  try {
    let authCtx;
    function Consumer() {
      authCtx = useAuth();
      return React.createElement('div', null, authCtx.user ? `Logged in as ${authCtx.user.full_name}` : 'Not logged in');
    }

    await act(async () => {
      root.render(
        React.createElement(
          MemoryRouter,
          null,
          React.createElement(AuthProvider, null, React.createElement(Consumer))
        )
      );
    });

    assert.ok(authCtx.user, 'Session must be recovered from native token when localStorage is wiped');
    assert.equal(authCtx.user.email, 'josie@leyblestore.com');
    assert.equal(authCtx.user.full_name, 'Josie');
    assert.equal(container.textContent, 'Logged in as Josie');
  } finally {
    globalThis.fetch = originalFetch;
    await api.setToken(null);
    api.__setNativeForTest(null);
    act(() => root.unmount());
    container.remove();
  }
});

test('Regression: DashboardPage degrades gracefully offline with cached data and advisory banner', async () => {
  localStorage.clear();

  const mockData = {
    summary: { in_transit_count: 2, pending_count: 5, completed_count: 3, pending_tickets: 0 },
    orders: [],
    low_stock: [],
  };
  localStorage.setItem('cached_dashboard', JSON.stringify(mockData));

  // Device is offline
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new TypeError('Failed to fetch');
  };

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  try {
    await act(async () => {
      root.render(React.createElement(MemoryRouter, null, React.createElement(DashboardPage)));
    });

    assert.ok(container.textContent.includes('Dashboard'), 'Dashboard should render');
    assert.ok(
      container.textContent.includes('Showing cached dashboard data'),
      'Advisory banner should indicate cached data while offline'
    );
    assert.ok(!container.textContent.includes('Failed to fetch'), 'Must never show raw "Failed to fetch"');
  } finally {
    globalThis.fetch = originalFetch;
    act(() => root.unmount());
    container.remove();
  }
});

test('Regression: DashboardPage with no cached data renders clean offline fallback card pointing to Orders', async () => {
  localStorage.clear();

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new TypeError('Failed to fetch');
  };

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  try {
    await act(async () => {
      root.render(React.createElement(MemoryRouter, null, React.createElement(DashboardPage)));
    });

    assert.ok(container.textContent.includes('You are currently offline'), 'Clean offline heading rendered');
    assert.ok(container.textContent.includes('Go to Outgoing Orders'), 'Link to Outgoing Orders present');
    assert.ok(!container.textContent.includes('Failed to fetch'), 'Must never show raw "Failed to fetch"');
  } finally {
    globalThis.fetch = originalFetch;
    act(() => root.unmount());
    container.remove();
  }
});

test('Regression: OrdersPage falls back to receiptHistory cache when offline instead of failing with toast', async () => {
  localStorage.clear();
  __resetMemoryBackend();

  // Pre-seed local receipt history with an order
  const cachedOrder = {
    id: 999,
    receipt_number: '1-00999',
    customer_name: 'Tindahan ni Aling Josie',
    total_amount: 1500,
    created_at: new Date().toISOString(),
    status: 'pending',
    order_type: 'delivery',
  };
  await putReceipt(cachedOrder);

  // Device is offline
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new TypeError('Failed to fetch');
  };

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  try {
    await act(async () => {
      root.render(
        React.createElement(
          MemoryRouter,
          null,
          React.createElement(ToastProvider, null, React.createElement(OrdersPage))
        )
      );
    });

    // Wait for async load()
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    assert.ok(
      container.textContent.includes('Tindahan ni Aling Josie'),
      'Locally cached order must be displayed when offline'
    );
    assert.ok(
      !container.textContent.includes('Failed to load orders'),
      'Must not trigger "Failed to load orders" error toast'
    );
  } finally {
    globalThis.fetch = originalFetch;
    act(() => root.unmount());
    container.remove();
  }
});

test('Regression: OrdersPage falls back to cached_orders (including server orders with null receipt_number) when offline', async () => {
  localStorage.clear();
  __resetMemoryBackend();

  const serverOrderWithoutReceiptNumber = {
    id: 1963,
    receipt_number: null,
    customer_name: 'Teresa Sari Sari',
    total_amount: 2744,
    created_at: new Date().toISOString(),
    status: 'pending',
    order_type: 'delivery',
  };

  // Pre-seed nativeStore cached_orders as if previously loaded online
  await nativeStore.setJson('v25.cached_orders', [serverOrderWithoutReceiptNumber]);

  // Device is offline
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new TypeError('Failed to fetch');
  };

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  try {
    await act(async () => {
      root.render(
        React.createElement(
          MemoryRouter,
          null,
          React.createElement(ToastProvider, null, React.createElement(OrdersPage))
        )
      );
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    assert.ok(
      container.textContent.includes('Teresa Sari Sari'),
      'Server orders without receipt_number must be loaded from cache when offline'
    );
    assert.ok(
      !container.textContent.includes('Failed to load orders'),
      'Must not trigger "Failed to load orders" error toast'
    );
  } finally {
    globalThis.fetch = originalFetch;
    act(() => root.unmount());
    container.remove();
  }
});

