// OS detection + shortcut-formatting helpers.
//
// **When adding or referencing a keyboard shortcut anywhere in this app,
// always render the user-facing text through `kbd()` / `mod()` so Windows
// and Linux users see "Ctrl+K" while macOS users see "⌘K".** The runtime
// key handlers already accept both `metaKey` and `ctrlKey` as the modifier
// (see App.tsx); this module only governs display.

const detectMac = (): boolean => {
  if (typeof navigator === "undefined") return false;
  // Newer browsers expose userAgentData; fall back to platform for older.
  const data = (navigator as unknown as { userAgentData?: { platform?: string } })
    .userAgentData;
  const platform = (data?.platform ?? navigator.platform ?? "").toLowerCase();
  return platform.includes("mac");
};

export const isMac = detectMac();

/// True when running as the Cloudflare web app (web/ compiles this same src
/// tree with Tauri shims). Gates desktop-only capabilities: offline
/// downloads, file export, native drags. Detection: Tauri injects
/// __TAURI_INTERNALS__ into its webview; a plain browser doesn't have it.
export const isWeb =
  typeof window !== "undefined" &&
  !("__TAURI_INTERNALS__" in (window as unknown as Record<string, unknown>));

/// The Cmd/Ctrl modifier name — "⌘" on macOS, "Ctrl" everywhere else.
export const mod = isMac ? "⌘" : "Ctrl";

/// Render a Cmd/Ctrl shortcut for display, e.g. kbd("K") → "⌘K" / "Ctrl+K".
export function kbd(key: string): string {
  return isMac ? `${mod}${key}` : `${mod}+${key}`;
}

/// Render a Cmd/Ctrl + click style action for display.
/// macOS reads more compactly with a hyphen; Windows uses "+".
export function kbdClick(): string {
  return isMac ? `${mod}-click` : `${mod}+click`;
}

/// Render Shift+click for display. Same on all platforms today but routed
/// through this helper so we have a single place if conventions change.
export const shiftClick = "Shift-click";
