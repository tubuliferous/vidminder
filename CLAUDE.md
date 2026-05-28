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

## Other project notes

- The yt-dlp sidecar lives at `src-tauri/binaries/yt-dlp-<target-triple>`.
  Run `npm run install-sidecar` after a fresh clone to symlink it.
- Dev: `npm run tauri dev` from project root.
- Release: bump `package.json`, `src-tauri/Cargo.toml`, and
  `src-tauri/tauri.conf.json` to the same version; commit; tag `vX.Y.Z`;
  push the tag. CI publishes the GitHub Release automatically with stable-
  named asset copies the README links to.
- DB lives at `~/Library/Application Support/VidMinder/vidminder.sqlite`
  (macOS) — paths are platform-specific via `dirs::data_dir()`.
