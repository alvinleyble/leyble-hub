/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      screens: {
        // Permanent sidebar only on real desktops (mouse/trackpad). Phones and
        // tablets get the hamburger drawer in BOTH portrait and landscape.
        desktop: { raw: '(min-width: 1024px) and (pointer: fine)' },
      },
      colors: {
        // ── V2 Design Tokens (Theme-aware via CSS variables) ────────────
        // Used ONLY by the V2 tablet shell / nav chrome and V2 screens.
        // V1 pages (Personnel, Incoming, Tickets, Audit, …) keep their
        // existing light styling and must not consume these.
        v2: {
          bg: 'var(--v2-bg)',
          surface: 'var(--v2-surface)',
          raised: 'var(--v2-raised)',
          border: 'var(--v2-border)',
          text: 'var(--v2-text)',
          muted: 'var(--v2-muted)',
          accent: 'var(--v2-accent)',
          'accent-strong': 'var(--v2-accent-strong)',
          'pill-active': 'var(--v2-pill-active)',
          'pill-border': 'var(--v2-pill-border)',
          'pill-text': 'var(--v2-pill-text)',
          'print-btn': 'var(--v2-print-btn)',
          'print-btn-hover': 'var(--v2-print-btn-hover)',
          'table-hover': 'var(--v2-table-hover)',
        },
      },
      minHeight: {
        touch: '48px',
        // Tablet directive: 52px+ touch targets on the V2 shell.
        tablet: '52px',
      },
      minWidth: {
        touch: '48px',
        tablet: '52px',
      },
    },
  },
  plugins: [],
};
