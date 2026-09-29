// The two halves of the app's navigation: the six top tabs every screen size shows,
// and the four things tucked behind the hamburger menu at the far right.

export const TAB_ITEMS = [
  { path: '/dashboard', label: 'Dashboard', icon: 'dashboard' },
  { path: '/orders',    label: 'Outgoing',  icon: 'outgoing' },
  { path: '/incoming',  label: 'Incoming',  icon: 'incoming' },
  { path: '/inventory', label: 'Inventory', icon: 'inventory' },
  { path: '/customers', label: 'Customers', icon: 'customers' },
  { path: '/personnel', label: 'Personnel', icon: 'personnel' },
];

export const MENU_ITEMS = [
  { path: '/tickets',  label: 'Tickets',   icon: 'tickets' },
  { path: '/audit',    label: 'Audit Log', icon: 'audit' },
  { path: '/settings', label: 'Settings',  icon: 'settings' },
];

// True when `path` is exactly the page on screen. A sub-page does not count: tapping
// Outgoing from an order's detail page goes back to the list, not a refresh.
export function isCurrentPage(pathname, path) {
  return pathname.replace(/\/+$/, '') === path;
}
