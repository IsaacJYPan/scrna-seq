/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        primary: "#3b82f6",
        background: "#0f172a",
        surface: "#1e293b",
        border: "#334155",
        text: "#f8fafc",
        textMuted: "#94a3b8",
        success: "#22c55e",
        danger: "#ef4444"
      }
    },
  },
  plugins: [],
}
