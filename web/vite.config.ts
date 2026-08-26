import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const shim = (name: string) =>
  fileURLToPath(new URL(`./src/shims/${name}.ts`, import.meta.url));

// The web app compiles the DESKTOP frontend (../src) directly — the aliases
// below swap Tauri's runtime modules for browser shims, so the two builds
// share one UI codebase.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@tauri-apps/api/core": shim("tauri-core"),
      "@tauri-apps/api/event": shim("tauri-misc"),
      "@tauri-apps/api/path": shim("tauri-misc"),
      "@tauri-apps/api/app": shim("tauri-misc"),
      "@tauri-apps/plugin-opener": shim("tauri-misc"),
      "@tauri-apps/plugin-dialog": shim("tauri-misc"),
      "@tauri-apps/plugin-deep-link": shim("tauri-misc"),
    },
  },
  server: {
    fs: { allow: [".."] },
    proxy: {
      "/api": "http://localhost:8787",
    },
  },
});
