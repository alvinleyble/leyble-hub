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
        // ── V2 dark slate design tokens ────────────────────────────────
        // Used ONLY by the V2 tablet shell / nav chrome and V2 screens.
        // V1 pages (Personnel, Incoming, Tickets, Audit, …) keep their
        // existing light styling and must not consume these.
        v2: {
          bg: '#020617',        // app background (slate-950)
          surface: '#0f172a',   // shell chrome / cards (slate-900)
          raised: '#1e293b',    // hovered / raised surface (slate-800)
          border: '#334155',    // dividers (slate-700)
          text: '#f1f5f9',      // primary text (slate-100)
          muted: '#94a3b8',     // secondary text (slate-400)
          accent: '#38bdf8',    // focus rings / active nav (sky-400)
          'accent-strong': '#0284c7', // active nav fill (sky-600)
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
