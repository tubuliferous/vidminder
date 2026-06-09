#!/usr/bin/env node
// Install the yt-dlp + ffmpeg sidecar binaries for the current host so
// `tauri dev` and `tauri build` can satisfy the externalBin requirement.
//
// On macOS/Linux, this prefers symlinking whatever is already on PATH (fast,
// stays up to date with brew/apt). If nothing is on PATH it downloads a static
// build — yt-dlp from its own GitHub releases, ffmpeg from the pinned
// eugeneware/ffmpeg-static release (which ships per-platform static binaries).
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
const ext = p === "win32" ? ".exe" : "";

function targetTriple() {
  if (p === "win32") return "x86_64-pc-windows-msvc";
  if (p === "darwin" && a === "arm64") return "aarch64-apple-darwin";
  if (p === "darwin") return "x86_64-apple-darwin";
  if (p === "linux" && a === "x64") return "x86_64-unknown-linux-gnu";
  throw new Error(`unsupported host platform/arch: ${p}/${a}`);
}

const triple = targetTriple();
const binDir = join(repoRoot, "src-tauri", "binaries");

function ytDlpUrl() {
  if (p === "win32") return "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe";
  if (p === "darwin") return "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos";
  return "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux";
}

// Pinned static-ffmpeg release. Assets are direct per-platform binaries.
const FFMPEG_STATIC_TAG = "b6.0";
function ffmpegUrl() {
  const base = `https://github.com/eugeneware/ffmpeg-static/releases/download/${FFMPEG_STATIC_TAG}`;
  if (p === "win32") return `${base}/ffmpeg-win32-x64`;
  if (p === "darwin") return `${base}/ffmpeg-darwin-${a === "arm64" ? "arm64" : "x64"}`;
  return `${base}/ffmpeg-linux-x64`;
}

// Install one sidecar to `binaries/<name>-<triple><ext>`. By default this
// prefers symlinking whatever is on PATH (fast, stays current). Pass
// `forceDownload` to always fetch the standalone build instead — needed for
// ffmpeg, where a PATH copy is typically a dynamically-linked Homebrew binary
// that depends on dylibs not present in the shipped bundle (so it'd break on
// other machines). The pinned static build is fully self-contained.
function install(name, url, { forceDownload = false } = {}) {
  const outPath = join(binDir, `${name}-${triple}${ext}`);
  if (existsSync(outPath)) {
    console.log(`${name} sidecar already present: ${outPath}`);
    return;
  }
  mkdirSync(binDir, { recursive: true });

  if (!forceDownload && p !== "win32") {
    try {
      const which = execSync(`command -v ${name}`, { encoding: "utf8" }).trim();
      if (which) {
        execSync(`ln -sf "${which}" "${outPath}"`);
        console.log(`Symlinked ${name} from ${which} → ${outPath}`);
        return;
      }
    } catch {
      // fall through to download
    }
  }

  console.log(`Downloading ${name} from ${url}…`);
  execSync(`curl -L --fail -o "${outPath}" "${url}"`, { stdio: "inherit" });
  if (p !== "win32") chmodSync(outPath, 0o755);
  console.log(`Saved ${name} sidecar to ${outPath}`);
}

install("yt-dlp", ytDlpUrl());
// Always download a self-contained static ffmpeg — never symlink a Homebrew
// one — so the bundle ships complete and dev matches production exactly.
install("ffmpeg", ffmpegUrl(), { forceDownload: true });
