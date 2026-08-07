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
        nearside: {
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

      // The three cosmetic packs (Plan 5 Task 2). Each is a full theme rather
      // than an accent swap, because a half-themed app looks broken rather
      // than bought. Every one repeats the shape and status tokens above: a
      // theme that omits `--surface-ring` or `--receipt-read` does not inherit
      // them from `nearside`, it renders them as the literal string.
      {
        'nearside-midnight': {
          'color-scheme': 'dark',
          primary: '#6ea8fe',
          'primary-content': '#0b1020',
          secondary: '#8892b0',
          'secondary-content': '#0b1020',
          accent: '#6ea8fe',
          'accent-content': '#0b1020',
          neutral: '#1b2a4a',
          'neutral-content': '#e7ecf7',
          'base-100': '#141c31',
          'base-200': '#101728',
          'base-300': '#0b1020',
          'base-content': '#e7ecf7',
          info: '#6ea8fe',
          'info-content': '#0b1020',
          success: '#3ec27a',
          'success-content': '#06120b',
          warning: '#e0a63b',
          'warning-content': '#0b1020',
          error: '#f2777a',
          'error-content': '#0b1020',
          '--surface-ring': '#141c31',
          '--receipt-read': '#a7f3d0',
          '--presence-offline': '#3a4560',
          '--rounded-box': '0.75rem',
          '--rounded-btn': '0.5rem',
          '--rounded-badge': '1.9rem',
          '--tab-radius': '0.5rem',
          '--border-btn': '1px',
          '--animation-btn': '0.2s',
          '--btn-focus-scale': '0.97',
        },
      },
      {
        'nearside-paper': {
          'color-scheme': 'light',
          primary: '#8a6d3b',
          'primary-content': '#fffaf0',
          secondary: '#9c8a6e',
          'secondary-content': '#fffaf0',
          accent: '#8a6d3b',
          'accent-content': '#fffaf0',
          neutral: '#e0d8c6',
          'neutral-content': '#332b1d',
          'base-100': '#fffdf7',
          'base-200': '#f6f2e9',
          'base-300': '#ece6d8',
          'base-content': '#332b1d',
          info: '#3d6b8a',
          'info-content': '#fffaf0',
          success: '#3f7d44',
          'success-content': '#fffaf0',
          warning: '#9a6b1f',
          'warning-content': '#fffaf0',
          error: '#a83232',
          'error-content': '#fffaf0',
          '--surface-ring': '#fffdf7',
          // Light theme: the read tick sits on a dark primary bubble, so it
          // has to go lighter, not darker, exactly as it does on the dark one.
          '--receipt-read': '#d7f0c8',
          '--presence-offline': '#c4bba6',
          '--rounded-box': '0.75rem',
          '--rounded-btn': '0.5rem',
          '--rounded-badge': '1.9rem',
          '--tab-radius': '0.5rem',
          '--border-btn': '1px',
          '--animation-btn': '0.2s',
          '--btn-focus-scale': '0.97',
        },
      },
      {
        'nearside-terminal': {
          'color-scheme': 'dark',
          primary: '#4ade80',
          'primary-content': '#04150a',
          secondary: '#3f6b4c',
          'secondary-content': '#dcffe6',
          accent: '#4ade80',
          'accent-content': '#04150a',
          neutral: '#123018',
          'neutral-content': '#dcffe6',
          'base-100': '#0e1a11',
          'base-200': '#0b130d',
          'base-300': '#050a06',
          'base-content': '#d6f5de',
          info: '#4ade80',
          'info-content': '#04150a',
          success: '#4ade80',
          'success-content': '#04150a',
          warning: '#d9b04a',
          'warning-content': '#04150a',
          error: '#f2777a',
          'error-content': '#04150a',
          '--surface-ring': '#0e1a11',
          '--receipt-read': '#bbf7d0',
          '--presence-offline': '#2a4531',
          '--rounded-box': '0.5rem',
          '--rounded-btn': '0.25rem',
          '--rounded-badge': '0.25rem',
          '--tab-radius': '0.25rem',
          '--border-btn': '1px',
          '--animation-btn': '0.2s',
          '--btn-focus-scale': '0.97',
        },
      },
    ],
    darkTheme: 'nearside',
  },
};
