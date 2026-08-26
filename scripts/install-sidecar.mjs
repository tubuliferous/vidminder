#!/usr/bin/env node
// Set up the binaries VidMinder shells out to so `tauri dev` / `tauri build`
// work on a fresh clone:
//
//   1. ffmpeg — a single self-contained static binary, bundled as a Tauri
//      externalBin sidecar (next to the app executable). Used to mux the
//      separate video+audio DASH streams YouTube serves above ~720p.
//
//   2. A Python runtime — a relocatable CPython (python-build-standalone) with
//      yt-dlp pip-installed into it, bundled as a Tauri *resource* directory.
//      We run it as `python -m yt_dlp`. This replaces the old `yt-dlp_macos`
//      PyInstaller "onefile" binary, whose ~13s-per-invocation cold start made
//      adding videos and following channels painfully slow (it unpacked a whole
//      Python runtime to a temp dir on every single call). The relocatable
//      interpreter starts in ~0.3s instead.
//
//   3. deno — a second externalBin sidecar. yt-dlp's JS-challenge solver
//      (yt-dlp-ejs) needs an external JS runtime; without one on PATH YouTube
//      rejects most downloads with "The page needs to be reloaded". ytdlp.rs
//      puts the sidecar dir on the child's PATH so yt-dlp discovers it.
//
// Run with: `node scripts/install-sidecar.mjs`  (npm run install-sidecar)

import { mkdirSync, existsSync, chmodSync, rmSync, renameSync } from "node:fs";
import { execSync } from "node:child_process";
import { platform, arch } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

const p = platform();
const a = arch();
const ext = p === "win32" ? ".exe" : "";

// Keep these in lock-step with .github/workflows/release.yml.
const PBS_TAG = "20260602";
const PY_VERSION = "3.12.13";

function targetTriple() {
  if (p === "win32") return "x86_64-pc-windows-msvc";
  if (p === "darwin" && a === "arm64") return "aarch64-apple-darwin";
  if (p === "darwin") return "x86_64-apple-darwin";
  if (p === "linux" && a === "x64") return "x86_64-unknown-linux-gnu";
  throw new Error(`unsupported host platform/arch: ${p}/${a}`);
}

const triple = targetTriple();
const binDir = join(repoRoot, "src-tauri", "binaries");
const runtimeDir = join(repoRoot, "src-tauri", "runtime");

// ---- ffmpeg sidecar -------------------------------------------------------

const FFMPEG_STATIC_TAG = "b6.0";
function ffmpegUrl() {
  const base = `https://github.com/eugeneware/ffmpeg-static/releases/download/${FFMPEG_STATIC_TAG}`;
  if (p === "win32") return `${base}/ffmpeg-win32-x64`;
  if (p === "darwin") return `${base}/ffmpeg-darwin-${a === "arm64" ? "arm64" : "x64"}`;
  return `${base}/ffmpeg-linux-x64`;
}

// The pinned static ffmpeg build is fully self-contained, so we always download
// it rather than symlinking a (typically dynamically-linked) Homebrew copy that
// would break once the bundle is shipped to another machine.
function installFfmpeg() {
  const outPath = join(binDir, `ffmpeg-${triple}${ext}`);
  if (existsSync(outPath)) {
    console.log(`ffmpeg sidecar already present: ${outPath}`);
    return;
  }
  mkdirSync(binDir, { recursive: true });
  const url = ffmpegUrl();
  console.log(`Downloading ffmpeg from ${url}…`);
  execSync(`curl -L --fail -o "${outPath}" "${url}"`, { stdio: "inherit" });
  if (p !== "win32") chmodSync(outPath, 0o755);
  console.log(`Saved ffmpeg sidecar to ${outPath}`);
}

// ---- deno sidecar ---------------------------------------------------------

// Deno's release assets are named by the same target triples we build for.
// Keep DENO_VERSION in lock-step with .github/workflows/release.yml.
const DENO_VERSION = "2.8.0";
function denoUrl() {
  return (
    `https://github.com/denoland/deno/releases/download/` +
    `v${DENO_VERSION}/deno-${triple}.zip`
  );
}

function installDeno() {
  const outPath = join(binDir, `deno-${triple}${ext}`);
  if (existsSync(outPath)) {
    console.log(`deno sidecar already present: ${outPath}`);
    return;
  }
  mkdirSync(binDir, { recursive: true });
  const zip = join(binDir, "deno.zip");
  const url = denoUrl();
  console.log(`Downloading deno from ${url}…`);
  execSync(`curl -L --fail -o "${zip}" "${url}"`, { stdio: "inherit" });
  // The zip holds a single `deno[.exe]`. bsdtar (macOS/Windows) extracts zip
  // archives; GNU tar doesn't, so use unzip on Linux.
  const extract =
    p === "linux"
      ? `unzip -o "${zip}" -d "${binDir}"`
      : `tar -xf "${zip}" -C "${binDir}"`;
  execSync(extract, { stdio: "inherit" });
  rmSync(zip, { force: true });
  renameSync(join(binDir, `deno${ext}`), outPath);
  if (p !== "win32") chmodSync(outPath, 0o755);
  console.log(`Saved deno sidecar to ${outPath}`);
}

// ---- Python + yt-dlp runtime ---------------------------------------------

function pbsUrl() {
  return (
    `https://github.com/astral-sh/python-build-standalone/releases/download/` +
    `${PBS_TAG}/cpython-${PY_VERSION}+${PBS_TAG}-${triple}-install_only.tar.gz`
  );
}

function pythonExe() {
  return p === "win32"
    ? join(runtimeDir, "python", "python.exe")
    : join(runtimeDir, "python", "bin", "python3");
}

function installRuntime() {
  const pylibDir = join(runtimeDir, "pylib");
  if (existsSync(pylibDir) && existsSync(join(runtimeDir, "python"))) {
    console.log(`Python runtime already present: ${runtimeDir}`);
    return;
  }
  mkdirSync(runtimeDir, { recursive: true });

  // 1. Relocatable CPython for this host (extracts to runtime/python/).
  const url = pbsUrl();
  const tgz = join(runtimeDir, "python.tar.gz");
  console.log(`Downloading CPython ${PY_VERSION} from ${url}…`);
  execSync(`curl -L --fail -o "${tgz}" "${url}"`, { stdio: "inherit" });
  execSync(`tar -xzf "${tgz}" -C "${runtimeDir}"`, { stdio: "inherit" });
  rmSync(tgz, { force: true });

  // 2. yt-dlp + yt-dlp-ejs + certifi into runtime/pylib (pure-Python,
  //    arch-independent). We run it via `python -m yt_dlp` with
  //    PYTHONPATH=pylib. certifi gives the relocatable interpreter a CA bundle
  //    so HTTPS verification works. yt-dlp-ejs is REQUIRED: it holds the JS
  //    challenge solver (run via deno/node) that YouTube's anti-bot check
  //    demands — without it downloads fail with "The page needs to be
  //    reloaded". Do this before stripping symlinks, since the bundled python3
  //    is one of them.
  const py = pythonExe();
  console.log("Installing yt-dlp + yt-dlp-ejs + certifi into runtime/pylib…");
  execSync(
    `"${py}" -m pip install --target "${pylibDir}" --no-compile --upgrade yt-dlp yt-dlp-ejs certifi`,
    { stdio: "inherit" }
  );

  // Drop the convenience symlinks pbs ships (python3 -> python3.12, etc.). We
  // invoke the real versioned binary directly, and a symlink-free tree can't be
  // mangled by any platform's resource bundler.
  if (p !== "win32") {
    execSync(`find "${join(runtimeDir, "python")}" -type l -delete`);
  }
  console.log(`Python runtime ready: ${runtimeDir}`);
}

installFfmpeg();
installDeno();
installRuntime();
