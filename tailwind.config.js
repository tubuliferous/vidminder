/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      // Colors reference CSS variables holding space-separated RGB channels
      // (defined in src/App.css). The `<alpha-value>` placeholder lets opacity
      // modifiers (e.g. `text-accent/85`) compile to `rgb(var(--x) / 0.85)`,
      // which works on older WebKit — unlike v4's color-mix() output.
      colors: {
        canvas: "rgb(var(--color-canvas) / <alpha-value>)",
        surface: "rgb(var(--color-surface) / <alpha-value>)",
        "surface-2": "rgb(var(--color-surface-2) / <alpha-value>)",
        line: "rgb(var(--color-line) / <alpha-value>)",
        "line-soft": "rgb(var(--color-line-soft) / <alpha-value>)",
        ink: "rgb(var(--color-ink) / <alpha-value>)",
        "ink-dim": "rgb(var(--color-ink-dim) / <alpha-value>)",
        "ink-faint": "rgb(var(--color-ink-faint) / <alpha-value>)",
        accent: "rgb(var(--color-accent) / <alpha-value>)",
        "accent-dim": "rgb(var(--color-accent-dim) / <alpha-value>)",
        danger: "rgb(var(--color-danger) / <alpha-value>)",
      },
      // v3's preflight defaults a bare `border` to gray-200; v4 defaulted to
      // currentColor. Match v4 so any uncolored border stays faithful to how
      // the UI was designed.
      borderColor: {
        DEFAULT: "currentColor",
      },
    },
  },
  plugins: [],
};
