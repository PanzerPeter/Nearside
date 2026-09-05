export default {
  plugins: {
    // Tailwind 4 moved the PostCSS plugin into its own package, and folded
    // `@import` handling and vendor prefixing into itself — autoprefixer was
    // here for the latter and is now dead weight.
    '@tailwindcss/postcss': {},
  },
};
