/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      // Overlay elevation. Tailwind's own scale bands badly on a dark surface;
      // see the long note beside `--elev-*` in src/index.css for why, and why
      // these are variables rather than literals.
      boxShadow: {
        overlay: 'var(--elev-overlay)',
        modal: 'var(--elev-modal)',
        sheet: 'var(--elev-sheet)',
      },
      colors: {
        scrim: 'var(--scrim)',
      },
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

      // Two more themes that ship free, for the same reason the messenger
      // does: a phone used in daylight and a phone with an OLED panel are
      // ergonomic needs, not cosmetics, and selling a readable screen is
      // selling the app back to the person who already has it. The paid packs
      // below are looks; these two are legibility.
      {
        'nearside-daylight': {
          'color-scheme': 'light',
          primary: '#2563eb',
          'primary-content': '#ffffff',
          secondary: '#5b6675',
          'secondary-content': '#ffffff',
          accent: '#2563eb',
          'accent-content': '#ffffff',
          // Light themes invert the surface ladder: `neutral` (the incoming
          // bubble) has to be a *raised* surface here, not daisyUI's usual
          // near-black, or every message the friend sends lands in a dark slab.
          neutral: '#e6ebf2',
          'neutral-content': '#1b2430',
          'base-100': '#ffffff',
          'base-200': '#f4f6fa',
          'base-300': '#e8ecf3',
          'base-content': '#1b2430',
          info: '#2563eb',
          'info-content': '#ffffff',
          success: '#15803d',
          'success-content': '#ffffff',
          warning: '#a16207',
          'warning-content': '#ffffff',
          error: '#b91c1c',
          'error-content': '#ffffff',
          '--surface-ring': '#ffffff',
          // Same rule as everywhere: the read tick sits on the primary bubble,
          // so it goes lighter than the bubble, never darker.
          '--receipt-read': '#a7f3d0',
          '--presence-offline': '#b6bfcc',
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
        'nearside-void': {
          'color-scheme': 'dark',
          // base-300 is true #000000 on purpose: on an OLED panel that is an
          // unlit pixel, which is where the battery saving comes from. The
          // ladder above it stays visible so surfaces don't merge into one void.
          primary: '#4c8dff',
          'primary-content': '#ffffff',
          secondary: '#8a93a6',
          'secondary-content': '#000000',
          accent: '#4c8dff',
          'accent-content': '#ffffff',
          neutral: '#1c1d21',
          'neutral-content': '#f2f4f7',
          'base-100': '#0c0c0e',
          'base-200': '#060607',
          'base-300': '#000000',
          'base-content': '#f2f4f7',
          info: '#4c8dff',
          'info-content': '#ffffff',
          success: '#2ecc71',
          'success-content': '#00120a',
          warning: '#f0b429',
          'warning-content': '#120c00',
          error: '#ff5c5c',
          'error-content': '#120000',
          '--surface-ring': '#0c0c0e',
          '--receipt-read': '#86efac',
          '--presence-offline': '#3a3d44',
          '--rounded-box': '0.75rem',
          '--rounded-btn': '0.5rem',
          '--rounded-badge': '1.9rem',
          '--tab-radius': '0.5rem',
          '--border-btn': '1px',
          '--animation-btn': '0.2s',
          '--btn-focus-scale': '0.97',
        },
      },

      // The cosmetic packs (Plan 5 Task 2). Each is a full theme rather
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
      {
        'nearside-sunset': {
          'color-scheme': 'dark',
          primary: '#e0563f',
          'primary-content': '#fff4f0',
          secondary: '#b58ad6',
          'secondary-content': '#1b1024',
          accent: '#e0563f',
          'accent-content': '#fff4f0',
          neutral: '#3a2450',
          'neutral-content': '#f4e9fa',
          'base-100': '#2b1a3c',
          'base-200': '#211430',
          'base-300': '#170d21',
          'base-content': '#f0e4f5',
          info: '#8aa8ff',
          'info-content': '#1b1024',
          success: '#34c77b',
          'success-content': '#06120b',
          warning: '#f0b429',
          'warning-content': '#1b1024',
          error: '#ff5c7a',
          'error-content': '#1b1024',
          '--surface-ring': '#2b1a3c',
          // A mint tick disappears into this bubble's warm red; the read state
          // borrows the theme's other end of the spectrum instead, which still
          // reads as "not the white delivered tick" at 12px.
          '--receipt-read': '#ffd479',
          '--presence-offline': '#4d3a63',
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
        'nearside-sakura': {
          'color-scheme': 'light',
          primary: '#d6336c',
          'primary-content': '#fff5f8',
          secondary: '#9c7b8c',
          'secondary-content': '#fff5f8',
          accent: '#d6336c',
          'accent-content': '#fff5f8',
          neutral: '#fbe3ec',
          'neutral-content': '#4a2436',
          'base-100': '#fffafc',
          'base-200': '#fdeef4',
          'base-300': '#f7dde8',
          'base-content': '#4a2436',
          info: '#5b7fbe',
          'info-content': '#fff5f8',
          success: '#2f7d52',
          'success-content': '#fff5f8',
          warning: '#96661c',
          'warning-content': '#fff5f8',
          error: '#b3282f',
          'error-content': '#fff5f8',
          '--surface-ring': '#fffafc',
          // Amber, not mint: a pale green on this pink bubble is the same
          // lightness as the white delivered tick and the two stop separating.
          '--receipt-read': '#ffd166',
          '--presence-offline': '#d9c3cd',
          // Softer than the rest of the family — the roundness is the point
          // of the pack.
          '--rounded-box': '1rem',
          '--rounded-btn': '0.75rem',
          '--rounded-badge': '1.9rem',
          '--tab-radius': '0.75rem',
          '--border-btn': '1px',
          '--animation-btn': '0.2s',
          '--btn-focus-scale': '0.97',
        },
      },
      {
        'nearside-graphite': {
          'color-scheme': 'dark',
          // The only theme with no accent hue at all. Own and incoming bubbles
          // separate by lightness instead: a light-grey primary carrying dark
          // text against a dark-grey neutral carrying light text. An accent-
          // coloured mono theme would just be the default with the blue moved.
          primary: '#b3bac4',
          'primary-content': '#15171a',
          secondary: '#7d858f',
          'secondary-content': '#15171a',
          accent: '#b3bac4',
          'accent-content': '#15171a',
          neutral: '#2b2f34',
          'neutral-content': '#e6e8ea',
          'base-100': '#1d2024',
          'base-200': '#16181c',
          'base-300': '#0f1113',
          'base-content': '#e6e8ea',
          info: '#9aa3ae',
          'info-content': '#15171a',
          success: '#6fa585',
          'success-content': '#15171a',
          warning: '#b6a179',
          'warning-content': '#15171a',
          error: '#c98b8b',
          'error-content': '#15171a',
          '--surface-ring': '#1d2024',
          // Inverted against every other theme: this bubble is light and its
          // text is dark, so the read tick has to go darker to be seen at all.
          '--receipt-read': '#1f5c3a',
          '--presence-offline': '#4a4f56',
          // Tighter corners, to match a theme that is deliberately plain.
          '--rounded-box': '0.5rem',
          '--rounded-btn': '0.375rem',
          '--rounded-badge': '0.375rem',
          '--tab-radius': '0.375rem',
          '--border-btn': '1px',
          '--animation-btn': '0.2s',
          '--btn-focus-scale': '0.97',
        },
      },
    ],
    darkTheme: 'nearside',
  },
};
