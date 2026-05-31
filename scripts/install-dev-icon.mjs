// Generate the dev icon set (all variants — .icns, .ico, the PNG sizes, and
// the Windows Store squares) from a single source PNG, into
// src-tauri/icons-dev/. The dev tauri.conf overlay points at that folder, so
// `npm run tauri:dev` will pick them up automatically.
//
// Usage:
//   npm run install-dev-icon -- /path/to/your-source.png
import { execSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { argv } from "node:process";

const input = argv[2];
if (!input) {
  console.error("Usage: npm run install-dev-icon -- <path-to-1024x1024-png>");
  process.exit(1);
}
if (!existsSync(input)) {
  console.error(`Source PNG not found: ${input}`);
  process.exit(1);
}

mkdirSync("src-tauri/icons-dev", { recursive: true });

console.log(`Generating dev icons from ${input}…`);
execSync(
  `npx @tauri-apps/cli icon "${input}" --output src-tauri/icons-dev`,
  { stdio: "inherit" }
);
console.log("Done. Run `npm run tauri:dev` to launch with the dev icon.");
