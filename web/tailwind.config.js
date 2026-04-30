/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "#0F1115",
        paper: "#E8E4DA",
        teal: "#095F73",
        tealBright: "#3BB3C9",
        muted: "#9CA3AF",
      },
      fontFamily: {
        display: ['"EB Garamond"', "serif"],
        ui: ["Inter", "system-ui", "sans-serif"],
        mono: ['"JetBrains Mono"', "monospace"],
      },
    },
  },
  plugins: [],
};
