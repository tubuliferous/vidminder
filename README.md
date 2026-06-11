# VidMinder

An elegant, lightweight desktop app for collecting YouTube videos into a calm pool you'll actually get to. Drop URLs in, follow channels, watch in your browser. Cross-platform (Tauri 2 + React) — small binaries, no Electron.

[![Build](https://github.com/tubuliferous/vidminder/actions/workflows/release.yml/badge.svg)](https://github.com/tubuliferous/vidminder/actions/workflows/release.yml)
[![Latest release](https://img.shields.io/github/v/release/tubuliferous/vidminder?include_prereleases&label=latest)](https://github.com/tubuliferous/vidminder/releases/latest)

## Download

| Platform | Download |
| --- | --- |
| **Windows** | [Installer (.exe)](https://github.com/tubuliferous/vidminder/releases/latest/download/VidMinder-windows-setup.exe) · [MSI](https://github.com/tubuliferous/vidminder/releases/latest/download/VidMinder-windows.msi) |
| **macOS (Apple Silicon)** | [`.app.zip`](https://github.com/tubuliferous/vidminder/releases/latest/download/VidMinder-macos-arm64.app.zip) |
| **macOS (Intel)** | [`.app.zip`](https://github.com/tubuliferous/vidminder/releases/latest/download/VidMinder-macos-intel.app.zip) |
| **Linux** | [.deb](https://github.com/tubuliferous/vidminder/releases/latest/download/VidMinder-linux.deb) · [.rpm](https://github.com/tubuliferous/vidminder/releases/latest/download/VidMinder-linux.rpm) |

All links point to the **latest release** automatically — bookmark them and they'll keep working as new versions ship. Browse every version at the [releases page](https://github.com/tubuliferous/vidminder/releases).

> **Windows users**: The installer is unsigned, so SmartScreen will show a warning. Click *More info → Run anyway*.

> **macOS users**: Unzip and drag `VidMinder.app` to Applications. Because the app is unsigned, Gatekeeper will block it — on recent macOS you may even see *"VidMinder is damaged and can't be opened."* That's the quarantine flag, not a real problem. Clear it once with:
>
> ```sh
> xattr -dr com.apple.quarantine /Applications/VidMinder.app
> ```
>
> Then open the app normally. (On older macOS you can instead right-click the app and choose *Open* the first time.)

> Every release ships a self-contained build — yt-dlp is bundled, no separate install needed.

## What it does

- **Drop URLs** anywhere on the window to add videos. Paste with `⌘V`/`Ctrl+V` works too. Channel URLs (`youtube.com/@SomeChannel`) start following automatically.
- **Follow channels** and get new uploads in a recency-grouped Inbox (Today / This week / This month). VidMinder polls every 30 min in the background.
- **Tags, folders, favorites** for organizing. Drag videos onto sidebar slots to bulk-organize.
- **Search** across title, description, uploader, tags. Plus a dedicated inbox search.
- **Universal undo** — `⌘Z`/`Ctrl+Z` undoes the last add, delete, tag change, dismiss, follow, anything.
- **Keyboard shortcuts** — `⌘A`/`Ctrl+A` selects all rows, `Delete` removes the highlighted video, `⌘Delete`/`Ctrl+Delete` deletes the selected tag folder, `⌘T` focuses the tag input, `⌘,` opens settings. The full guide lives in **About VidMinder** (app menu on macOS, or the link at the bottom of Settings).

## Development

```bash
# One-time: install Rust and Node (Mac/Linux)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Clone, install deps, set up the bundled runtime, and run
git clone https://github.com/tubuliferous/vidminder.git
cd vidminder
npm install
npm run install-sidecar          # downloads a relocatable CPython + yt-dlp and a static ffmpeg into src-tauri/
npm run tauri dev
```

> No system `yt-dlp`/`ffmpeg` needed — `install-sidecar` fetches a self-contained
> Python runtime (with yt-dlp) and a static ffmpeg, the same pieces the shipped
> app bundles.

The SQLite database lives at:
- macOS: `~/Library/Application Support/VidMinder/vidminder.sqlite`
- Windows: `%APPDATA%\VidMinder\vidminder.sqlite`
- Linux: `~/.local/share/VidMinder/vidminder.sqlite`

## Architecture

- **Frontend**: React 19 + TypeScript + Vite + Tailwind v4
- **Backend**: Rust (Tauri 2), SQLite via `rusqlite` (bundled)
- **Metadata**: yt-dlp shelled out as a sidecar binary, bundled in each platform installer
- **CI**: GitHub Actions builds for Windows, macOS (Intel + ARM), and Linux on every push and on `v*` tags

## Releasing

```bash
git tag v0.1.0
git push --tags
```

A draft GitHub Release is created with all four platform installers attached. Promote it to Latest on the Releases page to make `releases/latest` point at it.

## License

Personal project — pick a license before publishing.
