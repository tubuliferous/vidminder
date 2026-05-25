#!/usr/bin/env node
// Install a yt-dlp sidecar binary for the current host so `tauri dev` and
// `tauri build` can satisfy the externalBin requirement.
//
// On macOS/Linux, this prefers symlinking whatever yt-dlp is on PATH (fast,
// stays up to date with brew/apt). If nothing is on PATH it downloads the
// latest release from yt-dlp's GitHub.
//
// Run with: `node scripts/install-sidecar.mjs`

import { mkdirSync, existsSync, chmodSync } from "node:fs";
import { execSync } from "node:child_process";
import { platform, arch } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

const p = platform();
const a = arch();

function targetTriple() {
  if (p === "win32") return "x86_64-pc-windows-msvc";
  if (p === "darwin" && a === "arm64") return "aarch64-apple-darwin";
  if (p === "darwin") return "x86_64-apple-darwin";
  if (p === "linux" && a === "x64") return "x86_64-unknown-linux-gnu";
  throw new Error(`unsupported host platform/arch: ${p}/${a}`);
}

function releaseUrl() {
  if (p === "win32") return "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe";
  if (p === "darwin") return "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos";
  return "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux";
}

const ext = p === "win32" ? ".exe" : "";
const triple = targetTriple();
const outPath = join(repoRoot, "src-tauri", "binaries", `yt-dlp-${triple}${ext}`);

if (existsSync(outPath)) {
  console.log(`yt-dlp sidecar already present: ${outPath}`);
  process.exit(0);
}

mkdirSync(dirname(outPath), { recursive: true });

if (p !== "win32") {
  try {
    const which = execSync("command -v yt-dlp", { encoding: "utf8" }).trim();
    if (which) {
      execSync(`ln -sf "${which}" "${outPath}"`);
      console.log(`Symlinked yt-dlp from ${which} → ${outPath}`);
      process.exit(0);
    }
  } catch {
    // fall through to download
  }
}

console.log(`Downloading yt-dlp from ${releaseUrl()}…`);
execSync(`curl -L --fail -o "${outPath}" "${releaseUrl()}"`, { stdio: "inherit" });
if (p !== "win32") {
  chmodSync(outPath, 0o755);
}
console.log(`Saved yt-dlp sidecar to ${outPath}`);
