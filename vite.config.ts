import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  // Down-level emitted JS/CSS syntax for older WebKit (the Intel builds must
  // run on macOS Monterey / Safari 15.x and older). Vite 7's default target is
  // too modern; this pins a conservative floor. NOTE: this only transpiles
  // syntax — runtime APIs (e.g. crypto.randomUUID) are guarded in code, since
  // no build target polyfills them.
  build: {
    target: ["es2020", "safari13.1"],
    cssTarget: "safari13.1",
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
