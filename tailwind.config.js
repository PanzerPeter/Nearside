/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: [
          'Inter',
          'SF Pro Display',
          '-apple-system',
          'system-ui',
          'Segoe UI',
          'Roboto',
          'sans-serif',
        ],
      },
    },
  },
  plugins: [require('daisyui')],
  daisyui: {
    // Discord-family cool-grey dark system with a single blue accent.
    themes: [
      {
        chatly: {
          'color-scheme': 'dark',

          // Blue is the single chromatic accent (brand, CTA, focus).
          primary: '#3b82f6',
          'primary-content': '#ffffff',

          // No second chromatic accent: secondary/accent stay in the surface/blue family.
          secondary: '#7a86ad',
          'secondary-content': '#010102',
          accent: '#3b82f6',
          'accent-content': '#ffffff',

          // Lightest grey tier — raised surfaces (incoming bubbles, hover states).
          neutral: '#383b40',
          'neutral-content': '#f7f8f8',

          // Surface ladder (modern chat-app cool greys): canvas (base-300) → surface (base-100).
          'base-100': '#2a2c31',
          'base-200': '#202225',
          'base-300': '#1a1b1e',
          'base-content': '#e8e9eb',

          // Semantic — success is the only bright marketing color; red/amber reserved for status.
          info: '#3b82f6',
          'info-content': '#ffffff',
          success: '#27a644',
          'success-content': '#ffffff',
          warning: '#e0a63b',
          'warning-content': '#010102',
          error: '#eb5757',
          'error-content': '#ffffff',

          // Surface a component can draw a status ring in — always equals the
          // surface the dot sits on, so it reads as a cut-out rather than a halo.
          '--surface-ring': '#2a2c31',
          // Read-receipt tick on an own (bg-primary) bubble. `success` is too
          // dark against #3b82f6 (~1.5:1) to register at 12px, and `info`
          // equals `primary`, so the read state needs its own light-mint
          // token — ~2.8:1 on the blue bubble, and unmistakably not the
          // white-ish delivered tick beside it.
          '--receipt-read': '#86efac',
          // Presence "offline" colour — active/away read `--su`/`--wa` directly
          // (see StatusDot.tsx) so a theme edit to success/warning stays in
          // sync; offline has no such semantic token to borrow, hence its own var.
          '--presence-offline': '#4b4d52',

          // Shapes: 12px cards, 8px buttons/inputs, pill badges. CTAs never pill.
          '--rounded-box': '0.75rem',
          '--rounded-btn': '0.5rem',
          '--rounded-badge': '1.9rem',
          '--tab-radius': '0.5rem',
          '--border-btn': '1px',
          '--animation-btn': '0.2s',
          '--btn-focus-scale': '0.97',
        },
      },
    ],
    darkTheme: 'chatly',
  },
};
