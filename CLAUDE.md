# VidMinder — project notes for Claude

## Keyboard shortcuts: OS parity is mandatory

When **adding a new feature with a keyboard shortcut**, or **adding a shortcut
to an existing feature**, every step below applies:

1. **Bind both `metaKey` (macOS ⌘) and `ctrlKey` (Windows/Linux)** in the
   `keydown` handler. We treat `e.metaKey || e.ctrlKey` as "the modifier"
   throughout `src/App.tsx`. New shortcuts must follow that pattern.

2. **Render every user-facing reference through `src/platform.ts`** rather
   than hardcoding `⌘`:
   - `kbd("K")` → `⌘K` on Mac / `Ctrl+K` elsewhere
   - `kbd(",")` → `⌘,` / `Ctrl+,`
   - `kbdClick()` → `⌘-click` / `Ctrl+click`
   - `mod` constant → `⌘` / `Ctrl`
   - `shiftClick` constant → `Shift-click` (same on all platforms today, but
     routed through `platform.ts` so we have one place to change if needed)

   This applies to: button tooltips (`title=`), placeholder strings, tip text
   in the Settings dialog and empty states, status-bar reminders in the
   header, and anywhere a shortcut is mentioned in copy.

3. **Update documentation** in lock-step:
   - The header status line in `src/App.tsx` (`{kbd("K")} search · …`)
   - The Tips list in `src/components/SettingsDialog.tsx`
   - The README's "Keyboard shortcuts" line (if present)
   - Any per-component placeholder that mentions the shortcut

4. **Test the actual binding works for both Cmd and Ctrl** on macOS before
   shipping. The `e.metaKey || e.ctrlKey` pattern means a macOS user can
   accidentally use Ctrl too — that's intentional and fine.

A `grep -n "⌘\\|Ctrl+" src/` should return **zero results in JSX/string
literals** — every occurrence must come from `kbd()` / `mod` / `kbdClick`.
The only legitimate raw `⌘`/`Ctrl` references are inside `src/platform.ts`
itself, in source-code comments, and in this file.

## Working efficiently (token hygiene)

This repo is large; a few habits keep context and cost under control.

- **Don't read big files whole.** The large ones: `src/App.tsx` (~2500 lines —
  top-level state, handlers, layout), `src-tauri/src/lib.rs` (Tauri commands),
  `src-tauri/src/db.rs` (sqlite), `src/components/Sidebar.tsx`. Grep for the
  symbol first, then Read with `offset`/`limit` around the hit.
- **Never read build artifacts / binaries.** `src-tauri/target/`, `dist/`,
  `node_modules/`, `src-tauri/binaries/` (bundled yt-dlp + ffmpeg, tens of MB),
  icons, and lockfiles are denied in `.claude/settings.json` and gitignored
  (so Grep/Glob already skip them). Note: `.claudeignore` is **not** a real
  Claude Code feature — use `.gitignore` + `permissions.deny` instead.
- **Where things live:**
  - Backend (`src-tauri/src/`): `lib.rs` = Tauri commands + orchestration;
    `db.rs` = schema + queries; `ytdlp.rs` = yt-dlp/ffmpeg sidecar, format
    listing, and offline downloads; `youtube_rss.rs` = RSS timestamps.
  - Frontend (`src/`): `App.tsx` = state/handlers/layout; `components/*` =
    one file per panel/dialog; `api.ts` = `invoke` wrappers; `settings.ts`,
    `types.ts`, `utils.ts`, `platform.ts`.
  - **Offline downloads:** `ytdlp.rs::download_video` + the `download_video` /
    `download_videos` / `cancel_download` / `delete_offline` /
    `list_video_formats` commands in `lib.rs`; UI in `VideoCard.tsx`,
    `DownloadQualityMenu.tsx`, the OfflineSection in `VideoDetails.tsx`, and the
    batch control in `MultiVideoDetails.tsx`. Files land in
    `~/Library/Application Support/VidMinder/offline/`.
- `App.tsx` is the main token sink and a good split candidate (extract handler
  groups into hooks like `useDownloads`/`useChannels`) — do it when the current
  feature is stable, not mid-change.

## Other project notes

- The yt-dlp sidecar lives at `src-tauri/binaries/yt-dlp-<target-triple>` and
  ffmpeg at `src-tauri/binaries/ffmpeg-<target-triple>`. Run
  `npm run install-sidecar` after a fresh clone (symlinks yt-dlp from PATH;
  always downloads a self-contained **static** ffmpeg so the bundle ships
  complete and doesn't depend on a system/Homebrew ffmpeg).
- Dev: `npm run tauri dev` from project root.
- Release: bump `package.json`, `src-tauri/Cargo.toml`, and
  `src-tauri/tauri.conf.json` to the same version; commit; tag `vX.Y.Z`;
  push the tag. CI publishes the GitHub Release automatically with stable-
  named asset copies the README links to.
- DB lives at `~/Library/Application Support/VidMinder/vidminder.sqlite`
  (macOS) — paths are platform-specific via `dirs::data_dir()`.
