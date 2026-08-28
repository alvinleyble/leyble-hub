import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, React, act } from './render.mjs';
import { Preferences } from '@capacitor/preferences';
import { api } from '../src/api/client.js';
import { ToastProvider } from '../src/components/ui/Toast.jsx';
import { SESSION_KEY } from '../src/offline/keys.js';
import {
  AuthProvider,
  useAuth,
  getStoredSession,
  setStoredSession,
  removeStoredSession,
  __setIsNativeForTest,
} from '../src/context/AuthContext.jsx';

const LoginPage = (await import('../src/pages/LoginPage.jsx')).default;
const OrderDetailPage = (await import('../src/pages/orders/OrderDetailPage.jsx')).default;
const ProductDetailPanel = (await import('../src/pages/inventory/ProductDetailPanel.jsx')).default;
const CustomerDetailPanel = (await import('../src/pages/customers/CustomerDetailPanel.jsx')).default;
const PersonnelDetailPanel = (await import('../src/pages/personnel/PersonnelDetailPanel.jsx')).default;
const DeliveryDetailPanel = (await import('../src/pages/incoming/DeliveryDetailPanel.jsx')).default;

let originalApiGet, originalApiPost, originalApiPatch, originalApiDel;

beforeEach(async () => {
  originalApiGet = api.get;
  originalApiPost = api.post;
  originalApiPatch = api.patch;
  originalApiDel = api.del;
  __setIsNativeForTest(false);
  localStorage.clear();
  await Preferences.clear().catch(() => {});
});

afterEach(() => {
  api.get = originalApiGet;
  api.post = originalApiPost;
  api.patch = originalApiPatch;
  api.del = originalApiDel;
  __setIsNativeForTest(false);
});

// ── 1. Native & Web Session Persistence in AuthContext ─────────────────────────

test('AuthContext: native builds store and retrieve session from @capacitor/preferences key v25.session', async () => {
  __setIsNativeForTest(true);

  const mockUser = { id: 42, email: 'josie@leyblestore.com', full_name: 'Josie Leyble', role: 'admin' };
  await setStoredSession(mockUser);

  // Directly verify @capacitor/preferences holds the value
  const { value } = await Preferences.get({ key: SESSION_KEY });
  assert.ok(value, 'Preferences must hold session value');
  assert.deepEqual(JSON.parse(value), mockUser);

  // Verify getStoredSession retrieves it
  const restored = await getStoredSession();
  assert.deepEqual(restored, mockUser);

  // Verify removeStoredSession cleans Preferences
  await removeStoredSession();
  const { value: cleared } = await Preferences.get({ key: SESSION_KEY });
  assert.equal(cleared, null);
});

test('AuthContext: web builds fall back to localStorage v25.session and legacy cached_user', async () => {
  __setIsNativeForTest(false);

  const mockUser = { id: 7, email: 'luis@leyblestore.com', full_name: 'Luis Leyble', role: 'staff' };
  await setStoredSession(mockUser);

  assert.deepEqual(JSON.parse(localStorage.getItem(SESSION_KEY)), mockUser);
  assert.deepEqual(await getStoredSession(), mockUser);

  await removeStoredSession();
  assert.equal(localStorage.getItem(SESSION_KEY), null);

  // Sane legacy fallback
  localStorage.setItem('cached_user', JSON.stringify(mockUser));
  assert.deepEqual(await getStoredSession(), mockUser);
});

test('AuthContext / AuthProvider: network failure during /auth/me silently restores session without error', async () => {
  __setIsNativeForTest(true);
  const mockUser = { id: 42, email: 'josie@leyblestore.com', full_name: 'Josie Leyble', role: 'admin' };
  await Preferences.set({ key: SESSION_KEY, value: JSON.stringify(mockUser) });

  // Simulate network failure on /auth/me
  api.get = async (path) => {
    if (path === '/auth/me') {
      const err = new TypeError('Failed to fetch');
      throw err;
    }
    return {};
  };

  let authResult = null;
  function TestConsumer() {
    const auth = useAuth();
    authResult = auth;
    return React.createElement('div', null, auth.loading ? 'loading' : `user:${auth.user?.email}`);
  }

  const { text, unmount } = render(
    React.createElement(AuthProvider, null, React.createElement(TestConsumer, null))
  );

  // Wait for checkAuth to finish
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });

  assert.equal(authResult?.loading, false);
  assert.deepEqual(authResult?.user, mockUser);
  assert.ok(text().includes('user:josie@leyblestore.com'));
  unmount();
});

test('AuthContext / AuthProvider: 401 unauthenticated clears user and session', async () => {
  __setIsNativeForTest(true);
  const mockUser = { id: 42, email: 'josie@leyblestore.com', full_name: 'Josie Leyble', role: 'admin' };
  await Preferences.set({ key: SESSION_KEY, value: JSON.stringify(mockUser) });

  // Simulate 401 on /auth/me
  api.get = async (path) => {
    if (path === '/auth/me') {
      const err = new Error('Unauthenticated');
      err.status = 401;
      throw err;
    }
    return {};
  };

  let authResult = null;
  function TestConsumer() {
    const auth = useAuth();
    authResult = auth;
    return React.createElement('div', null, auth.loading ? 'loading' : `user:${auth.user?.email ?? 'none'}`);
  }

  const { text, unmount } = render(
    React.createElement(AuthProvider, null, React.createElement(TestConsumer, null))
  );

  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });

  assert.equal(authResult?.loading, false);
  assert.equal(authResult?.user, null);
  assert.ok(text().includes('user:none'));

  const { value } = await Preferences.get({ key: SESSION_KEY });
  assert.equal(value, null);
  unmount();
});

// ── 2. Friendly Offline Error on LoginPage ─────────────────────────────────────

test('LoginPage: surfaces friendly "you\'re offline" message on network failure instead of raw "Failed to fetch"', async () => {
  api.post = async (path) => {
    if (path === '/auth/login') {
      throw new TypeError('Failed to fetch');
    }
    return {};
  };

  const { container, click, text, unmount } = render(
    React.createElement(
      AuthProvider,
      null,
      React.createElement(ToastProvider, null, React.createElement(LoginPage, null))
    )
  );

  const button = container.querySelector('button[type="submit"]');
  assert.ok(button, 'Submit button should exist');

  await act(async () => {
    click(button);
  });

  const content = text();
  assert.ok(!content.includes('Failed to fetch'), 'Must NOT show raw "Failed to fetch" error');
  assert.ok(
    content.includes("You're offline. Connect to the internet to sign in."),
    `Expected friendly offline message, got: ${content}`
  );
  unmount();
});

test('LoginPage: displays server credential error when online', async () => {
  api.post = async (path) => {
    if (path === '/auth/login') {
      const err = new Error('Invalid email or password');
      err.status = 401;
      throw err;
    }
    return {};
  };

  const { container, click, text, unmount } = render(
    React.createElement(
      AuthProvider,
      null,
      React.createElement(ToastProvider, null, React.createElement(LoginPage, null))
    )
  );

  const button = container.querySelector('button[type="submit"]');
  await act(async () => {
    click(button);
  });

  const content = text();
  assert.ok(content.includes('Invalid email or password'));
  unmount();
});

// ── 3. Defensive Null Guards on Crashing Detail Panels ──────────────────────────

test('OrderDetailPage: renders without crashing when cached order has missing items array', async () => {
  const partialOrder = {
    id: 1001,
    receipt_number: '1-00042',
    status: 'pending',
    order_type: 'delivery',
    customer_name: 'Aling Nena Store',
    total_amount: 1500.0,
    adjustment: 0,
    created_at: new Date().toISOString(),
    items: undefined, // Missing items array!
    personnel: undefined, // Missing personnel array!
  };

  api.get = async (path) => {
    if (path.includes('/orders/')) return partialOrder;
    return [];
  };

  const { text, unmount } = render(
    React.createElement(
      ToastProvider,
      null,
      React.createElement(OrderDetailPage, null)
    )
  );

  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });

  const content = text();
  assert.ok(content.includes('Aling Nena Store'), 'Renders customer name');
  assert.ok(content.includes('Line items not available offline'), 'Displays items empty fallback');
  assert.ok(content.includes('₱1,500.00'), 'Displays total amount from order summary');
  unmount();
});

test('ProductDetailPanel: renders fallback without crashing when product is null (offline fetch failure)', async () => {
  api.get = async () => {
    throw new TypeError('Failed to fetch');
  };

  const { text, unmount } = render(
    React.createElement(
      ToastProvider,
      null,
      React.createElement(ProductDetailPanel, {
        productId: 99,
        onClose: () => {},
        onSaved: () => {},
      })
    )
  );

  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });

  const content = text();
  assert.ok(content.includes('Product details not available offline.'));
  unmount();
});

test('ProductDetailPanel: handles partial product with undefined current_stock without crashing', async () => {
  const partialProduct = {
    id: 99,
    name: 'San Miguel Pale Pilsen',
    category: 'Beer',
    unit: 'case',
    sku: 'SMP-330',
    base_wholesale_price: 650,
    current_stock: null, // Null stock!
    units_per_case: 24,
    is_active: true,
    requires_bottle_return: true,
    deposit_fee: 120,
  };

  api.get = async (path) => {
    if (path === '/products/99') return partialProduct;
    if (path.includes('/audit')) return [];
    return [];
  };

  const { text, unmount } = render(
    React.createElement(
      ToastProvider,
      null,
      React.createElement(ProductDetailPanel, {
        productId: 99,
        onClose: () => {},
        onSaved: () => {},
      })
    )
  );

  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });

  const content = text();
  assert.ok(content.includes('San Miguel Pale Pilsen'));
  assert.ok(content.includes('Current Stock'));
  unmount();
});

test('CustomerDetailPanel: renders fallback without crashing when customer is null (offline fetch failure)', async () => {
  api.get = async () => {
    throw new TypeError('Failed to fetch');
  };

  const { text, unmount } = render(
    React.createElement(
      ToastProvider,
      null,
      React.createElement(CustomerDetailPanel, {
        customerId: 88,
        onClose: () => {},
        onSaved: () => {},
      })
    )
  );

  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });

  const content = text();
  assert.ok(content.includes('Customer details not available offline.'));
  unmount();
});

test('CustomerDetailPanel: handles customer with undefined customer_type without crashing', async () => {
  const partialCustomer = {
    id: 88,
    name: 'Mang Inasal Antipolo',
    customer_type: undefined, // Undefined customer type!
    is_active: true,
    phone: '09123456789',
    orders: [],
  };

  api.get = async (path) => {
    if (path === '/customers/88') return partialCustomer;
    if (path.includes('/prices')) return [];
    return [];
  };

  const { text, unmount } = render(
    React.createElement(
      ToastProvider,
      null,
      React.createElement(CustomerDetailPanel, {
        customerId: 88,
        onClose: () => {},
        onSaved: () => {},
      })
    )
  );

  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });

  const content = text();
  assert.ok(content.includes('Mang Inasal Antipolo'));
  assert.ok(content.includes('Regular'), 'Falls back to Regular badge for undefined customer_type');
  unmount();
});

test('PersonnelDetailPanel: renders fallback without crashing when person is null (offline fetch failure)', async () => {
  api.get = async () => {
    throw new TypeError('Failed to fetch');
  };

  const { text, unmount } = render(
    React.createElement(
      ToastProvider,
      null,
      React.createElement(PersonnelDetailPanel, {
        personnelId: 12,
        onClose: () => {},
        onSaved: () => {},
      })
    )
  );

  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });

  const content = text();
  assert.ok(content.includes('Personnel details not available offline.'));
  unmount();
});

test('PersonnelDetailPanel: handles person with undefined is_active without crashing or showing false Inactive', async () => {
  const partialPerson = {
    id: 12,
    full_name: 'Cardo Dalisay',
    role: 'Driver',
    is_active: undefined, // Undefined is_active!
    phone: '09123456789',
  };

  api.get = async (path) => {
    if (path === '/personnel/12') return partialPerson;
    if (path.includes('/orders')) return [];
    return [];
  };

  const { text, unmount } = render(
    React.createElement(
      ToastProvider,
      null,
      React.createElement(PersonnelDetailPanel, {
        personnelId: 12,
        onClose: () => {},
        onSaved: () => {},
      })
    )
  );

  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });

  const content = text();
  assert.ok(content.includes('Cardo Dalisay'));
  assert.ok(!content.includes('Inactive'), 'Undefined is_active must not be treated as inactive');
  unmount();
});

test('DeliveryDetailPanel: renders without crashing when delivery.items is null or undefined', async () => {
  const partialDelivery = {
    id: 5,
    supplier_name: 'San Miguel Brewery Inc.',
    received_at: new Date().toISOString(),
    created_by_name: 'Josie',
    notes: 'Partial shipment',
    items: null, // Null items!
  };

  api.get = async (path) => {
    if (path === '/incoming/5') return partialDelivery;
    return [];
  };

  const { text, unmount } = render(
    React.createElement(
      ToastProvider,
      null,
      React.createElement(DeliveryDetailPanel, {
        deliveryId: 5,
        onClose: () => {},
        onVoided: () => {},
      })
    )
  );

  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });

  const content = text();
  assert.ok(content.includes('San Miguel Brewery Inc.'));
  assert.ok(content.includes('Products Received (0)'));
  unmount();
});
