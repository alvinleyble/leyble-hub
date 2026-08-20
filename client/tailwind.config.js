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
        // ── V2 Coca-Cola design tokens ──────────────────────────────────
        // Used ONLY by the V2 tablet shell / nav chrome and V2 screens.
        // V1 pages (Personnel, Incoming, Tickets, Audit, …) keep their
        // existing light styling and must not consume these.
        v2: {
          bg: '#0F0F10',              // app background — deep carbonated charcoal/black
          surface: '#1A1A1C',        // shell chrome / cards — dark charcoal surface
          raised: '#262629',         // hovered / raised surface
          border: '#2E2E33',         // dividers — subtle charcoal
          text: '#FFFFFF',           // primary text — pure crisp white
          muted: '#A1A1AA',          // secondary / helper text — clear muted gray
          accent: '#DC2626',         // focus rings / highlights — balanced crimson
          'accent-strong': '#991B1B', // active nav / primary CTAs — deep rich crimson
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
