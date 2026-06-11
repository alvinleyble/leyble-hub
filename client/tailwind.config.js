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
      minHeight: {
        touch: '48px',
      },
      minWidth: {
        touch: '48px',
      },
    },
  },
  plugins: [],
};
