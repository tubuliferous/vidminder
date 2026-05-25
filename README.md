# VidMinder

An elegant, lightweight desktop app for collecting YouTube videos into a calm pool you'll actually get to. Drop URLs in, follow channels, watch in your browser. Cross-platform (Tauri 2 + React) — small binaries, no Electron.

[![Build](https://github.com/tubuliferous/vidminder/actions/workflows/release.yml/badge.svg)](https://github.com/tubuliferous/vidminder/actions/workflows/release.yml)
[![Latest release](https://img.shields.io/github/v/release/tubuliferous/vidminder?include_prereleases&label=latest)](https://github.com/tubuliferous/vidminder/releases/latest)

## Download

Grab the latest installer for your platform from the **[latest release](https://github.com/tubuliferous/vidminder/releases/latest)** page:

| Platform | File |
| --- | --- |
| Windows | `*_x64-setup.exe` (NSIS) or `*_x64_en-US.msi` |
| macOS (Apple Silicon) | `VidMinder_*_aarch64-apple-darwin.app.zip` |
| macOS (Intel) | `VidMinder_*_x86_64-apple-darwin.app.zip` |
| Linux | `*.AppImage` or `*.deb` |

> **Windows users**: The installer is unsigned, so SmartScreen will show a warning. Click *More info → Run anyway*.

> **macOS users**: Unzip, drag `VidMinder.app` to Applications, then right-click it and choose *Open* the first time (Gatekeeper blocks unsigned apps on double-click). Or run `xattr -dr com.apple.quarantine /Applications/VidMinder.app` once.

> Every release ships a self-contained build — yt-dlp is bundled, no separate install needed.

## What it does

- **Drop URLs** anywhere on the window to add videos. Paste with `⌘V`/`Ctrl+V` works too. Channel URLs (`youtube.com/@SomeChannel`) start following automatically.
- **Follow channels** and get new uploads in a recency-grouped Inbox (Today / This week / This month). VidMinder polls every 30 min in the background.
- **Tags, folders, favorites** for organizing. Drag videos onto sidebar slots to bulk-organize.
- **Search** across title, description, uploader, tags. Plus a dedicated inbox search.
- **Universal undo** — `⌘Z`/`Ctrl+Z` undoes the last add, delete, tag change, dismiss, follow, anything.
- **Keyboard shortcuts** — `Delete` removes the highlighted video, `⌘T` focuses the tag input, `⌘,` opens settings.

## Development

```bash
# One-time: install Rust, Node, and yt-dlp (Mac/Linux)
brew install yt-dlp                    # or pipx install yt-dlp
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Clone, install deps, set up the yt-dlp sidecar, and run
git clone https://github.com/tubuliferous/vidminder.git
cd vidminder
npm install
npm run install-sidecar          # symlinks system yt-dlp into src-tauri/binaries
npm run tauri dev
```

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
