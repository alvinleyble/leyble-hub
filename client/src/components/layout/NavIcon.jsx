import React from 'react';

// Outline icons for the tab bar and the menu, drawn on a 24px grid so they share one
// stroke weight. Decorative only — every place that shows one also carries the name.
const PATHS = {
  dashboard: (
    <>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
    </>
  ),
  outgoing: (
    <>
      <path d="M2.5 6.5h11v10h-11z" />
      <path d="M13.5 9.5h4l3 3.5v3.5h-7" />
      <circle cx="6.5" cy="17.5" r="2" />
      <circle cx="17" cy="17.5" r="2" />
    </>
  ),
  incoming: (
    <>
      <path d="M12 3v11" />
      <path d="M7.5 9.5L12 14l4.5-4.5" />
      <path d="M3.5 14.5v4a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-4" />
    </>
  ),
  inventory: (
    <>
      <path d="M12 3l8.5 4.5L12 12 3.5 7.5z" />
      <path d="M3.5 7.5v9L12 21l8.5-4.5v-9" />
      <path d="M12 12v9" />
    </>
  ),
  customers: (
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20.5c0-3.6 2.9-6.5 6.5-6.5s6.5 2.9 6.5 6.5" />
      <path d="M16 4.7a3.5 3.5 0 0 1 0 6.6" />
      <path d="M21.5 20.5c0-2.8-1.7-5.2-4.2-6.1" />
    </>
  ),
  personnel: (
    <>
      <rect x="2.5" y="5" width="19" height="14" rx="2" />
      <circle cx="8.5" cy="11" r="2.2" />
      <path d="M5.3 16.2c.6-1.5 1.8-2.3 3.2-2.3s2.6.8 3.2 2.3" />
      <path d="M14.5 10h4M14.5 13.5h4" />
    </>
  ),
  tickets: (
    <>
      <path d="M3.5 7a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2v2.5a2.5 2.5 0 0 0 0 5V17a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-2.5a2.5 2.5 0 0 0 0-5z" />
      <path d="M14.5 5v14" strokeDasharray="2 2" />
    </>
  ),
  audit: (
    <>
      <rect x="4.5" y="4" width="15" height="17" rx="2" />
      <path d="M9 2.5h6v3H9z" />
      <path d="M8.5 11h7M8.5 14.5h7M8.5 18h4" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1" />
    </>
  ),
  logout: (
    <>
      <path d="M14.5 4.5h3a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-3" />
      <path d="M10 8l-4 4 4 4" />
      <path d="M6 12h10" />
    </>
  ),
  // Settings rows (pages/settings/SettingsList.jsx).
  profile: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4.5 20.5c0-4.1 3.4-7.5 7.5-7.5s7.5 3.4 7.5 7.5" />
    </>
  ),
  printer: (
    <>
      <path d="M6.5 9V3.5h11V9" />
      <rect x="3" y="9" width="18" height="8" rx="2" />
      <path d="M6.5 14h11v6.5h-11z" />
    </>
  ),
  device: (
    <>
      <rect x="5" y="2.5" width="14" height="19" rx="2" />
      <path d="M10.5 18h3" />
    </>
  ),
  about: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5.5" />
      <path d="M12 7.5h.01" />
    </>
  ),
  chevronRight: <path d="M9 5l7 7-7 7" />,
  chevronLeft: <path d="M15 5l-7 7 7 7" />,
  menu: <path d="M4 6h16M4 12h16M4 18h16" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  // Buttons and badges (docs/design/design-standard.md, Q10: one drawn icon set, no
  // emoji as icons). `printer` above doubles as the print action and the Printed badge.
  more: (
    <>
      <circle cx="12" cy="5" r="1.2" />
      <circle cx="12" cy="12" r="1.2" />
      <circle cx="12" cy="19" r="1.2" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16l4.5 4.5" />
    </>
  ),
  filter: <path d="M3.5 5.5h17M7 12h10M10.5 18.5h3" />,
  warning: (
    <>
      <path d="M12 3.5l9.5 16.5h-19z" />
      <path d="M12 10v4.5" />
      <path d="M12 17.5h.01" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  draft: (
    <>
      <path d="M14.5 3.5h-8a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-10z" />
      <path d="M14.5 3.5v5h5" />
      <path d="M8.5 13.5h7M8.5 17h4" />
    </>
  ),
  truck: (
    <>
      <path d="M2.5 6.5h11v10h-11z" />
      <path d="M13.5 9.5h4l3 3.5v3.5h-7" />
      <circle cx="6.5" cy="17.5" r="2" />
      <circle cx="17" cy="17.5" r="2" />
    </>
  ),
  store: (
    <>
      <path d="M3.5 9.5l1.5-5h14l1.5 5" />
      <path d="M3.5 9.5h17v2a3 3 0 0 1-5.7 1.3A3 3 0 0 1 12 14a3 3 0 0 1-2.8-1.2 3 3 0 0 1-5.7-1.3z" />
      <path d="M5 14v6.5h14V14" />
      <path d="M10 20.5v-4h4v4" />
    </>
  ),
  refresh: (
    <>
      <path d="M20 11a8 8 0 0 0-14.3-4.9L3.5 8.5" />
      <path d="M3.5 3.5v5h5" />
      <path d="M4 13a8 8 0 0 0 14.3 4.9l2.2-2.4" />
      <path d="M20.5 20.5v-5h-5" />
    </>
  ),
  merge: (
    <>
      <path d="M6 3.5v4a4 4 0 0 0 4 4h4a4 4 0 0 1 4 4v5" />
      <path d="M6 20.5v-9" />
      <path d="M15 17.5l3 3 3-3" />
    </>
  ),
  scale: (
    <>
      <path d="M12 3.5v17M7.5 20.5h9" />
      <path d="M4.5 7.5h15" />
      <path d="M4.5 7.5l-2.5 6a2.5 2.5 0 0 0 5 0z" />
      <path d="M19.5 7.5l-2.5 6a2.5 2.5 0 0 0 5 0z" />
    </>
  ),
  offline: (
    <>
      <path d="M3 3l18 18" />
      <path d="M8.5 16.5a5 5 0 0 1 7 0" />
      <path d="M5 12.5a10 10 0 0 1 4-2.3M14.5 10.3A10 10 0 0 1 19 12.5" />
      <path d="M12 20h.01" />
    </>
  ),
  edit: (
    <>
      <path d="M4 20h4L19 9l-4-4L4 16z" />
      <path d="M13.5 6.5l4 4" />
    </>
  ),
  check: <path d="M4.5 12.5l5 5 10-11" />,
};

export default function NavIcon({ name, className = 'w-6 h-6' }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
