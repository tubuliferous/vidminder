/** The web build compiles the desktop frontend (../src), so Tailwind must
 *  scan it; the theme mirrors the repo-root tailwind.config.js exactly. */
export default {
  content: [
    "./index.html",
    "./src/**/*.{ts,tsx}",
    "../src/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
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
        "danger-ink": "rgb(var(--color-danger-ink) / <alpha-value>)",
      },
      borderColor: {
        DEFAULT: "currentColor",
      },
    },
  },
  plugins: [],
};
