// Tailwind v4 handles vendor prefixing itself, and its design tokens live in
// src/App.css (@theme), so no separate tailwind.config.js or autoprefixer.
export default {
  plugins: {
    '@tailwindcss/postcss': {},
  },
}
