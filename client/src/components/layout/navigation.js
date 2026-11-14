// The two halves of the app's navigation: the top tabs every screen size shows, and
// what is tucked behind the hamburger menu at the far right. An item marked
// `everything: true` shows only while Settings' "Show everything" switch is on
// (config/showEverything.js); with it off the tabs are Dashboard, Outgoing, Inventory
// and Customers, and the menu holds Settings alone.

export const TAB_ITEMS = [
  { path: '/dashboard', label: 'Dashboard', icon: 'dashboard' },
  { path: '/orders',    label: 'Outgoing',  icon: 'outgoing' },
  { path: '/incoming',  label: 'Incoming',  icon: 'incoming',  everything: true },
  { path: '/inventory', label: 'Inventory', icon: 'inventory' },
  { path: '/customers', label: 'Customers', icon: 'customers' },
  { path: '/personnel', label: 'Personnel', icon: 'personnel', everything: true },
];

export const MENU_ITEMS = [
  { path: '/tickets',  label: 'Tickets',   icon: 'tickets',   everything: true },
  { path: '/audit',    label: 'Audit Log', icon: 'audit',     everything: true },
  { path: '/settings', label: 'Settings',  icon: 'settings' },
];

// The items to show for the switch's current state.
export function visibleNavItems(items, showEverything) {
  return showEverything ? items : items.filter((item) => !item.everything);
}

// True when `path` is exactly the page on screen. A sub-page does not count: tapping
// Outgoing from an order's detail page goes back to the list, not a refresh.
export function isCurrentPage(pathname, path) {
  return pathname.replace(/\/+$/, '') === path;
}
